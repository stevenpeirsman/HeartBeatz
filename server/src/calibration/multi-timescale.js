import { ema } from '../shared/math-utils.js';

// ==============================================================================
// Multi-Timescale Baseline Tracking — ACC-03-T1
// ==============================================================================
// Replaces the single-window rolling recalibration with three concurrent EMA
// baselines operating at different timescales:
//
//   FAST   (alpha=0.1,  ~30s half-life)  — tracks rapid environmental shifts
//   MEDIUM (alpha=0.01, ~5min half-life)  — tracks gradual drift (temperature, etc.)
//   SLOW   (alpha=0.001, ~1hr half-life)  — captures long-term "true" empty room
//
// The final baseline is a weighted blend that prefers the slow baseline when it
// agrees with medium, but falls back to fast when a sudden shift is detected
// (divergence between fast and slow exceeds a threshold).
//
// References:
//   - Adaptive CFAR Detection: Finn & Johnson, "Adaptive Detection Mode with
//     Threshold Control as a Function of Spatially Sampled Clutter Estimates",
//     RCA Review, 1968
//   - Multi-rate EMA: Brown, R.G. "Smoothing, Forecasting and Prediction of
//     Discrete Time Series", Prentice-Hall, 1963
//
// Usage:
//   import { MultiTimescaleTracker } from './calibration/multi-timescale.js';
//   const tracker = new MultiTimescaleTracker({ fastAlpha: 0.1 });
//   tracker.initialize(initialVariance, initialMeanAmp);
//   // On each CSI frame:
//   const result = tracker.update(currentVariance, currentMeanAmp, timestamp);
//   // result.baseline, result.baselineMeanAmp, result.activeScale, etc.
//
// ==============================================================================

/**
 * Default configuration for multi-timescale baseline tracking.
 * All values are overridable via constructor options or environment variables.
 *
 * @typedef {Object} MultiTimescaleConfig
 * @property {number} fastAlpha       - EMA alpha for fast timescale (default: 0.1)
 * @property {number} mediumAlpha     - EMA alpha for medium timescale (default: 0.01)
 * @property {number} slowAlpha       - EMA alpha for slow timescale (default: 0.001)
 * @property {number} fastHalfLifeS   - Approx half-life in seconds for fast EMA (informational)
 * @property {number} mediumHalfLifeS - Approx half-life in seconds for medium EMA (informational)
 * @property {number} slowHalfLifeS   - Approx half-life in seconds for slow EMA (informational)
 * @property {number} divergenceThreshold - Ratio threshold between fast and slow that triggers fast-tracking mode
 * @property {number} maxShiftPerUpdate   - Maximum baseline shift per update cycle to prevent overcorrection
 * @property {number} minBaseline         - Absolute minimum baseline variance floor
 * @property {number} updateIntervalMs    - Minimum time between EMA updates in milliseconds
 * @property {number} minSamplesForUpdate - Minimum variance samples before first update
 * @property {number} historySize         - Number of recalibration events to keep for diagnostics
 */
const DEFAULT_CONFIG = Object.freeze({
  // --- EMA smoothing alphas ---
  // alpha ≈ 1 - exp(-sampleInterval / halfLife)
  // At ~20 Hz sample rate with 30s update interval:
  fastAlpha:   0.1,    // half-life ≈ 30s  (reacts within ~1 minute)
  mediumAlpha: 0.01,   // half-life ≈ 5min (tracks gradual changes)
  slowAlpha:   0.001,  // half-life ≈ 1hr  (long-term reference)

  // --- Divergence detection ---
  // When fast/slow ratio exceeds this, the environment has shifted suddenly
  // and we weight the fast baseline more heavily.
  divergenceThreshold: 2.0,

  // --- Safety limits ---
  maxShiftPerUpdate: 0.5,   // Max absolute change in baseline per update
  minBaseline:       0.5,   // Floor to prevent division-by-zero in detection

  // --- Update scheduling ---
  updateIntervalMs:    1000, // Update EMAs at most once per second
  minSamplesForUpdate: 30,   // Need at least 30 variance samples before first update

  // --- Diagnostics ---
  historySize: 50,  // Keep last 50 recalibration events
});

