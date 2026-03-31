// ==============================================================================
// Statistical Feature Extraction
// ==============================================================================
// Implements ACC-01-T4: Compute statistical features over a sliding window of
// CSI amplitude frames. For each window, produces: mean, variance, kurtosis,
// skewness, IQR, and Shannon entropy per subcarrier band.
//
// These features capture the distributional shape of CSI amplitudes over time,
// which is critical for distinguishing presence patterns:
//   - Kurtosis: high values indicate sharp spikes (motion events)
//   - Skewness: asymmetry reveals whether amplitudes drift in one direction
//   - IQR: robust spread measure resistant to outliers
//   - Entropy: quantifies signal randomness (occupied rooms are more random)
//
// All core functions are pure — no side effects, no state mutation.
// The StatisticalFeatureExtractor class provides a stateful sliding window
// wrapper around the pure functions.
// ==============================================================================

import {
  NUM_SUBCARRIERS,
  NUM_BANDS,
  SUBCARRIER_BANDS,
} from '../shared/constants.js';

import { isValidAmplitudeArray } from '../shared/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default sliding window size in frames (~2s at 20 Hz). */
export const DEFAULT_WINDOW_SIZE = 40;

/** Minimum window size for meaningful higher-order statistics. */
export const MIN_WINDOW_SIZE = 8;

/** Maximum window size to bound memory usage on MeLE N100. */
export const MAX_WINDOW_SIZE = 400;

/**
 * Number of histogram bins for entropy calculation.
 * 16 bins balances resolution vs. sparse-bin noise for 6-7 samples per band.
 */
export const ENTROPY_BINS = 16;

/**
 * Small epsilon to avoid log(0) in entropy calculation.
 * @type {number}
 */
const LOG_EPSILON = 1e-12;

// ---------------------------------------------------------------------------
// Pure Statistical Functions
// ---------------------------------------------------------------------------

/**
 * Compute the arithmetic mean of a numeric array.
 *
 * @param {number[]} values - Input values
 * @returns {number} Mean, or 0 for empty input
 */
export function mean(values) {
  const n = values.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  return sum / n;
}

/**
 * Compute sample variance (Bessel-corrected, divides by N-1).
 *
 * @param {number[]} values - Input values
 * @param {number} [mu] - Optional pre-computed mean
 * @returns {number} Sample variance, or 0 if fewer than 2 values
 */
export function variance(values, mu) {
  const n = values.length;
  if (n < 2) return 0;
  const m = mu !== undefined ? mu : mean(values);
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i] - m;
    sumSq += d * d;
  }
  return sumSq / (n - 1);
}

/**
 * Compute sample standard deviation (sqrt of Bessel-corrected variance).
 *
 * @param {number[]} values - Input values
 * @param {number} [mu] - Optional pre-computed mean
 * @returns {number} Sample standard deviation
 */
export function stddev(values, mu) {
  return Math.sqrt(variance(values, mu));
}

/**
 * Compute sample skewness using the adjusted Fisher-Pearson coefficient.
 *
 * Skewness measures the asymmetry of the distribution:
 *   - Positive: tail extends to the right (occasional high spikes)
 *   - Negative: tail extends to the left
 *   - Zero: symmetric distribution
 *
 * Uses the bias-corrected formula: G1 = [n/((n-1)(n-2))] * sum((xi-mean)/std)^3
 * Requires at least 3 values for a meaningful result.
 *
 * @param {number[]} values - Input values
 * @param {number} [mu] - Optional pre-computed mean
 * @param {number} [sigma] - Optional pre-computed standard deviation
 * @returns {number} Sample skewness, or 0 if fewer than 3 values or zero variance
 */
export function skewness(values, mu, sigma) {
  const n = values.length;
  if (n < 3) return 0;
  const m = mu !== undefined ? mu : mean(values);
  const s = sigma !== undefined ? sigma : stddev(values, m);
  if (s < LOG_EPSILON) return 0; // All values identical

  let sumCubed = 0;
  for (let i = 0; i < n; i++) {
    const z = (values[i] - m) / s;
    sumCubed += z * z * z;
  }

  // Bias-corrected (adjusted Fisher-Pearson)
  const correction = n / ((n - 1) * (n - 2));
  return correction * sumCubed;
}

