// ==============================================================================
// Unit Tests — Short-Time FFT / Doppler Motion Classification (ACC-01-T3)
// ==============================================================================
// Tests verify:
//   1. Hann window generation and properties
//   2. FFT magnitude computation on known signals
//   3. Single-subcarrier Doppler spectrum
//   4. Multi-subcarrier averaged spectrum
//   5. Doppler feature extraction (peak, bands, centroid, entropy)
//   6. Motion classification logic
//   7. DopplerAnalyzer stateful class (push, ready, analyze, reset)
//   8. Edge cases: minimum FFT size, all-zero input, single subcarrier
//
// Run: node --test server/src/features/doppler.test.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  hannWindow,
  fftMagnitude,
  computeDopplerSpectrum,
  computeAverageDopplerSpectrum,
  extractDopplerFeatures,
  classifyMotion,
  DopplerAnalyzer,
  DEFAULT_FFT_SIZE,
  MIN_FFT_SIZE,
  MAX_FFT_SIZE,
  DOPPLER_BANDS,
  NUM_DOPPLER_BANDS,
  MOTION_CLASS,
  NOISE_FLOOR_ENERGY,
  BAND_DOMINANCE_THRESHOLD,
} from './doppler.js';
import { NUM_SUBCARRIERS } from '../shared/constants.js';

// ---------------------------------------------------------------------------
// Helpers: Synthetic signal generators
// ---------------------------------------------------------------------------

/**
 * Generate a pure sinusoidal signal.
 * @param {number} freqHz - Frequency in Hz
 * @param {number} sampleRateHz - Sample rate in Hz
 * @param {number} numSamples - Number of samples
 * @param {number} [amplitude=10] - Signal amplitude
 * @param {number} [phase=0] - Phase offset in radians
 * @returns {Float64Array}
 */
function generateSineWave(freqHz, sampleRateHz, numSamples, amplitude = 10, phase = 0) {
  const signal = new Float64Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    signal[i] = amplitude * Math.sin(2 * Math.PI * freqHz * i / sampleRateHz + phase);
  }
  return signal;
}

/**
 * Generate a multi-subcarrier dataset where all subcarriers share the
 * same sinusoidal motion at the given frequency (with small random offsets).
 * @param {number} freqHz - Motion frequency in Hz
 * @param {number} sampleRateHz - Frame rate in Hz
 * @param {number} numSamples - Buffer length (power of 2)
 * @param {number} numSC - Number of subcarriers
 * @param {number} [baseAmplitude=10] - Base signal amplitude
 * @returns {Float64Array[]}
 */
function generateMultiSubcarrierSignal(freqHz, sampleRateHz, numSamples, numSC, baseAmplitude = 10) {
  const series = [];
  for (let sc = 0; sc < numSC; sc++) {
    // Each subcarrier has slightly different amplitude and phase (realistic)
    const amp = baseAmplitude + (sc % 5) * 0.5;
    const phaseOffset = (sc * 0.1) % (2 * Math.PI);
    series.push(generateSineWave(freqHz, sampleRateHz, numSamples, amp, phaseOffset));
  }
  return series;
}

/**
 * Create an amplitude array of length numSC filled with a constant + sine variation.
 * @param {number} numSC
 * @param {number} baseValue
 * @param {number} sineValue - value to add based on index
 * @returns {number[]}
 */
function makeAmplitudeFrame(numSC, baseValue = 20, sineValue = 0) {
  return Array.from({ length: numSC }, (_, i) => baseValue + sineValue * Math.sin(i));
}

// ===========================================================================
// 1. Hann Window
// ===========================================================================

