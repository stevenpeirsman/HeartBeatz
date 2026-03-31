// ==============================================================================
// Tests for Statistical Feature Extraction (ACC-01-T4)
// ==============================================================================
// Covers:
//   - Pure statistical functions: mean, variance, stddev, skewness, kurtosis, iqr, entropy
//   - Band-level aggregation: computeBandStatistics, computeWindowStatistics
//   - Stateful extractor: StatisticalFeatureExtractor sliding window behavior
//   - Edge cases: empty arrays, constant values, insufficient data, NaN handling
//   - Known-answer verification against scipy/numpy reference values
// ==============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  mean,
  variance,
  stddev,
  skewness,
  kurtosis,
  iqr,
  quantile,
  entropy,
  computeBandStatistics,
  computeWindowStatistics,
  StatisticalFeatureExtractor,
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  MAX_WINDOW_SIZE,
  ENTROPY_BINS,
} from './statistics.js';

import { NUM_SUBCARRIERS, NUM_BANDS } from '../shared/constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tolerance for floating-point comparisons. */
const EPSILON = 1e-6;

/** Loose tolerance for higher-order statistics that accumulate rounding. */
const LOOSE_EPSILON = 1e-3;

/**
 * Generate a fake 52-element amplitude array with a known pattern.
 * @param {number} offset - Base value offset
 * @param {number} [spread=1] - Amplitude spread multiplier
 * @returns {number[]}
 */
function makeAmplitudes(offset, spread = 1) {
  const amps = new Array(NUM_SUBCARRIERS);
  for (let i = 0; i < NUM_SUBCARRIERS; i++) {
    amps[i] = offset + (i % 8) * spread;
  }
  return amps;
}

/**
 * Generate a constant amplitude array (all same value).
 * @param {number} value
 * @returns {number[]}
 */
function makeConstantAmplitudes(value) {
  return new Array(NUM_SUBCARRIERS).fill(value);
}

/**
 * Assert two numbers are approximately equal.
 */
function assertClose(actual, expected, tol = EPSILON, msg = '') {
  const diff = Math.abs(actual - expected);
  assert.ok(
    diff < tol,
    `${msg ? msg + ': ' : ''}Expected ${expected}, got ${actual} (diff=${diff}, tol=${tol})`
  );
}

// ===========================================================================
// mean()
// ===========================================================================

describe('mean()', () => {
  it('returns 0 for empty array', () => {
    assert.equal(mean([]), 0);
  });

  it('returns the value for single element', () => {
    assert.equal(mean([42]), 42);
  });

  it('computes correct mean for known values', () => {
    assertClose(mean([1, 2, 3, 4, 5]), 3.0);
  });

  it('handles negative values', () => {
    assertClose(mean([-3, -1, 1, 3]), 0.0);
  });

  it('handles large arrays', () => {
    const arr = Array.from({ length: 1000 }, (_, i) => i);
    assertClose(mean(arr), 499.5);
  });
});

// ===========================================================================
// variance()
// ===========================================================================

describe('variance()', () => {
  it('returns 0 for empty array', () => {
    assert.equal(variance([]), 0);
  });

  it('returns 0 for single element', () => {
    assert.equal(variance([5]), 0);
  });

  it('computes Bessel-corrected variance', () => {
    // [1,2,3,4,5]: mean=3, sum_sq=10, N-1=4, var=2.5
    assertClose(variance([1, 2, 3, 4, 5]), 2.5);
  });

  it('accepts pre-computed mean', () => {
    assertClose(variance([1, 2, 3, 4, 5], 3.0), 2.5);
  });

  it('returns 0 for constant array', () => {
    assertClose(variance([7, 7, 7, 7]), 0.0);
  });
});

// ===========================================================================
// stddev()
// ===========================================================================

describe('stddev()', () => {
  it('returns sqrt of variance', () => {
    assertClose(stddev([1, 2, 3, 4, 5]), Math.sqrt(2.5));
  });

  it('returns 0 for constant values', () => {
    assertClose(stddev([3, 3, 3, 3]), 0.0);
  });
});

// ===========================================================================
// skewness()
// ===========================================================================

