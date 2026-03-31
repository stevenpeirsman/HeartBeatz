// ==============================================================================
// Tests for features/correlation.js — Subcarrier Correlation Matrix (ACC-01-T5)
// ==============================================================================
// Covers:
//   - Band mean extraction: computeBandMeans
//   - Covariance matrix: computeCovarianceMatrix
//   - Correlation normalization: covarianceToCorrelation
//   - Eigenvalue analysis: dominantEigenvalue, estimateSmallestEigenvalue
//   - Eigenvalue spread: computeEigenvalueSpread
//   - Full pipeline: computeCorrelationFeatures
//   - Stateful analyzer: CorrelationAnalyzer circular buffer
//   - Edge cases: constant data, insufficient frames, zero-variance bands
// ==============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeBandMeans,
  computeCovarianceMatrix,
  covarianceToCorrelation,
  dominantEigenvalue,
  estimateSmallestEigenvalue,
  computeEigenvalueSpread,
  computeCorrelationFeatures,
  CorrelationAnalyzer,
  DEFAULT_CORR_WINDOW,
  MIN_CORR_WINDOW,
  MAX_CORR_WINDOW,
} from './correlation.js';

import { NUM_SUBCARRIERS, NUM_BANDS, SUBCARRIER_BANDS } from '../shared/constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EPSILON = 1e-6;
const LOOSE_EPSILON = 1e-3;

function assertClose(actual, expected, tol = EPSILON, msg = '') {
  const diff = Math.abs(actual - expected);
  assert.ok(
    diff < tol,
    `${msg ? msg + ': ' : ''}Expected ~${expected}, got ${actual} (diff=${diff})`
  );
}

function makeAmplitudes(fillValue, bandOverrides = {}) {
  const amps = new Array(NUM_SUBCARRIERS).fill(fillValue);
  for (const [bandIdx, value] of Object.entries(bandOverrides)) {
    const { start, end } = SUBCARRIER_BANDS[parseInt(bandIdx)];
    for (let i = start; i < end; i++) amps[i] = value;
  }
  return amps;
}

function makeWindow(count, generator) {
  const gen = generator || (() => makeAmplitudes(10));
  return Array.from({ length: count }, (_, i) => gen(i));
}

function makeIdentityMatrix(scale = 1) {
  return Array.from({ length: NUM_BANDS }, (_, i) => {
    const row = new Array(NUM_BANDS).fill(0);
    row[i] = scale;
    return row;
  });
}

// ===========================================================================
// computeBandMeans()
// ===========================================================================

describe('computeBandMeans()', () => {
  it('returns NUM_BANDS means', () => {
    const result = computeBandMeans(makeAmplitudes(10));
    assert.equal(result.length, NUM_BANDS);
  });

  it('returns uniform means for constant amplitudes', () => {
    const result = computeBandMeans(makeAmplitudes(42));
    for (let b = 0; b < NUM_BANDS; b++) {
      assertClose(result[b], 42, EPSILON, `Band ${b}`);
    }
  });

  it('detects per-band differences', () => {
    const amps = makeAmplitudes(10, { 0: 100 });
    const result = computeBandMeans(amps);
    assert.ok(result[0] > 50, `Band 0 should be high, got ${result[0]}`);
    assertClose(result[1], 10, EPSILON, 'Band 1 should stay at 10');
  });

  it('handles all-zero amplitudes', () => {
    const result = computeBandMeans(makeAmplitudes(0));
    for (let b = 0; b < NUM_BANDS; b++) {
      assertClose(result[b], 0, EPSILON);
    }
  });
});

// ===========================================================================
// computeCovarianceMatrix()
// ===========================================================================

