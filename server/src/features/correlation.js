// ==============================================================================
// Subcarrier Correlation Matrix & Eigenvalue Analysis (ACC-01-T5)
// ==============================================================================
// Computes the correlation matrix across subcarrier bands from a time window
// of CSI amplitude frames. The eigenvalue spread (ratio of largest to smallest
// eigenvalue) quantifies how "structured" the CSI variation is:
//
//   - High eigenvalue spread → one dominant direction of variation →
//     typically caused by a single person moving along a path
//   - Low eigenvalue spread → variation spread across many dimensions →
//     indicates either multiple people, diffuse motion, or noise
//
// The correlation structure between frequency bands reveals spatial information:
//   - Adjacent bands correlating → nearby scatterer (close person)
//   - Edge bands correlating with center → full-room occupancy
//   - All bands decorrelated → environmental noise or multiple sources
//
// All core functions are pure — no side effects, no state mutation.
// The CorrelationAnalyzer class provides a stateful sliding window wrapper.
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

/** Default sliding window size for correlation (~2s at 20Hz). */
export const DEFAULT_CORR_WINDOW = 40;

/** Minimum window size — need enough samples for stable covariance. */
export const MIN_CORR_WINDOW = 10;

/** Maximum window size to bound memory on MeLE N100. */
export const MAX_CORR_WINDOW = 400;

/**
 * Small epsilon to prevent division by zero in normalization.
 * @type {number}
 */
const EPSILON = 1e-12;

/**
 * Maximum iterations for the power-method eigenvalue solver.
 * 20 iterations is sufficient for 8x8 matrices — convergence is
 * typically within 5-10 iterations for well-conditioned matrices.
 * @type {number}
 */
const MAX_EIGEN_ITERATIONS = 20;

/**
 * Convergence threshold for the power-method eigenvector.
 * When the change in the dominant eigenvector norm falls below this,
 * we consider the eigenvalue converged.
 * @type {number}
 */
const EIGEN_CONVERGENCE = 1e-8;

// ---------------------------------------------------------------------------
// Pure Functions — Band Mean Extraction
// ---------------------------------------------------------------------------

/**
 * Compute the mean amplitude per band for a single CSI frame.
 *
 * @param {number[]} amplitudes - Array of 52 subcarrier amplitudes
 * @returns {number[]} Array of NUM_BANDS mean values
 */
export function computeBandMeans(amplitudes) {
  const means = new Array(NUM_BANDS);

  for (let b = 0; b < NUM_BANDS; b++) {
    const { start, end } = SUBCARRIER_BANDS[b];
    let sum = 0;
    const count = end - start;
    for (let i = start; i < end; i++) {
      sum += amplitudes[i];
    }
    means[b] = sum / count;
  }

  return means;
}

// ---------------------------------------------------------------------------
// Pure Functions — Covariance & Correlation
// ---------------------------------------------------------------------------

/**
 * Compute the covariance matrix from a time window of band-mean vectors.
 *
 * Each row/column of the matrix corresponds to one of the 8 frequency bands.
 * Entry (i,j) is the sample covariance between band i and band j over time.
 *
 * @param {number[][]} bandMeansWindow - Array of band-mean vectors (each length NUM_BANDS),
 *   ordered oldest-first. Minimum MIN_CORR_WINDOW entries required.
 * @returns {{ matrix: number[][], means: number[] } | null} Covariance matrix (NUM_BANDS x NUM_BANDS)
 *   and per-band temporal means, or null if insufficient data.
 */
export function computeCovarianceMatrix(bandMeansWindow) {
  const n = bandMeansWindow.length;
  if (n < MIN_CORR_WINDOW) return null;

  // Compute temporal means per band
  const means = new Array(NUM_BANDS).fill(0);
  for (let t = 0; t < n; t++) {
    for (let b = 0; b < NUM_BANDS; b++) {
      means[b] += bandMeansWindow[t][b];
    }
  }
  for (let b = 0; b < NUM_BANDS; b++) {
    means[b] /= n;
  }

  // Compute covariance matrix (Bessel-corrected, divides by n-1)
  const matrix = Array.from({ length: NUM_BANDS }, () =>
    new Array(NUM_BANDS).fill(0)
  );

  for (let t = 0; t < n; t++) {
    for (let i = 0; i < NUM_BANDS; i++) {
      const di = bandMeansWindow[t][i] - means[i];
      for (let j = i; j < NUM_BANDS; j++) {
        const dj = bandMeansWindow[t][j] - means[j];
        matrix[i][j] += di * dj;
      }
    }
  }

  // Normalize and mirror (symmetric matrix)
  for (let i = 0; i < NUM_BANDS; i++) {
    for (let j = i; j < NUM_BANDS; j++) {
      matrix[i][j] /= (n - 1);
      matrix[j][i] = matrix[i][j]; // Mirror
    }
  }

  return { matrix, means };
}

