// ==============================================================================
// Tests for features/amplitude.js — Subcarrier Grouping (ACC-01-T1)
// ==============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mean,
  variance,
  groupSubcarriers,
  computeTemporalBandFeatures,
  computeBandMotionScore,
} from './amplitude.js';
import { NUM_BANDS, NUM_SUBCARRIERS, SUBCARRIER_BANDS } from '../shared/constants.js';

// ---------------------------------------------------------------------------
// Helper: generate a test amplitude array
// ---------------------------------------------------------------------------

/**
 * Create a 52-element amplitude array filled with a value, optionally with
 * a specific band set to a different value.
 */
function makeAmplitudes(fillValue, bandOverrides = {}) {
  const amps = new Array(NUM_SUBCARRIERS).fill(fillValue);
  for (const [bandIdx, value] of Object.entries(bandOverrides)) {
    const { start, end } = SUBCARRIER_BANDS[parseInt(bandIdx)];
    for (let i = start; i < end; i++) amps[i] = value;
  }
  return amps;
}

// ---------------------------------------------------------------------------
// mean()
// ---------------------------------------------------------------------------

describe('mean()', () => {
  it('returns 0 for empty array', () => {
    assert.equal(mean([]), 0);
  });

  it('computes mean of positive values', () => {
    assert.equal(mean([2, 4, 6]), 4);
  });

  it('handles single element', () => {
    assert.equal(mean([42]), 42);
  });
});

// ---------------------------------------------------------------------------
// variance()
// ---------------------------------------------------------------------------

describe('variance()', () => {
  it('returns 0 for array with < 2 elements', () => {
    assert.equal(variance([]), 0);
    assert.equal(variance([5]), 0);
  });

  it('computes sample variance (Bessel-corrected)', () => {
    // [2, 4, 6] → mean=4, sum_sq=8, var=8/2=4
    assert.equal(variance([2, 4, 6]), 4);
  });

  it('returns 0 for constant values', () => {
    assert.equal(variance([3, 3, 3, 3]), 0);
  });

  it('accepts precomputed mean', () => {
    const v1 = variance([1, 2, 3, 4, 5]);
    const v2 = variance([1, 2, 3, 4, 5], 3);
    assert.equal(v1, v2);
  });
});

// ---------------------------------------------------------------------------
// groupSubcarriers()
// ---------------------------------------------------------------------------

describe('groupSubcarriers()', () => {
  it('throws on invalid input', () => {
    assert.throws(() => groupSubcarriers(null));
    assert.throws(() => groupSubcarriers([]));
    assert.throws(() => groupSubcarriers(new Array(51).fill(0)));
  });

  it('returns correct structure', () => {
    const result = groupSubcarriers(makeAmplitudes(10));
    assert.equal(result.bands.length, NUM_BANDS);
    assert.equal(result.bandMeans.length, NUM_BANDS);
    assert.equal(result.bandVars.length, NUM_BANDS);
    assert.equal(typeof result.overallMean, 'number');
    assert.equal(typeof result.overallVar, 'number');
    assert.equal(typeof result.interBandVar, 'number');
  });

  it('computes correct mean for uniform amplitudes', () => {
    const result = groupSubcarriers(makeAmplitudes(10));
    assert.equal(result.overallMean, 10);
    for (let b = 0; b < NUM_BANDS; b++) {
      assert.equal(result.bandMeans[b], 10, `Band ${b} mean should be 10`);
    }
  });

  it('reports zero variance for uniform amplitudes', () => {
    const result = groupSubcarriers(makeAmplitudes(5));
    assert.equal(result.overallVar, 0);
    assert.equal(result.interBandVar, 0);
    for (let b = 0; b < NUM_BANDS; b++) {
      assert.equal(result.bandVars[b], 0, `Band ${b} var should be 0`);
    }
  });

  it('detects inter-band variance when one band differs', () => {
    // Band 0 at 100, rest at 10
    const amps = makeAmplitudes(10, { 0: 100 });
    const result = groupSubcarriers(amps);

    // Inter-band variance should be > 0 since band means differ
    assert.ok(result.interBandVar > 0, 'Expected non-zero inter-band variance');

    // Band 0 mean should be 100
    assert.equal(result.bandMeans[0], 100);

    // Other bands should be 10
    for (let b = 1; b < NUM_BANDS; b++) {
      assert.equal(result.bandMeans[b], 10, `Band ${b} mean should be 10`);
    }
  });

  it('computes correct min/max/range per band', () => {
    const amps = makeAmplitudes(5);
    amps[0] = 1;   // Band 0 min
    amps[5] = 20;  // Band 0 max (still in band 0: indices 0-5)
    const result = groupSubcarriers(amps);

    assert.equal(result.bands[0].minAmplitude, 1);
    assert.equal(result.bands[0].maxAmplitude, 20);
    assert.equal(result.bands[0].range, 19);
  });

  it('preserves band labels from constants', () => {
    const result = groupSubcarriers(makeAmplitudes(1));
    assert.equal(result.bands[0].label, 'edge-neg');
    assert.equal(result.bands[3].label, 'dc-neg');
    assert.equal(result.bands[7].label, 'edge-pos');
  });
});

