// ==============================================================================
// HeartBeatz Shared Type Definitions & Factory Functions
// ==============================================================================
// JSDoc typedefs and factory functions for the data structures shared across
// the feature extraction, calibration, and ground truth modules.
//
// Since we're using plain JavaScript (not TypeScript), these serve as:
//   1. Documentation for developers (IDE autocompletion via JSDoc)
//   2. Runtime factories that enforce shape and defaults
//   3. Validation helpers for data integrity
// ==============================================================================

import { NUM_SUBCARRIERS, NUM_BANDS, SUBCARRIER_BANDS } from './constants.js';

// ---------------------------------------------------------------------------
// Core CSI Types
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ParsedCSIFrame
 * @property {number} version     - ADR-018 protocol version
 * @property {string} mac         - Node MAC address (xx:xx:xx:xx:xx:xx)
 * @property {number} seq         - Frame sequence number
 * @property {number} timestamp   - ESP32 timestamp (microseconds since boot)
 * @property {number} csiLen      - CSI payload length in bytes
 * @property {Buffer} csiData     - Raw I/Q byte pairs
 * @property {RadarData|null} radar - Optional radar piggyback data
 */

/**
 * @typedef {Object} RadarData
 * @property {number} state           - Radar detection state
 * @property {number} movingDist      - Moving target distance (cm)
 * @property {number} movingEnergy    - Moving target energy (0-255)
 * @property {number} stationaryDist  - Stationary target distance (cm)
 * @property {number} stationaryEnergy - Stationary target energy (0-255)
 */

/**
 * @typedef {Object} ComplexSample
 * @property {number} i - In-phase component (real)
 * @property {number} q - Quadrature component (imaginary)
 */

// ---------------------------------------------------------------------------
// Feature Vector Types
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} BandFeatures
 * @property {number} bandIndex       - Band index (0-7)
 * @property {string} label           - Human-readable band label
 * @property {number} meanAmplitude   - Mean amplitude across subcarriers in band
 * @property {number} variance        - Amplitude variance within band
 * @property {number} maxAmplitude    - Peak amplitude in band
 * @property {number} minAmplitude    - Minimum amplitude in band
 * @property {number} range           - Max - min amplitude spread
 */

/**
 * @typedef {Object} SubcarrierGroupResult
 * @property {BandFeatures[]} bands       - Per-band feature summaries (length = NUM_BANDS)
 * @property {number[]}       bandMeans   - Mean amplitudes per band (length = NUM_BANDS)
 * @property {number[]}       bandVars    - Variances per band (length = NUM_BANDS)
 * @property {number}         overallMean - Global mean amplitude across all subcarriers
 * @property {number}         overallVar  - Global variance across all subcarriers
 * @property {number}         interBandVar - Variance of band means (spatial spread indicator)
 */

/**
 * @typedef {Object} FeatureVector
 * @property {number}   timestamp         - Server-side timestamp (ms since epoch)
 * @property {string}   nodeMAC           - Source node MAC
 * @property {number[]} bandMeans         - Per-band mean amplitudes [8]
 * @property {number[]} bandVariances     - Per-band variances [8]
 * @property {number}   overallMean       - Global mean amplitude
 * @property {number}   overallVariance   - Global variance
 * @property {number}   interBandVariance - Variance between band means
 * @property {number[]} phaseDiffs        - Adjacent subcarrier phase differences [51]
 * @property {number}   dopplerPeak       - Dominant Doppler frequency (Hz)
 * @property {number}   dopplerEnergy     - Energy at Doppler peak
 * @property {number}   motionLevel       - Composite motion indicator [0-1]
 * @property {number}   csiQuality        - Frame quality score [0-1]
 */

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

/**
 * Create an empty BandFeatures object with sensible defaults.
 *
 * @param {number} bandIndex - Band index (0 to NUM_BANDS-1)
 * @returns {BandFeatures} Initialized band features
 */