/**
 * Compute sample excess kurtosis using the bias-corrected formula.
 *
 * Kurtosis measures the "tailedness" of the distribution:
 *   - Positive (leptokurtic): heavy tails, sharp peak — intermittent spikes
 *   - Zero (mesokurtic): Gaussian-like tails
 *   - Negative (platykurtic): light tails, flat peak — bounded variation
 *
 * Uses the standard bias-corrected formula (Fisher's definition):
 *   G2 = [(n(n+1))/((n-1)(n-2)(n-3))] * sum((xi-mean)/std)^4
 *        - [3(n-1)^2]/[(n-2)(n-3)]
 * Requires at least 4 values.
 *
 * @param {number[]} values - Input values
 * @param {number} [mu] - Optional pre-computed mean
 * @param {number} [sigma] - Optional pre-computed standard deviation
 * @returns {number} Excess kurtosis, or 0 if fewer than 4 values or zero variance
 */
export function kurtosis(values, mu, sigma) {
  const n = values.length;
  if (n < 4) return 0;
  const m = mu !== undefined ? mu : mean(values);
  const s = sigma !== undefined ? sigma : stddev(values, m);
  if (s < LOG_EPSILON) return 0;

  let sumFourth = 0;
  for (let i = 0; i < n; i++) {
    const z = (values[i] - m) / s;
    const z2 = z * z;
    sumFourth += z2 * z2;
  }

  // Bias-corrected excess kurtosis
  const a = (n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3));
  const b = (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
  return a * sumFourth - b;
}

/**
 * Compute the interquartile range (IQR = Q3 - Q1) using linear interpolation.
 *
 * IQR is a robust measure of spread that ignores the top and bottom 25% of data,
 * making it resistant to outliers from WiFi interference spikes.
 *
 * Uses the linear interpolation method (numpy's default "linear" method):
 * For quantile q with sorted data of length n:
 *   index = q * (n - 1)
 *   lower = floor(index), upper = ceil(index)
 *   result = data[lower] + (index - lower) * (data[upper] - data[lower])
 *
 * @param {number[]} values - Input values (will be copied and sorted)
 * @returns {number} Interquartile range (Q3 - Q1), or 0 for fewer than 4 values
 */
export function iqr(values) {
  const n = values.length;
  if (n < 4) return 0;

  // Sort a copy to avoid mutating input
  const sorted = values.slice().sort((a, b) => a - b);

  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  return q3 - q1;
}

/**
 * Compute a quantile from a pre-sorted array using linear interpolation.
 *
 * @param {number[]} sorted - Sorted numeric array (ascending)
 * @param {number} q - Quantile in [0, 1]
 * @returns {number} Interpolated quantile value
 */
export function quantile(sorted, q) {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];

  const index = q * (n - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) return sorted[lower];

  const fraction = index - lower;
  return sorted[lower] + fraction * (sorted[upper] - sorted[lower]);
}

/**
 * Compute Shannon entropy of a numeric array using histogram binning.
 *
 * Entropy quantifies the "randomness" or "unpredictability" of the signal:
 *   - High entropy: values spread uniformly across range (occupied, active room)
 *   - Low entropy: values concentrated in narrow range (empty, static room)
 *
 * The amplitude range is divided into ENTROPY_BINS equal-width bins.
 * Entropy is computed as: H = -sum(p_i * log2(p_i)) for non-zero p_i
 * Result is normalized to [0, 1] by dividing by log2(ENTROPY_BINS).
 *
 * @param {number[]} values - Input values
 * @param {number} [numBins=ENTROPY_BINS] - Number of histogram bins
 * @returns {number} Normalized Shannon entropy in [0, 1], or 0 for empty/constant input
 */