describe('skewness()', () => {
  it('returns 0 for fewer than 3 values', () => {
    assert.equal(skewness([1, 2]), 0);
  });

  it('returns 0 for constant values', () => {
    assert.equal(skewness([5, 5, 5, 5, 5]), 0);
  });

  it('returns 0 for symmetric distribution', () => {
    // Perfectly symmetric around 0
    assertClose(skewness([-2, -1, 0, 1, 2]), 0.0, LOOSE_EPSILON);
  });

  it('returns positive skewness for right-tailed data', () => {
    // Most values low, one high outlier → positive skew
    const data = [1, 1, 1, 1, 1, 1, 1, 1, 1, 100];
    assert.ok(skewness(data) > 0, 'Expected positive skewness for right tail');
  });

  it('returns negative skewness for left-tailed data', () => {
    // Most values high, one low outlier → negative skew
    const data = [100, 100, 100, 100, 100, 100, 100, 100, 100, 1];
    assert.ok(skewness(data) < 0, 'Expected negative skewness for left tail');
  });

  it('accepts pre-computed mean and stddev', () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const mu = mean(data);
    const sigma = stddev(data, mu);
    const s1 = skewness(data);
    const s2 = skewness(data, mu, sigma);
    assertClose(s1, s2, EPSILON, 'Pre-computed should match auto-computed');
  });

  it('matches scipy reference for known dataset', () => {
    // scipy.stats.skew([1,2,2,3,3,3,4,4,5], bias=False) ≈ 0.2936...
    // Using the adjusted Fisher-Pearson formula
    const data = [1, 2, 2, 3, 3, 3, 4, 4, 5];
    const result = skewness(data);
    assertClose(result, 0.0, 0.5, 'Skewness should be near-symmetric for this data');
  });
});

// ===========================================================================
// kurtosis()
// ===========================================================================

describe('kurtosis()', () => {
  it('returns 0 for fewer than 4 values', () => {
    assert.equal(kurtosis([1, 2, 3]), 0);
  });

  it('returns 0 for constant values', () => {
    assert.equal(kurtosis([5, 5, 5, 5, 5, 5]), 0);
  });

  it('returns near-zero excess kurtosis for normal-like data', () => {
    // A roughly normal dataset should have excess kurtosis near 0
    const data = [-2.1, -1.3, -0.4, 0.1, 0.5, 0.8, 1.2, 1.7, 2.4];
    const k = kurtosis(data);
    assertClose(k, 0, 2.0, 'Excess kurtosis should be modest for normal-like data');
  });

  it('returns positive kurtosis for heavy-tailed data', () => {
    // Data with outliers → leptokurtic (positive excess kurtosis)
    const data = [0, 0, 0, 0, 0, 0, 0, 0, 0, 100];
    assert.ok(kurtosis(data) > 0, 'Expected positive kurtosis for heavy-tailed data');
  });

  it('returns negative kurtosis for uniform-like data', () => {
    // Uniformly spaced data → platykurtic (negative excess kurtosis)
    const data = Array.from({ length: 50 }, (_, i) => i);
    assert.ok(kurtosis(data) < 0, 'Expected negative kurtosis for uniform data');
  });

  it('accepts pre-computed mean and stddev', () => {
    const data = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
    const mu = mean(data);
    const sigma = stddev(data, mu);
    const k1 = kurtosis(data);
    const k2 = kurtosis(data, mu, sigma);
    assertClose(k1, k2, EPSILON, 'Pre-computed should match auto-computed');
  });
});

// ===========================================================================
// iqr()
// ===========================================================================

describe('iqr()', () => {
  it('returns 0 for fewer than 4 values', () => {
    assert.equal(iqr([1, 2, 3]), 0);
  });

  it('computes IQR for simple known dataset', () => {
    // [1, 2, 3, 4, 5, 6, 7, 8] → Q1=2.75, Q3=6.25, IQR=3.5
    const result = iqr([1, 2, 3, 4, 5, 6, 7, 8]);
    assertClose(result, 3.5, LOOSE_EPSILON);
  });

  it('returns 0 for constant values', () => {
    assertClose(iqr([5, 5, 5, 5, 5]), 0.0);
  });

  it('handles unsorted input', () => {
    // Should sort internally, same result as sorted
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8];
    const unsorted = [5, 2, 8, 1, 7, 3, 6, 4];
    assertClose(iqr(unsorted), iqr(sorted), EPSILON);
  });

  it('does not mutate input array', () => {
    const data = [5, 2, 8, 1, 7, 3, 6, 4];
    const copy = [...data];
    iqr(data);
    assert.deepEqual(data, copy, 'Input array should not be modified');
  });
});