describe('hannWindow', () => {
  it('returns correct length', () => {
    const w = hannWindow(64);
    assert.equal(w.length, 64);
  });

  it('is zero at endpoints', () => {
    const w = hannWindow(64);
    assert.ok(Math.abs(w[0]) < 1e-10, 'First sample should be ~0');
    assert.ok(Math.abs(w[63]) < 1e-10, 'Last sample should be ~0');
  });

  it('peaks at center', () => {
    const w = hannWindow(64);
    // Center samples should be close to 1.0
    assert.ok(w[31] > 0.99, `Center should be ~1.0, got ${w[31]}`);
    assert.ok(w[32] > 0.99, `Center should be ~1.0, got ${w[32]}`);
  });

  it('is symmetric', () => {
    const w = hannWindow(32);
    for (let i = 0; i < 16; i++) {
      assert.ok(
        Math.abs(w[i] - w[31 - i]) < 1e-12,
        `Symmetry broken at i=${i}: ${w[i]} vs ${w[31 - i]}`
      );
    }
  });

  it('caches results (same reference)', () => {
    const w1 = hannWindow(128);
    const w2 = hannWindow(128);
    assert.strictEqual(w1, w2, 'Should return cached reference');
  });

  it('handles length=1', () => {
    const w = hannWindow(1);
    assert.equal(w.length, 1);
    assert.equal(w[0], 1.0);
  });

  it('throws on length < 1', () => {
    assert.throws(() => hannWindow(0), /≥ 1/);
    assert.throws(() => hannWindow(-5), /≥ 1/);
  });
});

// ===========================================================================
// 2. FFT Magnitude
// ===========================================================================

describe('fftMagnitude', () => {
  it('returns correct number of bins', () => {
    const signal = new Float64Array(64);
    const { magnitudes, powers } = fftMagnitude(signal);
    assert.equal(magnitudes.length, 33); // N/2 + 1
    assert.equal(powers.length, 33);
  });

  it('DC bin equals sum of input for constant signal', () => {
    const N = 16;
    const signal = new Float64Array(N).fill(5.0);
    const { magnitudes } = fftMagnitude(signal);
    // DC bin should equal N * value (for un-windowed FFT)
    assert.ok(
      Math.abs(magnitudes[0] - N * 5.0) < 1e-6,
      `DC bin should be ${N * 5}, got ${magnitudes[0]}`
    );
  });

  it('detects a pure sine at the correct bin', () => {
    const N = 64;
    const sampleRate = 64; // 1 Hz per bin
    const targetFreq = 5; // 5 Hz → bin 5
    const signal = generateSineWave(targetFreq, sampleRate, N, 1.0);

    const { magnitudes } = fftMagnitude(signal);

    // Bin 5 should have the highest magnitude (excluding DC)
    let maxBin = 1;
    for (let k = 2; k < magnitudes.length; k++) {
      if (magnitudes[k] > magnitudes[maxBin]) maxBin = k;
    }
    assert.equal(maxBin, targetFreq, `Peak should be at bin ${targetFreq}, got ${maxBin}`);
  });

  it('all-zero input produces all-zero spectrum', () => {
    const signal = new Float64Array(32);
    const { magnitudes } = fftMagnitude(signal);
    for (let k = 0; k < magnitudes.length; k++) {
      assert.ok(Math.abs(magnitudes[k]) < 1e-10, `Bin ${k} should be 0`);
    }
  });

  it('throws on non-power-of-2', () => {
    assert.throws(() => fftMagnitude(new Float64Array(30)), /power of 2/);
    assert.throws(() => fftMagnitude(new Float64Array(1)), /power of 2/);
  });

  it('power equals magnitude squared', () => {
    const signal = generateSineWave(3, 32, 32, 5.0);
    const { magnitudes, powers } = fftMagnitude(signal);
    for (let k = 0; k < magnitudes.length; k++) {
      assert.ok(
        Math.abs(powers[k] - magnitudes[k] * magnitudes[k]) < 1e-8,
        `Power should equal magnitude² at bin ${k}`
      );
    }
  });
});

// ===========================================================================
// 3. Single-Subcarrier Doppler Spectrum
// ===========================================================================

