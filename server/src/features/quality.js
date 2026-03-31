// ==============================================================================
// Frame Quality Scorer (ACC-01-T6)
// ==============================================================================
// Evaluates the quality of incoming CSI frames based on multiple indicators:
//
//   1. RSSI Stability — Consistent signal strength indicates stable RF conditions.
//      High RSSI variance suggests multipath changes or interference.
//
//   2. Timestamp Jitter — Regular frame spacing indicates healthy ESP32 operation.
//      High jitter suggests WiFi congestion, buffer overflows, or CPU overload.
//
//   3. Packet Loss Rate — Gaps in sequence numbers indicate dropped frames.
//      >5% loss significantly degrades feature extraction accuracy.
//
// The overall quality score is a weighted combination of these indicators,
// normalized to [0, 1] where 1 = perfect quality and 0 = unusable.
//
// All core functions are pure. The FrameQualityScorer class maintains state
// for tracking sequences and computing rolling quality metrics.
// ==============================================================================

import { NUM_SUBCARRIERS } from '../shared/constants.js';
import { isValidAmplitudeArray } from '../shared/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of recent frames to track for quality scoring. */
export const QUALITY_WINDOW_SIZE = 50;

/** Expected frame interval at 20 Hz (milliseconds). */
export const EXPECTED_FRAME_INTERVAL_MS = 50;

/** Maximum acceptable jitter as fraction of expected interval. */
export const MAX_JITTER_FRACTION = 0.5;

/**
 * Weight for each quality component in the overall score.
 * Must sum to 1.0.
 * @type {{ rssi: number, jitter: number, packetLoss: number, amplitude: number }}
 */
export const QUALITY_WEIGHTS = Object.freeze({
  rssi: 0.25,
  jitter: 0.25,
  packetLoss: 0.30,
  amplitude: 0.20,
});

/**
 * RSSI variance threshold for "good" signal stability (dBm²).
 * Below this → quality = 1.0 for RSSI component.
 * @type {number}
 */
export const RSSI_VARIANCE_GOOD = 4;

/**
 * RSSI variance threshold for "bad" signal stability (dBm²).
 * Above this → quality = 0.0 for RSSI component.
 * @type {number}
 */
export const RSSI_VARIANCE_BAD = 25;

/**
 * Minimum valid amplitude value — below this, subcarrier is likely noise.
 * @type {number}
 */
export const MIN_VALID_AMPLITUDE = 0.5;

/**
 * Minimum fraction of subcarriers with valid amplitude for a frame to be usable.
 * @type {number}
 */
export const MIN_VALID_SUBCARRIER_FRACTION = 0.7;

// ---------------------------------------------------------------------------
// Pure Functions — Individual Quality Components
// ---------------------------------------------------------------------------

/**
 * Compute RSSI stability score from a window of RSSI values.
 *
 * Maps RSSI variance to a [0, 1] quality score using linear interpolation:
 *   - variance <= RSSI_VARIANCE_GOOD → 1.0
 *   - variance >= RSSI_VARIANCE_BAD  → 0.0
 *   - in between → linear interpolation
 *
 * @param {number[]} rssiValues - Recent RSSI readings (dBm)
 * @returns {number} Quality score in [0, 1]
 */
export function computeRssiStability(rssiValues) {
  if (rssiValues.length < 2) return 1.0; // Not enough data to judge

  let sum = 0;
  for (let i = 0; i < rssiValues.length; i++) sum += rssiValues[i];
  const mean = sum / rssiValues.length;

  let sumSq = 0;
  for (let i = 0; i < rssiValues.length; i++) {
    const d = rssiValues[i] - mean;
    sumSq += d * d;
  }
  const variance = sumSq / (rssiValues.length - 1);

  if (variance <= RSSI_VARIANCE_GOOD) return 1.0;
  if (variance >= RSSI_VARIANCE_BAD) return 0.0;

  return 1.0 - (variance - RSSI_VARIANCE_GOOD) / (RSSI_VARIANCE_BAD - RSSI_VARIANCE_GOOD);
}

/**
 * Compute timestamp jitter score from a window of frame timestamps.
 *
 * Jitter is measured as the coefficient of variation (CV) of inter-frame intervals.
 * Low CV → consistent timing → high quality.
 *
 * @param {number[]} timestamps - Frame arrival timestamps (milliseconds)
 * @param {number} [expectedIntervalMs=EXPECTED_FRAME_INTERVAL_MS] - Expected interval
 * @returns {number} Quality score in [0, 1]
 */