export function entropy(values, numBins = ENTROPY_BINS) {
  const n = values.length;
  if (n < 2) return 0;

  // Find data range
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    if (values[i] < min) min = values[i];
    if (values[i] > max) max = values[i];
  }

  const range = max - min;
  if (range < LOG_EPSILON) return 0; // All values effectively identical

  // Build histogram
  const bins = new Array(numBins).fill(0);
  const binWidth = range / numBins;

  for (let i = 0; i < n; i++) {
    // Map value to bin index, clamping max value to last bin
    let binIdx = Math.floor((values[i] - min) / binWidth);
    if (binIdx >= numBins) binIdx = numBins - 1;
    bins[binIdx]++;
  }

  // Compute Shannon entropy
  let h = 0;
  const logN = Math.log2(n + LOG_EPSILON);
  for (let i = 0; i < numBins; i++) {
    if (bins[i] > 0) {
      const p = bins[i] / n;
      h -= p * Math.log2(p + LOG_EPSILON);
    }
  }

  // Normalize to [0, 1] by dividing by max possible entropy (uniform distribution)
  const maxEntropy = Math.log2(Math.min(numBins, n));
  if (maxEntropy < LOG_EPSILON) return 0;

  return Math.min(h / maxEntropy, 1.0);
}

// ---------------------------------------------------------------------------
// Band-Level Statistical Feature Aggregation
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} BandStatistics
 * @property {number} bandIndex  - Band index (0-7)
 * @property {string} label      - Band label (e.g., 'edge-neg', 'dc-pos')
 * @property {number} mean       - Mean amplitude over the window
 * @property {number} variance   - Sample variance
 * @property {number} stddev     - Sample standard deviation
 * @property {number} skewness   - Sample skewness (asymmetry)
 * @property {number} kurtosis   - Excess kurtosis (tailedness)
 * @property {number} iqr        - Interquartile range (robust spread)
 * @property {number} entropy    - Normalized Shannon entropy [0,1]
 */

/**
 * @typedef {Object} WindowStatistics
 * @property {BandStatistics[]} bands       - Per-band statistics (length NUM_BANDS)
 * @property {BandStatistics}   overall     - Aggregated statistics across all subcarriers
 * @property {number}           frameCount  - Number of frames in the window
 * @property {number}           timestamp   - Timestamp of the latest frame (ms)
 */

/**
 * Compute full statistical features for a single subcarrier band
 * from a flat array of amplitude values collected over the window.
 *
 * @param {number[]} values - Amplitude values for this band across the window
 * @param {number} bandIndex - Band index (0-7) or -1 for overall
 * @param {string} label - Band label string
 * @returns {BandStatistics} Computed statistics
 */
export function computeBandStatistics(values, bandIndex, label) {
  const mu = mean(values);
  const sigma = stddev(values, mu);

  return {
    bandIndex,
    label,
    mean: mu,
    variance: variance(values, mu),
    stddev: sigma,
    skewness: skewness(values, mu, sigma),
    kurtosis: kurtosis(values, mu, sigma),
    iqr: iqr(values),
    entropy: entropy(values),
  };
}

/**
 * Compute statistical features from a window of CSI amplitude frames.
 *
 * For each of the 8 subcarrier bands, collects all amplitude values across the
 * window and computes: mean, variance, stddev, skewness, kurtosis, IQR, entropy.
 * Also computes overall statistics across all 52 subcarriers.
 *
 * @param {number[][]} amplitudeFrames - Array of amplitude arrays (each length 52),
 *   ordered oldest-first. Minimum MIN_WINDOW_SIZE frames required.
 * @returns {WindowStatistics | null} Statistical features, or null if insufficient data
 */
