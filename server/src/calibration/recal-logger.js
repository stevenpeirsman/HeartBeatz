// ==============================================================================
// Recalibration Event Structured Logger — ACC-03-T5
// ==============================================================================
// Provides structured pino logging for all calibration recalibration events.
// Captures shift magnitude, trigger type, per-timescale state, and room state
// so that calibration behavior can be audited and debugged from production logs.
//
// Events are logged as structured JSON (pino) and also stored in an in-memory
// ring buffer for the /api/v1/calibration/history endpoint (ACC-03-T6).
//
// Design:
//   - Wraps MultiTimescaleTracker and EmptyRoomDetector events
//   - Classifies trigger types: 'scheduled' | 'cusum_shift' | 'empty_room' | 'manual' | 'startup'
//   - Computes shift magnitude as |newBaseline - oldBaseline| / oldBaseline (relative)
//   - Stores last N events in memory (configurable, default 100)
//
// Usage:
//   import { RecalibrationLogger } from './calibration/recal-logger.js';
//   const recalLogger = new RecalibrationLogger(pinoLogger, { maxEvents: 100 });
//   recalLogger.logRecalibration({ ... });
//   const history = recalLogger.getHistory(50);
// ==============================================================================

/** Default maximum events to retain in the ring buffer. */
const DEFAULT_MAX_EVENTS = 100;

/**
 * Enumeration of calibration trigger types.
 * @readonly
 * @enum {string}
 */
export const TriggerType = Object.freeze({
  /** Regular periodic EMA update. */
  SCHEDULED:   'scheduled',
  /** CUSUM detected a significant environment shift. */
  CUSUM_SHIFT: 'cusum_shift',
  /** Empty room detected — ideal calibration opportunity. */
  EMPTY_ROOM:  'empty_room',
  /** Manual recalibration triggered via API. */
  MANUAL:      'manual',
  /** Baseline restored from disk on startup. */
  STARTUP:     'startup',
});

/**
 * @typedef {Object} RecalibrationEvent
 * @property {string}  id             - Unique event ID (ISO timestamp + sequence)
 * @property {string}  timestamp      - ISO 8601 UTC timestamp
 * @property {string}  nodeId         - Node identifier (MAC or name)
 * @property {string}  triggerType    - One of TriggerType values
 * @property {number}  shiftMagnitude - Relative baseline shift |new-old|/old (0 = no change, 1 = doubled)
 * @property {number}  shiftAbsolute  - Absolute baseline change (new - old)
 * @property {number}  oldBaseline    - Previous baseline variance
 * @property {number}  newBaseline    - New baseline variance after recalibration
 * @property {string}  activeScale    - Dominant timescale ('fast'|'slow'|'blend')
 * @property {number}  divergence     - Fast/slow EMA divergence ratio
 * @property {number}  fastEma        - Fast EMA value at event time
 * @property {number}  mediumEma      - Medium EMA value at event time
 * @property {number}  slowEma        - Slow EMA value at event time
 * @property {string}  [roomState]    - Room state if available ('empty'|'occupied'|'unknown')
 * @property {number}  [roomConfidence] - Room state confidence [0, 1]
 */

/**
 * Structured logger for calibration recalibration events.
 *
 * Logs each recalibration event to pino with full context and stores
 * events in an in-memory ring buffer for API consumption.
 */
export class RecalibrationLogger {
  /**
   * @param {Object} logger      - Pino logger instance
   * @param {Object} [options={}]
   * @param {number} [options.maxEvents=100] - Maximum events to retain
   */
  constructor(logger, options = {}) {
    /** @type {Object} Pino child logger for calibration events */
    this._log = logger.child({ component: 'recalibration' });

    /** @type {number} Maximum events in ring buffer */
    this._maxEvents = options.maxEvents || DEFAULT_MAX_EVENTS;

    /** @type {RecalibrationEvent[]} Ring buffer of recent events */
    this._events = [];

    /** @type {number} Monotonically increasing sequence number */
    this._seq = 0;
  }