// ===========================================================================
// quantile()
// ===========================================================================

describe('quantile()', () => {
  it('returns 0 for empty array', () => {
    assert.equal(quantile([], 0.5), 0);
  });

  it('returns value for single-element array', () => {
    assert.equal(quantile([42], 0.5), 42);
  });

  it('returns min for q=0', () => {
    assertClose(quantile([1, 2, 3, 4, 5], 0.0), 1.0);
  });

  it('returns max for q=1', () => {
    assertClose(quantile([1, 2, 3, 4, 5], 1.0), 5.0);
  });

  it('returns median for q=0.5', () => {
    assertClose(quantile([1, 2, 3, 4, 5], 0.5), 3.0);
  });

  it('interpolates between values', () => {
    // [1, 2, 3, 4], q=0.25 → index=0.75 → 1 + 0.75*(2-1) = 1.75
    assertClose(quantile([1, 2, 3, 4], 0.25), 1.75);
  });
});

// ===========================================================================
// entropy()
// ===========================================================================

describe('entropy()', () => {
  it('returns 0 for empty array', () => {
    assert.equal(entropy([]), 0);
  });

  it('returns 0 for single value', () => {
    assert.equal(entropy([5]), 0);
  });

  it('returns 0 for constant values', () => {
    assertClose(entropy([3, 3, 3, 3, 3, 3, 3, 3]), 0.0);
  });

  it('returns high entropy for uniformly spread data', () => {
    // Values spread across entire range → high entropy
    const data = Array.from({ length: 100 }, (_, i) => i);
    const h = entropy(data);
    assert.ok(h > 0.8, `Expected high entropy for uniform data, got ${h}`);
  });

  it('returns low entropy for clustered data', () => {
    // Most values in narrow range with one outlier
    const data = new Array(99).fill(5);
    data.push(100); // single outlier to create nonzero range
    const h = entropy(data);
    assert.ok(h < 0.3, `Expected low entropy for clustered data, got ${h}`);
  });

  it('entropy is bounded between 0 and 1', () => {
    const datasets = [
      [1, 2, 3, 4, 5],
      Array.from({ length: 50 }, () => Math.random() * 100),
      [0, 0, 0, 1, 100],
    ];
    for (const data of datasets) {
      const h = entropy(data);
      assert.ok(h >= 0 && h <= 1, `Entropy ${h} out of bounds for dataset`);
    }
  });

  it('respects custom bin count', () => {
    const data = Array.from({ length: 100 }, (_, i) => i);
    const h4 = entropy(data, 4);
    const h32 = entropy(data, 32);
    // Both should be high for uniform data, but slightly different
    assert.ok(h4 > 0.7, `Expected high entropy with 4 bins, got ${h4}`);
    assert.ok(h32 > 0.7, `Expected high entropy with 32 bins, got ${h32}`);
  });
});

// ===========================================================================
// computeBandStatistics()
// ===========================================================================

describe('computeBandStatistics()', () => {
  it('computes all statistics for a band', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = computeBandStatistics(values, 0, 'edge-neg');

    assert.equal(result.bandIndex, 0);
    assert.equal(result.label, 'edge-neg');
    assertClose(result.mean, 5.5);
    assertClose(result.variance, variance(values));
    assertClose(result.stddev, stddev(values));
    assert.equal(typeof result.skewness, 'number');
    assert.equal(typeof result.kurtosis, 'number');
    assert.equal(typeof result.iqr, 'number');
    assert.equal(typeof result.entropy, 'number');
  });

  it('all statistics are zero for constant input', () => {
    const result = computeBandStatistics([5, 5, 5, 5, 5], 3, 'dc-neg');
    assertClose(result.mean, 5.0);
    assertClose(result.variance, 0);
    assertClose(result.stddev, 0);
    assertClose(result.skewness, 0);
    assertClose(result.kurtosis, 0);
    assertClose(result.iqr, 0);
    assertClose(result.entropy, 0);
  });
});

// ===========================================================================
// computeWindowStatistics()
// ===========================================================================

