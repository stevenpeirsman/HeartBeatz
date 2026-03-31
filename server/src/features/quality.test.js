// ==============================================================================
// Tests for features/quality.js — Frame Quality Scorer (ACC-01-T6)
// ==============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRssiStability,
  computeTimestampJitter,
  computePacketLoss,
  computeAmplitudeValidity,
  computeQualityReport,
  FrameQualityScorer,
  QUALITY_WINDOW_SIZE,
  QUALITY_WEIGHTS,
  RSSI_VARIANCE_GOOD,
  RSSI_VARIANCE_BAD,
  MIN_VALID_AMPLITUDE,
  MIN_VALID_SUBCARRIER_FRACTION,
} from './quality.js';
import { NUM_SUBCARRIERS } from '../shared/constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAmplitudes(fillValue) {
  return new Array(NUM_SUBCARRIERS).fill(fillValue);
}

// ---------------------------------------------------------------------------
// computeRssiStability()
// ---------------------------------------------------------------------------

describe('quality: computeRssiStability()', () => {
  it('returns 1.0 for insufficient data', () => {
    assert.equal(computeRssiStability([]), 1.0);
    assert.equal(computeRssiStability([-55]), 1.0);
  });

  it('returns 1.0 for constant RSSI (zero variance)', () => {
    const rssi = new Array(20).fill(-55);
    assert.equal(computeRssiStability(rssi), 1.0);
  });

  it('returns 1.0 for low RSSI variance', () => {
    // Variance < RSSI_VARIANCE_GOOD
    const rssi = [];
    for (let i = 0; i < 20; i++) rssi.push(-55 + (i % 2 === 0 ? 0.5 : -0.5));
    const score = computeRssiStability(rssi);
    assert.equal(score, 1.0);
  });

  it('returns 0.0 for high RSSI variance', () => {
    // Variance > RSSI_VARIANCE_BAD
    const rssi = [];
    for (let i = 0; i < 20; i++) rssi.push(i % 2 === 0 ? -40 : -60);
    const score = computeRssiStability(rssi);
    assert.equal(score, 0.0);
  });

  it('returns intermediate score for moderate variance', () => {
    // Create RSSI with variance between GOOD and BAD
    const rssi = [];
    for (let i = 0; i < 20; i++) rssi.push(-55 + (i % 2 === 0 ? 2 : -2));
    const score = computeRssiStability(rssi);
    assert.ok(score > 0 && score < 1, `Expected intermediate score, got ${score}`);
  });
});

// ---------------------------------------------------------------------------
// computeTimestampJitter()
// ---------------------------------------------------------------------------

describe('quality: computeTimestampJitter()', () => {
  it('returns 1.0 for insufficient data', () => {
    assert.equal(computeTimestampJitter([]), 1.0);
    assert.equal(computeTimestampJitter([100, 150]), 1.0);
  });

  it('returns 1.0 for perfectly regular timestamps', () => {
    const ts = [];
    for (let i = 0; i < 20; i++) ts.push(i * 50); // Exactly 50ms intervals
    const score = computeTimestampJitter(ts);
    assert.equal(score, 1.0);
  });

  it('returns low score for highly irregular timestamps', () => {
    // Very random intervals
    const ts = [0, 10, 200, 210, 400, 405, 600, 610, 800, 850, 1200];
    const score = computeTimestampJitter(ts);
    assert.ok(score < 0.5, `Expected low score for jittery timestamps, got ${score}`);
  });

  it('returns intermediate score for moderate jitter', () => {
    const ts = [];
    for (let i = 0; i < 20; i++) {
      // 50ms ± small jitter
      ts.push(i * 50 + (i % 2 === 0 ? 5 : -5));
    }
    const score = computeTimestampJitter(ts);
    assert.ok(score > 0.5 && score <= 1.0, `Expected good score, got ${score}`);
  });
});

// ---------------------------------------------------------------------------
// computePacketLoss()
// ---------------------------------------------------------------------------