/**
 * Convert a covariance matrix to a Pearson correlation matrix.
 *
 * Correlation normalizes each entry by the product of the standard deviations
 * of the two bands: r(i,j) = cov(i,j) / (std_i * std_j).
 * Diagonal entries are always 1.0 (unless a band has zero variance → 0).
 *
 * @param {number[][]} covMatrix - Covariance matrix (NUM_BANDS x NUM_BANDS)
 * @returns {number[][]} Correlation matrix (NUM_BANDS x NUM_BANDS), values in [-1, 1]
 */
export function covarianceToCorrelation(covMatrix) {
  const n = covMatrix.length;
  const corr = Array.from({ length: n }, () => new Array(n).fill(0));

  // Extract standard deviations from diagonal
  const stds = new Array(n);
  for (let i = 0; i < n; i++) {
    stds[i] = Math.sqrt(Math.max(covMatrix[i][i], 0));
  }

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (stds[i] < EPSILON || stds[j] < EPSILON) {
        corr[i][j] = (i === j) ? 1.0 : 0.0;
      } else {
        corr[i][j] = covMatrix[i][j] / (stds[i] * stds[j]);
        // Clamp to [-1, 1] for numerical safety
        corr[i][j] = Math.max(-1, Math.min(1, corr[i][j]));
      }
    }
  }

  return corr;
}

// ---------------------------------------------------------------------------
// Pure Functions — Eigenvalue Analysis
// ---------------------------------------------------------------------------

/**
 * Compute the dominant eigenvalue of a symmetric matrix using the power method.
 *
 * The power method iteratively multiplies a random vector by the matrix,
 * converging to the eigenvector corresponding to the largest eigenvalue.
 * For our 8×8 symmetric covariance matrices, convergence is fast.
 *
 * @param {number[][]} matrix - Symmetric square matrix (n×n)
 * @returns {{ value: number, vector: number[] }} Dominant eigenvalue and eigenvector
 */
export function dominantEigenvalue(matrix) {
  const n = matrix.length;
  if (n === 0) return { value: 0, vector: [] };
  if (n === 1) return { value: matrix[0][0], vector: [1] };

  // Initialize with unit vector [1, 0, ..., 0] for determinism
  let v = new Array(n).fill(0);
  v[0] = 1;

  let eigenvalue = 0;

  for (let iter = 0; iter < MAX_EIGEN_ITERATIONS; iter++) {
    // Matrix-vector multiply: w = M * v
    const w = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        w[i] += matrix[i][j] * v[j];
      }
    }

    // Find max component for normalization (Rayleigh quotient)
    let maxAbs = 0;
    for (let i = 0; i < n; i++) {
      const absW = Math.abs(w[i]);
      if (absW > maxAbs) maxAbs = absW;
    }

    if (maxAbs < EPSILON) {
      // Matrix is effectively zero
      return { value: 0, vector: v };
    }

    // Normalize
    const prevEigenvalue = eigenvalue;
    eigenvalue = maxAbs;
    for (let i = 0; i < n; i++) {
      v[i] = w[i] / maxAbs;
    }

    // Check convergence
    if (Math.abs(eigenvalue - prevEigenvalue) < EIGEN_CONVERGENCE) {
      break;
    }
  }

  return { value: eigenvalue, vector: v };
}

/**
 * Estimate the smallest eigenvalue of a symmetric positive semi-definite matrix.
 *
 * Uses the trace minus sum-of-dominant approach:
 *   trace(M) = sum of all eigenvalues
 *   Since we know the dominant eigenvalue, the smallest can be bounded by:
 *   smallest ≈ (trace - dominant) / (n - 1) as a lower-bound estimate.
 *
 * For more accuracy with 8x8 matrices, we use deflation: subtract the
 * dominant eigenvalue's contribution and find the smallest of the remainder
 * by inverting the deflated matrix and finding its dominant eigenvalue.
 *
 * @param {number[][]} matrix - Symmetric positive semi-definite matrix
 * @param {number} dominantEigen - Already computed dominant eigenvalue
 * @param {number[]} dominantVec - Already computed dominant eigenvector
 * @returns {number} Estimated smallest eigenvalue (non-negative, clamped to 0)
 */
export function estimateSmallestEigenvalue(matrix, dominantEigen, dominantVec) {
  const n = matrix.length;
  if (n <= 1) return dominantEigen;

  // Compute trace
  let trace = 0;
  for (let i = 0; i < n; i++) {
    trace += matrix[i][i];
  }

  // Lower-bound estimate: (trace - dominant) / (n-1)
  // This is exact when all remaining eigenvalues are equal.
  const remainingAvg = (trace - dominantEigen) / (n - 1);
  return Math.max(0, remainingAvg);
}

