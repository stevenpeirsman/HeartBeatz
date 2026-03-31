// ==============================================================================
// Short-Time FFT / Doppler Motion Classification (ACC-01-T3)
// ==============================================================================
// Implements a Short-Time FFT (STFFT) on per-subcarrier CSI amplitude time
// series to extract Doppler-domain features for motion classification.
//
// Physical background:
//   When a person moves in a WiFi-sensed environment, the CSI amplitude on each
//   subcarrier exhibits time-varying fluctuations. The frequency of these
//   fluctuations encodes the speed and type of motion:
//
//   - Breathing:  0.2 – 0.5 Hz  (12–30 breaths/min, subtle chest displacement)
//   - Fidgeting:  0.5 – 1.0 Hz  (small postural shifts, hand gestures)
//   - Walking:    1.0 – 3.0 Hz  (limb swing, torso displacement)
//   - Running:    3.0 – 6.0 Hz  (fast limb cadence)
//
//   By computing a windowed FFT on the time-domain CSI signal, we project these
//   fluctuations into the frequency domain. The resulting Doppler spectrum tells
//   us what kinds of motion are present and how energetic they are.
//
// Design:
//   - Uses a real-valued radix-2 FFT (no external dependencies)
//   - Hann window to reduce spectral leakage
//   - Per-subcarrier spectra are averaged across all subcarriers for robustness
//   - Features: peak frequency, peak energy, band energies, spectral centroid,
//     spectral entropy, motion classification label
//
// Performance:
//   FFT of 64 or 128 points on 52 subcarriers at 20 Hz ≈ 0.2ms on N100.
//   Well within the 40% CPU budget.
//
// All functions are pure — no side effects, no state. Stateful buffering is
// handled by the caller (DopplerAnalyzer class at the bottom).
// ==============================================================================

import {
  NUM_SUBCARRIERS,
  BREATHING_FREQ_MIN,
  BREATHING_FREQ_MAX,
} from '../shared/constants.js';
import pino from 'pino';

