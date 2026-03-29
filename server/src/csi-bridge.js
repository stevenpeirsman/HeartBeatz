// ==============================================================================
// CSI UDP-to-WebSocket Bridge — v2 (Improved Signal Processing)
// ==============================================================================
// Receives ADR-018 binary CSI frames from ESP32 nodes over UDP (port 5005),
// processes them into vital-sign estimates, and broadcasts via WebSocket
// (port 3001) in the format the HeartBeatz server expects.
//
// v2 Improvements over v1:
//   - EMA smoothing on person count (eliminates 0-8 fluctuation)
//   - Autocorrelation-based frequency estimation (replaces zero-crossing)
//   - Multi-node weighted fusion (replaces naive Math.max)
//   - Adaptive thresholds using running statistics
//   - Actual measured sample rate instead of hardcoded 50 Hz
//   - Bandpass-style filtering for vital sign extraction
//   - Calibration phase to establish per-node baselines
//
// Architecture:
//   ESP32 nodes ──UDP:5005──> [CSI Bridge] ──WS:3001──> HeartBeatz Server
//                                  │
//                              HTTP:3000 (/health, /api/nodes, /api/v1/sensing/latest)
//
// Usage: node csi-bridge.js
// Env:   UDP_PORT=5005, HTTP_PORT=3000, WS_PORT=3001

import dgram from 'dgram';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const UDP_PORT  = parseInt(process.env.UDP_PORT || '5005', 10);
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '3000', 10);
const WS_PORT   = parseInt(process.env.WS_PORT || '3001', 10);
const TICK_MS   = parseInt(process.env.TICK_MS || '100', 10);  // 10 Hz output

// ADR-018 frame constants
const ADR018_MAGIC = 0xC5110001;
const HEADER_SIZE  = 22;  // 4 magic + 2 ver + 6 mac + 4 seq + 4 ts + 2 csi_len

// EMA smoothing factors (0 = no smoothing, 1 = no memory)
const EMA_PERSON_COUNT = 0.05;   // Responsive — ~4s settling, good for kids without noise spikes
const EMA_HEART_RATE   = 0.12;   // Slightly faster for per-person tracking
const EMA_BREATHING    = 0.08;   // Slightly faster for per-person tracking
const EMA_MOTION       = 0.30;   // Fast — catch kids running quickly

// Calibration: first N seconds establish baseline
const CALIBRATION_FRAMES = 150;  // ~6s at 25 Hz (faster calibration)

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/** Compute the mean of an array. */
function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** Compute variance of an array. */
function variance(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return arr.reduce((sum, x) => sum + (x - m) ** 2, 0) / (arr.length - 1);
}

/** Compute standard deviation of an array. */
function stddev(arr) {
  return Math.sqrt(variance(arr));
}

/** Compute median of an array. */
function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Exponential Moving Average update. */
function emaUpdate(prev, current, alpha) {
  if (prev === null || prev === undefined) return current;
  return alpha * current + (1 - alpha) * prev;
}

/**
 * Autocorrelation-based frequency estimation.
 * Much more robust than zero-crossing for noisy CSI signals.
 *
 * Finds the lag with the highest autocorrelation within the expected
 * frequency range, then converts lag to frequency.
 *
 * @param {number[]} signal - Time-domain signal samples
 * @param {number} sampleRate - Actual samples per second
 * @param {number} minFreq - Minimum expected frequency (Hz)
 * @param {number} maxFreq - Maximum expected frequency (Hz)
 * @returns {{ freq: number, confidence: number }} Frequency in Hz + confidence [0-1]
 */
function estimateFrequencyAutocorr(signal, sampleRate, minFreq, maxFreq) {
  const N = signal.length;
  if (N < 20 || sampleRate < 1) return { freq: 0, confidence: 0 };

  // Detrend: subtract mean
  const m = mean(signal);
  const detrended = signal.map(x => x - m);

  // Compute energy for normalization
  const energy = detrended.reduce((s, x) => s + x * x, 0);
  if (energy < 1e-6) return { freq: 0, confidence: 0 };

  // Lag range from frequency range
  const minLag = Math.max(1, Math.floor(sampleRate / maxFreq));
  const maxLag = Math.min(N - 1, Math.ceil(sampleRate / minFreq));

  if (minLag >= maxLag) return { freq: 0, confidence: 0 };

  // Compute autocorrelation for each lag in range
  let bestLag = minLag;
  let bestCorr = -Infinity;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i < N - lag; i++) {
      corr += detrended[i] * detrended[i + lag];
    }
    corr /= energy;  // Normalize to [-1, 1]

    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  // Confidence: how strong the autocorrelation peak is
  // A clear periodic signal gives bestCorr close to 1
  const confidence = Math.max(0, Math.min(1, bestCorr));

  if (confidence < 0.15) return { freq: 0, confidence: 0 };

  const freq = sampleRate / bestLag;
  return { freq, confidence };
}

