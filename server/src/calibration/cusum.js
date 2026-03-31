import { ema } from '../shared/math-utils.js';

// ==============================================================================
// CUSUM Environment Change Detection — ACC-03-T2
// ==============================================================================
// Implements Cumulative Sum (CUSUM) change-point detection on per-subcarrier
// CSI residuals to detect environment changes such as furniture being moved,
// doors opening/closing, or temperature-induced drift.
//
// The algorithm monitors the difference between observed CSI variance and the
// expected baseline. When this cumulative residual exceeds a threshold, it
// signals that the environment has changed and triggers a baseline reset.
//
// Two-sided CUSUM is used to detect both upward shifts (new obstructions,
// interference) and downward shifts (obstructions removed, interference cleared).
//
// References:
//   - Page, E.S. "Continuous Inspection Schemes", Biometrika, 1954
//     (Original CUSUM formulation)
//   - Basseville, M. & Nikiforov, I. "Detection of Abrupt Changes: Theory and
//     Application", Prentice-Hall, 1993 (Multi-channel extension)
//   - Lucas, J.M. & Crosier, R.B. "Fast Initial Response for CUSUM Quality
//     Control Schemes", Technometrics, 1982 (FIR headstart)
//
// Usage:
//   import { CusumDetector } from './calibration/cusum.js';
//   const detector = new CusumDetector({ numChannels: 52 });
//   detector.initialize(baselinePerSubcarrier);
//   // On each CSI frame:
//   const result = detector.update(currentAmplitudes, timestamp);
//   if (result.changeDetected) {
//     // Trigger baseline recalibration
//   }
//
// ==============================================================================

/**
 * Default configuration for CUSUM environment change detection.
 * All values are overridable via constructor options or environment variables.
 *
 * @typedef {Object} CusumConfig
 * @property {number} numChannels         - Number of subcarrier channels to monitor (default: 52)
 * @property {number} slackParameter      - CUSUM allowance parameter (k): minimum shift size to detect,
 *                                          expressed in units of baseline std dev (default: 0.5)
 * @property {number} decisionThreshold   - CUSUM decision interval (h): cumulative sum must exceed this
 *                                          to trigger alarm, in units of baseline std dev (default: 5.0)
 * @property {number} channelVoteRatio    - Fraction of channels that must alarm to declare a change (default: 0.25)
 * @property {number} cooldownMs          - Minimum time between change detections in ms (default: 10000)
 * @property {number} warmupSamples       - Minimum samples before detection is active (default: 50)
 * @property {number} baselineStdFloor    - Minimum per-channel std dev to prevent division by zero (default: 0.1)
 * @property {number} firHeadstart        - Fast Initial Response headstart value as fraction of threshold (default: 0.5)
 * @property {boolean} enableFir          - Enable Fast Initial Response for quicker detection after reset (default: true)
 * @property {number} historySize         - Number of detection events to keep for diagnostics (default: 50)
 * @property {number} residualEmaAlpha    - EMA alpha for tracking per-channel running std dev (default: 0.02)
 */
const DEFAULT_CONFIG = Object.freeze({
  // --- Channel configuration ---
  numChannels:       52,     // ESP32-S3 HT20: 52 usable subcarriers

  // --- CUSUM parameters (Page 1954) ---
  // k = slack parameter: detects shifts > k standard deviations
  // h = decision threshold: larger h = fewer false alarms, slower detection
  // Rule of thumb: k = delta/2 where delta is the minimum shift to detect
  slackParameter:    0.5,    // Detect shifts > 1 std dev (k = delta/2 = 1.0/2)
  decisionThreshold: 5.0,    // ~5 sigma cumulative deviation triggers alarm

  // --- Multi-channel voting ---
  // Require multiple subcarriers to agree before declaring a change.
  // This rejects single-subcarrier glitches and narrow-band interference.
  channelVoteRatio:  0.25,   // 25% of channels must alarm (≈13 of 52)

  // --- Timing ---
  cooldownMs:        10000,  // 10s cooldown between detections
  warmupSamples:     50,     // ~2.5s at 20Hz before detection activates

  // --- Safety ---
  baselineStdFloor:  0.1,    // Minimum std dev per channel to prevent /0

  // --- Fast Initial Response (Lucas & Crosier 1982) ---
  // Starts the CUSUM statistic partway to the threshold after a reset,
  // so that changes occurring right after calibration are detected faster.
  firHeadstart:      0.5,    // Start at 50% of threshold
  enableFir:         true,

  // --- Diagnostics ---
  historySize:       50,

  // --- Adaptive baseline std tracking ---
  residualEmaAlpha:  0.02,   // EMA for running std dev estimation per channel
});