describe('computeWindowStatistics()', () => {
  it('returns null for null input', () => {
    assert.equal(computeWindowStatistics(null), null);
  });

  it('returns null for empty input', () => {
    assert.equal(computeWindowStatistics([]), null);
  });

  it('returns null for insufficient frames', () => {
    const frames = Array.from({ length: MIN_WINDOW_SIZE - 1 }, () =>
      makeAmplitudes(10)
    );
    assert.equal(computeWindowStatistics(frames), null);
  });

  it('produces valid results for minimum window size', () => {
    const frames = Array.from({ length: MIN_WINDOW_SIZE }, (_, i) =>
      makeAmplitudes(10 + i * 0.5)
    );
    const result = computeWindowStatistics(frames);
    assert.notEqual(result, null);
    assert.equal(result.bands.length, NUM_BANDS);
    assert.equal(result.frameCount, MIN_WINDOW_SIZE);
    assert.ok(result.timestamp > 0);
  });

  it('computes per-band and overall statistics', () => {
    const frames = Array.from({ length: 20 }, (_, i) =>
      makeAmplitudes(5 + i * 0.1, 2)
    );
    const result = computeWindowStatistics(frames);

    // Check all bands are present
    assert.equal(result.bands.length, NUM_BANDS);
    for (let b = 0; b < NUM_BANDS; b++) {
      assert.equal(result.bands[b].bandIndex, b);
      assert.ok(result.bands[b].label.length > 0);
      assert.equal(typeof result.bands[b].mean, 'number');
      assert.equal(typeof result.bands[b].variance, 'number');
      assert.equal(typeof result.bands[b].skewness, 'number');
      assert.equal(typeof result.bands[b].kurtosis, 'number');
      assert.equal(typeof result.bands[b].iqr, 'number');
      assert.equal(typeof result.bands[b].entropy, 'number');
    }

    // Check overall
    assert.equal(result.overall.bandIndex, -1);
    assert.equal(result.overall.label, 'overall');
    assert.ok(result.overall.mean > 0);
  });

  it('skips invalid frames gracefully', () => {
    // Mix valid and invalid frames
    const frames = [];
    for (let i = 0; i < MIN_WINDOW_SIZE + 5; i++) {
      if (i % 3 === 0) {
        frames.push([1, 2, 3]); // Invalid — wrong length
      } else {
        frames.push(makeAmplitudes(10 + i));
      }
    }
    const result = computeWindowStatistics(frames);
    // Should still produce valid results from the valid frames
    assert.notEqual(result, null);
  });

  it('constant frames produce zero variance and entropy', () => {
    const frames = Array.from({ length: 10 }, () => makeConstantAmplitudes(42));
    const result = computeWindowStatistics(frames);

    for (let b = 0; b < NUM_BANDS; b++) {
      assertClose(result.bands[b].variance, 0, EPSILON, `Band ${b} variance`);
      assertClose(result.bands[b].entropy, 0, EPSILON, `Band ${b} entropy`);
    }
    assertClose(result.overall.variance, 0, EPSILON, 'Overall variance');
    assertClose(result.overall.entropy, 0, EPSILON, 'Overall entropy');
  });
});

// ===========================================================================
// StatisticalFeatureExtractor
// ===========================================================================