export function computeTimestampJitter(timestamps, expectedIntervalMs = EXPECTED_FRAME_INTERVAL_MS) {
  if (timestamps.length < 3) return 1.0; // Not enough data

  // Compute inter-frame intervals
  const intervals = [];
  for (let i = 1; i < timestamps.length; i++) {
    intervals.push(timestamps[i] - timestamps[i - 1]);
  }

  // Mean interval
  let sum = 0;
  for (const iv of intervals) sum += iv;
  const mean = sum / intervals.length;

  if (mean <= 0) return 0.0;

  // Standard deviation of intervals
  let sumSq = 0;
  for (const iv of intervals) {
    const d = iv - mean;
    sumSq += d * d;
  }
  const std = Math.sqrt(sumSq / (intervals.length - 1));

  // Coefficient of variation (CV)
  const cv = std / expectedIntervalMs;

  // Map CV to quality: CV=0 → 1.0, CV >= MAX_JITTER_FRACTION → 0.0
  if (cv <= 0) return 1.0;
  if (cv >= MAX_JITTER_FRACTION) return 0.0;

  return 1.0 - cv / MAX_JITTER_FRACTION;
}

/**
 * Compute packet loss score from a sequence of frame sequence numbers.
 *
 * Counts gaps in the sequence number stream. Handles 16-bit wrap-around.
 *
 * @param {number[]} seqNumbers - Frame sequence numbers (ordered by arrival)
 * @returns {{ score: number, lossRate: number, gapCount: number }}
 *   score in [0, 1], loss rate as fraction, number of detected gaps
 */
export function computePacketLoss(seqNumbers) {
  if (seqNumbers.length < 2) return { score: 1.0, lossRate: 0, gapCount: 0 };

  let gapCount = 0;
  let totalExpected = 0;

  for (let i = 1; i < seqNumbers.length; i++) {
    // Handle 16-bit wraparound
    let diff = seqNumbers[i] - seqNumbers[i - 1];
    if (diff < 0) diff += 65536; // 16-bit wrap

    if (diff > 1) {
      gapCount += diff - 1;
    }
    totalExpected += diff;
  }

  if (totalExpected <= 0) return { score: 1.0, lossRate: 0, gapCount: 0 };

  const lossRate = gapCount / totalExpected;

  // Map loss rate to quality: 0% → 1.0, >= 10% → 0.0
  const score = lossRate <= 0 ? 1.0
    : lossRate >= 0.1 ? 0.0
    : 1.0 - lossRate / 0.1;

  return { score, lossRate, gapCount };
}

/**
 * Compute amplitude validity score for a single CSI frame.
 *
 * Checks what fraction of subcarriers have amplitudes above the noise floor.
 * Frames with many near-zero subcarriers are likely corrupted or interfered.
 *
 * @param {number[]} amplitudes - Array of 52 subcarrier amplitudes
 * @returns {number} Quality score in [0, 1]
 */
export function computeAmplitudeValidity(amplitudes) {
  if (!isValidAmplitudeArray(amplitudes)) return 0.0;

  let validCount = 0;
  for (let i = 0; i < NUM_SUBCARRIERS; i++) {
    if (amplitudes[i] >= MIN_VALID_AMPLITUDE) {
      validCount++;
    }
  }

  const fraction = validCount / NUM_SUBCARRIERS;
  if (fraction >= MIN_VALID_SUBCARRIER_FRACTION) return 1.0;
  if (fraction <= 0) return 0.0;

  return fraction / MIN_VALID_SUBCARRIER_FRACTION;
}

// ---------------------------------------------------------------------------
// Pure Functions — Combined Quality Score
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} QualityReport
 * @property {number} overall          - Combined quality score [0, 1]
 * @property {number} rssiStability    - RSSI stability component [0, 1]
 * @property {number} timestampJitter  - Jitter component [0, 1]
 * @property {number} packetLossScore  - Packet loss component [0, 1]
 * @property {number} amplitudeValidity - Amplitude validity component [0, 1]
 * @property {number} packetLossRate   - Raw packet loss fraction
 * @property {number} gapCount         - Number of detected sequence gaps
 * @property {number} frameCount       - Frames analyzed
 * @property {number} timestamp        - Computation time (ms)
 */