/**
 * Simple moving-average bandpass filter.
 * Removes DC (low-pass subtraction) and high-frequency noise.
 *
 * @param {number[]} signal - Input samples
 * @param {number} shortWindow - Short-term average window (removes slow trends)
 * @param {number} longWindow - Long-term average window (acts as baseline)
 * @returns {number[]} Filtered signal
 */
function bandpassFilter(signal, shortWindow, longWindow) {
  const N = signal.length;
  if (N < longWindow) return signal;

  const result = [];
  for (let i = longWindow; i < N; i++) {
    // Short-term average (captures signal of interest)
    const shortSlice = signal.slice(Math.max(0, i - shortWindow), i + 1);
    const shortAvg = mean(shortSlice);

    // Long-term average (baseline to subtract)
    const longSlice = signal.slice(Math.max(0, i - longWindow), i + 1);
    const longAvg = mean(longSlice);

    result.push(shortAvg - longAvg);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Node State Tracking
// ---------------------------------------------------------------------------

/** Per-node state for CSI processing. */
class NodeState {
  constructor(mac) {
    this.mac = mac;
    this.lastSeen = Date.now();
    this.frameCount = 0;
    this.lastSeq = 0;

    // --- Sample rate measurement ---
    this.frameTimestamps = [];       // Recent frame arrival times for rate calc
    this.measuredSampleRate = 20;    // Initial estimate, will be updated

    // --- Calibration ---
    this.calibrated = false;
    this.baselineMeanAmp = 0;        // Mean amplitude when "empty room"
    this.baselineVariance = 0;       // Variance when "empty room"

    // --- CSI amplitude history ---
    this.amplitudeHistory = [];      // Per-frame mean amplitudes
    this.amplitudeWindowSize = 400;  // ~20s at 20Hz — longer window for stability

    // --- Temporal variance tracking ---
    this.varianceHistory = [];
    this.varianceWindowSize = 50;    // ~2 seconds at 25Hz (responsive to quick changes)

    // --- Vital signs buffers ---
    // Breathing: 0.15-0.5 Hz → need ~8s window minimum (2 full cycles at 0.25 Hz)
    this.breathingBuffer = [];
    this.breathingWindowSize = 200;  // ~10s at 20Hz

    // Heart rate: 0.8-2.5 Hz → need ~4s window
    this.heartBuffer = [];
    this.heartWindowSize = 160;      // ~8s at 20Hz

    // --- Per-subcarrier tracking (for better sensitivity) ---
    this.subcarrierHistory = [];     // Array of arrays: per-subcarrier amplitude over time
    this.subcarrierWindowSize = 60;  // ~3s at 20Hz

    // --- Median filter buffer for person count ---
    this.rawCountBuffer = [];        // Last N raw counts, median-filtered before EMA
    this.rawCountBufferSize = 20;    // ~0.8 second median filter at 25Hz (spike rejection)

    // --- EMA-smoothed outputs ---
    this.emaPersonCount = null;
    this.emaHeartRate = null;
    this.emaBreathingRate = null;
    this.emaMotionLevel = null;

    // --- Final published estimates ---
    this.heartRate = 0;
    this.breathingRate = 0;
    this.motionState = 'none';
    this.motionLevel = 0;            // Raw motion metric for fusion
    this.confidence = 0;
    this.csiQuality = 0;
    this.personCount = 0;
    this.rawPersonCount = 0;         // Pre-EMA person count for diagnostics
    this.rssi = 0;
    this.noiseLevel = 0.1;           // Calibrated noise floor for fusion weighting
  }
}

/** Active nodes indexed by MAC string. */
const nodes = new Map();

/** Get or create node state. */
function getNode(mac) {
  if (!nodes.has(mac)) {
    console.log(`[CSI] New node discovered: ${mac}`);
    nodes.set(mac, new NodeState(mac));
  }
  const node = nodes.get(mac);
  node.lastSeen = Date.now();
  return node;
}

// ---------------------------------------------------------------------------
// ADR-018 Frame Parser
// ---------------------------------------------------------------------------

/**
 * Parse an ADR-018 binary frame from an ESP32 node.
 * Returns null if the frame is invalid.
 */
function parseFrame(buf) {
  if (buf.length < HEADER_SIZE) return null;

  const magic = buf.readUInt32BE(0);
  if (magic !== ADR018_MAGIC) return null;

  const version = buf.readUInt16BE(4);
  const mac = Array.from(buf.slice(6, 12))
    .map(b => b.toString(16).padStart(2, '0'))
    .join(':');
  const seq = buf.readUInt32LE(12);
  const timestamp = buf.readUInt32LE(16);
  const csiLen = buf.readUInt16LE(20);

  if (buf.length < HEADER_SIZE + csiLen) return null;

  const csiData = buf.slice(HEADER_SIZE, HEADER_SIZE + csiLen);

  // Check for radar data after CSI
  let radar = null;
  const radarOffset = HEADER_SIZE + csiLen;
  if (buf.length > radarOffset && buf[radarOffset] === 1) {
    radar = {
      state: buf[radarOffset + 1],
      movingDist: buf.readUInt16LE(radarOffset + 2),
      movingEnergy: buf[radarOffset + 4],
      stationaryDist: buf.readUInt16LE(radarOffset + 5),
      stationaryEnergy: buf[radarOffset + 7],
    };
  }

  return { version, mac, seq, timestamp, csiLen, csiData, radar };
}

// ---------------------------------------------------------------------------
// CSI Signal Processing
// ---------------------------------------------------------------------------

/**
 * Extract amplitudes from CSI I/Q pairs.
 * CSI data is interleaved: [I0, Q0, I1, Q1, ...] (signed 8-bit).
 */
function extractAmplitudes(csiData) {
  const amps = [];
  for (let i = 0; i + 1 < csiData.length; i += 2) {
    let real = csiData[i];
    let imag = csiData[i + 1];
    if (real > 127) real -= 256;
    if (imag > 127) imag -= 256;
    amps.push(Math.sqrt(real * real + imag * imag));
  }
  return amps;
}

/**
 * Update measured sample rate from frame timestamps.
 * Uses a sliding window of recent timestamps to calculate actual Hz.
 */
function updateSampleRate(node) {
  const now = Date.now();
  node.frameTimestamps.push(now);

  // Keep last 100 timestamps
  if (node.frameTimestamps.length > 100) {
    node.frameTimestamps.shift();
  }

  if (node.frameTimestamps.length >= 10) {
    const window = node.frameTimestamps;
    const durationMs = window[window.length - 1] - window[0];
    if (durationMs > 0) {
      node.measuredSampleRate = ((window.length - 1) * 1000) / durationMs;
    }
  }
}

/**
 * Run calibration to establish baseline (empty or reference state).
 * Called once enough frames have been collected.
 */
function calibrate(node) {
  if (node.amplitudeHistory.length < CALIBRATION_FRAMES) return;
  if (node.calibrated) return;

  node.baselineMeanAmp = mean(node.amplitudeHistory);
  // Clamp baseline variance to a sensible minimum. If calibration captures
  // an anomalously quiet window (e.g., everyone perfectly still for 6s),
  // the variance can be near-zero, making any subsequent signal look massive.
  // Minimum of 2.0 reflects typical ambient WiFi multipath noise.
  node.baselineVariance = Math.max(2.0, variance(node.amplitudeHistory));
  node.calibrated = true;

  // Reset person count EMA to 0 so it starts fresh from calibration
  node.emaPersonCount = 0;
  node.personCount = 0;
  node.rawCountBuffer = [];

  console.log(`[CSI] Node ${node.mac.slice(-5)} calibrated: ` +
    `baseline_amp=${node.baselineMeanAmp.toFixed(2)}, ` +
    `baseline_var=${node.baselineVariance.toFixed(4)}, ` +
    `sample_rate=${node.measuredSampleRate.toFixed(1)} Hz`);
}

/**
 * Estimate person count from CSI signal characteristics.
 *
 * Uses multiple metrics combined for robustness:
 *   1. Temporal variance of mean amplitude (people cause fluctuation)
 *   2. Subcarrier decorrelation spread (more people = more diverse patterns)
 *   3. Cross-subcarrier variance (spatial diversity from multiple bodies)
 *
 * Absolute thresholds with EMA smoothing for stability.
 * No baseline subtraction (calibration may happen with people present).
 */
function estimatePersonCount(node) {
  if (node.amplitudeHistory.length < 30) return;

  // --- Metric 1: Temporal variance (heavily biased toward long-term) ---
  const recentSlice = node.amplitudeHistory.slice(-node.varianceWindowSize);
  const temporalVar = variance(recentSlice);

  // Long window: ~5 seconds (100 frames at 20Hz) — provides stability
  const longSlice = node.amplitudeHistory.slice(-Math.min(120, node.amplitudeHistory.length));
  const longVar = variance(longSlice);

  // Very-long window: ~10 seconds (200 frames) — ultra-stable baseline
  const veryLongSlice = node.amplitudeHistory.slice(-Math.min(200, node.amplitudeHistory.length));
  const veryLongVar = variance(veryLongSlice);

  // Blend: favor long-term but with enough short-term to detect kids moving
  const blendedVar = 0.15 * temporalVar + 0.25 * longVar + 0.6 * veryLongVar;

  // --- Metric 2: Subcarrier decorrelation ---
  let subcarrierScore = 0;
  if (node.subcarrierHistory.length >= 10) {
    const nSubs = node.subcarrierHistory[0]?.length || 0;
    if (nSubs > 4) {
      // Compute variance of each subcarrier over time
      const subVars = [];
      for (let sc = 0; sc < nSubs; sc++) {
        const scTimeSeries = node.subcarrierHistory.map(frame => frame[sc] || 0);
        subVars.push(variance(scTimeSeries));
      }
      // High spread = subcarriers affected differently = more bodies in different positions
      subcarrierScore = stddev(subVars);
    }
  }

  // --- Metric 3: Cross-subcarrier variance (spatial diversity) ---
  // Average the per-frame variance across subcarriers
  const recentCrossVar = mean(node.varianceHistory.slice(-20));

  // --- Normalize variance by subtracting the calibrated baseline ---
  // The baseline variance represents "empty room" noise. We subtract it
  // so that effectiveVar ≈ 0 when nobody is present, regardless of how
  // noisy the node inherently is. This makes the threshold ladder work
  // consistently across quiet and noisy nodes.
  // Cap baseline variance: if calibration happened during activity, the baseline
  // is inflated and excessVar stays at 0, permanently blinding the node.
  // Cap at 5.0 (≈2× the highest healthy baseline observed) to prevent this.
  const MAX_BASELINE_VAR = 5.0;
  const noiseFloor = node.calibrated
    ? Math.max(0.05, Math.min(MAX_BASELINE_VAR, node.baselineVariance))
    : 0.1;

  // Excess variance = how much above baseline the signal currently is.
  // Negative means quieter than baseline — clamp to 0.
  const excessVar = Math.max(0, blendedVar - noiseFloor);

  // Scale by noise floor so a given person causes roughly the same
  // effectiveVar on a quiet node as on a noisy node.
  let effectiveVar;
  if (noiseFloor < 1.0) {
    // Quiet node: use excess directly (already small numbers)
    effectiveVar = excessVar;
  } else if (noiseFloor < 8.0) {
    // Moderate noise: scale excess by noise floor
    effectiveVar = excessVar / Math.sqrt(noiseFloor);
  } else {
    // Very noisy node: stronger compression
    effectiveVar = Math.log1p(excessVar) / Math.log1p(Math.sqrt(noiseFloor));
  }
  // Track noise level for fusion weighting
  node.noiseLevel = noiseFloor;
  // Debug fields for diagnostics
  node.blendedVar = blendedVar;
  node.effectiveVar = effectiveVar;
  node.excessVar = excessVar;

  // --- Combine metrics into person count estimate ---
  let rawCount;
  if (effectiveVar < 0.05) {
    rawCount = 0;
  } else if (effectiveVar < 0.2) {
    rawCount = 1;
  } else if (effectiveVar < 0.5) {
    rawCount = 1 + (effectiveVar - 0.2) / 0.3;    // Interpolate 1→2
  } else if (effectiveVar < 1.0) {
    rawCount = 2 + (effectiveVar - 0.5) / 0.5;    // Interpolate 2→3
  } else if (effectiveVar < 1.8) {
    rawCount = 3 + (effectiveVar - 1.0) / 0.8;    // Interpolate 3→4
  } else if (effectiveVar < 3.0) {
    rawCount = 4 + (effectiveVar - 1.8) / 1.2;    // Interpolate 4→5
  } else {
    rawCount = Math.min(7, 5 + (effectiveVar - 3.0) / 2);
  }

  // Boost from subcarrier decorrelation (multiple people in different positions)
  if (subcarrierScore > 0.5 && rawCount >= 1) {
    const scBoost = Math.min(1.0, (subcarrierScore - 0.5) / 3);
    rawCount += scBoost;
  }

  // Boost from high cross-subcarrier variance (strong spatial presence)
  if (recentCrossVar > 50 && rawCount >= 1) {
    rawCount *= 1.05;
  }

  // Hard cap per node: a single WiFi node can't reliably distinguish >5 people
  rawCount = Math.min(5, rawCount);

  node.rawPersonCount = rawCount;

  // --- Median filter: reject outlier spikes ---
  node.rawCountBuffer.push(rawCount);
  if (node.rawCountBuffer.length > node.rawCountBufferSize) {
    node.rawCountBuffer.shift();
  }
  const medianCount = median(node.rawCountBuffer);

  // --- EMA smoothing on median-filtered count ---
  node.emaPersonCount = emaUpdate(node.emaPersonCount, medianCount, EMA_PERSON_COUNT);

  // Hysteresis: only update displayed count when EMA moves >0.4 from current
  const emaRounded = Math.round(node.emaPersonCount);
  if (Math.abs(node.emaPersonCount - node.personCount) > 0.4 ||
      (node.personCount === 0 && node.emaPersonCount > 0.3)) {
    node.personCount = Math.max(0, Math.min(8, emaRounded));
  }
}

/**
 * Estimate vital signs using autocorrelation on filtered CSI signal.
 */
function estimateVitalSigns(node) {
  const sr = node.measuredSampleRate;

  // --- Breathing Rate (0.15-0.5 Hz = 9-30 breaths/min) ---
  if (node.breathingBuffer.length >= 80) {
    // Bandpass: keep 0.1-0.6 Hz content
    // Short window ~2s removes fast variations, long window ~10s removes DC
    const shortWin = Math.max(2, Math.round(sr * 0.5));
    const longWin = Math.max(10, Math.round(sr * 8));
    const filtered = bandpassFilter(node.breathingBuffer, shortWin, longWin);

    if (filtered.length >= 40) {
      const { freq, confidence } = estimateFrequencyAutocorr(filtered, sr, 0.15, 0.5);
      if (freq > 0 && confidence > 0.2) {
        const bpm = freq * 60;
        node.emaBreathingRate = emaUpdate(node.emaBreathingRate, bpm, EMA_BREATHING);
        node.breathingRate = Math.round(node.emaBreathingRate);
      }
    }
  }

  // --- Heart Rate (0.8-2.0 Hz = 48-120 bpm) ---
  if (node.heartBuffer.length >= 60) {
    // Bandpass: keep 0.7-2.3 Hz content
    const shortWin = Math.max(2, Math.round(sr * 0.15));
    const longWin = Math.max(5, Math.round(sr * 1.0));
    const filtered = bandpassFilter(node.heartBuffer, shortWin, longWin);

    if (filtered.length >= 30) {
      const { freq, confidence } = estimateFrequencyAutocorr(filtered, sr, 0.8, 2.0);
      if (freq > 0 && confidence > 0.35) {
        const bpm = freq * 60;
        node.emaHeartRate = emaUpdate(node.emaHeartRate, bpm, EMA_HEART_RATE);
        node.heartRate = Math.round(node.emaHeartRate);
      }
    }
  }
}

/**
 * Process a new CSI frame and update the node's vital-sign estimates.
 */
function processFrame(frame) {
  const node = getNode(frame.mac);
  node.frameCount++;
  node.lastSeq = frame.seq;
  if (frame.sourceIp) node.sourceIp = frame.sourceIp;

  // Update measured sample rate
  updateSampleRate(node);

  const amps = extractAmplitudes(frame.csiData);
  if (amps.length === 0) return;

  const meanAmp = mean(amps);
  const ampVariance = variance(amps);

  // CSI quality: normalized mean amplitude
  node.csiQuality = Math.min(1, meanAmp / 30);

  // Push to amplitude history
  node.amplitudeHistory.push(meanAmp);
  if (node.amplitudeHistory.length > node.amplitudeWindowSize) {
    node.amplitudeHistory.shift();
  }

  // Push to variance history
  node.varianceHistory.push(ampVariance);
  if (node.varianceHistory.length > node.varianceWindowSize) {
    node.varianceHistory.shift();
  }

  // Push to vital sign buffers
  node.breathingBuffer.push(meanAmp);
  if (node.breathingBuffer.length > node.breathingWindowSize) {
    node.breathingBuffer.shift();
  }

  node.heartBuffer.push(meanAmp);
  if (node.heartBuffer.length > node.heartWindowSize) {
    node.heartBuffer.shift();
  }

  // Per-subcarrier tracking
  node.subcarrierHistory.push(amps);
  if (node.subcarrierHistory.length > node.subcarrierWindowSize) {
    node.subcarrierHistory.shift();
  }

  // --- Motion Detection (with EMA) ---
  const recentVariance = mean(node.varianceHistory);
  node.emaMotionLevel = emaUpdate(node.emaMotionLevel, recentVariance, EMA_MOTION);
  node.motionLevel = node.emaMotionLevel;

  const motionThreshold = 5;
  const stationaryThreshold = 1;

  if (node.emaMotionLevel > motionThreshold) {
    node.motionState = 'moving';
  } else if (node.emaMotionLevel > stationaryThreshold) {
    node.motionState = 'stationary';
  } else {
    node.motionState = 'none';
  }

  // --- Calibration ---
  calibrate(node);

  // --- Person Count (with EMA + adaptive thresholds) ---
  estimatePersonCount(node);

  // --- Vital Signs (autocorrelation-based) ---
  // Only run every 5 frames to save CPU
  if (node.frameCount % 5 === 0) {
    estimateVitalSigns(node);
  }

  // --- Confidence ---
  const frameFreshness = Math.min(1, node.amplitudeHistory.length / 100);
  const calibrationBonus = node.calibrated ? 0.2 : 0;
  node.confidence = Math.min(1,
    node.csiQuality * 0.3 +
    frameFreshness * 0.3 +
    calibrationBonus +
    (node.measuredSampleRate > 10 ? 0.2 : 0.1)
  );
}

// ---------------------------------------------------------------------------
// Multi-Node Fusion
// ---------------------------------------------------------------------------

/**
 * Fuse person counts from multiple nodes using weighted average.
 *
 * Weights are based on:
 *   - CSI quality (better signal = more trust)
 *   - Confidence score
 *   - Motion level (nodes seeing more motion contribute more)
 *
 * This replaces the naive Math.max approach which was very noisy.
 */
function fusePersonCount(activeNodes) {
  if (activeNodes.length === 0) return 0;
  if (activeNodes.length === 1) return activeNodes[0].personCount;

  let weightedSum = 0;
  let totalWeight = 0;

  for (const node of activeNodes) {
    // Weight factors:
    //   - CSI quality * confidence (signal strength)
    //   - Noise penalty: noisy nodes contribute less
    const signalWeight = Math.max(0.1, node.csiQuality * node.confidence);
    const noiseLevel = node.noiseLevel || 0.1;
    // Noisy node penalty: 1.0 for quiet, 0.3 for very noisy
    const noisePenalty = noiseLevel < 1.0 ? 1.0 : 1.0 / (1 + Math.log1p(noiseLevel));
    const weight = signalWeight * noisePenalty;

    weightedSum += node.personCount * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return 0;

  const fusedRaw = weightedSum / totalWeight;

  // Bias toward quieter (more reliable) nodes' max count
  const quietNodes = activeNodes.filter(n => (n.noiseLevel || 0.1) < 2.0);
  const quietMax = quietNodes.length > 0
    ? Math.max(...quietNodes.map(n => n.personCount))
    : Math.max(...activeNodes.map(n => n.personCount));

  // Blend: favor the quiet-node maximum slightly
  return Math.round(0.5 * fusedRaw + 0.5 * quietMax);
}

// ---------------------------------------------------------------------------
// WebSocket Server (port 3001)
// ---------------------------------------------------------------------------

const wsServer = new WebSocketServer({ port: WS_PORT, path: '/ws/sensing' });
const wsClients = new Set();

wsServer.on('connection', (ws) => {
  console.log(`[WS] Client connected (total: ${wsClients.size + 1})`);
  wsClients.add(ws);

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`[WS] Client disconnected (total: ${wsClients.size})`);
  });

  ws.on('error', (err) => {
    console.error(`[WS] Client error:`, err.message);
    wsClients.delete(ws);
  });
});

