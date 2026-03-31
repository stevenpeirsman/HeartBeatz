// ==============================================================================
// Empty-Room Detection — ACC-03-T3
// ==============================================================================
// Detects when a monitored room is unoccupied by analyzing the variance of
// incoming CSI frames relative to the calibrated baseline. When the observed
// variance stays below a configurable multiple of the baseline variance for a
// sustained period, the room is classified as "empty" with high confidence.
//
// This information is critical for two purposes:
//   1. **Baseline calibration**: An empty room is the ideal time to recalibrate
//      the baseline, since no human motion contaminates the signal.
//   2. **Occupancy reporting**: The detection feeds into the person-count
//      pipeline — a confirmed empty room overrides noisy threshold detectors.
//
// Algorithm overview:
//   - Maintain a sliding window of recent variance observations
//   - Compute the ratio: observedVariance / baselineVariance
//   - If ratio < varianceRatioThreshold (default 1.2x) consistently for
//     quietDurationMs (default 10 minutes), declare "empty"
//   - Use hysteresis: once empty is declared, require a higher ratio
//     (reoccupyRatioThreshold, default 1.5x) to transition back to "occupied"
//   - Track confidence as fraction of quiet window that was below threshold
//
// References:
//   - CFAR (Constant False Alarm Rate) detection: the ratio test is analogous
//     to cell-averaging CFAR where the baseline serves as the noise estimate.
//     Finn, H.M. & Johnson, R.S. "Adaptive Detection Mode with Threshold
//     Control", RCA Review, 1968.
//   - Hysteresis for state transitions: Schmitt trigger principle applied to
//     occupancy detection to prevent rapid toggling at decision boundaries.
//
// Usage:
//   import { EmptyRoomDetector } from './calibration/empty-room.js';
//   const detector = new EmptyRoomDetector();
//   // On each CSI processing cycle:
//   const result = detector.update(currentVariance, baselineVariance, timestamp);
//   if (result.isEmpty) {
//     // Trigger baseline recalibration with empty-room data
//   }
//
// ==============================================================================

/**
 * Default configuration for empty-room detection.
 * All values are overridable via constructor options or environment variables.
 *
 * @typedef {Object} EmptyRoomConfig
 * @property {number} varianceRatioThreshold   - Max ratio of observed/baseline variance to qualify as "quiet" (default: 1.2)
 * @property {number} reoccupyRatioThreshold   - Min ratio to transition from empty back to occupied (default: 1.5, must be > varianceRatioThreshold)
 * @property {number} quietDurationMs          - How long (ms) variance must stay below threshold to declare empty (default: 600000 = 10 min)
 * @property {number} windowSizeMs             - Sliding window duration (ms) for variance ratio observations (default: 720000 = 12 min)
 * @property {number} minObservations          - Minimum observations in window before making a decision (default: 100)
 * @property {number} quietFractionRequired    - Fraction of observations in window that must be "quiet" to declare empty (default: 0.90)
 * @property {number} samplingIntervalMs       - Minimum interval (ms) between recorded observations to avoid memory pressure (default: 1000)
 * @property {number} historySize              - Number of state-transition events to retain for diagnostics (default: 50)
 * @property {number} confidenceDecayRate      - How fast confidence decays when noisy samples appear (0-1, default: 0.05)
 */