/**
 * Compute eigenvalue spread: ratio of dominant to smallest eigenvalue.
 *
 * This is a simplified condition number that measures how "spread out" the
 * variation is across frequency bands:
 *   - Spread ≈ 1 → variation uniform across all bands (noise or many sources)
 *   - Spread >> 1 → one dominant direction (single person, structured motion)
 *   - Spread = ∞ → at least one band has zero variance (clipped to MAX_SPREAD)
 *
 * @param {number[][]} covMatrix - Covariance matrix (NUM_BANDS x NUM_BANDS)
 * @returns {{ spread: number, dominantEigenvalue: number, smallestEigenvalue: number,
 *             dominantVector: number[] }}
 */
export function computeEigenvalueSpread(covMatrix) {
  const MAX_SPREAD = 1000; // Cap to avoid infinities

  const { value: dominant, vector } = dominantEigenvalue(covMatrix);

  if (dominant < EPSILON) {
    // Zero matrix → no meaningful spread
    return {
      spread: 1.0,
      dominantEigenvalue: 0,
      smallestEigenvalue: 0,
      dominantVector: vector,
    };
  }

  const smallest = estimateSmallestEigenvalue(covMatrix, dominant, vector);

  const spread = smallest > EPSILON
    ? Math.min(dominant / smallest, MAX_SPREAD)
    : MAX_SPREAD;

  return {
    spread,
    dominantEigenvalue: dominant,
    smallestEigenvalue: smallest,
    dominantVector: vector,
  };
}

// ---------------------------------------------------------------------------
// Pure Functions — Aggregate Correlation Features
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CorrelationFeatures
 * @property {number[][]} correlationMatrix   - Pearson correlation matrix (8x8)
 * @property {number[][]} covarianceMatrix    - Sample covariance matrix (8x8)
 * @property {number}     eigenvalueSpread    - Ratio of largest to smallest eigenvalue
 * @property {number}     dominantEigenvalue  - Largest eigenvalue of covariance
 * @property {number}     smallestEigenvalue  - Estimated smallest eigenvalue
 * @property {number[]}   dominantEigenvector - Eigenvector of largest eigenvalue
 * @property {number}     meanCorrelation     - Mean of off-diagonal correlations
 * @property {number}     maxCorrelation      - Maximum off-diagonal |correlation|
 * @property {number}     minCorrelation      - Minimum off-diagonal |correlation|
 * @property {number}     adjacentCorrelation - Mean correlation between adjacent bands
 * @property {number}     edgeDcCorrelation   - Correlation between edge and DC bands
 * @property {number}     frameCount          - Number of frames used
 * @property {number}     timestamp           - Timestamp of latest computation (ms)
 */

/**
 * Compute full correlation features from a time window of CSI amplitude frames.
 *
 * @param {number[][]} amplitudeFrames - Array of amplitude arrays (each length 52),
 *   ordered oldest-first. Minimum MIN_CORR_WINDOW frames required.
 * @returns {CorrelationFeatures | null} Correlation analysis results, or null if insufficient data
 */