/**
 * Multi-timescale EMA baseline tracker for CSI person detection.
 *
 * Maintains three concurrent exponential moving averages of the observed
 * variance, each at a different timescale. The final baseline is computed
 * as a weighted blend that adapts to environmental dynamics:
 *
 * - In steady state: slow baseline dominates (most stable)
 * - During rapid change: fast baseline takes over (most responsive)
 * - Gradual drift: medium baseline provides smooth tracking
 *
 * @example
 * const tracker = new MultiTimescaleTracker();
 * tracker.initialize(1.2, 45.0);
 * const result = tracker.update(1.5, 46.0);
 * console.log(result.baseline); // blended variance baseline
 */
export class MultiTimescaleTracker {
  /**
   * Create a new multi-timescale tracker.
   * @param {Partial<MultiTimescaleConfig>} [options={}] - Override default config values
   */
  constructor(options = {}) {
    /** @type {MultiTimescaleConfig} */
    this.config = { ...DEFAULT_CONFIG, ...options };

    // --- EMA state for each timescale ---
    /** @type {number} Fast-adapting EMA of variance */
    this.fastEma = 0;
    /** @type {number} Medium-adapting EMA of variance */
    this.mediumEma = 0;
    /** @type {number} Slow-adapting EMA of variance (long-term reference) */
    this.slowEma = 0;

    // --- EMA state for mean amplitude ---
    /** @type {number} Fast-adapting EMA of mean amplitude */
    this.fastMeanAmp = 0;
    /** @type {number} Medium-adapting EMA of mean amplitude */
    this.mediumMeanAmp = 0;
    /** @type {number} Slow-adapting EMA of mean amplitude */
    this.slowMeanAmp = 0;

    // --- Blended output ---
    /** @type {number} Current blended baseline variance */
    this.baseline = 0;
    /** @type {number} Current blended baseline mean amplitude */
    this.baselineMeanAmp = 0;

    // --- Tracking state ---
    /** @type {boolean} Whether initialize() has been called */
    this.initialized = false;
    /** @type {number} Timestamp of last EMA update */
    this.lastUpdateTime = 0;
    /** @type {number} Total number of update() calls */
    this.updateCount = 0;
    /** @type {number} Total samples received */
    this.sampleCount = 0;
    /** @type {string} Which timescale is currently dominant ('fast'|'medium'|'slow'|'blend') */
    this.activeScale = 'slow';

    // --- Diagnostics ---
    /** @type {Array<Object>} History of recalibration events */
    this.history = [];
  }

  /**
   * Initialize all three EMAs with the same seed value.
   * Call this once with the initial calibration result (e.g., from the first
   * N frames of an empty room).
   *
   * @param {number} initialVariance - Variance from initial calibration
   * @param {number} initialMeanAmp  - Mean amplitude from initial calibration
   * @param {number} [timestamp=Date.now()] - Initialization timestamp
   */
  initialize(initialVariance, initialMeanAmp, timestamp = Date.now()) {
    const seedVar = Math.max(this.config.minBaseline, initialVariance);

    this.fastEma = seedVar;
    this.mediumEma = seedVar;
    this.slowEma = seedVar;

    this.fastMeanAmp = initialMeanAmp;
    this.mediumMeanAmp = initialMeanAmp;
    this.slowMeanAmp = initialMeanAmp;

    this.baseline = seedVar;
    this.baselineMeanAmp = initialMeanAmp;

    this.lastUpdateTime = timestamp;
    this.initialized = true;
    this.updateCount = 0;
    this.sampleCount = 0;
    this.activeScale = 'slow';
    this.history = [];
  }

