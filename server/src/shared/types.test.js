// ==============================================================================
// Tests for shared/types.js
// ==============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBandFeatures,
  createSubcarrierGroupResult,
  createFeatureVector,
  isValidAmplitudeArray,
  isValidCSIPayload,
  extractIQSamples,
  complexAmplitude,
  complexPhase,
} from './types.js';
import { NUM_SUBCARRIERS, NUM_BANDS } from './constants.js';

describe('createBandFeatures', () => {
  it('creates default features for valid band index', () => {
    const band = createBandFeatures(0);
    assert.equal(band.bandIndex, 0);
    assert.equal(band.label, 'edge-neg');
    assert.equal(band.meanAmplitude, 0);
    assert.equal(band.variance, 0);
  });

  it('throws RangeError for invalid band index', () => {
    assert.throws(() => createBandFeatures(-1), RangeError);
    assert.throws(() => createBandFeatures(8), RangeError);
    assert.throws(() => createBandFeatures(100), RangeError);
  });
});

describe('createSubcarrierGroupResult', () => {
  it('creates result with correct number of bands', () => {
    const result = createSubcarrierGroupResult();
    assert.equal(result.bands.length, NUM_BANDS);
    assert.equal(result.bandMeans.length, NUM_BANDS);
    assert.equal(result.bandVars.length, NUM_BANDS);
  });

  it('initializes all numeric fields to zero', () => {
    const result = createSubcarrierGroupResult();
    assert.equal(result.overallMean, 0);
    assert.equal(result.overallVar, 0);
    assert.equal(result.interBandVar, 0);
  });
});

describe('createFeatureVector', () => {
  it('creates feature vector with correct MAC', () => {
    const fv = createFeatureVector('aa:bb:cc:dd:ee:ff');
    assert.equal(fv.nodeMAC, 'aa:bb:cc:dd:ee:ff');
    assert.equal(fv.bandMeans.length, NUM_BANDS);
    assert.equal(fv.phaseDiffs.length, NUM_SUBCARRIERS - 1);
  });

  it('has a recent timestamp', () => {
    const before = Date.now();
    const fv = createFeatureVector('test');
    const after = Date.now();
    assert.ok(fv.timestamp >= before && fv.timestamp <= after);
  });
});

describe('isValidAmplitudeArray', () => {
  it('returns true for array of length 52', () => {
    assert.equal(isValidAmplitudeArray(new Array(52).fill(0)), true);
  });

  it('returns false for wrong lengths', () => {
    assert.equal(isValidAmplitudeArray([]), false);
    assert.equal(isValidAmplitudeArray(new Array(51).fill(0)), false);
    assert.equal(isValidAmplitudeArray(new Array(53).fill(0)), false);
  });

  it('returns false for non-arrays', () => {
    assert.equal(isValidAmplitudeArray(null), false);
    assert.equal(isValidAmplitudeArray('string'), false);
  });
});

describe('isValidCSIPayload', () => {
  it('returns true for 104-byte buffer', () => {
    assert.equal(isValidCSIPayload(Buffer.alloc(104)), true);
  });

  it('returns true for larger buffer', () => {
    assert.equal(isValidCSIPayload(Buffer.alloc(200)), true);
  });

  it('returns false for too-small buffer', () => {
    assert.equal(isValidCSIPayload(Buffer.alloc(103)), false);
  });

  it('returns false for null', () => {
    assert.equal(isValidCSIPayload(null), false);
  });
});

describe('extractIQSamples', () => {
  it('extracts correct number of samples', () => {
    const buf = Buffer.alloc(104); // 52 * 2 bytes
    const samples = extractIQSamples(buf);
    assert.equal(samples.length, NUM_SUBCARRIERS);
  });

  it('correctly converts signed values', () => {
    // Create buffer with known I/Q values
    const buf = Buffer.alloc(104);
    buf[0] = 10;    // I = 10
    buf[1] = 250;   // Q = 250 → signed = -6
    const samples = extractIQSamples(buf);
    assert.equal(samples[0].i, 10);
    assert.equal(samples[0].q, -6);
  });

  it('handles negative I values', () => {
    const buf = Buffer.alloc(104);
    buf[0] = 200;   // I = 200 → signed = -56
    buf[1] = 50;    // Q = 50
    const samples = extractIQSamples(buf);
    assert.equal(samples[0].i, -56);
    assert.equal(samples[0].q, 50);
  });
});

describe('complexAmplitude', () => {
  it('computes magnitude correctly for 3-4-5 triangle', () => {
    const amp = complexAmplitude({ i: 3, q: 4 });
    assert.equal(amp, 5);
  });

  it('returns 0 for zero sample', () => {
    assert.equal(complexAmplitude({ i: 0, q: 0 }), 0);
  });

  it('handles negative components', () => {
    const amp = complexAmplitude({ i: -3, q: -4 });
    assert.equal(amp, 5);
  });
});

describe('complexPhase', () => {
  it('returns 0 for positive real axis', () => {
    const phase = complexPhase({ i: 1, q: 0 });
    assert.ok(Math.abs(phase) < 1e-10);
  });

  it('returns π/2 for positive imaginary axis', () => {
    const phase = complexPhase({ i: 0, q: 1 });
    assert.ok(Math.abs(phase - Math.PI / 2) < 1e-10);
  });

  it('returns -π/2 for negative imaginary axis', () => {
    const phase = complexPhase({ i: 0, q: -1 });
    assert.ok(Math.abs(phase + Math.PI / 2) < 1e-10);
  });

  it('returns π for negative real axis', () => {
    const phase = complexPhase({ i: -1, q: 0 });
    assert.ok(Math.abs(Math.abs(phase) - Math.PI) < 1e-10);
  });
});