export function computeCorrelationFeatures(amplitudeFrames) {
  if (!amplitudeFrames || amplitudeFrames.length < MIN_CORR_WINDOW) {
    return null;
  }

  // Step 1: Convert each frame to band means
  const bandMeansWindow = [];
  for (let f = 0; f < amplitudeFrames.length; f++) {
    if (!isValidAmplitudeArray(amplitudeFrames[f])) continue;
    bandMeansWindow.push(computeBandMeans(amplitudeFrames[f]));
  }

  if (bandMeansWindow.length < MIN_CORR_WINDOW) {
    return null;
  }

  // Step 2: Compute covariance matrix
  const covResult = computeCovarianceMatrix(bandMeansWindow);
  if (!covResult) return null;

  const { matrix: covMatrix } = covResult;

  // Step 3: Convert to correlation matrix
  const corrMatrix = covarianceToCorrelation(covMatrix);

  // Step 4: Eigenvalue analysis on covariance matrix
  const eigenResult = computeEigenvalueSpread(covMatrix);

  // Step 5: Aggregate correlation statistics
  let sumOffDiag = 0;
  let maxOffDiag = -1;
  let minOffDiag = 2;
  let countOffDiag = 0;

  for (let i = 0; i < NUM_BANDS; i++) {
    for (let j = i + 1; j < NUM_BANDS; j++) {
      const absCorr = Math.abs(corrMatrix[i][j]);
      sumOffDiag += absCorr;
      if (absCorr > maxOffDiag) maxOffDiag = absCorr;
      if (absCorr < minOffDiag) minOffDiag = absCorr;
      countOffDiag++;
    }
  }

  const meanCorr = countOffDiag > 0 ? sumOffDiag / countOffDiag : 0;

  // Adjacent band correlation: mean of |corr(b, b+1)| for b=0..6
  let adjSum = 0;
  for (let b = 0; b < NUM_BANDS - 1; b++) {
    adjSum += Math.abs(corrMatrix[b][b + 1]);
  }
  const adjacentCorrelation = adjSum / (NUM_BANDS - 1);

  // Edge-DC correlation: average of |corr(0,3)|, |corr(0,4)|, |corr(7,3)|, |corr(7,4)|
  const edgeDcCorrelation = (
    Math.abs(corrMatrix[0][3]) +
    Math.abs(corrMatrix[0][4]) +
    Math.abs(corrMatrix[7][3]) +
    Math.abs(corrMatrix[7][4])
  ) / 4;

  return {
    correlationMatrix: corrMatrix,
    covarianceMatrix: covMatrix,
    eigenvalueSpread: eigenResult.spread,
    dominantEigenvalue: eigenResult.dominantEigenvalue,
    smallestEigenvalue: eigenResult.smallestEigenvalue,
    dominantEigenvector: eigenResult.dominantVector,
    meanCorrelation: meanCorr,
    maxCorrelation: maxOffDiag >= 0 ? maxOffDiag : 0,
    minCorrelation: minOffDiag <= 1 ? minOffDiag : 0,
    adjacentCorrelation,
    edgeDcCorrelation,
    frameCount: bandMeansWindow.length,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Stateful Sliding Window Analyzer
// ---------------------------------------------------------------------------

/**
 * Stateful analyzer that maintains a sliding window of amplitude frames
 * and produces CorrelationFeatures on demand.
 *
 * Usage:
 *   const analyzer = new CorrelationAnalyzer({ windowSize: 40 });
 *   analyzer.push(amplitudeArray);  // call per CSI frame
 *   const features = analyzer.compute(); // null until window fills
 */
export class CorrelationAnalyzer {
  /**
   * @param {Object} [options]
   * @param {number} [options.windowSize=DEFAULT_CORR_WINDOW] - Sliding window size
   */
  constructor(options = {}) {
    const windowSize = options.windowSize ?? DEFAULT_CORR_WINDOW;

    if (windowSize < MIN_CORR_WINDOW || windowSize > MAX_CORR_WINDOW) {
      throw new RangeError(
        `windowSize must be between ${MIN_CORR_WINDOW} and ${MAX_CORR_WINDOW}, got ${windowSize}`
      );
    }

    /** @type {number} */
    this._windowSize = windowSize;

    /** @type {number[][]} Circular buffer of amplitude frames */
    this._buffer = [];

    /** @type {number} Write pointer */
    this._writePtr = 0;

    /** @type {number} Total frames pushed */
    this._totalFrames = 0;
  }

  /**
   * Push a new amplitude frame into the sliding window.
   *
   * @param {number[]} amplitudes - Array of 52 subcarrier amplitudes
   * @throws {Error} If amplitudes is not valid
   */
  push(amplitudes) {
    if (!isValidAmplitudeArray(amplitudes)) {
      throw new Error(
        `Expected ${NUM_SUBCARRIERS} amplitudes, got ${amplitudes?.length ?? 'null'}`
      );
    }

    if (this._buffer.length < this._windowSize) {
      this._buffer.push(amplitudes);
    } else {
      this._buffer[this._writePtr] = amplitudes;
    }

    this._writePtr = (this._writePtr + 1) % this._windowSize;
    this._totalFrames++;
  }

  /**
   * Compute correlation features from the current window.
   *
   * @returns {CorrelationFeatures | null} Features, or null if insufficient data
   */
  compute() {
    if (this._buffer.length < MIN_CORR_WINDOW) {
      return null;
    }

    const ordered = this._getOrderedFrames();
    return computeCorrelationFeatures(ordered);
  }

  /**
   * Get frames in chronological order from the circular buffer.
   * @returns {number[][]} Frames ordered oldest-first
   * @private
   */
  _getOrderedFrames() {
    const len = this._buffer.length;
    if (len < this._windowSize) return this._buffer;

    const ordered = new Array(len);
    for (let i = 0; i < len; i++) {
      ordered[i] = this._buffer[(this._writePtr + i) % len];
    }
    return ordered;
  }

  /** @returns {number} Window size */
  get windowSize() { return this._windowSize; }

  /** @returns {number} Frames in buffer */
  get frameCount() { return this._buffer.length; }

  /** @returns {number} Total frames pushed */
  get totalFrames() { return this._totalFrames; }

  /** Reset all state. */
  reset() {
    this._buffer = [];
    this._writePtr = 0;
    this._totalFrames = 0;
  }
}