describe('computeCovarianceMatrix()', () => {
  it('returns null for insufficient data', () => {
    const window = Array.from({ length: MIN_CORR_WINDOW - 1 }, () =>
      new Array(NUM_BANDS).fill(10)
    );
    assert.equal(computeCovarianceMatrix(window), null);
  });

  it('returns zero covariance for constant data', () => {
    const window = Array.from({ length: 20 }, () =>
      new Array(NUM_BANDS).fill(10)
    );
    const result = computeCovarianceMatrix(window);
    assert.notEqual(result, null);
    for (let i = 0; i < NUM_BANDS; i++) {
      for (let j = 0; j < NUM_BANDS; j++) {
        assertClose(result.matrix[i][j], 0, EPSILON, `cov[${i}][${j}]`);
      }
    }
  });

  it('produces symmetric matrix', () => {
    const window = Array.from({ length: 20 }, (_, t) => {
      const row = new Array(NUM_BANDS);
      for (let b = 0; b < NUM_BANDS; b++) {
        row[b] = 10 + t * (b + 1) * 0.5;
      }
      return row;
    });
    const result = computeCovarianceMatrix(window);
    for (let i = 0; i < NUM_BANDS; i++) {
      for (let j = 0; j < NUM_BANDS; j++) {
        assertClose(result.matrix[i][j], result.matrix[j][i], EPSILON,
          `Symmetry: cov[${i}][${j}] vs cov[${j}][${i}]`);
      }
    }
  });

  it('diagonal entries are non-negative', () => {
    const window = Array.from({ length: 20 }, (_, t) => {
      const row = new Array(NUM_BANDS);
      for (let b = 0; b < NUM_BANDS; b++) {
        row[b] = Math.sin(t * (b + 1) * 0.3) * 10 + 50;
      }
      return row;
    });
    const result = computeCovarianceMatrix(window);
    for (let i = 0; i < NUM_BANDS; i++) {
      assert.ok(result.matrix[i][i] >= -EPSILON,
        `Variance of band ${i} should be non-negative, got ${result.matrix[i][i]}`);
    }
  });

  it('computes correct means', () => {
    const window = Array.from({ length: 20 }, () => new Array(NUM_BANDS).fill(25));
    const result = computeCovarianceMatrix(window);
    for (let b = 0; b < NUM_BANDS; b++) {
      assertClose(result.means[b], 25, EPSILON, `Mean of band ${b}`);
    }
  });
});

// ===========================================================================
// covarianceToCorrelation()
// ===========================================================================

describe('covarianceToCorrelation()', () => {
  it('diagonal is always 1', () => {
    const covMatrix = Array.from({ length: NUM_BANDS }, (_, i) => {
      const row = new Array(NUM_BANDS).fill(0.5);
      row[i] = 4;
      return row;
    });
    const corr = covarianceToCorrelation(covMatrix);
    for (let i = 0; i < NUM_BANDS; i++) {
      assertClose(corr[i][i], 1.0, EPSILON, `Diagonal [${i}][${i}]`);
    }
  });

  it('correlation values bounded [-1, 1]', () => {
    const window = Array.from({ length: 30 }, (_, t) => {
      const row = new Array(NUM_BANDS);
      for (let b = 0; b < NUM_BANDS; b++) {
        row[b] = Math.sin(t * (b + 1) * 0.2) * 5 + 50;
      }
      return row;
    });
    const covResult = computeCovarianceMatrix(window);
    const corr = covarianceToCorrelation(covResult.matrix);
    for (let i = 0; i < NUM_BANDS; i++) {
      for (let j = 0; j < NUM_BANDS; j++) {
        assert.ok(corr[i][j] >= -1 - EPSILON && corr[i][j] <= 1 + EPSILON,
          `corr[${i}][${j}] = ${corr[i][j]} out of [-1,1]`);
      }
    }
  });

  it('handles zero-variance bands', () => {
    const covMatrix = Array.from({ length: NUM_BANDS }, (_, i) => {
      const row = new Array(NUM_BANDS).fill(0);
      row[i] = i === 0 ? 0 : 1;
      return row;
    });
    const corr = covarianceToCorrelation(covMatrix);
    assertClose(corr[0][0], 1.0, EPSILON);
    for (let j = 1; j < NUM_BANDS; j++) {
      assertClose(corr[0][j], 0, EPSILON, `corr[0][${j}] for zero-var band`);
    }
  });
});

