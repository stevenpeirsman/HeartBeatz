// ==============================================================================
// CSI-Label Alignment — Match Labels to Nearest CSI Frames
// ==============================================================================
// ACC-08-T3: Implements temporal alignment between human-annotated ground truth
// labels and CSI detection events (frames). Labels are recorded asynchronously
// by a human pressing buttons; CSI frames arrive at ~5Hz per node. This module
// finds the nearest CSI frame for each label within a configurable time window.
//
// Why alignment matters:
//   A human presses "2 people" at t=12.345s. The system recorded CSI frames at
//   t=12.280s, t=12.480s, t=12.680s. We need to match the label to the frame
//   at t=12.280s (65ms delta) to compute accuracy metrics. If no frame exists
//   within the tolerance window, the label is marked "unaligned" and excluded
//   from evaluation to avoid corrupting metrics.
//
// Data flow:
//   labels (from ground-truth/storage.js)
//     + events (from events table, written by CSI pipeline)
//     → aligned pairs: { label, event, delta_ms }
//     → unaligned labels (no matching frame within tolerance)
//
// Algorithm:
//   For each label, use indexed range queries on the events table to find the
//   closest timestamp. Events are indexed by timestamp (idx_events_timestamp),
//   so the DB handles the heavy lifting via two ORDER BY + LIMIT 1 queries:
//   one for the nearest event before the label, one for the nearest after.
//   We then pick whichever is temporally closer.
// ==============================================================================

import { getDb } from '../db/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * SQLite strftime format string for sub-second precision.
 * Used throughout alignment queries to preserve millisecond accuracy.
 * Produces e.g. '2026-03-31 10:00:00.050' which sorts correctly as a string.
 * @type {string}
 */
const TIMESTAMP_FORMAT = '%Y-%m-%d %H:%M:%f';

/**
 * Regex for validating session ID format (UUID v4 or similar alphanumeric-dash).
 * @type {RegExp}
 */
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

// ---------------------------------------------------------------------------
// Input Validation
// ---------------------------------------------------------------------------

/**
 * Validate a session ID string.
 *
 * @param {string} sessionId
 * @throws {Error} If sessionId is falsy or fails format check
 * @private
 */
function _validateSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('sessionId is required and must be a non-empty string');
  }
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`Invalid sessionId format: "${sessionId}". Must be 1-128 alphanumeric/dash/underscore characters.`);
  }
}

/**
 * Validate maxDeltaMs parameter.
 *
 * @param {number} maxDeltaMs
 * @throws {Error} If maxDeltaMs is negative or not a number
 * @private
 */