/** Module-level logger for Doppler analysis state transitions. */
const logger = pino({ name: 'doppler' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default FFT size (must be power of 2). 64 points at 20 Hz → 3.2s window. */
export const DEFAULT_FFT_SIZE = 64;

/** Minimum FFT size supported. */
export const MIN_FFT_SIZE = 16;

/** Maximum FFT size supported (to bound memory on N100). */
export const MAX_FFT_SIZE = 512;

/**
 * Doppler frequency band definitions (Hz).
 * Each band corresponds to a motion type, enabling classification.
 * @type {ReadonlyArray<{name: string, minHz: number, maxHz: number, description: string}>}
 */
export const DOPPLER_BANDS = Object.freeze([
  { name: 'breathing',  minHz: 0.2, maxHz: 0.5, description: 'Respiratory motion (12-30 breaths/min)' },
  { name: 'fidgeting',  minHz: 0.5, maxHz: 1.0, description: 'Small postural shifts, gestures' },
  { name: 'walking',    minHz: 1.0, maxHz: 3.0, description: 'Normal gait, limb swing' },
  { name: 'running',    minHz: 3.0, maxHz: 6.0, description: 'Fast locomotion' },
]);

/** Number of Doppler bands. */
export const NUM_DOPPLER_BANDS = DOPPLER_BANDS.length;

/**
 * Motion classification labels returned by classifyMotion().
 * @enum {string}
 */
export const MOTION_CLASS = Object.freeze({
  NONE:       'none',
  BREATHING:  'breathing',
  FIDGETING:  'fidgeting',
  WALKING:    'walking',
  RUNNING:    'running',
  MIXED:      'mixed',
});

/**
 * Minimum spectral energy (sum across all bins) to consider motion present.
 * Below this threshold, we classify as NONE. This avoids false positives from
 * quantization noise in the ESP32's 8-bit I/Q ADC.
 * Tuned empirically: typical noise floor ≈ 0.5–2.0 energy units at 64-pt FFT.
 */
export const NOISE_FLOOR_ENERGY = 3.0;

/**
 * Minimum fraction of total energy a band must contain to be considered
 * "dominant" for classification purposes.
 */
export const BAND_DOMINANCE_THRESHOLD = 0.35;

// ---------------------------------------------------------------------------
// Hann Window
// ---------------------------------------------------------------------------

/**
 * Generate a Hann (raised cosine) window of length N.
 *
 * w[n] = 0.5 * (1 - cos(2πn / (N-1)))
 *
 * The Hann window reduces spectral leakage at the cost of slightly wider main
 * lobe (1.5x vs rectangular). For our application the leakage reduction is
 * essential — motion bands are close together and we need clean separation.
 *
 * Results are cached internally for performance (one allocation per FFT size).
 *
 * @param {number} n - Window length
 * @returns {Float64Array} Window coefficients
 */
const _hannCache = new Map();

export function hannWindow(n) {
  if (n < 1) throw new RangeError(`Window length must be ≥ 1, got ${n}`);

  if (_hannCache.has(n)) return _hannCache.get(n);

  const w = new Float64Array(n);
  if (n === 1) {
    w[0] = 1.0;
  } else {
    const factor = (2 * Math.PI) / (n - 1);
    for (let i = 0; i < n; i++) {
      w[i] = 0.5 * (1 - Math.cos(factor * i));
    }
  }

  _hannCache.set(n, w);
  return w;
}

// ---------------------------------------------------------------------------
// Radix-2 FFT (real-valued input)
// ---------------------------------------------------------------------------

/**
 * Compute the magnitude spectrum of a real-valued signal using radix-2 FFT.
 *
 * Returns only the first N/2 + 1 bins (DC to Nyquist), since the spectrum of
 * a real signal is conjugate-symmetric.
 *
 * Implementation: Cooley-Tukey decimation-in-time, in-place bit-reversal.
 * No external dependencies — pure JavaScript for portability on MeLE N100.
 *
 * @param {Float64Array|number[]} signal - Time-domain signal (length must be power of 2)
 * @returns {{ magnitudes: Float64Array, powers: Float64Array }}
 *   magnitudes: |X[k]| for k = 0..N/2 (length N/2 + 1)
 *   powers: |X[k]|² for k = 0..N/2 (length N/2 + 1)
 * @throws {Error} If signal length is not a power of 2
 */
export function fftMagnitude(signal) {
  const N = signal.length;
  if (N < 2 || (N & (N - 1)) !== 0) {
    throw new Error(`FFT size must be a power of 2, got ${N}`);
  }

  // Copy input into real/imag arrays
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    re[i] = signal[i];
  }

  // Bit-reversal permutation
  let j = 0;
  for (let i = 0; i < N; i++) {
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
    let m = N >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }

  // Cooley-Tukey butterfly computation
  for (let size = 2; size <= N; size *= 2) {
    const halfSize = size / 2;
    const angle = (-2 * Math.PI) / size;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);

    for (let i = 0; i < N; i += size) {
      let curRe = 1.0;
      let curIm = 0.0;

      for (let k = 0; k < halfSize; k++) {
        const evenIdx = i + k;
        const oddIdx = i + k + halfSize;

        const tRe = curRe * re[oddIdx] - curIm * im[oddIdx];
        const tIm = curRe * im[oddIdx] + curIm * re[oddIdx];

        re[oddIdx] = re[evenIdx] - tRe;
        im[oddIdx] = im[evenIdx] - tIm;
        re[evenIdx] += tRe;
        im[evenIdx] += tIm;

        // Rotate twiddle factor
        const nextRe = curRe * wRe - curIm * wIm;
        const nextIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
        curIm = nextIm;
      }
    }
  }

  // Extract magnitude and power for bins 0..N/2
  const numBins = (N / 2) + 1;
  const magnitudes = new Float64Array(numBins);
  const powers = new Float64Array(numBins);

  for (let k = 0; k < numBins; k++) {
    const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    magnitudes[k] = mag;
    powers[k] = re[k] * re[k] + im[k] * im[k];
  }

  return { magnitudes, powers };
}

// ---------------------------------------------------------------------------
// Doppler Spectrum Computation
// ---------------------------------------------------------------------------