// ===========================================================================
// dominantEigenvalue()
// ===========================================================================

describe('dominantEigenvalue()', () => {
  it('returns 0 for empty matrix', () => {
    const result = dominantEigenvalue([]);
    assert.equal(result.value, 0);
  });

  it('returns the value for 1x1 matrix', () => {
    const result = dominantEigenvalue([[5]]);
    assertClose(result.value, 5);
  });

  it('finds eigenvalue of identity matrix', () => {
    const identity = makeIdentityMatrix(1);
    const result = dominantEigenvalue(identity);
    assertClose(result.value, 1, LOOSE_EPSILON);
  });

  it('finds eigenvalue of scaled identity', () => {
    const scaled = makeIdentityMatrix(7);
    const result = dominantEigenvalue(scaled);
    assertClose(result.value, 7, LOOSE_EPSILON);
  });

  it('finds dominant eigenvalue of known 2x2', () => {
    // [[2, 1], [1, 2]]: eigenvalues 3 and 1
    const result = dominantEigenvalue([[2, 1], [1, 2]]);
    assertClose(result.value, 3, LOOSE_EPSILON);
  });

  it('returns eigenvector of correct length', () => {
    const result = dominantEigenvalue(makeIdentityMatrix(1));
    assert.equal(result.vector.length, NUM_BANDS);
  });

  it('handles zero matrix', () => {
    const zero = Array.from({ length: 4 }, () => new Array(4).fill(0));
    const result = dominantEigenvalue(zero);
    assertClose(result.value, 0, EPSILON);
  });
});

// ===========================================================================
// estimateSmallestEigenvalue()
// ===========================================================================

describe('estimateSmallestEigenvalue()', () => {
  it('returns dominant for 1x1', () => {
    assertClose(estimateSmallestEigenvalue([[5]], 5, [1]), 5);
  });

  it('returns non-negative', () => {
    const result = estimateSmallestEigenvalue(
      makeIdentityMatrix(3), 3, [1, 0, 0, 0, 0, 0, 0, 0]
    );
    assert.ok(result >= 0);
  });

  it('estimates correctly for identity', () => {
    // All eigenvalues = 1, remaining avg = (8-1)/7 = 1
    const result = estimateSmallestEigenvalue(
      makeIdentityMatrix(1), 1, [1, 0, 0, 0, 0, 0, 0, 0]
    );
    assertClose(result, 1, LOOSE_EPSILON);
  });
});

// ===========================================================================
// computeEigenvalueSpread()
// ===========================================================================

describe('computeEigenvalueSpread()', () => {
  it('returns spread=1 for zero matrix', () => {
    const zero = Array.from({ length: NUM_BANDS }, () => new Array(NUM_BANDS).fill(0));
    assertClose(computeEigenvalueSpread(zero).spread, 1.0);
  });

  it('returns spread=1 for identity (all eigenvalues equal)', () => {
    assertClose(computeEigenvalueSpread(makeIdentityMatrix(1)).spread, 1.0, LOOSE_EPSILON);
  });

  it('returns high spread for rank-1 matrix', () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8];
    const matrix = Array.from({ length: NUM_BANDS }, (_, i) =>
      Array.from({ length: NUM_BANDS }, (_, j) => v[i] * v[j])
    );
    const result = computeEigenvalueSpread(matrix);
    assert.ok(result.spread > 10, `Rank-1 should have high spread, got ${result.spread}`);
  });
});

// ===========================================================================
// computeCorrelationFeatures()
// ===========================================================================