/**
 * Compute combined quality report from all indicators.
 *
 * @param {Object} params
 * @param {number[]} params.rssiValues - Recent RSSI readings
 * @param {number[]} params.timestamps - Frame arrival timestamps (ms)
 * @param {number[]} params.seqNumbers - Frame sequence numbers
 * @param {number[]} params.amplitudes - Latest frame amplitudes
 * @returns {QualityReport} Quality assessment
 */
export function computeQualityReport({ rssiValues, timestamps, seqNumbers, amplitudes }) {
  const rssiStability = computeRssiStability(rssiValues || []);
  const timestampJitter = computeTimestampJitter(timestamps || []);
  const { score: packetLossScore, lossRate, gapCount } = computePacketLoss(seqNumbers || []);
  const amplitudeValidity = computeAmplitudeValidity(amplitudes || []);

  const overall =
    QUALITY_WEIGHTS.rssi * rssiStability +
    QUALITY_WEIGHTS.jitter * timestampJitter +
    QUALITY_WEIGHTS.packetLoss * packetLossScore +
    QUALITY_WEIGHTS.amplitude * amplitudeValidity;

  return {
    overall: Math.max(0, Math.min(1, overall)),
    rssiStability,
    timestampJitter,
    packetLossScore,
    amplitudeValidity,
    packetLossRate: lossRate,
    gapCount,
    frameCount: (timestamps || []).length,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Stateful Frame Quality Scorer
// ---------------------------------------------------------------------------

/**
 * Stateful scorer that tracks incoming frame metadata and produces
 * rolling quality reports.
 *
 * Usage:
 *   const scorer = new FrameQualityScorer();
 *   scorer.push({ rssi: -55, timestamp: Date.now(), seq: 100, amplitudes });
 *   const report = scorer.compute();
 */
export class FrameQualityScorer {
  /**
   * @param {Object} [options]
   * @param {number} [options.windowSize=QUALITY_WINDOW_SIZE] - Sliding window size
   */
  constructor(options = {}) {
    this._windowSize = options.windowSize ?? QUALITY_WINDOW_SIZE;

    /** @type {number[]} */
    this._rssiValues = [];
    /** @type {number[]} */
    this._timestamps = [];
    /** @type {number[]} */
    this._seqNumbers = [];
    /** @type {number[] | null} */
    this._lastAmplitudes = null;
    /** @type {number} */
    this._totalFrames = 0;
  }

  /**
   * Push a new frame's metadata into the scoring window.
   *
   * @param {Object} frame
   * @param {number} [frame.rssi] - RSSI value (dBm)
   * @param {number} frame.timestamp - Arrival timestamp (ms)
   * @param {number} frame.seq - Sequence number
   * @param {number[]} [frame.amplitudes] - Amplitude array (52 elements)
   */
  push(frame) {
    if (frame.rssi !== undefined) {
      this._rssiValues.push(frame.rssi);
      if (this._rssiValues.length > this._windowSize) {
        this._rssiValues.shift();
      }
    }

    this._timestamps.push(frame.timestamp);
    if (this._timestamps.length > this._windowSize) {
      this._timestamps.shift();
    }

    this._seqNumbers.push(frame.seq);
    if (this._seqNumbers.length > this._windowSize) {
      this._seqNumbers.shift();
    }

    if (frame.amplitudes) {
      this._lastAmplitudes = frame.amplitudes;
    }

    this._totalFrames++;
  }

  /**
   * Compute quality report from current window data.
   *
   * @returns {QualityReport} Current quality assessment
   */
  compute() {
    return computeQualityReport({
      rssiValues: this._rssiValues,
      timestamps: this._timestamps,
      seqNumbers: this._seqNumbers,
      amplitudes: this._lastAmplitudes,
    });
  }

  /** @returns {number} Total frames processed */
  get totalFrames() { return this._totalFrames; }

  /** @returns {number} Frames in current window */
  get frameCount() { return this._timestamps.length; }

  /** Reset all state. */
  reset() {
    this._rssiValues = [];
    this._timestamps = [];
    this._seqNumbers = [];
    this._lastAmplitudes = null;
    this._totalFrames = 0;
  }
}
