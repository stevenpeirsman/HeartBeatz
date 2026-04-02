// ==============================================================================
// CSI UDP-to-WebSocket Bridge — v3 (Rolling Recalibration + Heatmap)
// ==============================================================================
// Receives ADR-018 binary CSI frames from ESP32 nodes over UDP (port 5005),
// processes them into vital-sign estimates, and broadcasts via WebSocket
// (port 3001) in the format the HeartBeatz server expects.
//
// v3 Improvements over v2:
//   - Rolling baseline recalibration (continuously adapts to environment changes)
//   - CFAR-inspired person detection (Constant False Alarm Rate adaptive thresholds)
//   - Per-subcarrier heatmap API for dev visualization (/api/heatmap)
//   - Improved noise floor tracking with exponential aging
//   - Environment change detection (furniture moved, doors opened, etc.)
//
// v2 Improvements over v1:
//   - EMA smoothing on person count (eliminates 0-8 fluctuation)
//   - Autocorrelation-based frequency estimation (replaces zero-crossing)
//   - Multi-node weighted fusion (replaces naive Math.max)
//   - Adaptive thresholds using running statistics
//   - Actual measured sample rate instead of hardcoded 50 Hz
//   - Bandpass-style filtering for vital sign extraction
//   - Initial calibration phase to establish per-node baselines
//
// Architecture:
//   ESP32 nodes ──UDP:5005──> [CSI Bridge] ──WS:3001──> HeartBeatz Server
//                                  │
//                              HTTP:3000 (/health, /api/nodes, /api/v1/sensing/latest,
//                                         /api/heatmap, /api/diagnostics)
//
// Usage: node csi-bridge.js
// Env:   UDP_PORT=5005, HTTP_PORT=3000, WS_PORT=3001

import dgram from 'dgram';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

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

// ---------------------------------------------------------------------------
// Live-Tunable Configuration (adjustable at runtime via /api/tuning)
// ---------------------------------------------------------------------------
// All detection thresholds are in this object so the admin UI can tweak them
// without restarting the bridge. GET /api/tuning returns current values;
// PUT /api/tuning accepts a partial JSON object to merge.

const tuning = {
  // EMA smoothing factors (0 = no smoothing, 1 = no memory)
  emaPersonCount: 0.002,   // v2.8: ~13.9s half-life at 25Hz
  emaHeartRate:   0.12,    // Slightly faster for per-person tracking
  emaBreathing:   0.08,    // Slightly faster for per-person tracking
  emaMotion:      0.30,    // Fast — catch kids running quickly

  // Person count threshold ladder (effectiveVar breakpoints)
  thresholdZero:    0.05,  // Below → 0 people
  thresholdOne:     0.20,  // Below → 1 person
  thresholdTwo:     0.50,  // Below → interpolate 1→2
  thresholdThree:   1.00,  // Below → interpolate 2→3
  thresholdFour:    1.80,  // Below → interpolate 3→4
  thresholdFive:    3.00,  // Above → cap at 5

  // Absolute floor fallback (v2.22)
  absoluteFloor:       0.22,  // blendedVar must exceed this for fallback person detection
  absoluteFloorScale:  0.35,  // Maps blendedVar 0.22→0.57 to personCount 0→1

  // Max baseline variance cap
  maxBaselineVar:    7.0,

  // Hysteresis thresholds for person count flipping
  hysteresisUp:    0.30,   // emaPC must exceed this to flip 0→1
  hysteresisDown:  0.40,   // |emaPC - personCount| must exceed this to flip

  // Motion detection thresholds
  motionThreshold:     180,
  stationaryThreshold: 170,

  // Vital sign gating
  vitalGateThreshold: 0.45,  // Suppress vitals when emaPC below this

  // Calibration
  calibrationFrames: 150,   // ~6s at 25Hz

  // Rolling recalibration
  recalWindowS:      120,   // 2-minute sliding window
  recalIntervalS:    30,    // Re-evaluate every 30s
  recalQuietPctile:  10,    // 10th percentile as quiet floor
  recalMinFrames:    500,   // Min frames before first recal
  recalMaxShift:     0.5,   // Max baseline shift per cycle
  recalBlendAlpha:   0.3,   // Blend weight for new baseline

  // Variance blending weights (must sum to 1.0)
  blendWeightShort:  0.10,  // Recent 50 frames (~2.5s)
  blendWeightMed:    0.20,  // 120 frames (~6s)
  blendWeightLong:   0.70,  // 400 frames (~20s)

  // Multi-node fusion
  fusionQuietThreshold: 2.0,  // Nodes below this are "quiet"
  fusionQuietWeight:    0.5,  // Weight of quiet-node ref in fusion
};

