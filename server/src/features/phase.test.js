// ==============================================================================
// Unit Tests — Phase Difference Extraction (ACC-01-T2)
// ==============================================================================
// Tests verify:
//   1. Raw phase extraction from I/Q data
//   2. Adjacent phase difference computation
//   3. Phase unwrapping removes 2π discontinuities
//   4. Linear fit and residual computation
//   5. Per-band phase feature aggregation
//   6. Full pipeline (extractPhaseFeatures)
//   7. Edge cases: NaN handling, low-magnitude subcarriers, all-zero data
//   8. wrapToPi utility
//
// Run: node --test server/src/features/phase.test.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPhases,
  computeAdjacentPhaseDiffs,
  unwrapPhase,
  fitLinearPhase,
  computeBandPhaseFeatures,
  extractPhaseFeatures,
  wrapToPi,
  NUM_PHASE_DIFFS,
} from './phase.js';
import { NUM_SUBCARRIERS } from '../shared/constants.js';

// ---------------------------------------------------------------------------
// Helpers: Synthetic CSI data generators
// ---------------------------------------------------------------------------

/**
 * Create a CSI payload buffer from I/Q value pairs.
 * @param {Array<{i: number, q: number}>} samples - I/Q pairs (signed int8 range)
 * @returns {Buffer}
 */
function makeCSIBuffer(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  for (let k = 0; k < samples.length; k++) {
    // Convert signed to unsigned byte representation
    let ival = samples[k].i;
    let qval = samples[k].q;
    if (ival < 0) ival += 256;
    if (qval < 0) qval += 256;
    buf[k * 2] = ival;
    buf[k * 2 + 1] = qval;
  }
  return buf;
}

/**
 * Generate 52 I/Q samples with known amplitude and phase.
 * @param {number} amplitude - Desired amplitude for all subcarriers
 * @param {number} phaseOffset - Starting phase (radians)
 * @param {number} phaseSlope - Phase increment per subcarrier (radians)
 * @returns {Array<{i: number, q: number}>}
 */
function makeLinearPhaseSamples(amplitude, phaseOffset, phaseSlope) {
  const samples = [];
  for (let k = 0; k < NUM_SUBCARRIERS; k++) {
    const phase = phaseOffset + phaseSlope * k;
    // Round to integer range (int8 signed: -128 to 127)
    const i = Math.round(amplitude * Math.cos(phase));
    const q = Math.round(amplitude * Math.sin(phase));
    samples.push({ i: Math.max(-128, Math.min(127, i)), q: Math.max(-128, Math.min(127, q)) });
  }
  return samples;
}

/**
 * Generate 52 I/Q samples where all subcarriers have the same constant phase.
 * @param {number} amplitude
 * @param {number} phase - Constant phase for all subcarriers
 * @returns {Array<{i: number, q: number}>}
 */
function makeConstantPhaseSamples(amplitude, phase) {
  return makeLinearPhaseSamples(amplitude, phase, 0);
}

// ---------------------------------------------------------------------------
// Tests: wrapToPi
// ---------------------------------------------------------------------------

describe('wrapToPi', () => {
  it('should not change values already in [-π, π]', () => {
    assert.equal(wrapToPi(0), 0);
    assert.ok(Math.abs(wrapToPi(1.5) - 1.5) < 1e-10);
    assert.ok(Math.abs(wrapToPi(-1.5) - (-1.5)) < 1e-10);
  });

  it('should wrap values > π', () => {
    const wrapped = wrapToPi(Math.PI + 0.5);
    assert.ok(wrapped >= -Math.PI && wrapped <= Math.PI);
    assert.ok(Math.abs(wrapped - (-Math.PI + 0.5)) < 1e-10);
  });

  it('should wrap values < -π', () => {
    const wrapped = wrapToPi(-Math.PI - 0.5);
    assert.ok(wrapped >= -Math.PI && wrapped <= Math.PI);
    assert.ok(Math.abs(wrapped - (Math.PI - 0.5)) < 1e-10);
  });

  it('should handle multiples of 2π', () => {
    const wrapped = wrapToPi(4 * Math.PI + 0.3);
    assert.ok(Math.abs(wrapped - 0.3) < 1e-10);
  });

  it('should handle negative multiples of 2π', () => {
    const wrapped = wrapToPi(-6 * Math.PI + 0.7);
    assert.ok(Math.abs(wrapped - 0.7) < 1e-10);
  });
});