// ---------------------------------------------------------------------------
// computeTemporalBandFeatures()
// ---------------------------------------------------------------------------

describe('computeTemporalBandFeatures()', () => {
  it('returns defaults for insufficient history', () => {
    const result = computeTemporalBandFeatures([], 5);
    assert.equal(result.mostActiveBand, -1);
    assert.deepEqual(result.temporalBandVars, new Array(NUM_BANDS).fill(0));
  });

  it('returns defaults for null history', () => {
    const result = computeTemporalBandFeatures(null);
    assert.equal(result.mostActiveBand, -1);
  });

  it('detects most active band in temporal series', () => {
    // Create a history where band 3 fluctuates strongly and band 0 fluctuates weakly
    const history = [];
    for (let t = 0; t < 10; t++) {
      const amps = makeAmplitudes(10);
      // Band 3 oscillates between 5 and 50 (large fluctuation)
      const band3 = SUBCARRIER_BANDS[3];
      const val3 = t % 2 === 0 ? 5 : 50;
      for (let i = band3.start; i < band3.end; i++) amps[i] = val3;
      // Band 0 has a small fluctuation (so minVar > 0, enabling ratio)
      const band0 = SUBCARRIER_BANDS[0];
      const val0 = t % 2 === 0 ? 9 : 11;
      for (let i = band0.start; i < band0.end; i++) amps[i] = val0;
      history.push(groupSubcarriers(amps));
    }

    const temporal = computeTemporalBandFeatures(history);
    assert.equal(temporal.mostActiveBand, 3);
    assert.ok(temporal.temporalBandVars[3] > temporal.temporalBandVars[0]);
    // Ratio is 0 when some bands have zero temporal variance (by design — avoids division by zero)
    // The key assertion is that band 3 is detected as the most active
    assert.ok(temporal.temporalBandVars[3] > 0, 'Band 3 should have non-zero temporal variance');
  });

  it('returns zero activity ratio for uniform temporal data', () => {
    const history = [];
    for (let t = 0; t < 10; t++) {
      history.push(groupSubcarriers(makeAmplitudes(10)));
    }
    const temporal = computeTemporalBandFeatures(history);
    assert.equal(temporal.bandActivityRatio, 0);
    assert.equal(temporal.temporalOverallVar, 0);
  });
});

// ---------------------------------------------------------------------------
// computeBandMotionScore()
// ---------------------------------------------------------------------------

describe('computeBandMotionScore()', () => {
  it('returns 0 when baseline is zero', () => {
    const grouped = groupSubcarriers(makeAmplitudes(10));
    assert.equal(computeBandMotionScore(grouped, 0), 0);
  });

  it('returns 0 for uniform amplitudes with any baseline', () => {
    // Uniform → all band variances are 0, inter-band var is 0
    const grouped = groupSubcarriers(makeAmplitudes(10));
    const score = computeBandMotionScore(grouped, 1.0);
    assert.equal(score, 0);
  });

  it('returns higher score for more variance', () => {
    const lowVar = makeAmplitudes(10, { 0: 11 }); // slight variance
    const highVar = makeAmplitudes(10, { 0: 100, 4: 80 }); // lots of variance

    const scoreLow = computeBandMotionScore(groupSubcarriers(lowVar), 1.0);
    const scoreHigh = computeBandMotionScore(groupSubcarriers(highVar), 1.0);

    assert.ok(scoreHigh > scoreLow, `High var score (${scoreHigh}) should exceed low (${scoreLow})`);
  });

  it('returns value between 0 and 1', () => {
    const amps = makeAmplitudes(10, { 0: 100, 7: 1 });
    const score = computeBandMotionScore(groupSubcarriers(amps), 0.5);
    assert.ok(score >= 0 && score <= 1, `Score ${score} should be in [0,1]`);
  });
});