/** Broadcast a JSON message to all connected WebSocket clients. */
function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP API (port 3000)
// ---------------------------------------------------------------------------

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/health' || req.url === '/api/health') {
    const activeNodes = [...nodes.values()].filter(n => Date.now() - n.lastSeen < 10000);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      version: 2,
      source: 'udp',
      clients: wsClients.size,
      nodes: activeNodes.length,
      uptime_s: Math.floor((Date.now() - startTime) / 1000),
    }));

  } else if (req.url === '/api/nodes') {
    const activeNodes = [...nodes.values()].map(n => ({
      mac: n.mac,
      ip: n.sourceIp || '',
      frameCount: n.frameCount,
      lastSeen: n.lastSeen,
      sampleRate: parseFloat(n.measuredSampleRate.toFixed(1)),
      csiQuality: parseFloat(n.csiQuality.toFixed(3)),
      motionState: n.motionState,
      personCount: n.personCount,
      rawPersonCount: parseFloat((n.rawPersonCount || 0).toFixed(2)),
      emaPersonCount: parseFloat((n.emaPersonCount || 0).toFixed(2)),
      heartRate: n.heartRate,
      breathingRate: n.breathingRate,
      calibrated: n.calibrated,
      confidence: parseFloat(n.confidence.toFixed(3)),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(activeNodes));

  } else if (req.url === '/api/v1/sensing/latest') {
    // Discovery-compatible endpoint for HeartBeatz DiscoveryService
    const activeNodes = [...nodes.values()].filter(n => Date.now() - n.lastSeen < 10000);
    const nodeList = activeNodes.map(n => ({
      node_id: n.mac,
      mac: n.mac,
      ip: n.sourceIp || '',
      rssi: n.rssi || -50,
      timestamp: n.lastSeen,
      frames: n.frameCount,
      csi_quality: n.csiQuality,
      motion_state: n.motionState,
      person_count: n.personCount,
      heart_rate: n.heartRate,
      breathing_rate: n.breathingRate,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ nodes: nodeList }));

  } else if (req.url === '/api/calibrate') {
    // Force re-calibration of all nodes
    for (const node of nodes.values()) {
      node.calibrated = false;
      node.amplitudeHistory = [];
      node.emaPersonCount = null;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'calibrating', message: 'All nodes will recalibrate over next ~10s' }));

  } else if (req.url === '/api/diagnostics') {
    // Detailed diagnostics for the auto-improvement system
    const diag = [...nodes.values()].map(n => ({
      mac: n.mac,
      frameCount: n.frameCount,
      sampleRate: n.measuredSampleRate,
      calibrated: n.calibrated,
      baselineMeanAmp: n.baselineMeanAmp,
      baselineVariance: n.baselineVariance,
      currentAmpMean: n.amplitudeHistory.length > 0 ? mean(n.amplitudeHistory.slice(-20)) : 0,
      currentAmpVar: n.amplitudeHistory.length > 0 ? variance(n.amplitudeHistory.slice(-20)) : 0,
      emaPersonCount: n.emaPersonCount,
      rawPersonCount: n.rawPersonCount,
      personCount: n.personCount,
      motionLevel: n.motionLevel,
      csiQuality: n.csiQuality,
      confidence: n.confidence,
      heartRate: n.heartRate,
      breathingRate: n.breathingRate,
      amplitudeHistoryLen: n.amplitudeHistory.length,
      subcarrierHistoryLen: n.subcarrierHistory.length,
      blendedVar: n.blendedVar || 0,
      effectiveVar: n.effectiveVar || 0,
      excessVar: n.excessVar || 0,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      uptime_s: Math.floor((Date.now() - startTime) / 1000),
      totalFrames,
      wsClients: wsClients.size,
      nodes: diag,
    }));

  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ---------------------------------------------------------------------------
// UDP Receiver (port 5005)
// ---------------------------------------------------------------------------

const udpSocket = dgram.createSocket('udp4');
let totalFrames = 0;
const startTime = Date.now();

udpSocket.on('message', (msg, rinfo) => {
  const frame = parseFrame(msg);
  if (!frame) return;

  frame.sourceIp = rinfo.address;
  totalFrames++;
  processFrame(frame);

  // Diagnostic log every 500 frames (less noisy than v1's 200)
  if (totalFrames % 500 === 0) {
    const elapsed = (Date.now() - startTime) / 1000;
    const fps = (totalFrames / elapsed).toFixed(1);
    const nodeStats = [...nodes.values()].map(n =>
      `${n.mac.slice(-5)}:` +
      `${n.frameCount}f/${n.measuredSampleRate.toFixed(0)}Hz/` +
      `q${n.csiQuality.toFixed(2)}/` +
      `p${n.personCount}(ema${(n.emaPersonCount || 0).toFixed(1)})/` +
      `${n.motionState}` +
      `${n.calibrated ? '/cal' : ''}`
    ).join(', ');
    console.log(`[CSI] ${totalFrames} frames (${fps} fps) | ${nodeStats}`);
  }
});

udpSocket.on('error', (err) => {
  console.error(`[UDP] Error: ${err.message}`);
});

// ---------------------------------------------------------------------------
// Periodic Broadcast (10 Hz)
// ---------------------------------------------------------------------------

setInterval(() => {
  const activeNodes = [...nodes.values()].filter(n => Date.now() - n.lastSeen < 10000);

  if (activeNodes.length === 0) {
    broadcast({
      heart_rate: 0,
      breathing_rate: 0,
      motion_state: 'none',
      person_count: 0,
      timestamp: Date.now(),
      confidence: 0,
      csi_quality: 0,
      persons_positions: [],
    });
    return;
  }

  // Multi-node fusion (weighted, not just max)
  const totalPersons = fusePersonCount(activeNodes);

  // Vital signs: average across nodes that have valid readings
  const validHR = activeNodes.map(n => n.heartRate).filter(x => x > 0);
  const validBR = activeNodes.map(n => n.breathingRate).filter(x => x > 0);
  const avgHeartRate = validHR.length > 0 ? mean(validHR) : 0;
  const avgBreathing = validBR.length > 0 ? mean(validBR) : 0;

  const maxConfidence = Math.max(...activeNodes.map(n => n.confidence));
  const avgQuality = mean(activeNodes.map(n => n.csiQuality));

  // Overall motion: if any node detects motion
  const motionStates = activeNodes.map(n => n.motionState);
  let overallMotion = 'none';
  if (motionStates.includes('moving')) overallMotion = 'moving';
  else if (motionStates.includes('stationary')) overallMotion = 'stationary';

  // Generate approximate positions (clustered on the couch area)
  const positions = [];
  for (let i = 0; i < totalPersons; i++) {
    positions.push({
      x: 0.3 + (0.4 * i / Math.max(1, totalPersons - 1)),
      y: 0.5 + 0.05 * Math.sin(Date.now() / 5000 + i),
    });
  }

  broadcast({
    heart_rate: Math.round(avgHeartRate) || 0,
    breathing_rate: Math.round(avgBreathing) || 0,
    motion_state: overallMotion,
    person_count: totalPersons,
    timestamp: Date.now(),
    confidence: parseFloat(maxConfidence.toFixed(2)),
    csi_quality: parseFloat(avgQuality.toFixed(2)),
    persons_positions: positions,
    // Per-node vitals for zone-based display (each node covers a different area)
    node_vitals: activeNodes.map(n => ({
      mac: n.mac,
      name: n.name || `Node ${n.mac.slice(-5)}`,
      heartRate: n.heartRate,
      breathingRate: n.breathingRate,
      personCount: n.personCount,
      motionState: n.motionState,
      csiQuality: parseFloat(n.csiQuality.toFixed(2)),
      confidence: parseFloat(n.confidence.toFixed(2)),
    })),
    _nodes: activeNodes.map(n => ({
      mac: n.mac,
      frames: n.frameCount,
      quality: parseFloat(n.csiQuality.toFixed(2)),
      personCount: n.personCount,
      sampleRate: parseFloat(n.measuredSampleRate.toFixed(1)),
    })),
  });
}, TICK_MS);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

udpSocket.bind(UDP_PORT, () => {
  console.log(`[CSI Bridge v2] UDP receiver listening on 0.0.0.0:${UDP_PORT}`);
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`[CSI Bridge v2] HTTP API on http://localhost:${HTTP_PORT}/health`);
  console.log(`[CSI Bridge v2] Diagnostics: http://localhost:${HTTP_PORT}/api/diagnostics`);
});

console.log(`[CSI Bridge v2] WebSocket server on ws://localhost:${WS_PORT}/ws/sensing`);
console.log(`[CSI Bridge v2] Ready — waiting for ESP32 CSI frames...`);
console.log(`[CSI Bridge v2] Improvements: EMA smoothing, autocorrelation, multi-node fusion`);