const DEFAULT_CONFIG = Object.freeze({
  // --- Threshold ratios ---
  // varianceRatioThreshold: if observed_var / baseline_var < this, the frame
  // is considered "quiet" (no human activity). 1.2x means up to 20% above
  // baseline is tolerated — accounts for HVAC, electronic noise, minor drift.
  varianceRatioThreshold:  1.2,

  // reoccupyRatioThreshold: once empty is declared, the ratio must exceed this
  // to transition back to "occupied". Higher than varianceRatioThreshold to
  // implement Schmitt-trigger hysteresis and prevent state flickering.
  reoccupyRatioThreshold:  1.5,

  // --- Timing ---
  // quietDurationMs: 10 minutes of sustained quiet before declaring empty.
  // This is conservative — avoids false "empty" from someone sitting still.
  quietDurationMs:         600_000,  // 10 minutes in ms

  // windowSizeMs: sliding window slightly larger than quietDurationMs to
  // allow for some momentary spikes (e.g., HVAC cycling) within the period.
  windowSizeMs:            720_000,  // 12 minutes in ms

  // --- Minimum data requirements ---
  minObservations:         100,      // ~100 samples over 10 min at 1/s sampling

  // --- Quiet fraction ---
  // What fraction of the window must be below threshold to declare empty.
  // 0.90 = 90%, allowing up to 10% transient spikes (HVAC, interference).
  quietFractionRequired:   0.90,

  // --- Sampling ---
  // Rate-limit how often we record observations to control memory usage.
  // At 1 observation per second, 12-min window = ~720 entries max.
  samplingIntervalMs:      1000,     // 1 observation per second

  // --- Diagnostics ---
  historySize:             50,

  // --- Confidence ---
  // Exponential decay rate for confidence when noisy observations appear.
  confidenceDecayRate:     0.05,
});

/**
 * Room occupancy state enumeration.
 * @readonly
 * @enum {string}
 */
export const RoomState = Object.freeze({
  /** Room has people or activity detected. */
  OCCUPIED:  'occupied',
  /** Room confirmed empty — safe for baseline recalibration. */
  EMPTY:     'empty',
  /** Not enough data to determine state. */
  UNKNOWN:   'unknown',
});

/**
 * Automatic empty-room detector for CSI-based occupancy sensing.
 *
 * Monitors the ratio of observed CSI variance to the baseline variance over
 * a sliding window. When the ratio stays below a threshold for a sustained
 * period, the room is declared empty with a confidence score.
 *
 * Implements Schmitt-trigger hysteresis: the threshold for transitioning
 * from empty → occupied is higher than the threshold for occupied → empty,
 * preventing rapid state oscillation at decision boundaries.
 *
 * @example
 * const detector = new EmptyRoomDetector({ quietDurationMs: 300_000 }); // 5 min
 * const result = detector.update(1.1, 1.0, Date.now());
 * console.log(result.state);      // 'unknown' (not enough data yet)
 * console.log(result.confidence);  // 0.0
 */
export class EmptyRoomDetector {
  /**
   * Create a new empty-room detector.
   * @param {Partial<EmptyRoomConfig>} [options={}] - Override default config values
   * @param {Object} [logger=null] - Pino logger instance (optional). If provided,
   *   state transitions are logged at info level with structured context.
   */
  constructor(options = {}, logger = null) {
    /** @type {EmptyRoomConfig} */
    this.config = { ...DEFAULT_CONFIG, ...options };

    /** @type {Object|null} Pino logger for state transition logging */
    this._log = logger ? logger.child({ component: 'empty-room' }) : null;

    // Validate hysteresis: reoccupy threshold must exceed quiet threshold
    if (this.config.reoccupyRatioThreshold <= this.config.varianceRatioThreshold) {
      throw new Error(
        `EmptyRoomDetector: reoccupyRatioThreshold (${this.config.reoccupyRatioThreshold}) ` +
        `must be greater than varianceRatioThreshold (${this.config.varianceRatioThreshold}) ` +
        `for proper hysteresis behavior`
      );
    }

    // --- Observation sliding window ---
    // Each entry: { t: timestamp (ms), ratio: observed/baseline, isQuiet: boolean }
    /** @type {Array<{t: number, ratio: number, isQuiet: boolean}>} */
    this._observations = [];

    // --- State ---
    /** @type {string} Current room state (RoomState enum value) */
    this.state = RoomState.UNKNOWN;
    /** @type {number} Confidence in current state [0, 1] */
    this.confidence = 0;
    /** @type {number} Timestamp when quiet period started (0 if not quiet) */
    this._quietStartTime = 0;
    /** @type {number} Timestamp of last recorded observation */
    this._lastSampleTime = 0;
    /** @type {number} Total observations processed (including rate-limited ones) */
    this._totalObservations = 0;
    /** @type {number} Total state transitions */
    this._transitionCount = 0;

    // --- Diagnostics ---
    /** @type {Array<Object>} History of state-transition events */
    this.history = [];
  }