function _validateMaxDelta(maxDeltaMs) {
  if (typeof maxDeltaMs !== 'number' || maxDeltaMs < 0 || Number.isNaN(maxDeltaMs)) {
    throw new Error(`maxDeltaMs must be a non-negative number, got: ${maxDeltaMs}`);
  }
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a timestamp string to epoch milliseconds (UTC).
 *
 * Handles both SQLite datetime format ('2026-03-31 10:00:00') and ISO 8601
 * ('2026-03-31T10:00:00.050Z'). SQLite's datetime('now') produces UTC values
 * without a 'Z' suffix, which JavaScript's Date constructor incorrectly
 * interprets as local time. This helper normalizes both formats to UTC.
 *
 * @param {string} ts - Timestamp string in SQLite or ISO 8601 format
 * @returns {number} Epoch milliseconds (UTC)
 * @private
 */
function _parseTimestampUtc(ts) {
  // If already has timezone indicator (Z or +/-offset), parse directly
  if (ts.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(ts)) {
    return new Date(ts).getTime();
  }
  // SQLite datetime format (space-separated, no Z) — append Z for UTC parse
  return new Date(ts + 'Z').getTime();
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Default maximum time delta (in milliseconds) between a label and its
 * matched CSI frame. Labels without a frame within this window are
 * considered "unaligned" and excluded from evaluation.
 *
 * 100ms chosen because CSI frames arrive at ~5Hz (200ms apart), so any
 * label should be within 100ms of the nearest frame. Increasing this
 * value risks matching a label to a frame from a different occupancy state.
 * @type {number}
 */
export const DEFAULT_MAX_DELTA_MS = 100;

// ---------------------------------------------------------------------------
// Core Alignment Functions
// ---------------------------------------------------------------------------

/**
 * Find the nearest CSI detection event to a given timestamp for a specific node.
 *
 * Queries the events table for the closest event before and after the target
 * timestamp, then returns whichever is temporally closer. Uses the
 * idx_events_timestamp index for efficient lookup.
 *
 * @param {string} timestamp - ISO 8601 UTC timestamp to match against
 * @param {Object} [options]
 * @param {string} [options.nodeId] - Filter events to a specific node
 * @param {number} [options.maxDeltaMs=100] - Maximum allowed time delta in ms
 * @returns {{ event: Object, delta_ms: number } | null} Matched event with
 *   temporal delta, or null if no event exists within the tolerance window
 */
export function findNearestEvent(timestamp, { nodeId, maxDeltaMs = DEFAULT_MAX_DELTA_MS } = {}) {
  _validateMaxDelta(maxDeltaMs);
  const db = getDb();

  // Use strftime with %f (fractional seconds) to preserve millisecond
  // precision. SQLite's datetime() truncates to whole seconds, which is
  // insufficient for 5Hz CSI alignment (200ms frame intervals).
  //
  // strftime('${TIMESTAMP_FORMAT}', ...) produces e.g. '2026-03-31 10:00:00.050'
  // which sorts correctly as a string with sub-second precision.
  const beforeSql = nodeId
    ? `SELECT * FROM events
       WHERE strftime('${TIMESTAMP_FORMAT}', timestamp) <= strftime('${TIMESTAMP_FORMAT}', ?) AND node_id = ?
       ORDER BY strftime('${TIMESTAMP_FORMAT}', timestamp) DESC LIMIT 1`
    : `SELECT * FROM events
       WHERE strftime('${TIMESTAMP_FORMAT}', timestamp) <= strftime('${TIMESTAMP_FORMAT}', ?)
       ORDER BY strftime('${TIMESTAMP_FORMAT}', timestamp) DESC LIMIT 1`;

  const afterSql = nodeId
    ? `SELECT * FROM events
       WHERE strftime('${TIMESTAMP_FORMAT}', timestamp) > strftime('${TIMESTAMP_FORMAT}', ?) AND node_id = ?
       ORDER BY strftime('${TIMESTAMP_FORMAT}', timestamp) ASC LIMIT 1`
    : `SELECT * FROM events
       WHERE strftime('${TIMESTAMP_FORMAT}', timestamp) > strftime('${TIMESTAMP_FORMAT}', ?)
       ORDER BY strftime('${TIMESTAMP_FORMAT}', timestamp) ASC LIMIT 1`;

  const params = nodeId ? [timestamp, nodeId] : [timestamp];
  const before = db.prepare(beforeSql).get(...params);
  const after = db.prepare(afterSql).get(...params);

  // Compute deltas in milliseconds using UTC-aware parser
  const targetMs = _parseTimestampUtc(timestamp);
  let bestEvent = null;
  let bestDelta = Infinity;

  if (before) {
    const deltaMs = Math.abs(targetMs - _parseTimestampUtc(before.timestamp));
    if (deltaMs < bestDelta) {
      bestEvent = before;
      bestDelta = deltaMs;
    }
  }

  if (after) {
    const deltaMs = Math.abs(targetMs - _parseTimestampUtc(after.timestamp));
    if (deltaMs < bestDelta) {
      bestEvent = after;
      bestDelta = deltaMs;
    }
  }

  // Check tolerance
  if (!bestEvent || bestDelta > maxDeltaMs) {
    return null;
  }

  return { event: bestEvent, delta_ms: bestDelta };
}

/**
 * Align all labels in a session to their nearest CSI detection events.
 *
 * Iterates through every label in the session, finds the nearest event for
 * each, and returns two arrays: aligned pairs (label + event + delta) and
 * unaligned labels (no matching event within tolerance).
 *
 * @param {string} sessionId - Labeling session UUID
 * @param {Object} [options]
 * @param {string} [options.nodeId] - Restrict alignment to a specific node
 * @param {number} [options.maxDeltaMs=100] - Maximum allowed time delta in ms
 * @returns {{
 *   aligned: Array<{ label: Object, event: Object, delta_ms: number }>,
 *   unaligned: Array<{ label: Object, reason: string }>,
 *   stats: { total: number, aligned_count: number, unaligned_count: number,
 *            alignment_rate: number, avg_delta_ms: number, max_delta_ms: number }
 * }}
 */
export function alignSession(sessionId, { nodeId, maxDeltaMs = DEFAULT_MAX_DELTA_MS } = {}) {
  _validateSessionId(sessionId);
  _validateMaxDelta(maxDeltaMs);
  const db = getDb();

  // Fetch all labels for the session, ordered by timestamp
  const labels = db.prepare(`
    SELECT * FROM labels
    WHERE session_id = ?
    ORDER BY timestamp ASC
  `).all(sessionId);

  const aligned = [];
  const unaligned = [];

  for (const label of labels) {
    // Use label's node_id if set, otherwise fall back to option nodeId
    const effectiveNodeId = label.node_id || nodeId;

    const match = findNearestEvent(label.timestamp, {
      nodeId: effectiveNodeId,
      maxDeltaMs,
    });

    if (match) {
      aligned.push({
        label,
        event: match.event,
        delta_ms: match.delta_ms,
      });
    } else {
      unaligned.push({
        label,
        reason: `No event within ${maxDeltaMs}ms of label timestamp ${label.timestamp}`,
      });
    }
  }

  // Compute summary statistics
  const totalDelta = aligned.reduce((sum, pair) => sum + pair.delta_ms, 0);
  const maxObservedDelta = aligned.length > 0
    ? Math.max(...aligned.map(p => p.delta_ms))
    : 0;

  const stats = {
    total: labels.length,
    aligned_count: aligned.length,
    unaligned_count: unaligned.length,
    alignment_rate: labels.length > 0
      ? Math.round((aligned.length / labels.length) * 10000) / 10000
      : 0,
    avg_delta_ms: aligned.length > 0
      ? Math.round((totalDelta / aligned.length) * 100) / 100
      : 0,
    max_delta_ms: maxObservedDelta,
  };

  return { aligned, unaligned, stats };
}

/**
 * Get aligned pairs for evaluation — returns only the fields needed for
 * computing confusion matrix and accuracy metrics.
 *
 * This is the primary interface for the evaluation pipeline (ACC-08-T4).
 * Returns a flat array of { true_count, predicted_count, delta_ms } tuples
 * suitable for direct input to confusion matrix computation.
 *
 * @param {string} sessionId - Labeling session UUID
 * @param {Object} [options]
 * @param {string} [options.nodeId] - Restrict alignment to a specific node
 * @param {number} [options.maxDeltaMs=100] - Maximum allowed time delta in ms
 * @param {string} [options.confidenceFilter] - Only include labels with this
 *   confidence level or higher ('certain' > 'likely' > 'unsure')
 * @returns {{
 *   pairs: Array<{ true_count: number, predicted_count: number, delta_ms: number,
 *                  label_id: number, event_id: number, timestamp: string }>,
 *   stats: Object
 * }}
 */
export function getEvaluationPairs(sessionId, {
  nodeId,
  maxDeltaMs = DEFAULT_MAX_DELTA_MS,
  confidenceFilter,
} = {}) {
  // Validation delegated to alignSession (sessionId + maxDeltaMs)
  const { aligned, unaligned, stats } = alignSession(sessionId, { nodeId, maxDeltaMs });

  // Confidence ranking for filtering
  const confidenceRank = { certain: 3, likely: 2, unsure: 1 };
  const minRank = confidenceFilter ? (confidenceRank[confidenceFilter] || 0) : 0;

  const pairs = [];
  for (const { label, event, delta_ms } of aligned) {
    // Apply confidence filter if specified
    const labelRank = confidenceRank[label.confidence] || 0;
    if (labelRank < minRank) continue;

    pairs.push({
      true_count: label.true_count,
      predicted_count: event.predicted_count,
      delta_ms,
      label_id: label.id,
      event_id: event.id,
      timestamp: label.timestamp,
    });
  }

  return {
    pairs,
    stats: {
      ...stats,
      filtered_count: aligned.length - pairs.length,
      evaluation_count: pairs.length,
    },
  };
}

/** Exported for testing — session ID regex pattern */
export { SESSION_ID_RE as _SESSION_ID_RE };

export default {
  DEFAULT_MAX_DELTA_MS,
  findNearestEvent,
  alignSession,
  getEvaluationPairs,
};
