// ==============================================================================
// Amplitude Feature Extraction with Subcarrier Grouping
// ==============================================================================
// Implements ACC-01-T1: subcarrier grouping into 8 logical frequency bands
// with per-band and cross-band statistics.
//
// This module takes raw CSI amplitude arrays (52 subcarriers) and computes
// spatially-aware features by grouping subcarriers into 8 bands that correspond
// to different OFDM frequency regions. Different bands respond differently to
// human presence and motion due to varying multipath characteristics.
//
// Key insight: near-DC bands (3,4) are sensitive to slow/static changes while
// edge bands (0,7) respond more to fast motion and multipath.
//
// All functions are pure — no side effects, no state. This makes them easy to
// test and safe to call from any processing pipeline context.
// ==============================================================================

import {
  NUM_SUBCARRIERS,
  NUM_BANDS,
  SUBCARRIER_BANDS,
} from '../shared/constants.js';

import {
  createBandFeatures,
  createSubcarrierGroupResult,
  isValidAmplitudeArray,
} from '../shared/types.js';

// ---------------------------------------------------------------------------
// Core Statistics (pure, no dependencies)
// ---------------------------------------------------------------------------

/**
 * Compute the arithmetic mean of a numeric array.
 *
 * @param {number[]} arr - Input values
 * @returns {number} Mean value, or 0 for empty array
 */
export function mean(arr) {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  return sum / arr.length;
}

/**
 * Compute sample variance (Bessel-corrected, divides by N-1).
 *
 * @param {number[]} arr - Input values
 * @param {number} [precomputedMean] - Optional pre-computed mean to avoid redundant calculation
 * @returns {number} Sample variance, or 0 for arrays with fewer than 2 elements
 */
export function variance(arr, precomputedMean) {
  if (arr.length < 2) return 0;
  const m = precomputedMean !== undefined ? precomputedMean : mean(arr);
  let sumSq = 0;
  for (let i = 0; i < arr.length; i++) {
    const diff = arr[i] - m;
    sumSq += diff * diff;
  }
  return sumSq / (arr.length - 1);
}

// ---------------------------------------------------------------------------
// Subcarrier Grouping
// ---------------------------------------------------------------------------

/**
 * Group 52 subcarrier amplitudes into 8 logical frequency bands and compute
 * per-band and cross-band statistics.
 *
 * Band layout (see shared/constants.js for detailed mapping):
 *   Bands 0,7 (edge)  → multipath-sensitive, fast motion
 *   Bands 1,2,5,6 (mid/inner) → general purpose
 *   Bands 3,4 (near DC) → slow motion, static presence
 *
 * @param {number[]} amplitudes - Array of 52 subcarrier amplitudes
 * @returns {import('../shared/types.js').SubcarrierGroupResult} Grouped features
 * @throws {Error} If amplitudes array is not valid (not length 52)
 */
export function groupSubcarriers(amplitudes) {
  if (!isValidAmplitudeArray(amplitudes)) {
    throw new Error(
      `Expected ${NUM_SUBCARRIERS} amplitudes, got ${amplitudes?.length ?? 'null'}`
    );
  }

  const result = createSubcarrierGroupResult();

  // --- Step 1: Compute per-band statistics ---
  for (let b = 0; b < NUM_BANDS; b++) {
    const { start, end } = SUBCARRIER_BANDS[b];
    const bandAmps = amplitudes.slice(start, end);
    const bandMean = mean(bandAmps);
    const bandVar = variance(bandAmps, bandMean);

    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < bandAmps.length; i++) {
      if (bandAmps[i] < min) min = bandAmps[i];
      if (bandAmps[i] > max) max = bandAmps[i];
    }

    result.bands[b].meanAmplitude = bandMean;
    result.bands[b].variance = bandVar;
    result.bands[b].maxAmplitude = max;
    result.bands[b].minAmplitude = min;
    result.bands[b].range = max - min;

    result.bandMeans[b] = bandMean;
    result.bandVars[b] = bandVar;
  }

  // --- Step 2: Compute global statistics ---
  result.overallMean = mean(amplitudes);
  result.overallVar = variance(amplitudes, result.overallMean);

  // --- Step 3: Inter-band variance (variance of band means) ---
  // This captures the spatial spread of the CSI response. Higher inter-band
  // variance indicates more frequency-selective fading (typical with human presence
  // creating additional multipath reflections).
  result.interBandVar = variance(result.bandMeans);

  return result;
}