/**
 * Per-channel CUSUM state tracking a single subcarrier.
 * Maintains both upper (positive shift) and lower (negative shift) CUSUM
 * statistics for two-sided detection.
 *
 * @typedef {Object} ChannelState
 * @property {number} cusumHigh  - Upper CUSUM statistic (detects upward mean shift)
 * @property {number} cusumLow   - Lower CUSUM statistic (detects downward mean shift)
 * @property {number} baseline   - Expected amplitude for this channel
 * @property {number} runningStd - Running estimate of per-channel noise std dev
 * @property {boolean} alarming  - Whether this channel is currently in alarm state
 */

/**
 * Two-sided CUSUM change-point detector for multi-channel CSI data.
 *
 * Monitors per-subcarrier residuals (observed - baseline) and detects
 * statistically significant shifts in the CSI environment. Uses a voting
 * mechanism across channels to distinguish genuine environment changes
 * from transient per-subcarrier noise or narrow-band interference.
 *
 * @example
 * const detector = new CusumDetector({ numChannels: 52 });
 * const baselines = new Float64Array(52).fill(10.0);
 * detector.initialize(baselines);
 * const result = detector.update(newAmplitudes, Date.now());
 * if (result.changeDetected) console.log('Environment changed!');
 */
export class CusumDetector {
  /**
   * Create a new CUSUM change-point detector.
   * @param {Partial<CusumConfig>} [options={}] - Override default config values
   */
  constructor(options = {}) {
    /** @type {CusumConfig} */
    this.config = { ...DEFAULT_CONFIG, ...options };

    // --- Per-channel state arrays ---
    /** @type {Float64Array} Upper CUSUM statistic per channel */
    this.cusumHigh = new Float64Array(this.config.numChannels);
    /** @type {Float64Array} Lower CUSUM statistic per channel */
    this.cusumLow = new Float64Array(this.config.numChannels);
    /** @type {Float64Array} Expected amplitude baseline per channel */
    this.baselines = new Float64Array(this.config.numChannels);
    /** @type {Float64Array} Running std dev estimate per channel */
    this.runningStd = new Float64Array(this.config.numChannels);

    // --- Tracking state ---
    /** @type {boolean} Whether initialize() has been called */
    this.initialized = false;
    /** @type {number} Total samples processed */
    this.sampleCount = 0;
    /** @type {number} Timestamp of last change detection */
    this.lastChangeTime = 0;
    /** @type {number} Total number of detected changes */
    this.changeCount = 0;

    // --- Diagnostics ---
    /** @type {Array<CusumEvent>} Recent detection events */
    this.history = [];
  }

  /**
   * Initialize the detector with per-channel baseline amplitudes.
   *
   * Sets all CUSUM statistics to zero (or FIR headstart if enabled) and
   * stores the baselines for future residual computation.
   *
   * @param {ArrayLike<number>} baselineAmplitudes - Per-channel baseline values (length must match numChannels)
   * @param {ArrayLike<number>} [initialStdDevs]   - Per-channel std dev estimates (optional, defaults to baselineStdFloor)
   * @param {number} [timestamp=Date.now()]         - Initialization timestamp
   */
  initialize(baselineAmplitudes, initialStdDevs = null, timestamp = Date.now()) {
    const n = this.config.numChannels;

    if (baselineAmplitudes.length < n) {
      throw new Error(
        `CusumDetector.initialize(): expected ${n} baselines, got ${baselineAmplitudes.length}`
      );
    }

    // Store baselines and initial std devs
    for (let i = 0; i < n; i++) {
      this.baselines[i] = baselineAmplitudes[i];
      this.runningStd[i] = initialStdDevs
        ? Math.max(this.config.baselineStdFloor, initialStdDevs[i])
        : this.config.baselineStdFloor;
    }

    // Reset CUSUM statistics
    this._resetCusum();

    this.initialized = true;
    this.sampleCount = 0;
    this.lastChangeTime = timestamp;
    this.history = [];
  }