describe('computeDopplerSpectrum', () => {
  it('removes DC offset', () => {
    const N = 64;
    const sampleRate = 20;
    // Constant signal with large DC offset
    const signal = new Float64Array(N).fill(100);
    const { magnitudes } = computeDopplerSpectrum(signal, sampleRate);

    // DC bin should be near zero after mean subtraction
    assert.ok(magnitudes[0] < 1e-6, `DC should be ~0 after mean subtraction, got ${magnitudes[0]}`);
  });

  it('detects a known frequency correctly', () => {
    const N = 64;
    const sampleRate = 20;
    const targetFreq = 2.5; // Walking frequency
    const signal = generateSineWave(targetFreq, sampleRate, N, 10);

    const { freqs, magnitudes, binWidthHz } = computeDopplerSpectrum(signal, sampleRate);

    // Bin width = 20/64 = 0.3125 Hz
    assert.ok(Math.abs(binWidthHz - sampleRate / N) < 1e-10);

    // Find peak (excluding DC)
    let peakBin = 1;
    for (let k = 2; k < magnitudes.length; k++) {
      if (magnitudes[k] > magnitudes[peakBin]) peakBin = k;
    }
    const peakFreq = freqs[peakBin];

    // Peak should be within ±1 bin of target
    assert.ok(
      Math.abs(peakFreq - targetFreq) <= binWidthHz + 1e-6,
      `Peak at ${peakFreq} Hz should be near ${targetFreq} Hz`
    );
  });

  it('frequency axis is monotonically increasing', () => {
    const { freqs } = computeDopplerSpectrum(new Float64Array(32).fill(1), 20);
    for (let k = 1; k < freqs.length; k++) {
      assert.ok(freqs[k] > freqs[k - 1], `freqs[${k}] should be > freqs[${k - 1}]`);
    }
  });

  it('throws on too-short signal', () => {
    assert.throws(
      () => computeDopplerSpectrum(new Float64Array(8), 20),
      /too short/i
    );
  });

  it('throws on invalid sample rate', () => {
    assert.throws(
      () => computeDopplerSpectrum(new Float64Array(32), 0),
      /positive/i
    );
    assert.throws(
      () => computeDopplerSpectrum(new Float64Array(32), -10),
      /positive/i
    );
  });
});

// ===========================================================================
// 4. Multi-Subcarrier Averaged Spectrum
// ===========================================================================

describe('computeAverageDopplerSpectrum', () => {
  it('returns correct structure and dimensions', () => {
    const N = 64;
    const numSC = 4;
    const series = generateMultiSubcarrierSignal(1.5, 20, N, numSC);
    const result = computeAverageDopplerSpectrum(series, 20);

    assert.equal(result.freqs.length, N / 2 + 1);
    assert.equal(result.avgMagnitudes.length, N / 2 + 1);
    assert.equal(result.avgPowers.length, N / 2 + 1);
    assert.equal(result.numSubcarriers, numSC);
    assert.ok(result.binWidthHz > 0);
  });

  it('averaged spectrum detects correlated signal', () => {
    const N = 64;
    const sampleRate = 20;
    const targetFreq = 1.5; // Walking-ish
    const series = generateMultiSubcarrierSignal(targetFreq, sampleRate, N, 8, 10);

    const { freqs, avgPowers, binWidthHz } = computeAverageDopplerSpectrum(series, sampleRate);

    // Find peak
    let peakBin = 1;
    for (let k = 2; k < avgPowers.length; k++) {
      if (avgPowers[k] > avgPowers[peakBin]) peakBin = k;
    }

    assert.ok(
      Math.abs(freqs[peakBin] - targetFreq) <= binWidthHz + 1e-6,
      `Averaged peak at ${freqs[peakBin]} Hz should be near ${targetFreq} Hz`
    );
  });

  it('throws on empty input', () => {
    assert.throws(() => computeAverageDopplerSpectrum([], 20), /at least one/i);
  });

  it('throws on mismatched lengths', () => {
    assert.throws(
      () => computeAverageDopplerSpectrum([new Float64Array(32), new Float64Array(64)], 20),
      /length/i
    );
  });
});

// ===========================================================================
// 5. Doppler Feature Extraction
// ===========================================================================

