// ==============================================================================
// Phase Difference Extraction with Linear Unwrapping (ACC-01-T2)
// ==============================================================================
// Extracts phase information from CSI I/Q samples and computes adjacent
// subcarrier phase differences with linear unwrapping to remove 2π ambiguity.
//
// Phase differences between adjacent subcarriers are a powerful feature for
// indoor sensing because:
//   - They capture the relative propagation delay across frequencies
//   - Human presence creates multipath reflections that shift phase relationships
//   - Phase is more robust to hardware gain variations than amplitude alone
//   - Adjacent phase diffs cancel common-mode phase offsets (e.g., PLL drift)
//
// The unwrapping process removes discontinuities caused by the [-π, π] wrapping
// of atan2, producing a smooth phase progression across subcarriers. Deviations
// from the linear trend (residuals) are the actual features — they encode the
// multipath environment caused by human presence and motion.
//
// All functions are pure — no side effects, no state.
// ==============================================================================

import { NUM_SUBCARRIERS, NUM_BANDS, SUBCARRIER_BANDS } from '../shared/constants.js';
import { extractIQSamples, complexPhase, isValidCSIPayload } from '../shared/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Two times π — used for phase wrapping calculations. */
const TWO_PI = 2 * Math.PI;

/** Minimum I/Q magnitude to consider a subcarrier valid for phase extraction.
 *  Below this threshold, the phase angle from atan2 is dominated by noise.
 *  Value chosen as sqrt(2) ≈ 1.41 — both I and Q must be ≥1 on average. */
const MIN_PHASE_MAGNITUDE = 1.41;

/** Number of adjacent subcarrier phase differences (NUM_SUBCARRIERS - 1). */
export const NUM_PHASE_DIFFS = NUM_SUBCARRIERS - 1;

// ---------------------------------------------------------------------------
// Phase Extraction — Core Functions
// ---------------------------------------------------------------------------

/**
 * Extract raw phase angles from CSI I/Q byte payload.
 * Converts raw bytes to complex samples, then computes phase via atan2.
 *
 * Subcarriers with I/Q magnitude below MIN_PHASE_MAGNITUDE are marked as NaN
 * to indicate unreliable phase data (near-zero signal is noise-dominated).
 *
 * @param {Buffer|Uint8Array} csiData - Raw interleaved I/Q bytes (104 bytes for 52 subcarriers)
 * @returns {{ phases: number[], magnitudes: number[], validCount: number }}
 *   phases: Phase angles in radians [-π, π], NaN for invalid subcarriers
 *   magnitudes: Amplitude per subcarrier (for quality gating)
 *   validCount: Number of subcarriers with valid phase data
 * @throws {Error} If CSI payload is invalid
 */
export function extractPhases(csiData) {
  if (!isValidCSIPayload(csiData)) {
    throw new Error(
      `Invalid CSI payload: expected ≥${NUM_SUBCARRIERS * 2} bytes, got ${csiData?.length ?? 'null'}`
    );
  }

  const samples = extractIQSamples(csiData);
  const phases = new Array(NUM_SUBCARRIERS);
  const magnitudes = new Array(NUM_SUBCARRIERS);
  let validCount = 0;

  for (let k = 0; k < NUM_SUBCARRIERS; k++) {
    const { i, q } = samples[k];
    const mag = Math.sqrt(i * i + q * q);
    magnitudes[k] = mag;

    if (mag < MIN_PHASE_MAGNITUDE) {
      phases[k] = NaN;
    } else {
      phases[k] = Math.atan2(q, i);
      validCount++;
    }
  }

  return { phases, magnitudes, validCount };
}

/**
 * Compute adjacent subcarrier phase differences (Δφ[k] = φ[k+1] - φ[k]).
 *
 * Phase differences between adjacent subcarriers cancel the common-mode
 * Carrier Frequency Offset (CFO) and Phase-Locked Loop (PLL) drift that
 * affect all subcarriers equally. This makes them more stable features
 * than raw phases for presence detection.
 *
 * The result is wrapped to [-π, π] since we want the instantaneous
 * difference, not an accumulated value. Wrapping is correct here because
 * adjacent subcarriers should have small phase differences (~0 in free space).
 *
 * @param {number[]} phases - Raw phase angles (length NUM_SUBCARRIERS), may contain NaN
 * @returns {number[]} Phase differences (length NUM_SUBCARRIERS - 1), NaN where either neighbor is invalid
 */