  /**
   * Feed a new variance observation and compute the updated blended baseline.
   *
   * @param {number} observedVariance - Current frame window variance
   * @param {number} observedMeanAmp  - Current frame window mean amplitude
   * @param {number} [timestamp=Date.now()] - Observation timestamp in ms
   * @returns {MultiTimescaleResult} Updated baseline and diagnostics
   */
  update(observedVariance, observedMeanAmp, timestamp = Date.now()) {
    if (!this.initialized) {
      throw new Error('MultiTimescaleTracker.update() called before initialize()');
    }

    this.sampleCount++;

    // Rate-limit EMA updates to avoid excessive computation
    if (timestamp - this.lastUpdateTime < this.config.updateIntervalMs) {
      return this._currentResult(timestamp);
    }

    // Wait for minimum sample count before first update
    if (this.sampleCount < this.config.minSamplesForUpdate && this.updateCount === 0) {
      return this._currentResult(timestamp);
    }

    this.lastUpdateTime = timestamp;
    this.updateCount++;

    // --- Step 1: Update all three EMA timescales ---
    this.fastEma = ema(this.fastEma, observedVariance, this.config.fastAlpha);
    this.mediumEma = ema(this.mediumEma, observedVariance, this.config.mediumAlpha);
    this.slowEma = ema(this.slowEma, observedVariance, this.config.slowAlpha);

    this.fastMeanAmp = ema(this.fastMeanAmp, observedMeanAmp, this.config.fastAlpha);
    this.mediumMeanAmp = ema(this.mediumMeanAmp, observedMeanAmp, this.config.mediumAlpha);
    this.slowMeanAmp = ema(this.slowMeanAmp, observedMeanAmp, this.config.slowAlpha);

    // --- Step 2: Detect divergence between timescales ---
    const divergence = this._computeDivergence();

    // --- Step 3: Compute blended baseline ---
    const oldBaseline = this.baseline;
    const oldMeanAmp = this.baselineMeanAmp;

    const { blendedVar, blendedAmp, activeScale, weights } = this._blend(divergence);

    // --- Step 4: Apply shift clamping for stability ---
    const deltaVar = blendedVar - oldBaseline;
    const clampedDelta = Math.sign(deltaVar)
      * Math.min(Math.abs(deltaVar), this.config.maxShiftPerUpdate);
    const newBaseline = Math.max(this.config.minBaseline, oldBaseline + clampedDelta);

    const deltaAmp = blendedAmp - oldMeanAmp;
    const clampedDeltaAmp = Math.sign(deltaAmp)
      * Math.min(Math.abs(deltaAmp), this.config.maxShiftPerUpdate * 10);
    const newMeanAmp = oldMeanAmp + clampedDeltaAmp;

    this.baseline = newBaseline;
    this.baselineMeanAmp = newMeanAmp;
    this.activeScale = activeScale;

    // --- Step 5: Record diagnostic event ---
    const event = {
      t: timestamp,
      oldBaseline,
      newBaseline,
      oldMeanAmp,
      newMeanAmp,
      fastEma: this.fastEma,
      mediumEma: this.mediumEma,
      slowEma: this.slowEma,
      divergence,
      activeScale,
      weights,
      updateCount: this.updateCount,
    };

    this.history.push(event);
    if (this.history.length > this.config.historySize) {
      this.history.shift();
    }

    return this._currentResult(timestamp, event);
  }

  // NOTE: EMA computation delegated to shared/math-utils.js ema() — DEBT-01

  /**
   * Compute the divergence ratio between fast and slow EMAs.
   * A ratio > divergenceThreshold indicates a sudden environmental change.
   *
   * Uses the ratio of the larger to the smaller to handle both upward
   * and downward shifts symmetrically.
   *
   * @returns {number} Divergence ratio (>= 1.0, higher = more divergent)
   * @private
   */
  _computeDivergence() {
    const fast = Math.max(this.fastEma, 0.001);
    const slow = Math.max(this.slowEma, 0.001);
    return Math.max(fast, slow) / Math.min(fast, slow);
  }

  /**
   * Compute the blended baseline from all three timescales.
   *
   * Blending strategy:
   * - When divergence is LOW (< threshold): slow dominates (stable reference)
   *   Weights: fast=0.1, medium=0.3, slow=0.6
   * - When divergence is HIGH (> threshold): fast dominates (rapid adaptation)
   *   Weights: fast=0.6, medium=0.3, slow=0.1
   * - Transition is smooth via sigmoid interpolation
   *
   * @param {number} divergence - Current fast/slow divergence ratio
   * @returns {{ blendedVar: number, blendedAmp: number, activeScale: string, weights: {fast: number, medium: number, slow: number} }}
   * @private
   */
  _blend(divergence) {
    // Sigmoid interpolation: 0 when divergence << threshold, 1 when >>
    // k controls steepness of transition
    const threshold = this.config.divergenceThreshold;
    const k = 5.0;  // Steepness factor
    const t = 1 / (1 + Math.exp(-k * (divergence / threshold - 1)));

    // Interpolate between steady-state and shift-mode weights
    const weights = {
      fast:   0.1 * (1 - t) + 0.6 * t,
      medium: 0.3,  // Medium stays constant — always contributes
      slow:   0.6 * (1 - t) + 0.1 * t,
    };

    const blendedVar = weights.fast * this.fastEma
                     + weights.medium * this.mediumEma
                     + weights.slow * this.slowEma;

    const blendedAmp = weights.fast * this.fastMeanAmp
                     + weights.medium * this.mediumMeanAmp
                     + weights.slow * this.slowMeanAmp;

    // Determine which scale is dominant for diagnostics
    let activeScale = 'blend';
    if (weights.fast > 0.5) activeScale = 'fast';
    else if (weights.slow > 0.5) activeScale = 'slow';

    return { blendedVar, blendedAmp, activeScale, weights };
  }