describe('extractDopplerFeatures', () => {
  it('extracts peak frequency from a known signal', () => {
    const N = 64;
    const sampleRate = 20;
    const walkingFreq = 2.0;
    const series = generateMultiSubcarrierSignal(walkingFreq, sampleRate, N, 4, 15);
    const { freqs, avgPowers, binWidthHz } = computeAverageDopplerSpectrum(series, sampleRate);
    const features = extractDopplerFeatures(freqs, avgPowers);

    assert.ok(
      Math.abs(features.peakFreqHz - walkingFreq) <= binWidthHz + 1e-6,
      `Peak should be near ${walkingFreq} Hz, got ${features.peakFreqHz} Hz`
    );
    assert.ok(features.peakPower > 0, 'Peak power should be positive');
  });

  it('walking signal has dominant energy in walking band', () => {
    const N = 64;
    const sampleRate = 20;
    const series = generateMultiSubcarrierSignal(2.0, sampleRate, N, 8, 15);
    const { freqs, avgPowers } = computeAverageDopplerSpectrum(series, sampleRate);
    const features = extractDopplerFeatures(freqs, avgPowers);

    // Walking band (index 2) should have the most energy
    const walkingBandIdx = 2; // walking band: 1.0–3.0 Hz
    assert.ok(
      features.bandFractions[walkingBandIdx] > features.bandFractions[0],
      'Walking band should have more energy than breathing band'
    );
    assert.ok(features.totalEnergy > 0, 'Total energy should be positive');
  });

  it('breathing signal has dominant energy in breathing band', () => {
    const N = 128;  // Need more samples for 0.3 Hz resolution
    const sampleRate = 20;
    const series = generateMultiSubcarrierSignal(0.35, sampleRate, N, 8, 15);
    const { freqs, avgPowers } = computeAverageDopplerSpectrum(series, sampleRate);
    const features = extractDopplerFeatures(freqs, avgPowers);

    // Breathing band (index 0) should dominate
    assert.ok(
      features.bandFractions[0] > features.bandFractions[2],
      `Breathing band fraction (${features.bandFractions[0]}) should exceed walking band (${features.bandFractions[2]})`
    );
  });

  it('spectral centroid is within Nyquist', () => {
    const N = 64;
    const series = generateMultiSubcarrierSignal(1.5, 20, N, 4, 10);
    const { freqs, avgPowers } = computeAverageDopplerSpectrum(series, 20);
    const features = extractDopplerFeatures(freqs, avgPowers);

    assert.ok(features.spectralCentroid >= 0, 'Centroid should be ≥ 0');
    assert.ok(features.spectralCentroid <= 10, `Centroid should be ≤ Nyquist, got ${features.spectralCentroid}`);
  });

  it('spectral entropy is non-negative', () => {
    const N = 64;
    const series = generateMultiSubcarrierSignal(2.0, 20, N, 4, 10);
    const { freqs, avgPowers } = computeAverageDopplerSpectrum(series, 20);
    const features = extractDopplerFeatures(freqs, avgPowers);

    assert.ok(features.spectralEntropy >= 0, 'Entropy should be ≥ 0');
  });

  it('band fractions sum to ≤ 1.0', () => {
    const N = 64;
    const series = generateMultiSubcarrierSignal(1.5, 20, N, 4, 10);
    const { freqs, avgPowers } = computeAverageDopplerSpectrum(series, 20);
    const features = extractDopplerFeatures(freqs, avgPowers);

    const fractionSum = features.bandFractions.reduce((a, b) => a + b, 0);
    // Some energy may be outside defined bands (e.g., > 6 Hz), so sum ≤ 1.0
    assert.ok(fractionSum <= 1.0 + 1e-10, `Band fractions sum to ${fractionSum}, should be ≤ 1.0`);
  });

  it('all-zero spectrum produces zero features', () => {
    const freqs = new Float64Array([0, 1, 2, 3, 4, 5]);
    const powers = new Float64Array(6).fill(0);
    const features = extractDopplerFeatures(freqs, powers);

    assert.equal(features.totalEnergy, 0);
    assert.equal(features.spectralCentroid, 0);
    assert.equal(features.spectralEntropy, 0);
    assert.equal(features.motionClass, MOTION_CLASS.NONE);
  });

  it('throws on mismatched freqs/powers lengths', () => {
    assert.throws(
      () => extractDopplerFeatures(new Float64Array(5), new Float64Array(6)),
      /same length/i
    );
  });
});

// ===========================================================================
// 6. Motion Classification
// ===========================================================================