describe('quality: computePacketLoss()', () => {
  it('returns perfect score for insufficient data', () => {
    const result = computePacketLoss([]);
    assert.equal(result.score, 1.0);
    assert.equal(result.lossRate, 0);
  });

  it('returns perfect score for consecutive sequences', () => {
    const seqs = [100, 101, 102, 103, 104, 105];
    const result = computePacketLoss(seqs);
    assert.equal(result.score, 1.0);
    assert.equal(result.lossRate, 0);
    assert.equal(result.gapCount, 0);
  });

  it('detects single-frame gaps', () => {
    const seqs = [100, 101, 103, 104, 105]; // Gap: seq 102 missing
    const result = computePacketLoss(seqs);
    assert.equal(result.gapCount, 1);
    assert.ok(result.lossRate > 0);
    assert.ok(result.score < 1.0);
  });

  it('detects multi-frame gaps', () => {
    const seqs = [100, 105]; // 4 frames missing
    const result = computePacketLoss(seqs);
    assert.equal(result.gapCount, 4);
    assert.ok(result.lossRate > 0);
  });

  it('handles 16-bit sequence wrap-around', () => {
    const seqs = [65534, 65535, 0, 1, 2];
    const result = computePacketLoss(seqs);
    assert.equal(result.gapCount, 0);
    assert.equal(result.score, 1.0);
  });

  it('returns 0.0 score for >= 10% loss', () => {
    // 10 out of 20 missing
    const seqs = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
    const result = computePacketLoss(seqs);
    // Each gap is 1, total gaps = 10, total expected = 20 → 50% loss
    assert.equal(result.score, 0.0);
  });
});

// ---------------------------------------------------------------------------
// computeAmplitudeValidity()
// ---------------------------------------------------------------------------

describe('quality: computeAmplitudeValidity()', () => {
  it('returns 0 for invalid arrays', () => {
    assert.equal(computeAmplitudeValidity(null), 0.0);
    assert.equal(computeAmplitudeValidity([1, 2, 3]), 0.0);
  });

  it('returns 1.0 for all-valid amplitudes', () => {
    const amps = makeAmplitudes(10);
    assert.equal(computeAmplitudeValidity(amps), 1.0);
  });

  it('returns 0.0 for all-zero amplitudes', () => {
    const amps = makeAmplitudes(0);
    assert.equal(computeAmplitudeValidity(amps), 0.0);
  });

  it('returns intermediate score for partial validity', () => {
    const amps = makeAmplitudes(10);
    // Set half the subcarriers to zero
    for (let i = 0; i < 26; i++) amps[i] = 0;
    const score = computeAmplitudeValidity(amps);
    assert.ok(score > 0 && score < 1, `Expected intermediate score, got ${score}`);
  });

  it('returns 1.0 when exactly at threshold fraction', () => {
    const amps = makeAmplitudes(0);
    // Set exactly MIN_VALID_SUBCARRIER_FRACTION to valid
    const validCount = Math.ceil(NUM_SUBCARRIERS * MIN_VALID_SUBCARRIER_FRACTION);
    for (let i = 0; i < validCount; i++) amps[i] = 10;
    const score = computeAmplitudeValidity(amps);
    assert.equal(score, 1.0);
  });
});

// ---------------------------------------------------------------------------
// computeQualityReport()
// ---------------------------------------------------------------------------