/**
 * Compute the Doppler spectrum from a single subcarrier's amplitude time series.
 *
 * Steps:
 *   1. Remove DC offset (subtract mean) — we don't care about absolute amplitude
 *   2. Apply Hann window to reduce spectral leakage
 *   3. Compute FFT magnitude spectrum
 *   4. Map frequency bins to Hz using the sample rate
 *
 * @param {Float64Array|number[]} timeSeries - Amplitude values over time (length = fftSize)
 * @param {number} sampleRateHz - Sampling rate in Hz (typically 20 Hz for CSI frames)
 * @returns {{
 *   freqs: Float64Array,
 *   magnitudes: Float64Array,
 *   powers: Float64Array,
 *   binWidthHz: number
 * }}
 *   freqs: Frequency axis in Hz (length N/2 + 1)
 *   magnitudes: Magnitude spectrum (length N/2 + 1)
 *   powers: Power spectrum (length N/2 + 1)
 *   binWidthHz: Frequency resolution (Hz per bin)
 */
export function computeDopplerSpectrum(timeSeries, sampleRateHz) {
  const N = timeSeries.length;
  if (N < MIN_FFT_SIZE) {
    throw new Error(`Time series too short: need ≥ ${MIN_FFT_SIZE} samples, got ${N}`);
  }
  if (sampleRateHz <= 0) {
    throw new Error(`Sample rate must be positive, got ${sampleRateHz}`);
  }

  // Step 1: Remove DC offset (mean subtraction)
  let sum = 0;
  for (let i = 0; i < N; i++) sum += timeSeries[i];
  const dcOffset = sum / N;

  // Step 2: Apply Hann window
  const window = hannWindow(N);
  const windowed = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    windowed[i] = (timeSeries[i] - dcOffset) * window[i];
  }

  // Step 3: FFT
  const { magnitudes, powers } = fftMagnitude(windowed);

  // Step 4: Frequency axis
  const numBins = magnitudes.length;
  const binWidthHz = sampleRateHz / N;
  const freqs = new Float64Array(numBins);
  for (let k = 0; k < numBins; k++) {
    freqs[k] = k * binWidthHz;
  }

  return { freqs, magnitudes, powers, binWidthHz };
}

/**
 * Compute averaged Doppler spectrum across multiple subcarriers.
 *
 * Each row of the input matrix is a single subcarrier's amplitude time series.
 * We compute the power spectrum for each subcarrier independently, then average
 * across subcarriers. This averaging:
 *   - Reduces noise (subcarrier-specific interference averages out)
 *   - Strengthens true motion signals (correlated across subcarriers)
 *   - Is equivalent to the mean periodogram in spectral estimation theory
 *
 * @param {Float64Array[]|number[][]} subcarrierTimeSeries
 *   Array of time series, one per subcarrier. All must have the same length.
 *   Outer length: number of subcarriers (typically 52)
 *   Inner length: number of time samples (must be power of 2)
 * @param {number} sampleRateHz - Sampling rate in Hz
 * @returns {{
 *   freqs: Float64Array,
 *   avgMagnitudes: Float64Array,
 *   avgPowers: Float64Array,
 *   binWidthHz: number,
 *   numSubcarriers: number
 * }}
 */
export function computeAverageDopplerSpectrum(subcarrierTimeSeries, sampleRateHz) {
  if (!subcarrierTimeSeries || subcarrierTimeSeries.length === 0) {
    throw new Error('At least one subcarrier time series is required');
  }

  const numSC = subcarrierTimeSeries.length;
  const N = subcarrierTimeSeries[0].length;

  // Validate all series have same length
  for (let sc = 1; sc < numSC; sc++) {
    if (subcarrierTimeSeries[sc].length !== N) {
      throw new Error(
        `Subcarrier ${sc} has length ${subcarrierTimeSeries[sc].length}, expected ${N}`
      );
    }
  }

  // Compute first spectrum to get dimensions
  const first = computeDopplerSpectrum(subcarrierTimeSeries[0], sampleRateHz);
  const numBins = first.magnitudes.length;
  const sumMag = new Float64Array(numBins);
  const sumPow = new Float64Array(numBins);

  for (let k = 0; k < numBins; k++) {
    sumMag[k] = first.magnitudes[k];
    sumPow[k] = first.powers[k];
  }

  // Accumulate remaining subcarriers
  for (let sc = 1; sc < numSC; sc++) {
    const spec = computeDopplerSpectrum(subcarrierTimeSeries[sc], sampleRateHz);
    for (let k = 0; k < numBins; k++) {
      sumMag[k] += spec.magnitudes[k];
      sumPow[k] += spec.powers[k];
    }
  }

  // Average
  const avgMagnitudes = new Float64Array(numBins);
  const avgPowers = new Float64Array(numBins);
  for (let k = 0; k < numBins; k++) {
    avgMagnitudes[k] = sumMag[k] / numSC;
    avgPowers[k] = sumPow[k] / numSC;
  }

  return {
    freqs: first.freqs,
    avgMagnitudes,
    avgPowers,
    binWidthHz: first.binWidthHz,
    numSubcarriers: numSC,
  };
}