describe('computeCorrelationFeatures()', () => {
  it('returns null for null/empty/insufficient', () => {
    assert.equal(computeCorrelationFeatures(null), null);
    assert.equal(computeCorrelationFeatures([]), null);
    assert.equal(computeCorrelationFeatures(makeWindow(MIN_CORR_WINDOW - 1)), null);
  });

  it('returns valid result for min window', () => {
    const frames = makeWindow(MIN_CORR_WINDOW, (i) =>
      makeAmplitudes(10 + i * 2, { 0: 10 + i * 5 })
    );
    const result = computeCorrelationFeatures(frames);
    assert.notEqual(result, null);
    assert.equal(result.correlationMatrix.length, NUM_BANDS);
    assert.equal(typeof result.eigenvalueSpread, 'number');
    assert.equal(typeof result.meanCorrelation, 'number');
    assert.equal(typeof result.adjacentCorrelation, 'number');
    assert.equal(typeof result.edgeDcCorrelation, 'number');
    assert.equal(result.frameCount, MIN_CORR_WINDOW);
    assert.ok(result.timestamp > 0);
  });

  it('correlation diagonal is 1 or 0', () => {
    const frames = makeWindow(20, (i) => makeAmplitudes(10 + i * 0.5));
    const result = computeCorrelationFeatures(frames);
    for (let b = 0; b < NUM_BANDS; b++) {
      const d = result.correlationMatrix[b][b];
      assert.ok(Math.abs(d - 1.0) < EPSILON || Math.abs(d) < EPSILON,
        `Diag [${b}][${b}] = ${d}`);
    }
  });

  it('correlation values in [-1, 1]', () => {
    const frames = makeWindow(30, (i) =>
      makeAmplitudes(10 + Math.sin(i) * 5, { 0: 10 + i * 3 })
    );
    const result = computeCorrelationFeatures(frames);
    for (let i = 0; i < NUM_BANDS; i++) {
      for (let j = 0; j < NUM_BANDS; j++) {
        assert.ok(result.correlationMatrix[i][j] >= -1 - EPSILON &&
                  result.correlationMatrix[i][j] <= 1 + EPSILON);
      }
    }
  });

  it('min <= mean <= max correlations', () => {
    const frames = makeWindow(20, (i) =>
      makeAmplitudes(10 + i, { 0: 50 - i, 7: 50 + i })
    );
    const result = computeCorrelationFeatures(frames);
    assert.ok(result.minCorrelation <= result.meanCorrelation + EPSILON);
    assert.ok(result.meanCorrelation <= result.maxCorrelation + EPSILON);
  });

  it('eigenvalue spread is positive', () => {
    const frames = makeWindow(20, (i) =>
      makeAmplitudes(10 + i * 2, { 3: 10 + i * 10 })
    );
    const result = computeCorrelationFeatures(frames);
    assert.ok(result.eigenvalueSpread > 0);
  });

  it('adjacent and edgeDc correlations in [0, 1]', () => {
    const frames = makeWindow(20, (i) => makeAmplitudes(10 + i));
    const result = computeCorrelationFeatures(frames);
    assert.ok(result.adjacentCorrelation >= 0 && result.adjacentCorrelation <= 1);
    assert.ok(result.edgeDcCorrelation >= 0 && result.edgeDcCorrelation <= 1);
  });

  it('skips invalid frames', () => {
    const frames = [];
    for (let i = 0; i < MIN_CORR_WINDOW + 5; i++) {
      frames.push(i === 2 || i === 5 ? [1, 2, 3] : makeAmplitudes(10 + i));
    }
    assert.notEqual(computeCorrelationFeatures(frames), null);
  });

  it('constant frames give spread ≈ 1', () => {
    const frames = makeWindow(20, () => makeAmplitudes(42));
    const result = computeCorrelationFeatures(frames);
    assertClose(result.eigenvalueSpread, 1.0, LOOSE_EPSILON);
  });
});

// ===========================================================================
// CorrelationAnalyzer
// ===========================================================================