describe('classifyMotion', () => {
  it('returns NONE for low energy', () => {
    assert.equal(
      classifyMotion(NOISE_FLOOR_ENERGY - 0.1, [0.5, 0.2, 0.2, 0.1]),
      MOTION_CLASS.NONE
    );
  });

  it('returns breathing when breathing band dominates', () => {
    assert.equal(
      classifyMotion(10, [0.7, 0.1, 0.1, 0.1]),
      'breathing'
    );
  });

  it('returns walking when walking band dominates', () => {
    assert.equal(
      classifyMotion(10, [0.05, 0.05, 0.8, 0.1]),
      'walking'
    );
  });

  it('returns running when running band dominates', () => {
    assert.equal(
      classifyMotion(10, [0.05, 0.05, 0.1, 0.8]),
      'running'
    );
  });

  it('returns fidgeting when fidgeting band dominates', () => {
    assert.equal(
      classifyMotion(10, [0.1, 0.6, 0.2, 0.1]),
      'fidgeting'
    );
  });

  it('returns MIXED when multiple bands are active', () => {
    // No single band above threshold, but multiple above 10%
    assert.equal(
      classifyMotion(10, [0.30, 0.25, 0.25, 0.20]),
      MOTION_CLASS.MIXED
    );
  });

  it('returns NONE when energy is present but no dominant band and < 2 active', () => {
    // Only one band barely above 10%
    assert.equal(
      classifyMotion(10, [0.15, 0.05, 0.05, 0.05]),
      MOTION_CLASS.NONE
    );
  });
});

// ===========================================================================
// 7. DopplerAnalyzer (Stateful Class)
// ===========================================================================

describe('DopplerAnalyzer', () => {
  it('constructs with default parameters', () => {
    const analyzer = new DopplerAnalyzer();
    assert.equal(analyzer.fftSize, DEFAULT_FFT_SIZE);
    assert.equal(analyzer.sampleRateHz, 20);
    assert.equal(analyzer.numSubcarriers, NUM_SUBCARRIERS);
    assert.equal(analyzer.isReady(), false);
    assert.equal(analyzer.frameCount, 0);
  });

  it('constructs with custom parameters', () => {
    const analyzer = new DopplerAnalyzer({ fftSize: 128, sampleRateHz: 25, numSubcarriers: 10 });
    assert.equal(analyzer.fftSize, 128);
    assert.equal(analyzer.sampleRateHz, 25);
    assert.equal(analyzer.numSubcarriers, 10);
  });

  it('throws on invalid fftSize', () => {
    assert.throws(() => new DopplerAnalyzer({ fftSize: 8 }), /16.*512/);
    assert.throws(() => new DopplerAnalyzer({ fftSize: 1024 }), /16.*512/);
    assert.throws(() => new DopplerAnalyzer({ fftSize: 30 }), /power of 2/);
  });

  it('reports not ready until enough frames', () => {
    const analyzer = new DopplerAnalyzer({ fftSize: 16, numSubcarriers: 4 });
    const frame = [1, 2, 3, 4];

    for (let i = 0; i < 15; i++) {
      analyzer.pushFrame(frame);
      assert.equal(analyzer.isReady(), false);
    }
    analyzer.pushFrame(frame);
    assert.equal(analyzer.isReady(), true);
    assert.equal(analyzer.frameCount, 16);
  });

  it('returns null from analyze() when not ready', () => {
    const analyzer = new DopplerAnalyzer({ fftSize: 16, numSubcarriers: 4 });
    assert.equal(analyzer.analyze(), null);
  });

  it('produces valid features after filling buffer', () => {
    const fftSize = 64;
    const sampleRate = 20;
    const numSC = 4;
    const analyzer = new DopplerAnalyzer({ fftSize, sampleRateHz: sampleRate, numSubcarriers: numSC });

    // Feed a 2 Hz walking signal
    const walkingFreq = 2.0;
    for (let t = 0; t < fftSize; t++) {
      const frame = [];
      for (let sc = 0; sc < numSC; sc++) {
        frame.push(20 + 10 * Math.sin(2 * Math.PI * walkingFreq * t / sampleRate + sc * 0.1));
      }
      analyzer.pushFrame(frame);
    }

    const result = analyzer.analyze();
    assert.ok(result !== null, 'Should produce result');
    assert.ok(result.ready, 'Should be ready');
    assert.ok(result.features.totalEnergy > 0, 'Should have energy');
    assert.ok(result.features.peakFreqHz > 0, 'Should have positive peak freq');

    // Peak should be near 2 Hz
    const binWidth = sampleRate / fftSize;
    assert.ok(
      Math.abs(result.features.peakFreqHz - walkingFreq) <= binWidth + 1e-6,
      `Peak should be near ${walkingFreq} Hz, got ${result.features.peakFreqHz}`
    );
  });

  it('continues working with circular buffer (more frames than fftSize)', () => {
    const fftSize = 32;
    const numSC = 4;
    const analyzer = new DopplerAnalyzer({ fftSize, sampleRateHz: 20, numSubcarriers: numSC });

    // Push 2x the buffer size
    for (let t = 0; t < fftSize * 2; t++) {
      const frame = [];
      for (let sc = 0; sc < numSC; sc++) {
        frame.push(20 + 5 * Math.sin(2 * Math.PI * 1.5 * t / 20));
      }
      analyzer.pushFrame(frame);
    }

    assert.equal(analyzer.frameCount, fftSize * 2);
    const result = analyzer.analyze();
    assert.ok(result !== null);
    assert.ok(result.features.totalEnergy > 0);
  });

  it('reset clears all state', () => {
    const analyzer = new DopplerAnalyzer({ fftSize: 16, numSubcarriers: 4 });
    for (let t = 0; t < 16; t++) {
      analyzer.pushFrame([1, 2, 3, 4]);
    }
    assert.equal(analyzer.isReady(), true);

    analyzer.reset();
    assert.equal(analyzer.isReady(), false);
    assert.equal(analyzer.frameCount, 0);
    assert.equal(analyzer.analyze(), null);
  });

  it('throws on wrong amplitude array length', () => {
    const analyzer = new DopplerAnalyzer({ fftSize: 16, numSubcarriers: 4 });
    assert.throws(() => analyzer.pushFrame([1, 2, 3]), /Expected 4/);
  });
});