  /**
   * Build the result object returned by update().
   *
   * @param {number} timestamp - Current timestamp
   * @param {Object} [event] - Diagnostic event if one was recorded
   * @returns {MultiTimescaleResult}
   * @private
   */
  _currentResult(timestamp, event = null) {
    return {
      baseline: this.baseline,
      baselineMeanAmp: this.baselineMeanAmp,
      activeScale: this.activeScale,
      fastEma: this.fastEma,
      mediumEma: this.mediumEma,
      slowEma: this.slowEma,
      divergence: this._computeDivergence(),
      updateCount: this.updateCount,
      sampleCount: this.sampleCount,
      event,
    };
  }

  /**
   * Get the current state for persistence or diagnostics.
   * @returns {Object} Serializable state object
   */
  getState() {
    return {
      fastEma: this.fastEma,
      mediumEma: this.mediumEma,
      slowEma: this.slowEma,
      fastMeanAmp: this.fastMeanAmp,
      mediumMeanAmp: this.mediumMeanAmp,
      slowMeanAmp: this.slowMeanAmp,
      baseline: this.baseline,
      baselineMeanAmp: this.baselineMeanAmp,
      activeScale: this.activeScale,
      updateCount: this.updateCount,
      sampleCount: this.sampleCount,
      lastUpdateTime: this.lastUpdateTime,
      config: { ...this.config },
    };
  }

  /**
   * Restore tracker state from a previously saved snapshot.
   * Used for loading persisted baseline on restart.
   *
   * @param {Object} state - State object from getState()
   */
  restoreState(state) {
    if (!state || typeof state.fastEma !== 'number') {
      throw new Error('Invalid state object for MultiTimescaleTracker.restoreState()');
    }

    this.fastEma = state.fastEma;
    this.mediumEma = state.mediumEma;
    this.slowEma = state.slowEma;
    this.fastMeanAmp = state.fastMeanAmp;
    this.mediumMeanAmp = state.mediumMeanAmp;
    this.slowMeanAmp = state.slowMeanAmp;
    this.baseline = state.baseline;
    this.baselineMeanAmp = state.baselineMeanAmp;
    this.activeScale = state.activeScale || 'slow';
    this.updateCount = state.updateCount || 0;
    this.sampleCount = state.sampleCount || 0;
    this.lastUpdateTime = state.lastUpdateTime || 0;
    this.initialized = true;
  }

  /**
   * Get the last N diagnostic events for API/dashboard consumption.
   * @param {number} [count=10] - Number of events to return
   * @returns {Array<Object>} Recent recalibration events, newest last
   */
  getRecentHistory(count = 10) {
    return this.history.slice(-count);
  }

  /**
   * Reset the tracker to uninitialized state.
   * Useful for forcing a fresh calibration (e.g., after node reboot).
   */
  reset() {
    this.fastEma = 0;
    this.mediumEma = 0;
    this.slowEma = 0;
    this.fastMeanAmp = 0;
    this.mediumMeanAmp = 0;
    this.slowMeanAmp = 0;
    this.baseline = 0;
    this.baselineMeanAmp = 0;
    this.initialized = false;
    this.lastUpdateTime = 0;
    this.updateCount = 0;
    this.sampleCount = 0;
    this.activeScale = 'slow';
    this.history = [];
  }
}

/**
 * @typedef {Object} MultiTimescaleResult
 * @property {number} baseline        - Blended variance baseline
 * @property {number} baselineMeanAmp - Blended mean amplitude baseline
 * @property {string} activeScale     - Which timescale is dominant ('fast'|'slow'|'blend')
 * @property {number} fastEma         - Current fast EMA value
 * @property {number} mediumEma       - Current medium EMA value
 * @property {number} slowEma         - Current slow EMA value
 * @property {number} divergence      - Fast/slow divergence ratio
 * @property {number} updateCount     - Total EMA updates performed
 * @property {number} sampleCount     - Total samples received
 * @property {Object|null} event      - Diagnostic event if a recalibration occurred
 */