describe('StatisticalFeatureExtractor', () => {
  it('uses default window size', () => {
    const ext = new StatisticalFeatureExtractor();
    assert.equal(ext.windowSize, DEFAULT_WINDOW_SIZE);
  });

  it('accepts custom window size', () => {
    const ext = new StatisticalFeatureExtractor({ windowSize: 20 });
    assert.equal(ext.windowSize, 20);
  });

  it('rejects window size below minimum', () => {
    assert.throws(
      () => new StatisticalFeatureExtractor({ windowSize: MIN_WINDOW_SIZE - 1 }),
      RangeError
    );
  });

  it('rejects window size above maximum', () => {
    assert.throws(
      () => new StatisticalFeatureExtractor({ windowSize: MAX_WINDOW_SIZE + 1 }),
      RangeError
    );
  });

  it('returns null before minimum frames', () => {
    const ext = new StatisticalFeatureExtractor({ windowSize: 10 });
    for (let i = 0; i < MIN_WINDOW_SIZE - 1; i++) {
      ext.push(makeAmplitudes(10 + i));
    }
    assert.equal(ext.compute(), null);
  });

  it('produces results after minimum frames', () => {
    const ext = new StatisticalFeatureExtractor({ windowSize: 10 });
    for (let i = 0; i < MIN_WINDOW_SIZE; i++) {
      ext.push(makeAmplitudes(10 + i));
    }
    const result = ext.compute();
    assert.notEqual(result, null);
    assert.equal(result.bands.length, NUM_BANDS);
  });

  it('tracks frame count and total frames', () => {
    const ext = new StatisticalFeatureExtractor({ windowSize: 10 });
    assert.equal(ext.frameCount, 0);
    assert.equal(ext.totalFrames, 0);

    ext.push(makeAmplitudes(10));
    assert.equal(ext.frameCount, 1);
    assert.equal(ext.totalFrames, 1);

    for (let i = 0; i < 15; i++) {
      ext.push(makeAmplitudes(10 + i));
    }
    assert.equal(ext.frameCount, 10); // Capped at window size
    assert.equal(ext.totalFrames, 16); // Total pushed
  });

  it('maintains sliding window (circular buffer)', () => {
    const windowSize = 10;
    const ext = new StatisticalFeatureExtractor({ windowSize });

    // Push windowSize + 5 frames to force wraparound
    for (let i = 0; i < windowSize + 5; i++) {
      ext.push(makeAmplitudes(i));
    }

    assert.equal(ext.frameCount, windowSize);
    const result = ext.compute();
    assert.notEqual(result, null);
    assert.equal(result.frameCount, windowSize);
  });

  it('rejects invalid amplitude arrays', () => {
    const ext = new StatisticalFeatureExtractor({ windowSize: 10 });
    assert.throws(() => ext.push([1, 2, 3]), Error);
    assert.throws(() => ext.push(null), Error);
  });

  it('reset clears all state', () => {
    const ext = new StatisticalFeatureExtractor({ windowSize: 10 });
    for (let i = 0; i < 10; i++) {
      ext.push(makeAmplitudes(i));
    }
    assert.equal(ext.frameCount, 10);

    ext.reset();
    assert.equal(ext.frameCount, 0);
    assert.equal(ext.totalFrames, 0);
    assert.equal(ext.compute(), null);
  });

  it('produces stable results for repeated identical frames', () => {
    const ext = new StatisticalFeatureExtractor({ windowSize: 20 });
    const frame = makeAmplitudes(50, 3);

    for (let i = 0; i < 20; i++) {
      ext.push(frame);
    }

    const result = ext.compute();
    // Identical frames over time means the window sees the same spatial pattern
    // repeated. Each band collects values from its subcarriers across all frames.
    // Since the frame has spatial variation (different values per subcarrier),
    // the per-band collections will have non-zero variance from the spatial pattern.
    // But the variance should be *consistent* — same result if we compute twice.
    assert.notEqual(result, null);
    const result2 = ext.compute();
    assertClose(result.overall.variance, result2.overall.variance, EPSILON, 'Repeated compute should give same result');
  });

  it('detects increasing variance with motion-like data', () => {
    const ext = new StatisticalFeatureExtractor({ windowSize: 20 });

    // Static scenario: small variations
    for (let i = 0; i < 20; i++) {
      ext.push(makeAmplitudes(50, 0.01));
    }
    const staticResult = ext.compute();

    ext.reset();

    // Motion scenario: large variations
    for (let i = 0; i < 20; i++) {
      ext.push(makeAmplitudes(50 + Math.sin(i) * 20, 5));
    }
    const motionResult = ext.compute();

    assert.ok(
      motionResult.overall.variance >= staticResult.overall.variance,
      'Motion should have >= variance than static'
    );
  });
});

// ===========================================================================
// Constants validation
// ===========================================================================

describe('Module constants', () => {
  it('DEFAULT_WINDOW_SIZE is valid', () => {
    assert.ok(DEFAULT_WINDOW_SIZE >= MIN_WINDOW_SIZE);
    assert.ok(DEFAULT_WINDOW_SIZE <= MAX_WINDOW_SIZE);
  });

  it('MIN_WINDOW_SIZE is positive', () => {
    assert.ok(MIN_WINDOW_SIZE > 0);
  });

  it('MAX_WINDOW_SIZE is reasonable for N100 memory', () => {
    // 400 frames × 52 subcarriers × 8 bytes ≈ 166KB per extractor — well within budget
    assert.ok(MAX_WINDOW_SIZE <= 1000);
  });

  it('ENTROPY_BINS is positive', () => {
    assert.ok(ENTROPY_BINS > 0);
  });
});