describe('quality: computeQualityReport()', () => {
  it('returns full report with all inputs', () => {
    const report = computeQualityReport({
      rssiValues: new Array(20).fill(-55),
      timestamps: Array.from({ length: 20 }, (_, i) => i * 50),
      seqNumbers: Array.from({ length: 20 }, (_, i) => i),
      amplitudes: makeAmplitudes(10),
    });

    assert.ok(report.overall >= 0 && report.overall <= 1);
    assert.ok(report.rssiStability >= 0 && report.rssiStability <= 1);
    assert.ok(report.timestampJitter >= 0 && report.timestampJitter <= 1);
    assert.ok(report.packetLossScore >= 0 && report.packetLossScore <= 1);
    assert.ok(report.amplitudeValidity >= 0 && report.amplitudeValidity <= 1);
    assert.ok(report.timestamp > 0);
    assert.equal(report.frameCount, 20);
  });

  it('returns 1.0 overall for perfect inputs', () => {
    const report = computeQualityReport({
      rssiValues: new Array(20).fill(-55),
      timestamps: Array.from({ length: 20 }, (_, i) => i * 50),
      seqNumbers: Array.from({ length: 20 }, (_, i) => i),
      amplitudes: makeAmplitudes(10),
    });
    assert.ok(Math.abs(report.overall - 1.0) < 0.01,
      `Expected overall ~1.0, got ${report.overall}`);
  });

  it('handles missing inputs gracefully', () => {
    const report = computeQualityReport({});
    assert.ok(typeof report.overall === 'number');
    assert.ok(report.overall >= 0 && report.overall <= 1);
  });

  it('weights sum to 1.0', () => {
    const sum = QUALITY_WEIGHTS.rssi + QUALITY_WEIGHTS.jitter +
                QUALITY_WEIGHTS.packetLoss + QUALITY_WEIGHTS.amplitude;
    assert.ok(Math.abs(sum - 1.0) < 1e-10, `Weights sum to ${sum}, expected 1.0`);
  });
});

// ---------------------------------------------------------------------------
// FrameQualityScorer (stateful wrapper)
// ---------------------------------------------------------------------------

describe('quality: FrameQualityScorer', () => {
  it('constructs with default settings', () => {
    const scorer = new FrameQualityScorer();
    assert.equal(scorer.totalFrames, 0);
    assert.equal(scorer.frameCount, 0);
  });

  it('tracks frames and produces reports', () => {
    const scorer = new FrameQualityScorer();
    for (let i = 0; i < 10; i++) {
      scorer.push({
        rssi: -55,
        timestamp: i * 50,
        seq: i,
        amplitudes: makeAmplitudes(10),
      });
    }
    assert.equal(scorer.totalFrames, 10);
    assert.equal(scorer.frameCount, 10);

    const report = scorer.compute();
    assert.ok(report.overall > 0);
  });

  it('maintains window size limit', () => {
    const scorer = new FrameQualityScorer({ windowSize: 10 });
    for (let i = 0; i < 20; i++) {
      scorer.push({ rssi: -55, timestamp: i * 50, seq: i });
    }
    assert.equal(scorer.frameCount, 10);
    assert.equal(scorer.totalFrames, 20);
  });

  it('handles frames without optional fields', () => {
    const scorer = new FrameQualityScorer();
    scorer.push({ timestamp: 0, seq: 0 });
    scorer.push({ timestamp: 50, seq: 1 });
    const report = scorer.compute();
    assert.ok(typeof report.overall === 'number');
  });

  it('reset clears all state', () => {
    const scorer = new FrameQualityScorer();
    for (let i = 0; i < 10; i++) {
      scorer.push({ rssi: -55, timestamp: i * 50, seq: i });
    }
    scorer.reset();
    assert.equal(scorer.totalFrames, 0);
    assert.equal(scorer.frameCount, 0);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('quality: exported constants', () => {
  it('QUALITY_WINDOW_SIZE is positive', () => {
    assert.ok(QUALITY_WINDOW_SIZE > 0);
  });

  it('QUALITY_WEIGHTS sum to 1.0', () => {
    const sum = Object.values(QUALITY_WEIGHTS).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1.0) < 1e-10);
  });

  it('RSSI thresholds are ordered correctly', () => {
    assert.ok(RSSI_VARIANCE_GOOD < RSSI_VARIANCE_BAD);
  });

  it('MIN_VALID_SUBCARRIER_FRACTION is in (0, 1]', () => {
    assert.ok(MIN_VALID_SUBCARRIER_FRACTION > 0);
    assert.ok(MIN_VALID_SUBCARRIER_FRACTION <= 1);
  });
});