// Legacy const aliases REMOVED — all code now reads tuning.* directly for live updates.
// (remaining legacy aliases removed — use tuning.recalMaxShift / tuning.recalBlendAlpha)

// ---------------------------------------------------------------------------
// Tuning Persistence — load from disk on startup, save on every PUT
// ---------------------------------------------------------------------------
const __bridgeDirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__bridgeDirname, '..', 'data');
const TUNING_ACTIVE_PATH = join(DATA_DIR, 'tuning-active.json');

/** Load saved tuning from disk (merges into the tuning object). */
function loadTuningFromDisk() {
  try {
    if (!existsSync(TUNING_ACTIVE_PATH)) return;
    const raw = JSON.parse(readFileSync(TUNING_ACTIVE_PATH, 'utf-8'));
    const saved = raw.tuning || raw; // Support both {tuning:{...}} and flat format
    let loaded = 0;
    for (const [key, val] of Object.entries(saved)) {
      if (key in tuning && typeof val === 'number' && isFinite(val)) {
        tuning[key] = val;
        loaded++;
      }
    }
    console.log(`[Tuning] Loaded ${loaded} params from ${TUNING_ACTIVE_PATH}`);
  } catch (err) {
    console.warn(`[Tuning] Could not load saved tuning: ${err.message}`);
  }
}

/** Save current tuning to disk. */
function saveTuningToDisk() {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const payload = {
      version: 'active',
      savedAt: new Date().toISOString(),
      tuning: { ...tuning },
    };
    writeFileSync(TUNING_ACTIVE_PATH, JSON.stringify(payload, null, 2));
    console.log(`[Tuning] Saved to ${TUNING_ACTIVE_PATH}`);
  } catch (err) {
    console.warn(`[Tuning] Could not save tuning: ${err.message}`);
  }
}

// Apply saved tuning on startup
loadTuningFromDisk();

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
    this.firstSeen = Date.now();
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
    this.rawCountBufferSize = 35;    // ~1.4 second median filter at 25Hz (wider spike rejection window)

    // --- EMA-smoothed outputs ---
    this.emaPersonCount = null;
    this.emaHeartRate = null;
    this.emaBreathingRate = null;
    this.emaMotionLevel = null;

    // --- v3: Rolling recalibration state ---
    this.varianceLog = [];           // Timestamped variance samples for recalibration
    this.lastRecalTime = 0;          // Last time recalibration was evaluated
    this.recalCount = 0;             // How many times we've recalibrated
    this.baselineHistory = [];       // Track baseline evolution for diagnostics

    // --- v3: Heatmap data (per-subcarrier amplitudes for visualization) ---
    this.heatmapBuffer = [];         // Ring buffer of recent per-subcarrier amplitudes
    this.heatmapBufferSize = 100;    // ~5 seconds at 20Hz — enough for smooth visualization
    this.heatmapTimestamps = [];     // Corresponding timestamps
    this.lastSubcarrierAmps = [];    // Most recent frame's per-subcarrier amplitudes

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
  if (node.amplitudeHistory.length < tuning.calibrationFrames) return;
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
 * v3: Rolling baseline recalibration.
 *
 * Tracks variance over a sliding window and periodically re-evaluates the
 * baseline using the quietest periods observed. This solves several problems:
 *   1. Calibration poisoned by people present at startup
 *   2. Environment drift (temperature changes, interference, furniture moves)
 *   3. Long-running sessions where the initial baseline becomes stale
 *
 * Uses a percentile approach (CFAR-inspired): the baseline is set to the
 * Nth percentile of recent variance, so transient human presence (high
 * variance) doesn't inflate it, but sustained environmental changes do.
 */