/**
 * Compute temporal band features from a time series of grouped results.
 * Takes the last N SubcarrierGroupResults and computes the variance of each
 * band's mean over time. This captures how much each band is "fluctuating",
 * which is a key indicator of motion and presence.
 *
 * @param {import('../shared/types.js').SubcarrierGroupResult[]} history
 *   Recent grouping results (newest last)
 * @param {number} [minFrames=5] - Minimum frames needed for meaningful statistics
 * @returns {{
 *   temporalBandVars: number[],
 *   temporalOverallVar: number,
 *   mostActiveBand: number,
 *   leastActiveBand: number,
 *   bandActivityRatio: number
 * }} Temporal band features
 */
export function computeTemporalBandFeatures(history, minFrames = 5) {
  const defaultResult = {
    temporalBandVars: new Array(NUM_BANDS).fill(0),
    temporalOverallVar: 0,
    mostActiveBand: -1,
    leastActiveBand: -1,
    bandActivityRatio: 0,
  };

  if (!history || history.length < minFrames) {
    return defaultResult;
  }

  // For each band, collect the time series of mean amplitudes
  const temporalBandVars = new Array(NUM_BANDS);
  let maxVar = -Infinity;
  let minVar = Infinity;
  let mostActive = 0;
  let leastActive = 0;

  for (let b = 0; b < NUM_BANDS; b++) {
    const timeSeries = history.map(h => h.bandMeans[b]);
    const v = variance(timeSeries);
    temporalBandVars[b] = v;

    if (v > maxVar) { maxVar = v; mostActive = b; }
    if (v < minVar) { minVar = v; leastActive = b; }
  }

  // Temporal variance of the overall mean
  const overallTimeSeries = history.map(h => h.overallMean);
  const temporalOverallVar = variance(overallTimeSeries);

  // Activity ratio: most active band variance / least active band variance
  // Higher ratio suggests localized motion (specific frequency bands affected)
  // Lower ratio suggests global change (e.g., environmental drift)
  const bandActivityRatio = minVar > 1e-10 ? maxVar / minVar : 0;

  return {
    temporalBandVars,
    temporalOverallVar,
    mostActiveBand: mostActive,
    leastActiveBand: leastActive,
    bandActivityRatio,
  };
}

/**
 * Compute a simple motion indicator from band variances.
 * Combines intra-band variance (spatial) with inter-band variance to produce
 * a single motion score in [0, 1].
 *
 * @param {import('../shared/types.js').SubcarrierGroupResult} grouped
 *   Current frame's grouped features
 * @param {number} baselineVar - Calibrated baseline variance for normalization
 * @returns {number} Motion score in [0, 1] where 0=no motion, 1=strong motion
 */
export function computeBandMotionScore(grouped, baselineVar) {
  if (baselineVar <= 0) return 0;

  // Sum of all band variances (total intra-band variability)
  let totalBandVar = 0;
  for (let b = 0; b < NUM_BANDS; b++) {
    totalBandVar += grouped.bandVars[b];
  }

  // Combined metric: intra-band + inter-band, normalized by baseline
  const combinedVar = (totalBandVar / NUM_BANDS + grouped.interBandVar) / 2;
  const normalized = combinedVar / baselineVar;

  // Sigmoid-like mapping to [0, 1] — gradual onset, saturates at high values
  // score = 1 - 1/(1 + x) where x = normalized variance
  return 1 - 1 / (1 + normalized);
}