// ---------------------------------------------------------------------------
// Doppler Feature Extraction
// ---------------------------------------------------------------------------

/**
 * Extract Doppler-domain features from an averaged power spectrum.
 *
 * Features computed:
 *   - Peak frequency and energy (dominant motion frequency)
 *   - Per-band energies (breathing, fidgeting, walking, running)
 *   - Band energy fractions (normalized by total)
 *   - Spectral centroid (energy-weighted mean frequency)
 *   - Spectral entropy (flatness measure, high = broadband motion)
 *   - Motion classification label
 *
 * @param {Float64Array} freqs - Frequency axis in Hz (length N/2 + 1)
 * @param {Float64Array} powers - Power spectrum (length N/2 + 1)
 * @returns {{
 *   peakFreqHz: number,
 *   peakPower: number,
 *   bandEnergies: number[],
 *   bandFractions: number[],
 *   totalEnergy: number,
 *   spectralCentroid: number,
 *   spectralEntropy: number,
 *   motionClass: string
 * }}
 */
export function extractDopplerFeatures(freqs, powers) {
  if (freqs.length !== powers.length) {
    throw new Error(`freqs and powers must have same length`);
  }

  const numBins = freqs.length;

  // --- Total energy (exclude DC bin at index 0) ---
  let totalEnergy = 0;
  for (let k = 1; k < numBins; k++) {
    totalEnergy += powers[k];
  }

  // --- Peak frequency (exclude DC) ---
  let peakPower = 0;
  let peakIdx = 1;
  for (let k = 1; k < numBins; k++) {
    if (powers[k] > peakPower) {
      peakPower = powers[k];
      peakIdx = k;
    }
  }
  const peakFreqHz = freqs[peakIdx];

  // --- Per-band energies ---
  const bandEnergies = new Array(NUM_DOPPLER_BANDS).fill(0);
  const bandFractions = new Array(NUM_DOPPLER_BANDS).fill(0);

  for (let b = 0; b < NUM_DOPPLER_BANDS; b++) {
    const { minHz, maxHz } = DOPPLER_BANDS[b];
    for (let k = 1; k < numBins; k++) {
      if (freqs[k] >= minHz && freqs[k] < maxHz) {
        bandEnergies[b] += powers[k];
      }
    }
    bandFractions[b] = totalEnergy > 0 ? bandEnergies[b] / totalEnergy : 0;
  }

  // --- Spectral centroid (energy-weighted mean frequency, excluding DC) ---
  // Centroid = Σ(f[k] * P[k]) / Σ(P[k])  for k > 0
  let weightedSum = 0;
  for (let k = 1; k < numBins; k++) {
    weightedSum += freqs[k] * powers[k];
  }
  const spectralCentroid = totalEnergy > 0 ? weightedSum / totalEnergy : 0;

  // --- Spectral entropy (Shannon entropy of normalized power distribution) ---
  // High entropy → broadband (mixed motion), low entropy → narrowband (single motion)
  // H = -Σ p[k] * log2(p[k])  where p[k] = P[k] / totalEnergy
  let spectralEntropy = 0;
  if (totalEnergy > 0) {
    for (let k = 1; k < numBins; k++) {
      const p = powers[k] / totalEnergy;
      if (p > 1e-15) {
        spectralEntropy -= p * Math.log2(p);
      }
    }
  }

  // --- Motion classification ---
  const motionClass = classifyMotion(totalEnergy, bandFractions);

  return {
    peakFreqHz,
    peakPower,
    bandEnergies,
    bandFractions,
    totalEnergy,
    spectralCentroid,
    spectralEntropy,
    motionClass,
  };
}

