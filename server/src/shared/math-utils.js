// ==============================================================================
// Shared Math Utilities — DEBT-01
// ==============================================================================
// Common mathematical helper functions used across calibration modules.
// Extracted from multi-timescale.js and cusum.js to eliminate duplication.
//
// References:
//   - EMA: Brown, R.G. "Smoothing, Forecasting and Prediction of Discrete
//     Time Series", Prentice-Hall, 1963
// ==============================================================================

/**
 * Compute a single-step Exponential Moving Average (EMA) update.
 *
 * EMA_new = EMA_old * (1 - alpha) + observation * alpha
 *
 * Half-life ≈ -ln(2) / ln(1 - alpha) samples.
 * E.g., alpha=0.1 → half-life ≈ 6.6 samples; alpha=0.001 → ~693 samples.
 *
 * @param {number} current  - Current EMA value
 * @param {number} observed - New observation to incorporate
 * @param {number} alpha    - Smoothing factor, range (0, 1]. Lower = more smoothing.
 * @returns {number} Updated EMA value
 */
export function ema(current, observed, alpha) {
  return current * (1 - alpha) + observed * alpha;
}

/**
 * Clamp a numeric value within [min, max].
 *
 * @param {number} value - Value to clamp
 * @param {number} min   - Lower bound (inclusive)
 * @param {number} max   - Upper bound (inclusive)
 * @returns {number} Clamped value
 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