  /**
   * Process a new variance observation and update the room state.
   *
   * Call this on every CSI processing cycle (or at least once per second).
   * The method internally rate-limits how often it records observations to
   * the sliding window, so high-frequency calls are safe.
   *
   * @param {number} observedVariance  - Current measured CSI variance
   * @param {number} baselineVariance  - Current baseline variance from multi-timescale tracker
   * @param {number} [timestamp=Date.now()] - Observation timestamp in ms
   * @returns {EmptyRoomResult} Detection result and diagnostics
   */
  update(observedVariance, baselineVariance, timestamp = Date.now()) {
    this._totalObservations++;

    // Guard against invalid baseline (prevent division by zero)
    const safeBaseline = Math.max(baselineVariance, 0.001);
    const ratio = observedVariance / safeBaseline;

    // Determine if this observation qualifies as "quiet"
    // Note: hysteresis (empty→occupied transition) is handled in _evaluateState()
    // using reoccupyRatioThreshold on recent observations. Here we just classify
    // each observation as quiet/noisy using the base threshold.
    const isQuiet = ratio < this.config.varianceRatioThreshold;

    // Rate-limit observation recording
    if (timestamp - this._lastSampleTime >= this.config.samplingIntervalMs) {
      this._lastSampleTime = timestamp;
      this._observations.push({ t: timestamp, ratio, isQuiet });

      // Trim observations outside the sliding window
      const windowStart = timestamp - this.config.windowSizeMs;
      while (this._observations.length > 0 && this._observations[0].t < windowStart) {
        this._observations.shift();
      }
    }

    // --- Evaluate room state ---
    const prevState = this.state;
    const evaluation = this._evaluateState(timestamp);

    this.state = evaluation.state;
    this.confidence = evaluation.confidence;

    // Record state transitions
    if (prevState !== this.state && prevState !== RoomState.UNKNOWN) {
      this._transitionCount++;
      const event = {
        t: timestamp,
        from: prevState,
        to: this.state,
        confidence: this.confidence,
        quietFraction: evaluation.quietFraction,
        quietDurationMs: evaluation.quietDurationMs,
        observationCount: this._observations.length,
        transitionIndex: this._transitionCount,
      };

      this.history.push(event);
      if (this.history.length > this.config.historySize) {
        this.history.shift();
      }

      // Structured logging of state transitions (DEBT-03)
      if (this._log) {
        this._log.info({
          transition: { from: prevState, to: this.state },
          confidence: Math.round(this.confidence * 1000) / 1000,
          quietFraction: Math.round(evaluation.quietFraction * 1000) / 1000,
          quietDurationMs: evaluation.quietDurationMs,
          observationCount: this._observations.length,
          transitionIndex: this._transitionCount,
        }, `Room state: ${prevState} → ${this.state}`);
      }
    }

    return {
      state: this.state,
      isEmpty: this.state === RoomState.EMPTY,
      isOccupied: this.state === RoomState.OCCUPIED,
      confidence: this.confidence,
      currentRatio: ratio,
      quietFraction: evaluation.quietFraction,
      quietDurationMs: evaluation.quietDurationMs,
      observationCount: this._observations.length,
      totalObservations: this._totalObservations,
      stateChanged: prevState !== this.state,
      previousState: prevState,
    };
  }