export function createBandFeatures(bandIndex) {
  if (bandIndex < 0 || bandIndex >= NUM_BANDS) {
    throw new RangeError(`bandIndex must be 0-${NUM_BANDS - 1}, got ${bandIndex}`);
  }
  return {
    bandIndex,
    label: SUBCARRIER_BANDS[bandIndex].label,
    meanAmplitude: 0,
    variance: 0,
    maxAmplitude: 0,
    minAmplitude: 0,
    range: 0,
  };
}

/**
 * Create an empty SubcarrierGroupResult.
 *
 * @returns {SubcarrierGroupResult} Initialized grouping result
 */
export function createSubcarrierGroupResult() {
  return {
    bands: Array.from({ length: NUM_BANDS }, (_, i) => createBandFeatures(i)),
    bandMeans: new Array(NUM_BANDS).fill(0),
    bandVars: new Array(NUM_BANDS).fill(0),
    overallMean: 0,
    overallVar: 0,
    interBandVar: 0,
  };
}

/**
 * Create an empty FeatureVector with defaults.
 *
 * @param {string} nodeMAC - Source node MAC address
 * @returns {FeatureVector} Initialized feature vector
 */
export function createFeatureVector(nodeMAC) {
  return {
    timestamp: Date.now(),
    nodeMAC,
    bandMeans: new Array(NUM_BANDS).fill(0),
    bandVariances: new Array(NUM_BANDS).fill(0),
    overallMean: 0,
    overallVariance: 0,
    interBandVariance: 0,
    phaseDiffs: new Array(NUM_SUBCARRIERS - 1).fill(0),
    dopplerPeak: 0,
    dopplerEnergy: 0,
    motionLevel: 0,
    csiQuality: 0,
  };
}

// ---------------------------------------------------------------------------
// Validation Helpers
// ---------------------------------------------------------------------------

/**
 * Validate that an amplitude array has the expected number of subcarriers.
 *
 * @param {number[]} amplitudes - Array of amplitude values
 * @returns {boolean} True if valid length
 */
export function isValidAmplitudeArray(amplitudes) {
  return Array.isArray(amplitudes) && amplitudes.length === NUM_SUBCARRIERS;
}

/**
 * Validate that raw CSI I/Q data has expected byte length.
 *
 * @param {Buffer|Uint8Array} csiData - Raw I/Q bytes
 * @returns {boolean} True if valid length for 52 subcarriers
 */
export function isValidCSIPayload(csiData) {
  return csiData != null && csiData.length >= NUM_SUBCARRIERS * 2;
}

/**
 * Extract I/Q complex samples from raw CSI bytes.
 * Converts unsigned int8 pairs to signed values.
 *
 * @param {Buffer|Uint8Array} csiData - Raw interleaved I/Q bytes
 * @returns {ComplexSample[]} Array of NUM_SUBCARRIERS complex samples
 */
export function extractIQSamples(csiData) {
  const samples = [];
  for (let idx = 0; idx < NUM_SUBCARRIERS; idx++) {
    let i = csiData[idx * 2];
    let q = csiData[idx * 2 + 1];
    // Convert unsigned byte to signed int8
    if (i > 127) i -= 256;
    if (q > 127) q -= 256;
    samples.push({ i, q });
  }
  return samples;
}

/**
 * Compute amplitude from complex I/Q sample.
 *
 * @param {ComplexSample} sample - Complex sample with i and q fields
 * @returns {number} Amplitude (magnitude) = sqrt(i² + q²)
 */
export function complexAmplitude(sample) {
  return Math.sqrt(sample.i * sample.i + sample.q * sample.q);
}

/**
 * Compute phase angle from complex I/Q sample.
 *
 * @param {ComplexSample} sample - Complex sample with i and q fields
 * @returns {number} Phase angle in radians [-π, π]
 */
export function complexPhase(sample) {
  return Math.atan2(sample.q, sample.i);
}