  /**
   * Process a new CSI amplitude frame and check for environment changes.
   *
   * For each subcarrier, computes the standardized residual:
   *   z_i = (observed_i - baseline_i) / runningStd_i
   *
   * Then updates the two-sided CUSUM statistics:
   *   S_high_i = max(0, S_high_i + z_i - k)   [detects upward shift]
   *   S_low_i  = max(0, S_low_i  - z_i - k)   [detects downward shift]
   *
   * A channel is "alarming" if either S_high or S_low exceeds the threshold h.
   * An environment change is declared when the fraction of alarming channels
   * exceeds the channelVoteRatio.
   *
   * @param {ArrayLike<number>} amplitudes - Per-channel amplitude values (length >= numChannels)
   * @param {number} [timestamp=Date.now()] - Frame timestamp in ms
   * @returns {CusumResult} Detection result and diagnostics
   */
  update(amplitudes, timestamp = Date.now()) {
    if (!this.initialized) {
      throw new Error('CusumDetector.update() called before initialize()');
    }

    const n = this.config.numChannels;
    if (amplitudes.length < n) {
      throw new Error(
        `CusumDetector.update(): expected ${n} amplitudes, got ${amplitudes.length}`
      );
    }

    this.sampleCount++;

    const k = this.config.slackParameter;
    const h = this.config.decisionThreshold;
    let alarmingCount = 0;
    let maxCusum = 0;
    let sumResidual = 0;

    for (let i = 0; i < n; i++) {
      // --- Compute standardized residual ---
      const residual = amplitudes[i] - this.baselines[i];
      const std = Math.max(this.runningStd[i], this.config.baselineStdFloor);
      const z = residual / std;

      sumResidual += Math.abs(z);

      // --- Update running std dev via EMA on absolute residuals ---
      // Using |residual| * sqrt(pi/2) as unbiased std estimator from MAD
      // (for Gaussian: E[|X|] = std * sqrt(2/pi), so std ≈ |X| * sqrt(pi/2))
      const absResidual = Math.abs(residual);
      const stdEstimate = absResidual * 1.2533;  // sqrt(pi/2) ≈ 1.2533
      this.runningStd[i] = ema(
        this.runningStd[i],
        Math.max(this.config.baselineStdFloor, stdEstimate),
        this.config.residualEmaAlpha
      );

      // --- Two-sided CUSUM update (Page 1954) ---
      // S_high detects upward shift: accumulates positive standardized residuals
      // S_low  detects downward shift: accumulates negative standardized residuals
      this.cusumHigh[i] = Math.max(0, this.cusumHigh[i] + z - k);
      this.cusumLow[i]  = Math.max(0, this.cusumLow[i]  - z - k);

      // Track max CUSUM for diagnostics
      const channelMax = Math.max(this.cusumHigh[i], this.cusumLow[i]);
      if (channelMax > maxCusum) maxCusum = channelMax;

      // Check if this channel is alarming
      if (this.cusumHigh[i] > h || this.cusumLow[i] > h) {
        alarmingCount++;
      }
    }

    const alarmRatio = alarmingCount / n;
    const meanAbsResidual = sumResidual / n;

    // --- Check for change detection ---
    const inWarmup = this.sampleCount < this.config.warmupSamples;
    const inCooldown = (timestamp - this.lastChangeTime) < this.config.cooldownMs;
    const voteExceeded = alarmRatio >= this.config.channelVoteRatio;

    const changeDetected = !inWarmup && !inCooldown && voteExceeded;

    if (changeDetected) {
      this.changeCount++;
      this.lastChangeTime = timestamp;

      // Record diagnostic event
      const event = {
        t: timestamp,
        changeIndex: this.changeCount,
        alarmRatio,
        alarmingChannels: alarmingCount,
        totalChannels: n,
        maxCusum,
        meanAbsResidual,
        direction: this._detectDirection(),
        sampleCount: this.sampleCount,
      };

      this.history.push(event);
      if (this.history.length > this.config.historySize) {
        this.history.shift();
      }

      // Reset CUSUM after detection to prepare for next change
      this._resetCusum();
    }

    return {
      changeDetected,
      alarmRatio,
      alarmingChannels: alarmingCount,
      maxCusum,
      meanAbsResidual,
      inWarmup,
      inCooldown,
      sampleCount: this.sampleCount,
      changeCount: this.changeCount,
    };
  }

  /**
   * Update the baselines after an environment change has been confirmed.
   * Called by the calibration system after it has computed new baselines.
   *
   * @param {ArrayLike<number>} newBaselines - Updated per-channel baseline amplitudes
   * @param {ArrayLike<number>} [newStdDevs] - Updated per-channel std dev estimates (optional)
   */
  updateBaselines(newBaselines, newStdDevs = null) {
    const n = this.config.numChannels;

    if (newBaselines.length < n) {
      throw new Error(
        `CusumDetector.updateBaselines(): expected ${n} baselines, got ${newBaselines.length}`
      );
    }

    for (let i = 0; i < n; i++) {
      this.baselines[i] = newBaselines[i];
      if (newStdDevs) {
        this.runningStd[i] = Math.max(this.config.baselineStdFloor, newStdDevs[i]);
      }
    }

    // Reset CUSUM statistics for the new baseline
    this._resetCusum();
  }

  /**
   * Determine the dominant direction of the detected change.
   * Compares total upper vs lower CUSUM mass across all channels.
   *
   * @returns {'up' | 'down' | 'mixed'} Direction of the environment shift
   * @private
   */
  _detectDirection() {
    let totalHigh = 0;
    let totalLow = 0;
    const n = this.config.numChannels;

    for (let i = 0; i < n; i++) {
      totalHigh += this.cusumHigh[i];
      totalLow += this.cusumLow[i];
    }

    if (totalHigh > totalLow * 2) return 'up';
    if (totalLow > totalHigh * 2) return 'down';
    return 'mixed';
  }