  /**
   * Evaluate the current room state based on the sliding window of observations.
   *
   * Decision logic:
   * 1. If insufficient data → UNKNOWN
   * 2. If currently EMPTY and ratio exceeds reoccupyRatioThreshold → OCCUPIED
   * 3. If quiet fraction >= required AND quiet duration >= required → EMPTY
   * 4. Otherwise → OCCUPIED (default assumption: room is occupied)
   *
   * @param {number} timestamp - Current timestamp
   * @returns {{ state: string, confidence: number, quietFraction: number, quietDurationMs: number }}
   * @private
   */
  _evaluateState(timestamp) {
    const obs = this._observations;

    // Not enough data to decide
    if (obs.length < this.config.minObservations) {
      return {
        state: RoomState.UNKNOWN,
        confidence: 0,
        quietFraction: 0,
        quietDurationMs: 0,
      };
    }

    // Compute quiet fraction within the window
    const quietCount = obs.filter(o => o.isQuiet).length;
    const quietFraction = quietCount / obs.length;

    // Compute continuous quiet duration (from the most recent quiet streak)
    const quietDurationMs = this._computeQuietDuration(timestamp);

    // --- State transitions ---
    if (this.state === RoomState.EMPTY) {
      // Check for reoccupation: recent observations exceeding hysteresis threshold
      const recentCount = Math.min(10, obs.length);
      const recentObs = obs.slice(-recentCount);
      const recentAboveHysteresis = recentObs.filter(
        o => o.ratio >= this.config.reoccupyRatioThreshold
      ).length;

      // If majority of recent observations exceed hysteresis threshold → occupied
      if (recentAboveHysteresis > recentCount * 0.5) {
        return {
          state: RoomState.OCCUPIED,
          confidence: recentAboveHysteresis / recentCount,
          quietFraction,
          quietDurationMs,
        };
      }

      // Otherwise stay empty — confidence based on quiet fraction
      const confidence = Math.min(1.0, quietFraction / this.config.quietFractionRequired);
      return {
        state: RoomState.EMPTY,
        confidence,
        quietFraction,
        quietDurationMs,
      };
    }

    // --- Check for transition to EMPTY ---
    const durationMet = quietDurationMs >= this.config.quietDurationMs;
    const fractionMet = quietFraction >= this.config.quietFractionRequired;

    if (durationMet && fractionMet) {
      // Confidence combines both criteria
      const durationConfidence = Math.min(1.0,
        quietDurationMs / this.config.quietDurationMs);
      const fractionConfidence = Math.min(1.0,
        quietFraction / this.config.quietFractionRequired);
      const confidence = durationConfidence * fractionConfidence;

      return {
        state: RoomState.EMPTY,
        confidence,
        quietFraction,
        quietDurationMs,
      };
    }

    // Default: occupied, with confidence inversely proportional to quiet fraction
    const occupiedConfidence = Math.min(1.0, 1.0 - quietFraction);
    return {
      state: RoomState.OCCUPIED,
      confidence: Math.max(0.1, occupiedConfidence),  // Floor at 0.1 — never zero confidence
      quietFraction,
      quietDurationMs,
    };
  }

  /**
   * Compute the duration of the current continuous quiet streak.
   *
   * Walks backward from the most recent observation to find where the
   * last non-quiet observation occurred. The duration is measured from
   * that point to the current timestamp.
   *
   * Allows for brief interruptions: up to 10% of observations in the
   * streak can be non-quiet (transient spikes from HVAC, interference).
   *
   * @param {number} timestamp - Current timestamp
   * @returns {number} Duration in ms of the current quiet streak
   * @private
   */
  _computeQuietDuration(timestamp) {
    const obs = this._observations;
    if (obs.length === 0) return 0;

    // Walk backward to find the start of the quiet streak
    // Allow up to 10% non-quiet observations within the streak
    let nonQuietCount = 0;
    let totalInStreak = 0;
    let streakStartIdx = obs.length - 1;

    for (let i = obs.length - 1; i >= 0; i--) {
      totalInStreak++;
      if (!obs[i].isQuiet) {
        nonQuietCount++;
      }

      // If more than 10% non-quiet, the streak is broken at this point
      if (nonQuietCount / totalInStreak > 0.10) {
        streakStartIdx = i + 1;
        break;
      }

      // If we've walked all the way back, the whole window is quiet
      if (i === 0) {
        streakStartIdx = 0;
      }
    }

    if (streakStartIdx >= obs.length) return 0;

    return timestamp - obs[streakStartIdx].t;
  }