  /**
   * Log a recalibration event with full structured context.
   *
   * @param {Object} params
   * @param {string} params.nodeId        - Node identifier
   * @param {string} params.triggerType   - One of TriggerType values
   * @param {number} params.oldBaseline   - Previous baseline variance
   * @param {number} params.newBaseline   - New baseline variance
   * @param {string} params.activeScale   - Dominant timescale
   * @param {number} params.divergence    - Fast/slow divergence ratio
   * @param {number} params.fastEma       - Fast EMA value
   * @param {number} params.mediumEma     - Medium EMA value
   * @param {number} params.slowEma       - Slow EMA value
   * @param {string} [params.roomState]   - Room occupancy state
   * @param {number} [params.roomConfidence] - Room state confidence
   * @param {number} [params.timestamp]   - Override timestamp (ms since epoch)
   * @returns {RecalibrationEvent} The logged event
   */
  logRecalibration(params) {
    this._seq++;
    const now = params.timestamp ? new Date(params.timestamp) : new Date();
    const isoTimestamp = now.toISOString();

    const safeOldBaseline = Math.max(params.oldBaseline, 0.001);
    const shiftAbsolute = params.newBaseline - params.oldBaseline;
    const shiftMagnitude = Math.abs(shiftAbsolute) / safeOldBaseline;

    /** @type {RecalibrationEvent} */
    const event = {
      id: `${isoTimestamp}-${this._seq}`,
      timestamp: isoTimestamp,
      nodeId: params.nodeId,
      triggerType: params.triggerType,
      shiftMagnitude: Math.round(shiftMagnitude * 10000) / 10000, // 4 decimal places
      shiftAbsolute: Math.round(shiftAbsolute * 10000) / 10000,
      oldBaseline: Math.round(params.oldBaseline * 10000) / 10000,
      newBaseline: Math.round(params.newBaseline * 10000) / 10000,
      activeScale: params.activeScale,
      divergence: Math.round(params.divergence * 1000) / 1000,
      fastEma: Math.round(params.fastEma * 10000) / 10000,
      mediumEma: Math.round(params.mediumEma * 10000) / 10000,
      slowEma: Math.round(params.slowEma * 10000) / 10000,
    };

    if (params.roomState !== undefined) {
      event.roomState = params.roomState;
    }
    if (params.roomConfidence !== undefined) {
      event.roomConfidence = Math.round(params.roomConfidence * 1000) / 1000;
    }

    // Store in ring buffer
    this._events.push(event);
    if (this._events.length > this._maxEvents) {
      this._events.shift();
    }

    // Structured pino log — severity based on shift magnitude
    const logData = {
      recalEvent: event,
    };

    if (shiftMagnitude > 0.5) {
      // Large shift (>50% relative change) — warn level
      this._log.warn(logData, `Large recalibration: ${params.triggerType} shift=${shiftMagnitude.toFixed(3)} node=${params.nodeId}`);
    } else if (shiftMagnitude > 0.1) {
      // Moderate shift (>10%) — info level
      this._log.info(logData, `Recalibration: ${params.triggerType} shift=${shiftMagnitude.toFixed(3)} node=${params.nodeId}`);
    } else {
      // Small or no shift — debug level
      this._log.debug(logData, `Minor recalibration: ${params.triggerType} shift=${shiftMagnitude.toFixed(3)} node=${params.nodeId}`);
    }

    return event;
  }

  /**
   * Get the most recent recalibration events.
   *
   * @param {number} [count=100] - Maximum events to return
   * @returns {RecalibrationEvent[]} Events sorted newest-last
   */
  getHistory(count = 100) {
    return this._events.slice(-count);
  }

  /**
   * Get events filtered by node ID.
   *
   * @param {string} nodeId - Node identifier to filter by
   * @param {number} [count=50] - Maximum events to return
   * @returns {RecalibrationEvent[]}
   */
  getHistoryByNode(nodeId, count = 50) {
    return this._events
      .filter(e => e.nodeId === nodeId)
      .slice(-count);
  }

  /**
   * Get events filtered by trigger type.
   *
   * @param {string} triggerType - Trigger type to filter by
   * @param {number} [count=50] - Maximum events to return
   * @returns {RecalibrationEvent[]}
   */
  getHistoryByTrigger(triggerType, count = 50) {
    return this._events
      .filter(e => e.triggerType === triggerType)
      .slice(-count);
  }

  /**
   * Get summary statistics of recent recalibration activity.
   *
   * @returns {Object} Summary stats
   */
  getSummary() {
    const events = this._events;
    if (events.length === 0) {
      return {
        totalEvents: 0,
        triggerCounts: {},
        avgShiftMagnitude: 0,
        maxShiftMagnitude: 0,
        lastEventTimestamp: null,
      };
    }

    const triggerCounts = {};
    let totalShift = 0;
    let maxShift = 0;

    for (const event of events) {
      triggerCounts[event.triggerType] = (triggerCounts[event.triggerType] || 0) + 1;
      totalShift += event.shiftMagnitude;
      if (event.shiftMagnitude > maxShift) maxShift = event.shiftMagnitude;
    }

    return {
      totalEvents: events.length,
      triggerCounts,
      avgShiftMagnitude: Math.round((totalShift / events.length) * 10000) / 10000,
      maxShiftMagnitude: maxShift,
      lastEventTimestamp: events[events.length - 1].timestamp,
    };
  }

  /**
   * Clear all stored events.
   */
  clear() {
    this._events = [];
    this._seq = 0;
  }

  /**
   * Get the total number of stored events.
   * @returns {number}
   */
  get eventCount() {
    return this._events.length;
  }
}