export function computeAdjacentPhaseDiffs(phases) {
  if (phases.length !== NUM_SUBCARRIERS) {
    throw new Error(
      `Expected ${NUM_SUBCARRIERS} phases, got ${phases.length}`
    );
  }

  const diffs = new Array(NUM_PHASE_DIFFS);
  for (let k = 0; k < NUM_PHASE_DIFFS; k++) {
    const p1 = phases[k];
    const p2 = phases[k + 1];

    // If either subcarrier has invalid phase, propagate NaN
    if (Number.isNaN(p1) || Number.isNaN(p2)) {
      diffs[k] = NaN;
      continue;
    }

    // Compute difference and wrap to [-π, π]
    let diff = p2 - p1;
    diff = wrapToPi(diff);
    diffs[k] = diff;
  }

  return diffs;
}

// ---------------------------------------------------------------------------
// Linear Phase Unwrapping
// ---------------------------------------------------------------------------

/**
 * Unwrap a phase sequence by adding ±2π at discontinuities.
 *
 * Phase angles from atan2 are confined to [-π, π]. When the true underlying
 * phase crosses ±π, a jump of ~2π appears. Unwrapping detects these jumps
 * (where |Δφ| > π) and adds the appropriate multiple of 2π to make the
 * sequence continuous.
 *
 * NaN values are skipped — the unwrap state carries forward past them.
 *
 * @param {number[]} phases - Wrapped phase angles in radians
 * @returns {number[]} Unwrapped phase sequence (continuous, may exceed [-π, π])
 */
export function unwrapPhase(phases) {
  const unwrapped = new Array(phases.length);

  // Find the first valid phase to start from
  let lastValid = NaN;
  let offset = 0;

  for (let k = 0; k < phases.length; k++) {
    if (Number.isNaN(phases[k])) {
      unwrapped[k] = NaN;
      continue;
    }

    if (Number.isNaN(lastValid)) {
      // First valid value — no unwrapping needed
      unwrapped[k] = phases[k];
      lastValid = phases[k];
      continue;
    }

    // Compute expected value (previous + offset) vs actual
    let diff = phases[k] - lastValid;
    // Accumulate wraps: if diff > π, subtract 2π; if diff < -π, add 2π
    if (diff > Math.PI) {
      offset -= TWO_PI;
    } else if (diff < -Math.PI) {
      offset += TWO_PI;
    }

    unwrapped[k] = phases[k] + offset;
    lastValid = phases[k];
  }

  return unwrapped;
}

/**
 * Fit a linear trend to unwrapped phases and compute residuals.
 *
 * In an ideal single-path environment, the phase across OFDM subcarriers
 * follows a linear progression: φ[k] = a·k + b, where the slope (a)
 * relates to the propagation delay (Time of Flight) and the intercept (b)
 * is a common phase offset.
 *
 * Human presence creates additional multipath reflections that cause
 * deviations from this linear trend. The residuals (actual - fitted) encode
 * these deviations and serve as powerful features for presence detection.
 *
 * Uses least-squares linear regression: y = slope * x + intercept
 *
 * @param {number[]} unwrappedPhases - Unwrapped phase sequence (may contain NaN)
 * @returns {{
 *   slope: number,
 *   intercept: number,
 *   residuals: number[],
 *   residualStd: number,
 *   validCount: number
 * }}
 *   slope: Phase slope (related to propagation delay)
 *   intercept: Phase offset
 *   residuals: Per-subcarrier deviation from linear fit (NaN where input is NaN)
 *   residualStd: Standard deviation of residuals (0 if < 2 valid points)
 *   validCount: Number of valid (non-NaN) data points used in the fit
 */