  /**
   * Force a state transition (e.g., on manual calibration trigger).
   *
   * @param {string} newState - Target state (use RoomState enum)
   * @param {number} [timestamp=Date.now()] - Timestamp of forced transition
   */
  forceState(newState, timestamp = Date.now()) {
    const validStates = Object.values(RoomState);
    if (!validStates.includes(newState)) {
      throw new Error(
        `EmptyRoomDetector.forceState(): invalid state '${newState}'. ` +
        `Valid states: ${validStates.join(', ')}`
      );
    }

    const prevState = this.state;
    this.state = newState;

    if (newState === RoomState.EMPTY) {
      this.confidence = 1.0;  // Manual override = full confidence
    } else if (newState === RoomState.OCCUPIED) {
      this.confidence = 1.0;
    } else {
      this.confidence = 0;
    }

    if (prevState !== newState) {
      this._transitionCount++;
      this.history.push({
        t: timestamp,
        from: prevState,
        to: newState,
        confidence: this.confidence,
        quietFraction: 0,
        quietDurationMs: 0,
        observationCount: this._observations.length,
        transitionIndex: this._transitionCount,
        forced: true,
      });

      if (this._log) {
        this._log.info({
          transition: { from: prevState, to: newState },
          forced: true,
          transitionIndex: this._transitionCount,
        }, `Room state forced: ${prevState} → ${newState}`);
      }
    }
  }

  /**
   * Get the current state for persistence or diagnostics.
   * @returns {Object} Serializable state object
   */
  getState() {
    return {
      state: this.state,
      confidence: this.confidence,
      observations: this._observations.slice(),  // Shallow copy
      quietStartTime: this._quietStartTime,
      lastSampleTime: this._lastSampleTime,
      totalObservations: this._totalObservations,
      transitionCount: this._transitionCount,
      config: { ...this.config },
    };
  }

  /**
   * Restore detector state from a previously saved snapshot.
   * Used for reloading state on server restart.
   *
   * @param {Object} state - State object from getState()
   */
  restoreState(state) {
    if (!state || typeof state.state !== 'string') {
      throw new Error('Invalid state object for EmptyRoomDetector.restoreState()');
    }

    this.state = state.state;
    this.confidence = state.confidence || 0;
    this._observations = Array.isArray(state.observations) ? state.observations.slice() : [];
    this._quietStartTime = state.quietStartTime || 0;
    this._lastSampleTime = state.lastSampleTime || 0;
    this._totalObservations = state.totalObservations || 0;
    this._transitionCount = state.transitionCount || 0;
  }

  /**
   * Get recent state-transition events for API/dashboard consumption.
   * @param {number} [count=10] - Number of events to return
   * @returns {Array<Object>} Recent events, newest last
   */
  getRecentHistory(count = 10) {
    return this.history.slice(-count);
  }

  /**
   * Reset detector to initial unknown state.
   * Clears all observations and history.
   */
  reset() {
    this._observations = [];
    this.state = RoomState.UNKNOWN;
    this.confidence = 0;
    this._quietStartTime = 0;
    this._lastSampleTime = 0;
    this._totalObservations = 0;
    this._transitionCount = 0;
    this.history = [];
  }

  /**
   * Get a summary of the current detection state for logging.
   * @returns {Object} Summary suitable for pino structured logging
   */
  getSummary() {
    const obs = this._observations;
    const quietCount = obs.filter(o => o.isQuiet).length;
    return {
      state: this.state,
      confidence: Math.round(this.confidence * 1000) / 1000,
      quietFraction: obs.length > 0 ? Math.round((quietCount / obs.length) * 1000) / 1000 : 0,
      observationCount: obs.length,
      totalObservations: this._totalObservations,
      transitionCount: this._transitionCount,
    };
  }
}

/**
 * @typedef {Object} EmptyRoomResult
 * @property {string}  state             - Current room state ('empty'|'occupied'|'unknown')
 * @property {boolean} isEmpty           - Convenience: true if state is 'empty'
 * @property {boolean} isOccupied        - Convenience: true if state is 'occupied'
 * @property {number}  confidence        - Confidence in current state [0, 1]
 * @property {number}  currentRatio      - Current observed/baseline variance ratio
 * @property {number}  quietFraction     - Fraction of window observations below threshold [0, 1]
 * @property {number}  quietDurationMs   - Duration of current continuous quiet streak (ms)
 * @property {number}  observationCount  - Number of observations in sliding window
 * @property {number}  totalObservations - Total observations processed since creation
 * @property {boolean} stateChanged      - Whether state changed on this update
 * @property {string}  previousState     - State before this update
 */