// ---------------------------------------------------------------------------
// Tests: extractPhases
// ---------------------------------------------------------------------------

describe('extractPhases', () => {
  it('should throw on invalid CSI payload', () => {
    assert.throws(() => extractPhases(null), /Invalid CSI payload/);
    assert.throws(() => extractPhases(Buffer.alloc(10)), /Invalid CSI payload/);
  });

  it('should extract 52 phase values from valid I/Q data', () => {
    const samples = makeConstantPhaseSamples(50, 0.5);
    const buf = makeCSIBuffer(samples);
    const { phases, magnitudes, validCount } = extractPhases(buf);

    assert.equal(phases.length, NUM_SUBCARRIERS);
    assert.equal(magnitudes.length, NUM_SUBCARRIERS);
    assert.equal(validCount, NUM_SUBCARRIERS);

    // All phases should be approximately 0.5 (within quantization error)
    for (let k = 0; k < NUM_SUBCARRIERS; k++) {
      assert.ok(!Number.isNaN(phases[k]), `Phase at ${k} should not be NaN`);
      assert.ok(Math.abs(phases[k] - 0.5) < 0.1, `Phase at ${k} should be near 0.5, got ${phases[k]}`);
    }
  });

  it('should mark low-magnitude subcarriers as NaN', () => {
    // Create samples with some near-zero I/Q values
    const samples = [];
    for (let k = 0; k < NUM_SUBCARRIERS; k++) {
      if (k < 5) {
        samples.push({ i: 0, q: 0 }); // Zero magnitude
      } else {
        samples.push({ i: 50, q: 30 }); // Good signal
      }
    }
    const buf = makeCSIBuffer(samples);
    const { phases, validCount } = extractPhases(buf);

    // First 5 should be NaN (zero magnitude)
    for (let k = 0; k < 5; k++) {
      assert.ok(Number.isNaN(phases[k]), `Phase at ${k} should be NaN (zero I/Q)`);
    }
    // Rest should be valid
    for (let k = 5; k < NUM_SUBCARRIERS; k++) {
      assert.ok(!Number.isNaN(phases[k]), `Phase at ${k} should be valid`);
    }
    assert.equal(validCount, NUM_SUBCARRIERS - 5);
  });
});

// ---------------------------------------------------------------------------
// Tests: computeAdjacentPhaseDiffs
// ---------------------------------------------------------------------------

describe('computeAdjacentPhaseDiffs', () => {
  it('should throw on wrong-length input', () => {
    assert.throws(() => computeAdjacentPhaseDiffs([1, 2, 3]), /Expected 52/);
  });

  it('should return 51 differences for constant-phase input', () => {
    // All phases equal → all diffs should be 0
    const phases = new Array(NUM_SUBCARRIERS).fill(1.0);
    const diffs = computeAdjacentPhaseDiffs(phases);

    assert.equal(diffs.length, NUM_PHASE_DIFFS);
    for (let k = 0; k < NUM_PHASE_DIFFS; k++) {
      assert.ok(Math.abs(diffs[k]) < 1e-10, `Diff at ${k} should be 0 for constant phase`);
    }
  });

  it('should compute correct diffs for linear phase progression', () => {
    const slope = 0.1; // Small slope — no wrapping needed
    const phases = new Array(NUM_SUBCARRIERS);
    for (let k = 0; k < NUM_SUBCARRIERS; k++) {
      phases[k] = 0.1 * k;
    }
    const diffs = computeAdjacentPhaseDiffs(phases);

    for (let k = 0; k < NUM_PHASE_DIFFS; k++) {
      assert.ok(Math.abs(diffs[k] - 0.1) < 1e-10, `Diff at ${k} should be 0.1`);
    }
  });

  it('should wrap large phase jumps to [-π, π]', () => {
    const phases = new Array(NUM_SUBCARRIERS).fill(0);
    phases[0] = 3.0;
    phases[1] = -3.0; // Raw diff = -6.0, wrapped should be ≈ 0.28 (2π - 6)
    const diffs = computeAdjacentPhaseDiffs(phases);

    assert.ok(diffs[0] >= -Math.PI && diffs[0] <= Math.PI,
      `Wrapped diff should be in [-π, π], got ${diffs[0]}`);
  });

  it('should propagate NaN from invalid subcarriers', () => {
    const phases = new Array(NUM_SUBCARRIERS).fill(0.5);
    phases[10] = NaN;
    const diffs = computeAdjacentPhaseDiffs(phases);

    assert.ok(Number.isNaN(diffs[9]), 'Diff involving NaN source should be NaN');
    assert.ok(Number.isNaN(diffs[10]), 'Diff involving NaN source should be NaN');
    assert.ok(!Number.isNaN(diffs[8]), 'Diff not involving NaN should be valid');
    assert.ok(!Number.isNaN(diffs[11]), 'Diff not involving NaN should be valid');
  });
});