// ===========================================================================
// 8. Edge Cases
// ===========================================================================

describe('Edge cases', () => {
  it('minimum FFT size (16) works', () => {
    const signal = generateSineWave(2, 20, 16, 5);
    const { magnitudes } = computeDopplerSpectrum(signal, 20);
    assert.equal(magnitudes.length, 9); // 16/2 + 1
  });

  it('large FFT size (256) works', () => {
    const signal = generateSineWave(1, 20, 256, 5);
    const { magnitudes, binWidthHz } = computeDopplerSpectrum(signal, 20);
    assert.equal(magnitudes.length, 129); // 256/2 + 1
    assert.ok(Math.abs(binWidthHz - 20 / 256) < 1e-10);
  });

  it('single subcarrier averaged spectrum equals single spectrum', () => {
    const signal = generateSineWave(1.5, 20, 64, 10);
    const single = computeDopplerSpectrum(signal, 20);
    const averaged = computeAverageDopplerSpectrum([signal], 20);

    for (let k = 0; k < single.magnitudes.length; k++) {
      assert.ok(
        Math.abs(single.magnitudes[k] - averaged.avgMagnitudes[k]) < 1e-8,
        `Bin ${k}: single ${single.magnitudes[k]} vs avg ${averaged.avgMagnitudes[k]}`
      );
    }
  });

  it('constants are correctly defined', () => {
    assert.equal(NUM_DOPPLER_BANDS, 4);
    assert.equal(DOPPLER_BANDS[0].name, 'breathing');
    assert.equal(DOPPLER_BANDS[1].name, 'fidgeting');
    assert.equal(DOPPLER_BANDS[2].name, 'walking');
    assert.equal(DOPPLER_BANDS[3].name, 'running');
    assert.ok(NOISE_FLOOR_ENERGY > 0);
    assert.ok(BAND_DOMINANCE_THRESHOLD > 0 && BAND_DOMINANCE_THRESHOLD < 1);
  });

  it('MOTION_CLASS enum values are strings', () => {
    assert.equal(typeof MOTION_CLASS.NONE, 'string');
    assert.equal(typeof MOTION_CLASS.BREATHING, 'string');
    assert.equal(typeof MOTION_CLASS.WALKING, 'string');
    assert.equal(typeof MOTION_CLASS.MIXED, 'string');
  });

  it('DopplerAnalyzer with full 52 subcarriers works', () => {
    const analyzer = new DopplerAnalyzer({ fftSize: 32 });

    for (let t = 0; t < 32; t++) {
      const frame = [];
      for (let sc = 0; sc < NUM_SUBCARRIERS; sc++) {
        frame.push(20 + 8 * Math.sin(2 * Math.PI * 1.0 * t / 20 + sc * 0.05));
      }
      analyzer.pushFrame(frame);
    }

    const result = analyzer.analyze();
    assert.ok(result !== null);
    assert.ok(result.features.totalEnergy > 0);
    assert.equal(result.framesBuffered, 32);
  });
});