export function fitLinearPhase(unwrappedPhases) {
  // Collect valid (index, phase) pairs
  const validX = [];
  const validY = [];
  for (let k = 0; k < unwrappedPhases.length; k++) {
    if (!Number.isNaN(unwrappedPhases[k])) {
      validX.push(k);
      validY.push(unwrappedPhases[k]);
    }
  }

  const n = validX.length;
  const result = {
    slope: 0,
    intercept: 0,
    residuals: new Array(unwrappedPhases.length).fill(NaN),
    residualStd: 0,
    validCount: n,
  };

  if (n < 2) {
    return result;
  }

  // Least-squares linear regression: y = slope * x + intercept
  // Using the standard formulas:
  //   slope = (n·Σxy - Σx·Σy) / (n·Σx² - (Σx)²)
  //   intercept = (Σy - slope·Σx) / n
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += validX[i];
    sumY += validY[i];
    sumXY += validX[i] * validY[i];
    sumX2 += validX[i] * validX[i];
  }

  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-15) {
    // All x values are the same — degenerate case
    result.slope = 0;
    result.intercept = sumY / n;
  } else {
    result.slope = (n * sumXY - sumX * sumY) / denom;
    result.intercept = (sumY - result.slope * sumX) / n;
  }

  // Compute residuals and their standard deviation
  let sumResidSq = 0;
  for (let k = 0; k < unwrappedPhases.length; k++) {
    if (Number.isNaN(unwrappedPhases[k])) continue;
    const fitted = result.slope * k + result.intercept;
    const residual = unwrappedPhases[k] - fitted;
    result.residuals[k] = residual;
    sumResidSq += residual * residual;
  }

  // Bessel-corrected std (divide by n-2 since we estimated 2 parameters)
  if (n > 2) {
    result.residualStd = Math.sqrt(sumResidSq / (n - 2));
  } else {
    result.residualStd = 0;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Per-Band Phase Statistics
// ---------------------------------------------------------------------------

/**
 * Compute phase-based features aggregated by frequency band.
 *
 * Groups phase differences into the 8 standard subcarrier bands and computes
 * statistics per band. This provides spatially-resolved phase information
 * that complements the amplitude-based band features from amplitude.js.
 *
 * @param {number[]} phaseDiffs - Adjacent phase differences (length 51)
 * @returns {{
 *   bandPhaseMeans: number[],
 *   bandPhaseStds: number[],
 *   bandPhaseRanges: number[],
 *   overallPhaseStd: number,
 *   interBandPhaseVar: number
 * }}
 *   bandPhaseMeans: Mean phase difference per band [8]
 *   bandPhaseStds: Std dev of phase diffs per band [8]
 *   bandPhaseRanges: Max-min phase diff range per band [8]
 *   overallPhaseStd: Std dev across all valid phase diffs
 *   interBandPhaseVar: Variance of band means (phase spatial spread)
 */
export function computeBandPhaseFeatures(phaseDiffs) {
  if (phaseDiffs.length !== NUM_PHASE_DIFFS) {
    throw new Error(
      `Expected ${NUM_PHASE_DIFFS} phase diffs, got ${phaseDiffs.length}`
    );
  }

  const bandPhaseMeans = new Array(NUM_BANDS).fill(0);
  const bandPhaseStds = new Array(NUM_BANDS).fill(0);
  const bandPhaseRanges = new Array(NUM_BANDS).fill(0);

  // Phase diffs have indices 0..50, mapping to subcarrier pairs (0,1)..(50,51).
  // A phase diff at index k involves subcarriers k and k+1.
  // We assign diff[k] to whichever band subcarrier k belongs to.
  for (let b = 0; b < NUM_BANDS; b++) {
    const { start, end } = SUBCARRIER_BANDS[b];
    // Collect phase diffs whose source subcarrier falls in this band
    // diff[k] uses subcarriers k and k+1, so k ranges from start to min(end-1, 50)
    const bandDiffs = [];
    const diffEnd = Math.min(end - 1, NUM_PHASE_DIFFS);
    for (let k = start; k < diffEnd; k++) {
      if (!Number.isNaN(phaseDiffs[k])) {
        bandDiffs.push(phaseDiffs[k]);
      }
    }

    if (bandDiffs.length === 0) continue;

    // Mean
    let sum = 0;
    for (let j = 0; j < bandDiffs.length; j++) sum += bandDiffs[j];
    const m = sum / bandDiffs.length;
    bandPhaseMeans[b] = m;

    // Variance and range
    let sumSq = 0;
    let min = Infinity, max = -Infinity;
    for (let j = 0; j < bandDiffs.length; j++) {
      const diff = bandDiffs[j] - m;
      sumSq += diff * diff;
      if (bandDiffs[j] < min) min = bandDiffs[j];
      if (bandDiffs[j] > max) max = bandDiffs[j];
    }
    bandPhaseStds[b] = bandDiffs.length > 1
      ? Math.sqrt(sumSq / (bandDiffs.length - 1))
      : 0;
    bandPhaseRanges[b] = max - min;
  }

  // Overall phase std across all valid diffs
  const allValid = phaseDiffs.filter(d => !Number.isNaN(d));
  let overallPhaseStd = 0;
  if (allValid.length > 1) {
    let sum = 0;
    for (let j = 0; j < allValid.length; j++) sum += allValid[j];
    const m = sum / allValid.length;
    let sumSq = 0;
    for (let j = 0; j < allValid.length; j++) {
      const diff = allValid[j] - m;
      sumSq += diff * diff;
    }
    overallPhaseStd = Math.sqrt(sumSq / (allValid.length - 1));
  }

  // Inter-band phase variance (variance of band means)
  let interBandPhaseVar = 0;
  const validBandMeans = bandPhaseMeans.filter((_, b) => {
    const { start, end } = SUBCARRIER_BANDS[b];
    const diffEnd = Math.min(end - 1, NUM_PHASE_DIFFS);
    // Check if this band has any valid diffs
    for (let k = start; k < diffEnd; k++) {
      if (!Number.isNaN(phaseDiffs[k])) return true;
    }
    return false;
  });
  if (validBandMeans.length > 1) {
    let sum = 0;
    for (let j = 0; j < validBandMeans.length; j++) sum += validBandMeans[j];
    const m = sum / validBandMeans.length;
    let sumSq = 0;
    for (let j = 0; j < validBandMeans.length; j++) {
      const diff = validBandMeans[j] - m;
      sumSq += diff * diff;
    }
    interBandPhaseVar = sumSq / (validBandMeans.length - 1);
  }

  return {
    bandPhaseMeans,
    bandPhaseStds,
    bandPhaseRanges,
    overallPhaseStd,
    interBandPhaseVar,
  };
}

// ---------------------------------------------------------------------------
// High-Level Phase Feature Pipeline
// ---------------------------------------------------------------------------

/**
 * Complete phase feature extraction pipeline: from raw CSI bytes to phase features.
 *
 * This is the main entry point for phase processing. It:
 *   1. Extracts I/Q samples and computes per-subcarrier phase angles
 *   2. Unwraps the phase sequence to remove 2π discontinuities
 *   3. Fits a linear trend and computes residuals (multipath signature)
 *   4. Computes adjacent subcarrier phase differences
 *   5. Aggregates per-band phase statistics
 *
 * @param {Buffer|Uint8Array} csiData - Raw I/Q CSI payload (104 bytes)
 * @returns {{
 *   phaseDiffs: number[],
 *   unwrappedPhases: number[],
 *   linearFit: { slope: number, intercept: number, residuals: number[], residualStd: number, validCount: number },
 *   bandFeatures: { bandPhaseMeans: number[], bandPhaseStds: number[], bandPhaseRanges: number[], overallPhaseStd: number, interBandPhaseVar: number },
 *   quality: { validSubcarriers: number, totalSubcarriers: number, validFraction: number }
 * }}
 * @throws {Error} If CSI payload is invalid
 */
export function extractPhaseFeatures(csiData) {
  // Step 1: Extract raw phases from I/Q data
  const { phases, magnitudes, validCount } = extractPhases(csiData);

  // Step 2: Unwrap phases for linear fit
  const unwrappedPhases = unwrapPhase(phases);

  // Step 3: Fit linear trend and get residuals
  const linearFit = fitLinearPhase(unwrappedPhases);

  // Step 4: Compute adjacent phase differences (from wrapped phases)
  const phaseDiffs = computeAdjacentPhaseDiffs(phases);

  // Step 5: Aggregate per-band phase statistics
  const bandFeatures = computeBandPhaseFeatures(phaseDiffs);

  return {
    phaseDiffs,
    unwrappedPhases,
    linearFit,
    bandFeatures,
    quality: {
      validSubcarriers: validCount,
      totalSubcarriers: NUM_SUBCARRIERS,
      validFraction: validCount / NUM_SUBCARRIERS,
    },
  };
}

// ---------------------------------------------------------------------------
// Utility: Phase Wrapping
// ---------------------------------------------------------------------------

/**
 * Wrap an angle to the range [-π, π].
 *
 * @param {number} angle - Angle in radians
 * @returns {number} Wrapped angle in [-π, π]
 */
export function wrapToPi(angle) {
  // Modular arithmetic approach — handles arbitrary multiples of 2π
  let wrapped = angle % TWO_PI;
  if (wrapped > Math.PI) wrapped -= TWO_PI;
  if (wrapped < -Math.PI) wrapped += TWO_PI;
  return wrapped;
}