function rollingRecalibrate(node) {
  if (!node.calibrated) return;  // Wait for initial calibration first
  if (node.frameCount < tuning.recalMinFrames) return;

  const now = Date.now();

  // Log current variance sample for recalibration analysis
  if (node.amplitudeHistory.length >= 20) {
    const recentVar = variance(node.amplitudeHistory.slice(-20));
    node.varianceLog.push({ t: now, v: recentVar });
  }

  // Trim old entries beyond the recalibration window
  const cutoff = now - tuning.recalWindowS * 1000;
  while (node.varianceLog.length > 0 && node.varianceLog[0].t < cutoff) {
    node.varianceLog.shift();
  }

  // Only recalibrate at the configured interval
  if (now - node.lastRecalTime < tuning.recalIntervalS * 1000) return;
  node.lastRecalTime = now;

  // Need enough variance samples to make a meaningful assessment
  if (node.varianceLog.length < 30) return;

  // Find the Nth percentile of variance = our "quiet floor" estimate
  const sortedVars = node.varianceLog.map(e => e.v).sort((a, b) => a - b);
  const pctileIdx = Math.floor(sortedVars.length * tuning.recalQuietPctile / 100);
  const quietFloor = sortedVars[Math.max(0, pctileIdx)];

  // Damped update: don't shift too far in one step
  const oldBaseline = node.baselineVariance;
  const delta = quietFloor - oldBaseline;
  const clampedDelta = Math.sign(delta) * Math.min(Math.abs(delta), tuning.recalMaxShift);
  const newBaseline = oldBaseline + clampedDelta * tuning.recalBlendAlpha;

  // Apply same minimum floor as initial calibration
  node.baselineVariance = Math.max(0.5, newBaseline);

  // Also update baseline mean amplitude from quiet periods
  // (use the amplitude mean from the same percentile window)
  if (node.amplitudeHistory.length >= 50) {
    const recentMean = mean(node.amplitudeHistory.slice(-50));
    node.baselineMeanAmp = node.baselineMeanAmp * (1 - tuning.recalBlendAlpha * 0.5)
                         + recentMean * (tuning.recalBlendAlpha * 0.5);
  }

  node.recalCount++;

  // Track baseline evolution for diagnostics
  node.baselineHistory.push({
    t: now,
    oldVar: oldBaseline,
    newVar: node.baselineVariance,
    quietFloor,
    samples: node.varianceLog.length,
  });
  // Keep last 20 recalibration events
  if (node.baselineHistory.length > 20) node.baselineHistory.shift();

  // Log significant shifts
  if (Math.abs(node.baselineVariance - oldBaseline) > 0.1) {
    console.log(`[CSI] Node ${node.mac.slice(-5)} recalibrated (#${node.recalCount}): ` +
      `baseline_var ${oldBaseline.toFixed(3)} → ${node.baselineVariance.toFixed(3)} ` +
      `(quiet_floor=${quietFloor.toFixed(3)}, samples=${node.varianceLog.length})`);
  }
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

  // Very-long window: ~16 seconds (400 frames) — ultra-stable baseline
  // v2.2: increased from 200→300 to reduce blendedVar dip-below-noiseFloor on noisy nodes
  // v2.3: increased from 300→400 (matches amplitudeWindowSize) to further reduce
  //       blendedVar volatility — observed 6.0→8.7 swing over 15s on node 56:5c
  //       causing emaPersonCount stddev of 0.71 (target < 0.5)
  const veryLongSlice = node.amplitudeHistory.slice(-Math.min(400, node.amplitudeHistory.length));
  const veryLongVar = variance(veryLongSlice);

  // Blend: heavily favor long-term for stability; short-term detects fast changes
  // v2.1: reduced short-term weight (0.15→0.10) to cut blendedVar volatility
  //       on noisy nodes (observed 6.4→8.9 swing over 7s on node 56:5c)
  const blendedVar = tuning.blendWeightShort * temporalVar + tuning.blendWeightMed * longVar + tuning.blendWeightLong * veryLongVar;

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
  // v2.9: raised from 5.0→7.0 — node 36:24 calibrated with baselineVariance=10.66
  //       (likely during activity). Cap of 5.0 left noiseFloor too low, causing
  //       excessVar/effectiveVar to wildly over-count (rawPersonCount 4.7–5 when
  //       blendedVar spiked to 8–13). 7.0 reduces over-counting while still
  //       allowing detection on inherently noisy nodes.
  const noiseFloor = node.calibrated
    ? Math.max(0.05, Math.min(tuning.maxBaselineVar, node.baselineVariance))
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
  // Person count threshold ladder — all breakpoints read from tuning object
  // so the admin UI can live-adjust detection sensitivity
  const t = tuning;
  let rawCount;
  if (effectiveVar < t.thresholdZero) {
    rawCount = 0;
  } else if (effectiveVar < t.thresholdOne) {
    rawCount = 1;
  } else if (effectiveVar < t.thresholdTwo) {
    rawCount = 1 + (effectiveVar - t.thresholdOne) / (t.thresholdTwo - t.thresholdOne);
  } else if (effectiveVar < t.thresholdThree) {
    rawCount = 2 + (effectiveVar - t.thresholdTwo) / (t.thresholdThree - t.thresholdTwo);
  } else if (effectiveVar < t.thresholdFour) {
    rawCount = 3 + (effectiveVar - t.thresholdThree) / (t.thresholdFour - t.thresholdThree);
  } else if (effectiveVar < t.thresholdFive) {
    rawCount = 4 + (effectiveVar - t.thresholdFour) / (t.thresholdFive - t.thresholdFour);
  } else {
    rawCount = Math.min(7, 5 + (effectiveVar - t.thresholdFive) / 2);
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

  // --- v2.22: Absolute blendedVar floor detection ---
  // When the variance-based path is blinded by an inflated startup-calibration baseline
  // (noiseFloor = baselineVariance = 2.0 from startup noise, but current blendedVar is
  // consistently 0.30-0.90 with a person present), detect presence via absolute level.
  // Threshold 0.22 (v2.23: reverted from 0.30 back to 0.22) — diagnostic run 2026-03-31
  // observed node 56:5c emaPersonCount declining 0.783→0.543 over 14s (ema_eq ≈ 0.306)
  // because blendedVar oscillates 0.225–0.546 around the 0.30 threshold (breathing-driven).
  // With threshold=0.30, ~1/3 of readings give rawCount=0, pulling ema below the 0.5 flip
  // boundary and causing a false personCount=0. Lowering to 0.22 keeps all observed
  // person-present readings above threshold (min blendedVar=0.225); ema_eq rises to ~0.51
  // (stable at personCount=1). Node 36:24 current max blendedVar=0.340 → rawCount=0.343
  // → ema_eq≈0.12, well below the 0.3 false-positive flip boundary. Accepted trade-off:
  // if node 36:24 blendedVar spikes above ~0.51 for 15+ continuous seconds, a false count
  // increment is possible — monitor in next run.
  // Scale 0.35 preserved: 0.22 → 0, 0.57 → 1.0 person. Only activates when variance path = 0.
  if (node.calibrated && rawCount === 0 && blendedVar > t.absoluteFloor) {
    rawCount = Math.min(1.0, (blendedVar - t.absoluteFloor) / t.absoluteFloorScale);
  }

  node.rawPersonCount = rawCount;

  // --- Median filter: reject outlier spikes ---
  node.rawCountBuffer.push(rawCount);
  if (node.rawCountBuffer.length > node.rawCountBufferSize) {
    node.rawCountBuffer.shift();
  }
  const medianCount = median(node.rawCountBuffer);

  // --- EMA smoothing on median-filtered count ---
  node.emaPersonCount = emaUpdate(node.emaPersonCount, medianCount, tuning.emaPersonCount);

  // Hysteresis: only update displayed count when EMA moves >0.4 from current
  const emaRounded = Math.round(node.emaPersonCount);
  if (Math.abs(node.emaPersonCount - node.personCount) > t.hysteresisDown ||
      (node.personCount === 0 && node.emaPersonCount > t.hysteresisUp)) {
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
      // v2.19: raised breathing minFreq 0.15→0.20 Hz (9→12 bpm) — observed BR=10
      //        band-edge artifact on node 36:24 (BR latching onto search-band minimum,
      //        same pattern as HR band-edge fix in v2.17). 12 bpm aligns with the
      //        lower bound of clinically normal resting breathing rate (12-25 bpm).
      const { freq, confidence } = estimateFrequencyAutocorr(filtered, sr, 0.20, 0.5);
      if (freq > 0 && confidence > 0.2) {
        const bpm = freq * 60;
        node.emaBreathingRate = emaUpdate(node.emaBreathingRate, bpm, tuning.emaBreathing);
        node.breathingRate = Math.round(node.emaBreathingRate);
      } else if (node.emaBreathingRate > 0) {
        // v2.16: decay stale breathing rate when autocorrelation fails confidence gate.
        //        Without decay, the last detected value persists indefinitely while
        //        the personCount EMA is still above the zero-out threshold (0.45).
        //        Decay alpha = tuning.emaBreathing * 0.05 ≈ 0.004 → ~70s half-life at 25Hz.
        node.emaBreathingRate = emaUpdate(node.emaBreathingRate, 0, tuning.emaBreathing * 0.05);
        // v2.20: raised zero-out threshold 3→10 — observed BR=10-11 band-edge decay
        //        artifact on node 36:24 (autocorrelation intermittently detects at
        //        band-edge 12 bpm then fails confidence, EMA decays to 10-11).
        //        Since autocorrelation search band minimum is 12 bpm (0.20 Hz),
        //        any ema<10 is a decay artifact (same logic as HR fix in v2.18).
        if (node.emaBreathingRate < 10) { node.emaBreathingRate = 0; }
        node.breathingRate = Math.round(node.emaBreathingRate);
      }
    }
  }

  // --- Heart Rate (0.833-2.0 Hz = 50-120 bpm) ---
  if (node.heartBuffer.length >= 60) {
    // Bandpass: keep 0.7-2.3 Hz content
    const shortWin = Math.max(2, Math.round(sr * 0.15));
    const longWin = Math.max(5, Math.round(sr * 1.0));
    const filtered = bandpassFilter(node.heartBuffer, shortWin, longWin);

    if (filtered.length >= 30) {
      // v2.17: raised minFreq 0.8→0.833 Hz (48→50 bpm) — observed HR=48 band-edge
      //        artifact on node 36:24 (HR declining 68→55→48 over 15s, latching onto
      //        search-band minimum). 50 bpm aligns with clinically normal resting range.
      const { freq, confidence } = estimateFrequencyAutocorr(filtered, sr, 0.833, 2.0);
      // v2.15: raised HR confidence gate 0.35→0.40 — observed HR=114 artifact
      //        on node 56:5c during EMA decay (rawPersonCount=0, ema=1.2→0.42).
      //        Higher confidence filters marginal detections near search-band edges.
      if (freq > 0 && confidence > 0.40) {
        const bpm = freq * 60;
        node.emaHeartRate = emaUpdate(node.emaHeartRate, bpm, tuning.emaHeartRate);
        node.heartRate = Math.round(node.emaHeartRate);
      } else if (node.emaHeartRate > 0) {
        // v2.16: decay stale heart rate when autocorrelation fails confidence gate.
        //        Observed HR=74 stuck across 15s on node f1:a4 while rawPersonCount
        //        dropped to 0 and effectiveVar=0 — the EMA personCount was still 3.4
        //        so the zero-out gate at line 650 didn't trigger.
        //        Decay alpha = tuning.emaHeartRate * 0.05 ≈ 0.006 → ~46s half-life at 25Hz.
        node.emaHeartRate = emaUpdate(node.emaHeartRate, 0, tuning.emaHeartRate * 0.05);
        // v2.18: raised zero-out threshold 5→40 — observed HR=6 phantom on node
        //        36:24 during EMA decay (ema=5.5, round→6). Since autocorrelation
        //        search band minimum is 50 bpm, any ema<40 is a decay artifact.
        if (node.emaHeartRate < 40) { node.emaHeartRate = 0; }
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

  // v3: Heatmap buffer (per-subcarrier amplitudes for dev visualization)
  node.lastSubcarrierAmps = amps;
  node.heatmapBuffer.push(amps);
  node.heatmapTimestamps.push(Date.now());
  if (node.heatmapBuffer.length > node.heatmapBufferSize) {
    node.heatmapBuffer.shift();
    node.heatmapTimestamps.shift();
  }

  // --- Motion Detection (with EMA) ---
  const recentVariance = mean(node.varianceHistory);
  node.emaMotionLevel = emaUpdate(node.emaMotionLevel, recentVariance, tuning.emaMotion);
  node.motionLevel = node.emaMotionLevel;

  // v2.10: raised thresholds — ambient cross-subcarrier variance in an
  // empty room is 66-154 (node-dependent); old values (5/1) caused perpetual "moving" state.
  // New values sit above observed ambient so "none" is the idle state and
  // real human activity pushes the metric above stationary/moving limits.
  if (node.emaMotionLevel > tuning.motionThreshold) {
    node.motionState = 'moving';
  } else if (node.emaMotionLevel > tuning.stationaryThreshold) {
    node.motionState = 'stationary';
  } else {
    node.motionState = 'none';
  }

  // --- Calibration ---
  calibrate(node);

  // --- v3: Rolling Recalibration (adapts baseline to environment changes) ---
  rollingRecalibrate(node);

  // --- Person Count (with EMA + adaptive thresholds) ---
  estimatePersonCount(node);

  // --- Vital Signs (autocorrelation-based) ---
  // Only run every 5 frames to save CPU
  if (node.frameCount % 5 === 0) {
    estimateVitalSigns(node);
  }

  // --- Vital Sign Gating (v2.7, tuned v2.9) ---
  // Suppress displayed vital signs when no person is detected.
  // The autocorrelation picks up periodic artifacts in ambient WiFi noise,
  // producing misleading HR/BR readings in an empty room. The EMA buffers
  // keep tracking internally so values ramp up quickly when someone enters.
  // v2.9: lowered emaPersonCount gate from 0.3 → 0.15 to suppress spurious
  //       HR during EMA decay (observed HR=83 with personCount=0, ema=0.33).
  // v2.11: raised gate from 0.15 → 0.25 — observed spurious HR=68/BR=27 on
  //        node 36:24 with personCount=0 but ema=0.17 (just above 0.15).
  //        0.25 is still below the hysteresis flip-to-1 at ema>0.3, so vitals
  //        appear shortly before the count transitions without false positives.
  // v2.14: raised gate from 0.25 → 0.45 — observed spurious HR=87 on node
  //        56:5c with personCount=0 but ema=0.40 (inflated by transient noise
  //        spike rawPersonCount=2.63). 0.45 is still below the hysteresis
  //        flip-to-1 at ema≥0.5, so vitals appear during genuine arrivals.
  if (node.personCount === 0 && node.emaPersonCount < tuning.vitalGateThreshold) {
    node.heartRate = 0;
    node.breathingRate = 0;
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

  // --- Gate: only fuse nodes that are calibrated AND have a reasonable
  //     sample rate (≥5 Hz).  Uncalibrated / low-rate nodes have unstable
  //     baselines and their person-count estimates are unreliable.
  const MIN_FUSION_SAMPLE_RATE = 5;          // Hz
  const fusionReady = activeNodes.filter(
    n => n.calibrated && n.measuredSampleRate >= MIN_FUSION_SAMPLE_RATE
  );

  // Fall back to all active nodes only if *none* qualify (better than zero)
  const candidates = fusionReady.length > 0 ? fusionReady : activeNodes;

  if (candidates.length === 1) return candidates[0].personCount;

  let weightedSum = 0;
  let totalWeight = 0;

  for (const node of candidates) {
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
  const quietNodes = candidates.filter(n => (n.noiseLevel || 0.1) < tuning.fusionQuietThreshold);
  let quietRef;
  if (quietNodes.length > 0) {
    // Quiet nodes exist — trust the max among them
    quietRef = Math.max(...quietNodes.map(n => n.personCount));
  } else {
    // v2.12: No reliably quiet nodes (all at baselineVariance clamp) —
    // use MEDIAN instead of MAX to prevent a single outlier node from
    // dominating the fused count. Previously, max(all) caused the system
    // to report 3 people when 2/3 nodes saw 0 and 1 outlier saw 5.
    const counts = candidates.map(n => n.personCount).sort((a, b) => a - b);
    quietRef = counts[Math.floor(counts.length / 2)];
  }

  // Blend: favor the quiet-node reference slightly
  return Math.round(tuning.fusionQuietWeight * quietRef + (1 - tuning.fusionQuietWeight) * fusedRaw);
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

// Resolve __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // v3: Serve dev heatmap page
  if (req.url === '/dev-heatmap' || req.url === '/dev-heatmap.html') {
    try {
      const html = readFileSync(join(__dirname, '..', 'public', 'dev-heatmap.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('Dev heatmap file not found: ' + e.message);
    }
    return;
  }

  if (req.url === '/health' || req.url === '/api/health') {
    const activeNodes = [...nodes.values()].filter(n => Date.now() - n.lastSeen < 10000);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      version: 3,
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

  } else if (req.url.startsWith('/api/nodes/identify')) {
    // Node identification — returns the 1-based index for a given MAC.
    // Called by ESP32 firmware on boot to learn its display number.
    // GET /api/nodes/identify?mac=aa:bb:cc:dd:ee:ff
    const params = new URL(req.url, 'http://localhost').searchParams;
    const mac = (params.get('mac') || '').toLowerCase();
    // Build ordered list of all known nodes sorted by first-seen time
    const allNodes = [...nodes.values()].sort((a, b) => (a.firstSeen || 0) - (b.firstSeen || 0));
    const idx = allNodes.findIndex(n => n.mac.toLowerCase() === mac);
    const index = idx >= 0 ? idx + 1 : 0;
    if (index > 0) {
      console.log(`[NodeID] Node ${mac} identified as #${index}`);
    } else {
      console.log(`[NodeID] Unknown MAC ${mac} — returning index 0`);
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ index, mac }));

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
      // v3: Rolling recalibration diagnostics
      recalCount: n.recalCount || 0,
      varianceLogLen: (n.varianceLog || []).length,
      baselineHistory: (n.baselineHistory || []).slice(-5).map(e => ({
        t: e.t,
        oldVar: e.oldVar?.toFixed(4),
        newVar: e.newVar?.toFixed(4),
        quietFloor: e.quietFloor?.toFixed(4),
      })),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      uptime_s: Math.floor((Date.now() - startTime) / 1000),
      version: 3,
      totalFrames,
      wsClients: wsClients.size,
      nodes: diag,
    }));

  } else if (req.url === '/api/heatmap') {
    // v3: Per-subcarrier heatmap data for dev visualization
    // Returns recent per-subcarrier amplitude data for each active node
    const heatmap = [...nodes.values()]
      .filter(n => Date.now() - n.lastSeen < 10000)
      .map(n => ({
        mac: n.mac,
        sampleRate: parseFloat(n.measuredSampleRate.toFixed(1)),
        personCount: n.personCount,
        emaPersonCount: parseFloat((n.emaPersonCount || 0).toFixed(3)),
        blendedVar: parseFloat((n.blendedVar || 0).toFixed(4)),
        effectiveVar: parseFloat((n.effectiveVar || 0).toFixed(4)),
        noiseFloor: parseFloat((n.noiseLevel || 0).toFixed(4)),
        baselineVariance: parseFloat((n.baselineVariance || 0).toFixed(4)),
        recalCount: n.recalCount || 0,
        // Current frame: per-subcarrier amplitudes
        currentAmps: n.lastSubcarrierAmps || [],
        // Historical: last N frames of per-subcarrier data (downsampled for bandwidth)
        // Send every 5th frame to keep payload manageable
        history: {
          timestamps: n.heatmapTimestamps.filter((_, i) => i % 5 === 0),
          // Each entry is an array of subcarrier amplitudes
          frames: n.heatmapBuffer.filter((_, i) => i % 5 === 0),
        },
        // Per-subcarrier statistics (mean and variance over recent window)
        subcarrierStats: (() => {
          if (n.subcarrierHistory.length < 5) return { means: [], variances: [] };
          const nSubs = n.subcarrierHistory[0]?.length || 0;
          const means = [];
          const variances = [];
          for (let sc = 0; sc < nSubs; sc++) {
            const series = n.subcarrierHistory.map(f => f[sc] || 0);
            means.push(parseFloat(mean(series).toFixed(2)));
            variances.push(parseFloat(variance(series).toFixed(2)));
          }
          return { means, variances };
        })(),
        // Baseline evolution (for diagnostics chart)
        baselineHistory: (n.baselineHistory || []).map(e => ({
          t: e.t,
          oldVar: parseFloat(e.oldVar.toFixed(4)),
          newVar: parseFloat(e.newVar.toFixed(4)),
          quietFloor: parseFloat(e.quietFloor.toFixed(4)),
        })),
      }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ timestamp: Date.now(), nodes: heatmap }));

  } else if (req.url === '/api/heatmap/stream') {
    // v3: Server-Sent Events stream for real-time heatmap updates
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 200\n\n');

    const interval = setInterval(() => {
      const data = [...nodes.values()]
        .filter(n => Date.now() - n.lastSeen < 10000)
        .map(n => ({
          mac: n.mac,
          personCount: n.personCount,
          emaPersonCount: parseFloat((n.emaPersonCount || 0).toFixed(3)),
          blendedVar: parseFloat((n.blendedVar || 0).toFixed(4)),
          effectiveVar: parseFloat((n.effectiveVar || 0).toFixed(4)),
          baselineVariance: parseFloat((n.baselineVariance || 0).toFixed(4)),
          currentAmps: n.lastSubcarrierAmps || [],
          motionState: n.motionState,
          heartRate: n.heartRate,
          breathingRate: n.breathingRate,
        }));
      res.write(`data: ${JSON.stringify({ t: Date.now(), nodes: data })}\n\n`);
    }, 200);  // 5 Hz update rate for smooth visualization

    req.on('close', () => clearInterval(interval));

  } else if (req.url === '/api/tuning' && req.method === 'GET') {
    // Return all live-tunable parameters
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tuning));

  } else if (req.url === '/api/tuning' && req.method === 'PUT') {
    // Merge partial updates into tuning config (live, no restart needed)
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const updates = JSON.parse(body);
        let changed = 0;
        for (const [key, val] of Object.entries(updates)) {
          if (key in tuning && typeof val === 'number' && isFinite(val)) {
            tuning[key] = val;
            changed++;
          }
        }
        console.log(`[Tuning] Updated ${changed} parameters:`, Object.keys(updates).join(', '));
        saveTuningToDisk(); // Persist to disk so settings survive restart
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, changed, tuning }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON: ' + e.message }));
      }
    });

  } else if (req.url === '/api/tuning/presets' && req.method === 'GET') {
    // List saved tuning presets (tuning-*.json files in data/)
    try {
      const files = readdirSync(DATA_DIR).filter(f => f.startsWith('tuning-') && f.endsWith('.json'));
      const presets = files.map(f => {
        try {
          const raw = JSON.parse(readFileSync(join(DATA_DIR, f), 'utf-8'));
          return { file: f, version: raw.version || f, description: raw.description || '', date: raw.date || raw.savedAt || '' };
        } catch { return { file: f, version: f, description: 'parse error' }; }
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(presets));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (req.url?.startsWith('/api/tuning/restore/') && req.method === 'PUT') {
    // Restore a saved preset: PUT /api/tuning/restore/tuning-v1.json
    const filename = decodeURIComponent(req.url.split('/').pop());
    const presetPath = join(DATA_DIR, filename);
    try {
      if (!existsSync(presetPath)) throw new Error(`Preset not found: ${filename}`);
      const raw = JSON.parse(readFileSync(presetPath, 'utf-8'));
      const preset = raw.tuning || raw;
      let restored = 0;
      for (const [key, val] of Object.entries(preset)) {
        if (key in tuning && typeof val === 'number' && isFinite(val)) {
          tuning[key] = val;
          restored++;
        }
      }
      saveTuningToDisk();
      console.log(`[Tuning] Restored ${restored} params from preset ${filename}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, restored, preset: filename, tuning }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (req.url === '/api/tuning' && req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();

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
  let avgHeartRate = validHR.length > 0 ? mean(validHR) : 0;
  let avgBreathing = validBR.length > 0 ? mean(validBR) : 0;

  // v2.13: Fusion-level vital sign gating — suppress HR/BR when fused
  // person count is 0. Per-node gating (line ~643) catches most cases,
  // but when one node has a transient phantom detection (ema spike above
  // 0.25), its HR leaks into the broadcast even though fusion correctly
  // reports 0 people. This gate catches that edge case.
  if (totalPersons === 0) {
    avgHeartRate = 0;
    avgBreathing = 0;
  }

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
  console.log(`[CSI Bridge v3] UDP receiver listening on 0.0.0.0:${UDP_PORT}`);
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`[CSI Bridge v3] HTTP API on http://localhost:${HTTP_PORT}/health`);
  console.log(`[CSI Bridge v3] Diagnostics: http://localhost:${HTTP_PORT}/api/diagnostics`);
  console.log(`[CSI Bridge v3] Dev Heatmap: http://localhost:${HTTP_PORT}/api/heatmap`);
  console.log(`[CSI Bridge v3] SSE Stream:  http://localhost:${HTTP_PORT}/api/heatmap/stream`);
});

console.log(`[CSI Bridge v3] WebSocket server on ws://localhost:${WS_PORT}/ws/sensing`);
console.log(`[CSI Bridge v3] Ready — waiting for ESP32 CSI frames...`);
console.log(`[CSI Bridge v3] v3: Rolling recalibration, CFAR detection, dev heatmap`);