describe('CorrelationAnalyzer', () => {
  it('creates with defaults', () => {
    const a = new CorrelationAnalyzer();
    assert.equal(a.windowSize, DEFAULT_CORR_WINDOW);
    assert.equal(a.frameCount, 0);
    assert.equal(a.totalFrames, 0);
  });

  it('accepts custom window size', () => {
    assert.equal(new CorrelationAnalyzer({ windowSize: 20 }).windowSize, 20);
  });

  it('throws on invalid window size', () => {
    assert.throws(() => new CorrelationAnalyzer({ windowSize: MIN_CORR_WINDOW - 1 }), RangeError);
    assert.throws(() => new CorrelationAnalyzer({ windowSize: MAX_CORR_WINDOW + 1 }), RangeError);
  });

  it('rejects invalid amplitudes', () => {
    const a = new CorrelationAnalyzer();
    assert.throws(() => a.push([1, 2, 3]), Error);
    assert.throws(() => a.push(null), Error);
  });

  it('returns null before min frames', () => {
    const a = new CorrelationAnalyzer({ windowSize: 20 });
    for (let i = 0; i < MIN_CORR_WINDOW - 1; i++) a.push(makeAmplitudes(10 + i));
    assert.equal(a.compute(), null);
  });

  it('returns valid result after min frames', () => {
    const a = new CorrelationAnalyzer({ windowSize: 20 });
    for (let i = 0; i < MIN_CORR_WINDOW; i++) a.push(makeAmplitudes(10 + i * 2));
    const result = a.compute();
    assert.notEqual(result, null);
    assert.equal(result.correlationMatrix.length, NUM_BANDS);
  });

  it('tracks frame count and total', () => {
    const a = new CorrelationAnalyzer({ windowSize: 15 });
    for (let i = 0; i < 20; i++) a.push(makeAmplitudes(10 + i));
    assert.equal(a.frameCount, 15);
    assert.equal(a.totalFrames, 20);
  });

  it('circular buffer overwrites oldest', () => {
    const a = new CorrelationAnalyzer({ windowSize: 12 });
    for (let i = 0; i < 17; i++) a.push(makeAmplitudes(10));
    assert.equal(a.frameCount, 12);
    assert.equal(a.totalFrames, 17);
  });

  it('reset clears state', () => {
    const a = new CorrelationAnalyzer({ windowSize: 15 });
    for (let i = 0; i < 15; i++) a.push(makeAmplitudes(10 + i));
    assert.notEqual(a.compute(), null);
    a.reset();
    assert.equal(a.frameCount, 0);
    assert.equal(a.totalFrames, 0);
    assert.equal(a.compute(), null);
  });

  it('detects decorrelation from presence-like data', () => {
    const a = new CorrelationAnalyzer({ windowSize: 30 });

    // Static: all bands move together
    for (let i = 0; i < 30; i++) {
      a.push(makeAmplitudes(50 + Math.sin(i * 0.3) * 5));
    }
    const staticResult = a.compute();

    a.reset();

    // Occupied: bands move independently
    for (let i = 0; i < 30; i++) {
      const amps = new Array(NUM_SUBCARRIERS);
      for (let s = 0; s < NUM_SUBCARRIERS; s++) {
        amps[s] = 50 + Math.sin(i * 0.3 * (s % 8 + 1)) * 10;
      }
      a.push(amps);
    }
    const occupiedResult = a.compute();

    assert.notEqual(staticResult, null);
    assert.notEqual(occupiedResult, null);
    // Static room should have higher mean correlation
    assert.ok(
      staticResult.meanCorrelation >= occupiedResult.meanCorrelation - 0.1,
      `Static (${staticResult.meanCorrelation}) should be >= occupied (${occupiedResult.meanCorrelation})`
    );
  });
});

// ===========================================================================
// Constants
// ===========================================================================

describe('correlation/constants', () => {
  it('DEFAULT_CORR_WINDOW is valid', () => {
    assert.ok(DEFAULT_CORR_WINDOW >= MIN_CORR_WINDOW);
    assert.ok(DEFAULT_CORR_WINDOW <= MAX_CORR_WINDOW);
  });

  it('MIN < MAX', () => {
    assert.ok(MIN_CORR_WINDOW < MAX_CORR_WINDOW);
  });
});