/**
 * Classify the dominant motion type from Doppler band energy fractions.
 *
 * Classification logic:
 *   1. If total energy < NOISE_FLOOR_ENERGY → NONE
 *   2. If one band exceeds BAND_DOMINANCE_THRESHOLD → that motion type
 *   3. If multiple bands are active → MIXED
 *
 * @param {number} totalEnergy - Total spectral energy (excluding DC)
 * @param {number[]} bandFractions - Fraction of energy in each Doppler band [4]
 * @returns {string} Motion class label from MOTION_CLASS enum
 */
export function classifyMotion(totalEnergy, bandFractions) {
  if (totalEnergy < NOISE_FLOOR_ENERGY) {
    return MOTION_CLASS.NONE;
  }

  // Find the dominant band (highest energy fraction)
  let maxFraction = 0;
  let dominantBand = -1;
  let activeBandCount = 0;

  for (let b = 0; b < NUM_DOPPLER_BANDS; b++) {
    if (bandFractions[b] > maxFraction) {
      maxFraction = bandFractions[b];
      dominantBand = b;
    }
    // Count bands with meaningful energy (>10% of total)
    if (bandFractions[b] > 0.10) {
      activeBandCount++;
    }
  }

  // If dominant band exceeds threshold → single motion type
  if (maxFraction >= BAND_DOMINANCE_THRESHOLD) {
    return DOPPLER_BANDS[dominantBand].name;
  }

  // Multiple bands active → mixed motion
  if (activeBandCount >= 2) {
    return MOTION_CLASS.MIXED;
  }

  // Low but present energy, no dominant band
  return MOTION_CLASS.NONE;
}

// ---------------------------------------------------------------------------
// Stateful Doppler Analyzer
// ---------------------------------------------------------------------------

/**
 * DopplerAnalyzer maintains a circular buffer of per-subcarrier amplitude
 * histories and computes Doppler spectra on demand.
 *
 * Usage:
 *   const analyzer = new DopplerAnalyzer({ fftSize: 64, sampleRateHz: 20 });
 *   // Feed frames as they arrive:
 *   analyzer.pushFrame(amplitudes);   // amplitudes: number[52]
 *   // When enough frames buffered:
 *   const features = analyzer.analyze();
 *
 * The analyzer is designed for a single CSI node. For multi-node setups,
 * create one DopplerAnalyzer per node.
 */
export class DopplerAnalyzer {
  /**
   * @param {Object} options
   * @param {number} [options.fftSize=64] - FFT window size (power of 2)
   * @param {number} [options.sampleRateHz=20] - CSI frame rate in Hz
   * @param {number} [options.numSubcarriers=52] - Number of subcarriers
   */
  constructor({ fftSize = DEFAULT_FFT_SIZE, sampleRateHz = 20, numSubcarriers = NUM_SUBCARRIERS } = {}) {
    if (fftSize < MIN_FFT_SIZE || fftSize > MAX_FFT_SIZE) {
      throw new RangeError(
        `fftSize must be ${MIN_FFT_SIZE}–${MAX_FFT_SIZE}, got ${fftSize}`
      );
    }
    if ((fftSize & (fftSize - 1)) !== 0) {
      throw new Error(`fftSize must be a power of 2, got ${fftSize}`);
    }

    /** @type {number} */
    this.fftSize = fftSize;
    /** @type {number} */
    this.sampleRateHz = sampleRateHz;
    /** @type {number} */
    this.numSubcarriers = numSubcarriers;

    /**
     * Circular buffer: one Float64Array per subcarrier, each of length fftSize.
     * @type {Float64Array[]}
     */
    this._buffers = Array.from(
      { length: numSubcarriers },
      () => new Float64Array(fftSize)
    );

    /** Write pointer into the circular buffer. @type {number} */
    this._writeIdx = 0;

    /** Number of frames pushed since last reset. @type {number} */
    this._frameCount = 0;

    /** Previous motion classification for state transition detection. @type {string|null} */
    this._prevMotionClass = null;
  }