  /**
   * Reset all CUSUM statistics, optionally with FIR headstart.
   *
   * Fast Initial Response (FIR) starts the CUSUM partway to the threshold,
   * allowing faster detection of changes that occur immediately after a reset.
   * This is especially useful after initialization or baseline update.
   *
   * @private
   */
  _resetCusum() {
    const n = this.config.numChannels;
    const headstart = this.config.enableFir
      ? this.config.firHeadstart * this.config.decisionThreshold
      : 0;

    for (let i = 0; i < n; i++) {
      this.cusumHigh[i] = headstart;
      this.cusumLow[i]  = headstart;
    }
  }

  // NOTE: EMA computation delegated to shared/math-utils.js ema() — DEBT-01

  /**
   * Get the current per-channel CUSUM statistics for visualization.
   *
   * @returns {{ high: Float64Array, low: Float64Array, baselines: Float64Array, runningStd: Float64Array }}
   */
  getChannelStats() {
    return {
      high: new Float64Array(this.cusumHigh),
      low: new Float64Array(this.cusumLow),
      baselines: new Float64Array(this.baselines),
      runningStd: new Float64Array(this.runningStd),
    };
  }

  /**
   * Get serializable state for persistence or diagnostics.
   * @returns {Object} Serializable state
   */
  getState() {
    return {
      cusumHigh: Array.from(this.cusumHigh),
      cusumLow: Array.from(this.cusumLow),
      baselines: Array.from(this.baselines),
      runningStd: Array.from(this.runningStd),
      sampleCount: this.sampleCount,
      changeCount: this.changeCount,
      lastChangeTime: this.lastChangeTime,
      config: { ...this.config },
    };
  }

  /**
   * Restore detector state from a previously saved snapshot.
   *
   * @param {Object} state - State object from getState()
   */
  restoreState(state) {
    if (!state || !Array.isArray(state.cusumHigh)) {
      throw new Error('Invalid state object for CusumDetector.restoreState()');
    }

    const n = this.config.numChannels;
    for (let i = 0; i < n; i++) {
      this.cusumHigh[i] = state.cusumHigh[i] || 0;
      this.cusumLow[i]  = state.cusumLow[i] || 0;
      this.baselines[i] = state.baselines[i] || 0;
      this.runningStd[i] = state.runningStd[i] || this.config.baselineStdFloor;
    }

    this.sampleCount = state.sampleCount || 0;
    this.changeCount = state.changeCount || 0;
    this.lastChangeTime = state.lastChangeTime || 0;
    this.initialized = true;
  }

  /**
   * Get recent detection events for API/dashboard consumption.
   * @param {number} [count=10] - Number of events to return
   * @returns {Array<CusumEvent>} Recent events, newest last
   */
  getRecentHistory(count = 10) {
    return this.history.slice(-count);
  }

  /**
   * Reset detector to uninitialized state.
   */
  reset() {
    this.cusumHigh.fill(0);
    this.cusumLow.fill(0);
    this.baselines.fill(0);
    this.runningStd.fill(0);
    this.initialized = false;
    this.sampleCount = 0;
    this.changeCount = 0;
    this.lastChangeTime = 0;
    this.history = [];
  }
}

/**
 * @typedef {Object} CusumResult
 * @property {boolean} changeDetected    - Whether an environment change was detected this frame
 * @property {number}  alarmRatio        - Fraction of channels currently alarming [0, 1]
 * @property {number}  alarmingChannels  - Count of alarming channels
 * @property {number}  maxCusum          - Maximum CUSUM statistic across all channels
 * @property {number}  meanAbsResidual   - Mean |standardized residual| across channels
 * @property {boolean} inWarmup          - Whether detector is still in warmup phase
 * @property {boolean} inCooldown        - Whether detector is in post-detection cooldown
 * @property {number}  sampleCount       - Total frames processed
 * @property {number}  changeCount       - Total changes detected
 */

/**
 * @typedef {Object} CusumEvent
 * @property {number} t                - Timestamp of detection
 * @property {number} changeIndex      - Sequential index of this detection
 * @property {number} alarmRatio       - Fraction of channels alarming at detection
 * @property {number} alarmingChannels - Count of alarming channels at detection
 * @property {number} totalChannels    - Total channel count
 * @property {number} maxCusum         - Peak CUSUM value at detection
 * @property {number} meanAbsResidual  - Mean absolute standardized residual
 * @property {string} direction        - Dominant shift direction ('up'|'down'|'mixed')
 * @property {number} sampleCount      - Total samples at time of detection
 */