// ---------------------------------------------------------------------------
// Tests: unwrapPhase
// ---------------------------------------------------------------------------

describe('unwrapPhase', () => {
  it('should not change a smooth sequence within [-π, π]', () => {
    const phases = [0, 0.1, 0.2, 0.3, 0.4];
    const unwrapped = unwrapPhase(phases);
    for (let k = 0; k < phases.length; k++) {
      assert.ok(Math.abs(unwrapped[k] - phases[k]) < 1e-10);
    }
  });

  it('should unwrap a positive-going crossing of π', () => {
    // Sequence that wraps from near +π to near -π
    const phases = [2.8, 3.0, -3.0, -2.8]; // jump at index 2
    const unwrapped = unwrapPhase(phases);

    // After unwrapping, the sequence should be monotonically increasing
    for (let k = 1; k < unwrapped.length; k++) {
      assert.ok(unwrapped[k] > unwrapped[k - 1],
        `Unwrapped sequence should be increasing: [${k-1}]=${unwrapped[k-1]}, [${k}]=${unwrapped[k]}`);
    }
  });

  it('should unwrap a negative-going crossing of -π', () => {
    // Sequence that wraps from near -π to near +π
    const phases = [-2.8, -3.0, 3.0, 2.8]; // jump at index 2
    const unwrapped = unwrapPhase(phases);

    // After unwrapping, the sequence should be monotonically decreasing
    for (let k = 1; k < unwrapped.length; k++) {
      assert.ok(unwrapped[k] < unwrapped[k - 1],
        `Unwrapped sequence should be decreasing: [${k-1}]=${unwrapped[k-1]}, [${k}]=${unwrapped[k]}`);
    }
  });

  it('should handle NaN values by carrying forward unwrap state', () => {
    const phases = [0, 0.5, NaN, 1.5, 2.0];
    const unwrapped = unwrapPhase(phases);

    assert.ok(Math.abs(unwrapped[0] - 0) < 1e-10);
    assert.ok(Math.abs(unwrapped[1] - 0.5) < 1e-10);
    assert.ok(Number.isNaN(unwrapped[2]));
    assert.ok(Math.abs(unwrapped[3] - 1.5) < 1e-10);
    assert.ok(Math.abs(unwrapped[4] - 2.0) < 1e-10);
  });

  it('should handle all-NaN input', () => {
    const phases = [NaN, NaN, NaN];
    const unwrapped = unwrapPhase(phases);
    for (let k = 0; k < phases.length; k++) {
      assert.ok(Number.isNaN(unwrapped[k]));
    }
  });

  it('should handle multiple wraps', () => {
    // Generate a phase sequence that wraps 3 times
    const count = 20;
    const trueSlope = 0.8; // Steep slope → multiple wraps
    const phases = [];
    for (let k = 0; k < count; k++) {
      phases.push(wrapToPi(trueSlope * k));
    }
    const unwrapped = unwrapPhase(phases);

    // The unwrapped sequence should approximate the true linear sequence
    for (let k = 0; k < count; k++) {
      if (!Number.isNaN(unwrapped[k])) {
        const expected = trueSlope * k;
        assert.ok(Math.abs(unwrapped[k] - expected) < 0.01,
          `Unwrapped[${k}] = ${unwrapped[k]}, expected ~${expected}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: fitLinearPhase
// ---------------------------------------------------------------------------

describe('fitLinearPhase', () => {
  it('should fit a perfect linear sequence', () => {
    const slope = 0.05;
    const intercept = 0.3;
    const phases = new Array(NUM_SUBCARRIERS);
    for (let k = 0; k < NUM_SUBCARRIERS; k++) {
      phases[k] = slope * k + intercept;
    }

    const result = fitLinearPhase(phases);
    assert.ok(Math.abs(result.slope - slope) < 1e-10, `Slope should be ${slope}, got ${result.slope}`);
    assert.ok(Math.abs(result.intercept - intercept) < 1e-10);
    assert.ok(result.residualStd < 1e-10, 'Residuals should be ~0 for perfect fit');
    assert.equal(result.validCount, NUM_SUBCARRIERS);
  });

  it('should compute nonzero residuals for non-linear phase', () => {
    const phases = new Array(NUM_SUBCARRIERS);
    for (let k = 0; k < NUM_SUBCARRIERS; k++) {
      // Linear + sinusoidal perturbation
      phases[k] = 0.05 * k + 0.5 * Math.sin(2 * Math.PI * k / 10);
    }

    const result = fitLinearPhase(phases);
    assert.ok(result.residualStd > 0.1, 'Residual std should be nonzero for non-linear data');
    assert.equal(result.validCount, NUM_SUBCARRIERS);
  });

  it('should skip NaN values in the fit', () => {
    const phases = new Array(NUM_SUBCARRIERS);
    for (let k = 0; k < NUM_SUBCARRIERS; k++) {
      phases[k] = 0.1 * k;
    }
    // Inject some NaNs
    phases[5] = NaN;
    phases[20] = NaN;
    phases[40] = NaN;

    const result = fitLinearPhase(phases);
    assert.equal(result.validCount, NUM_SUBCARRIERS - 3);
    assert.ok(Math.abs(result.slope - 0.1) < 0.01, 'Slope should still be ~0.1');
    // NaN positions should have NaN residuals
    assert.ok(Number.isNaN(result.residuals[5]));
    assert.ok(Number.isNaN(result.residuals[20]));
    assert.ok(Number.isNaN(result.residuals[40]));
  });

  it('should return defaults for < 2 valid points', () => {
    const phases = new Array(NUM_SUBCARRIERS).fill(NaN);
    phases[10] = 1.0; // Only one valid point

    const result = fitLinearPhase(phases);
    assert.equal(result.slope, 0);
    assert.equal(result.residualStd, 0);
    assert.equal(result.validCount, 1);
  });

  it('should return defaults for all-NaN input', () => {
    const phases = new Array(NUM_SUBCARRIERS).fill(NaN);
    const result = fitLinearPhase(phases);
    assert.equal(result.validCount, 0);
    assert.equal(result.slope, 0);
    assert.equal(result.intercept, 0);
  });
});

// ---------------------------------------------------------------------------
// Tests: computeBandPhaseFeatures
// ---------------------------------------------------------------------------

describe('computeBandPhaseFeatures', () => {
  it('should throw on wrong-length input', () => {
    assert.throws(() => computeBandPhaseFeatures([1, 2, 3]), /Expected 51/);
  });

  it('should return all zeros for all-zero phase diffs', () => {
    const diffs = new Array(NUM_PHASE_DIFFS).fill(0);
    const result = computeBandPhaseFeatures(diffs);

    assert.equal(result.bandPhaseMeans.length, 8);
    assert.equal(result.bandPhaseStds.length, 8);
    assert.equal(result.bandPhaseRanges.length, 8);

    for (let b = 0; b < 8; b++) {
      assert.ok(Math.abs(result.bandPhaseMeans[b]) < 1e-10);
      assert.ok(Math.abs(result.bandPhaseStds[b]) < 1e-10);
      assert.ok(Math.abs(result.bandPhaseRanges[b]) < 1e-10);
    }
    assert.ok(Math.abs(result.overallPhaseStd) < 1e-10);
    assert.ok(Math.abs(result.interBandPhaseVar) < 1e-10);
  });

  it('should detect varying phase across bands', () => {
    // Create diffs that are larger in edge bands than center bands
    const diffs = new Array(NUM_PHASE_DIFFS).fill(0);
    // Band 0 (indices 0-4): large diffs
    for (let k = 0; k < 5; k++) diffs[k] = 0.5;
    // Band 7 (indices 46-50): large diffs
    for (let k = 45; k < 51; k++) diffs[k] = -0.5;

    const result = computeBandPhaseFeatures(diffs);

    // Edge bands should have nonzero means
    assert.ok(Math.abs(result.bandPhaseMeans[0]) > 0.1,
      'Band 0 mean should be nonzero');
    assert.ok(Math.abs(result.bandPhaseMeans[7]) > 0.1,
      'Band 7 mean should be nonzero');
    // Inter-band variance should be > 0
    assert.ok(result.interBandPhaseVar > 0, 'Inter-band variance should be nonzero');
  });

  it('should handle NaN values gracefully', () => {
    const diffs = new Array(NUM_PHASE_DIFFS).fill(NaN);
    // Make band 3 (indices 20-24) valid
    for (let k = 20; k < 25; k++) diffs[k] = 0.2;

    const result = computeBandPhaseFeatures(diffs);

    // Band 3 should have valid mean, others should be 0
    assert.ok(Math.abs(result.bandPhaseMeans[3] - 0.2) < 1e-10);
    assert.ok(Math.abs(result.bandPhaseMeans[0]) < 1e-10);
  });
});

// ---------------------------------------------------------------------------
// Tests: extractPhaseFeatures (full pipeline)
// ---------------------------------------------------------------------------

describe('extractPhaseFeatures', () => {
  it('should throw on invalid payload', () => {
    assert.throws(() => extractPhaseFeatures(null), /Invalid CSI payload/);
  });

  it('should return complete feature set for valid CSI data', () => {
    const samples = makeLinearPhaseSamples(50, 0.0, 0.05);
    const buf = makeCSIBuffer(samples);
    const result = extractPhaseFeatures(buf);

    // Check structure
    assert.equal(result.phaseDiffs.length, NUM_PHASE_DIFFS);
    assert.equal(result.unwrappedPhases.length, NUM_SUBCARRIERS);
    assert.ok(result.linearFit);
    assert.ok(result.linearFit.residuals.length === NUM_SUBCARRIERS);
    assert.ok(result.bandFeatures);
    assert.equal(result.bandFeatures.bandPhaseMeans.length, 8);
    assert.ok(result.quality);
    assert.equal(result.quality.totalSubcarriers, NUM_SUBCARRIERS);
    assert.ok(result.quality.validFraction > 0);
  });

  it('should detect near-linear phase with low residuals', () => {
    // Create data with near-linear phase → residuals should be small
    const samples = makeLinearPhaseSamples(80, 0.1, 0.02);
    const buf = makeCSIBuffer(samples);
    const result = extractPhaseFeatures(buf);

    // Residual std should be relatively small (some quantization error expected)
    assert.ok(result.linearFit.residualStd < 0.5,
      `Residual std should be small for linear phase, got ${result.linearFit.residualStd}`);
  });

  it('should handle all-zero I/Q data (all NaN phases)', () => {
    const buf = Buffer.alloc(NUM_SUBCARRIERS * 2); // All zeros
    const result = extractPhaseFeatures(buf);

    assert.equal(result.quality.validSubcarriers, 0);
    assert.equal(result.quality.validFraction, 0);
    assert.equal(result.linearFit.validCount, 0);
  });
});