  /**
   * Push a new frame of subcarrier amplitudes into the circular buffer.
   *
   * @param {number[]} amplitudes - Amplitude per subcarrier (length = numSubcarriers)
   * @throws {Error} If amplitudes length doesn't match numSubcarriers
   */
  pushFrame(amplitudes) {
    if (amplitudes.length !== this.numSubcarriers) {
      throw new Error(
        `Expected ${this.numSubcarriers} amplitudes, got ${amplitudes.length}`
      );
    }

    for (let sc = 0; sc < this.numSubcarriers; sc++) {
      this._buffers[sc][this._writeIdx] = amplitudes[sc];
    }

    this._writeIdx = (this._writeIdx + 1) % this.fftSize;
    this._frameCount++;
  }

  /**
   * Check if enough frames have been accumulated for a valid FFT.
   * @returns {boolean}
   */
  isReady() {
    return this._frameCount >= this.fftSize;
  }

  /**
   * Get the number of frames buffered so far.
   * @returns {number}
   */
  get frameCount() {
    return this._frameCount;
  }

  /**
   * Compute Doppler features from the current buffer contents.
   *
   * Rearranges the circular buffer into chronological order, computes the
   * averaged Doppler spectrum across all subcarriers, and extracts features.
   *
   * @returns {{
   *   features: ReturnType<typeof extractDopplerFeatures>,
   *   spectrum: { freqs: Float64Array, avgPowers: Float64Array },
   *   ready: boolean,
   *   framesBuffered: number
   * } | null} Null if not enough frames buffered
   */
  analyze() {
    if (!this.isReady()) {
      return null;
    }

    // Rearrange circular buffer to chronological order
    const timeSeries = this._getChronologicalSeries();

    // Compute averaged spectrum
    const { freqs, avgPowers } = computeAverageDopplerSpectrum(
      timeSeries,
      this.sampleRateHz
    );

    // Extract features
    const features = extractDopplerFeatures(freqs, avgPowers);

    // Log state transitions when motion class changes
    if (this._prevMotionClass !== null && features.motionClass !== this._prevMotionClass) {
      logger.info({
        event: 'motion_class_change',
        from: this._prevMotionClass,
        to: features.motionClass,
        peakHz: features.peakFrequency,
        totalEnergy: features.totalEnergy,
        framesBuffered: Math.min(this._frameCount, this.fftSize),
      }, `Motion class transition: ${this._prevMotionClass} → ${features.motionClass}`);
    }
    this._prevMotionClass = features.motionClass;

    return {
      features,
      spectrum: { freqs, avgPowers },
      ready: true,
      framesBuffered: Math.min(this._frameCount, this.fftSize),
    };
  }

  /**
   * Reset the analyzer state (clear all buffers).
   */
  reset() {
    logger.debug({
      event: 'doppler_analyzer_reset',
      previousFrameCount: this._frameCount,
      previousMotionClass: this._prevMotionClass,
    }, 'DopplerAnalyzer reset — clearing all buffers');

    for (let sc = 0; sc < this.numSubcarriers; sc++) {
      this._buffers[sc].fill(0);
    }
    this._writeIdx = 0;
    this._frameCount = 0;
    this._prevMotionClass = null;
  }

  /**
   * Rearrange circular buffers into chronological order for FFT.
   * Returns an array of Float64Array, one per subcarrier.
   *
   * @private
   * @returns {Float64Array[]}
   */
  _getChronologicalSeries() {
    const N = this.fftSize;
    const series = new Array(this.numSubcarriers);

    for (let sc = 0; sc < this.numSubcarriers; sc++) {
      const ordered = new Float64Array(N);
      const buf = this._buffers[sc];

      // If we've written ≥ fftSize frames, _writeIdx points to the oldest sample
      // Chronological order: [writeIdx, writeIdx+1, ..., N-1, 0, 1, ..., writeIdx-1]
      for (let i = 0; i < N; i++) {
        ordered[i] = buf[(this._writeIdx + i) % N];
      }
      series[sc] = ordered;
    }

    return series;
  }
}