export function computeWindowStatistics(amplitudeFrames) {
  if (!amplitudeFrames || amplitudeFrames.length < MIN_WINDOW_SIZE) {
    return null;
  }

  const frameCount = amplitudeFrames.length;

  // Collect per-band values across the time window
  // bands[b] accumulates all amplitude values for band b across all frames
  const bandValues = Array.from({ length: NUM_BANDS }, () => []);
  const allValues = [];

  for (let f = 0; f < frameCount; f++) {
    const frame = amplitudeFrames[f];
    if (!isValidAmplitudeArray(frame)) continue;

    for (let b = 0; b < NUM_BANDS; b++) {
      const { start, end } = SUBCARRIER_BANDS[b];
      for (let s = start; s < end; s++) {
        bandValues[b].push(frame[s]);
        allValues.push(frame[s]);
      }
    }
  }

  // Compute per-band statistics
  const bands = new Array(NUM_BANDS);
  for (let b = 0; b < NUM_BANDS; b++) {
    bands[b] = computeBandStatistics(
      bandValues[b],
      b,
      SUBCARRIER_BANDS[b].label
    );
  }

  // Compute overall statistics across all subcarriers
  const overall = computeBandStatistics(allValues, -1, 'overall');

  return {
    bands,
    overall,
    frameCount,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Stateful Sliding Window Extractor
// ---------------------------------------------------------------------------

/**
 * Stateful extractor that maintains a sliding window of amplitude frames
 * and produces WindowStatistics on demand.
 *
 * Usage:
 *   const extractor = new StatisticalFeatureExtractor({ windowSize: 40 });
 *   extractor.push(amplitudeArray);  // call per CSI frame
 *   const stats = extractor.compute(); // null until window fills
 */
export class StatisticalFeatureExtractor {
  /**
   * @param {Object} [options]
   * @param {number} [options.windowSize=DEFAULT_WINDOW_SIZE] - Sliding window size
   */
  constructor(options = {}) {
    const windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;

    if (windowSize < MIN_WINDOW_SIZE || windowSize > MAX_WINDOW_SIZE) {
      throw new RangeError(
        `windowSize must be between ${MIN_WINDOW_SIZE} and ${MAX_WINDOW_SIZE}, got ${windowSize}`
      );
    }

    /** @type {number} */
    this._windowSize = windowSize;

    /**
     * Circular buffer of amplitude frames.
     * @type {number[][]}
     */
    this._buffer = [];

    /**
     * Write pointer for circular buffer.
     * @type {number}
     */
    this._writePtr = 0;

    /**
     * Total frames pushed (used to determine if buffer is full).
     * @type {number}
     */
    this._totalFrames = 0;
  }

  /**
   * Push a new amplitude frame into the sliding window.
   *
   * @param {number[]} amplitudes - Array of 52 subcarrier amplitudes
   * @throws {Error} If amplitudes is not a valid 52-element array
   */
  push(amplitudes) {
    if (!isValidAmplitudeArray(amplitudes)) {
      throw new Error(
        `Expected ${NUM_SUBCARRIERS} amplitudes, got ${amplitudes?.length ?? 'null'}`
      );
    }

    if (this._buffer.length < this._windowSize) {
      // Buffer not yet full — append
      this._buffer.push(amplitudes);
    } else {
      // Overwrite oldest entry (circular)
      this._buffer[this._writePtr] = amplitudes;
    }

    this._writePtr = (this._writePtr + 1) % this._windowSize;
    this._totalFrames++;
  }

  /**
   * Compute statistical features from the current window contents.
   *
   * @returns {WindowStatistics | null} Features, or null if not enough frames
   */
  compute() {
    if (this._buffer.length < MIN_WINDOW_SIZE) {
      return null;
    }

    // Build ordered array from circular buffer (oldest first)
    const ordered = this._getOrderedFrames();
    return computeWindowStatistics(ordered);
  }

  /**
   * Get frames in chronological order from the circular buffer.
   *
   * @returns {number[][]} Frames ordered oldest-first
   * @private
   */
  _getOrderedFrames() {
    const len = this._buffer.length;
    if (len < this._windowSize) {
      // Buffer not yet full — already in order
      return this._buffer;
    }

    // Circular buffer: writePtr points to the next slot to overwrite,
    // which is the oldest entry
    const ordered = new Array(len);
    for (let i = 0; i < len; i++) {
      ordered[i] = this._buffer[(this._writePtr + i) % len];
    }
    return ordered;
  }

  /**
   * Get the current window size configuration.
   * @returns {number}
   */
  get windowSize() {
    return this._windowSize;
  }

  /**
   * Get the number of frames currently in the buffer.
   * @returns {number}
   */
  get frameCount() {
    return this._buffer.length;
  }

  /**
   * Get the total number of frames pushed since creation.
   * @returns {number}
   */
  get totalFrames() {
    return this._totalFrames;
  }

  /**
   * Reset the extractor, clearing all buffered frames.
   */
  reset() {
    this._buffer = [];
    this._writePtr = 0;
    this._totalFrames = 0;
  }
}
