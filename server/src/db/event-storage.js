// ==============================================================================
// Detection Event Storage — Persist CSI Pipeline Results to SQLite
// ==============================================================================
// DB-03: All detection events are persisted with timestamp, node, predicted
// count, confidence, algorithm identifier, and optional features hash.
//
// This is the write-side of the events table. The read-side is handled by:
//   - ground-truth/alignment.js (find nearest event for label matching)
//   - ground-truth/evaluator.js (compare predictions to ground truth)
//   - metrics endpoints (aggregate accuracy over time)
//
// Design decisions:
//   - Batch insert mode for high-throughput ingestion (5Hz × N nodes)
//   - Prepared statements cached for performance on N100
//   - Async-safe: all writes use better-sqlite3 synchronous API
//   - Optional session tagging for evaluation correlation
//   - Configurable retention via pruneOldEvents()
//
// Performance targets:
//   - Single insert: < 1ms (WAL mode, prepared statement)
//   - Batch insert (100 events): < 10ms
//   - Prune (delete 1 day): < 50ms with indexed timestamp
// ==============================================================================

import { getDb } from './index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default retention period for raw events (30 days in milliseconds) */
export const DEFAULT_RETENTION_DAYS = 30;

/** Maximum batch size for bulk inserts (prevents memory pressure on N100) */
export const MAX_BATCH_SIZE = 500;

/** Valid algorithm identifiers */
export const VALID_ALGORITHMS = ['threshold', 'ml', 'ensemble', 'radar', 'fused'];

// ---------------------------------------------------------------------------
// Input Validation
// ---------------------------------------------------------------------------

/**
 * Validate a single event object before insertion.
 *
 * @param {Object} event - Detection event to validate
 * @param {string} event.node_id - Source node identifier
 * @param {number} event.predicted_count - Predicted person count (0-N)
 * @throws {Error} If required fields are missing or invalid
 * @private
 */
function _validateEvent(event) {
  if (!event || typeof event !== 'object') {
    throw new Error('Event must be a non-null object');
  }
  if (!event.node_id || typeof event.node_id !== 'string') {
    throw new Error('event.node_id is required and must be a non-empty string');
  }
  if (typeof event.predicted_count !== 'number' || event.predicted_count < 0 || !Number.isFinite(event.predicted_count)) {
    throw new Error(`event.predicted_count must be a non-negative finite number, got: ${event.predicted_count}`);
  }
  if (event.confidence !== undefined && event.confidence !== null) {
    if (typeof event.confidence !== 'number' || event.confidence < 0 || event.confidence > 1) {
      throw new Error(`event.confidence must be between 0 and 1, got: ${event.confidence}`);
    }
  }
  if (event.algorithm && !VALID_ALGORITHMS.includes(event.algorithm)) {
    throw new Error(`event.algorithm must be one of: ${VALID_ALGORITHMS.join(', ')}, got: "${event.algorithm}"`);
  }
}

// ---------------------------------------------------------------------------
// Single Event Storage
// ---------------------------------------------------------------------------

/**
 * Store a single detection event in the events table.
 *
 * Called by the CSI processing pipeline each time a person count prediction
 * is made. The event is timestamped at insertion time if no timestamp is
 * provided.
 *
 * @param {Object} event - Detection event to store
 * @param {string} event.node_id - Source ESP32 node identifier
 * @param {number} event.predicted_count - Predicted person count (integer 0+)
 * @param {number} [event.confidence] - Prediction confidence (0.0 to 1.0)
 * @param {string} [event.algorithm='threshold'] - Algorithm that produced this prediction
 * @param {string} [event.features_hash] - Hash of the feature vector used for this prediction
 * @param {string} [event.session_id] - Optional labeling session ID for evaluation correlation
 * @param {string} [event.timestamp] - ISO 8601 timestamp (defaults to now)
 * @returns {{ id: number, timestamp: string }} Inserted event ID and timestamp
 *
 * @example
 *   const { id } = storeEvent({
 *     node_id: 'esp32-node-1',
 *     predicted_count: 2,
 *     confidence: 0.87,
 *     algorithm: 'threshold',
 *     features_hash: 'abc123',
 *   });
 */
export function storeEvent(event) {
  _validateEvent(event);
  const db = getDb();

  const timestamp = event.timestamp || new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO events (timestamp, node_id, predicted_count, confidence, algorithm, features_hash, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const info = stmt.run(
    timestamp,
    event.node_id,
    Math.round(event.predicted_count),
    event.confidence ?? null,
    event.algorithm || 'threshold',
    event.features_hash || null,
    event.session_id || null,
  );

  return {
    id: Number(info.lastInsertRowid),
    timestamp,
  };
}

// ---------------------------------------------------------------------------
// Batch Event Storage
// ---------------------------------------------------------------------------

/**
 * Store multiple detection events in a single transaction.
 *
 * Optimized for high-throughput scenarios where multiple nodes produce
 * predictions at the same time. All events are inserted atomically —
 * either all succeed or none do.
 *
 * @param {Array<Object>} events - Array of event objects (same shape as storeEvent)
 * @returns {{ inserted: number, ids: number[] }} Count and IDs of inserted events
 * @throws {Error} If any event fails validation or batch exceeds MAX_BATCH_SIZE
 *
 * @example
 *   const { inserted, ids } = storeBatch([
 *     { node_id: 'node-1', predicted_count: 1, confidence: 0.9 },
 *     { node_id: 'node-2', predicted_count: 0, confidence: 0.95 },
 *   ]);
 */
export function storeBatch(events) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('events must be a non-empty array');
  }
  if (events.length > MAX_BATCH_SIZE) {
    throw new Error(`Batch size ${events.length} exceeds maximum ${MAX_BATCH_SIZE}. Split into smaller batches.`);
  }

  // Validate all events before starting the transaction
  for (let i = 0; i < events.length; i++) {
    try {
      _validateEvent(events[i]);
    } catch (err) {
      throw new Error(`Event at index ${i}: ${err.message}`);
    }
  }

  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO events (timestamp, node_id, predicted_count, confidence, algorithm, features_hash, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const ids = [];

  const insertAll = db.transaction(() => {
    for (const event of events) {
      const timestamp = event.timestamp || new Date().toISOString();
      const info = stmt.run(
        timestamp,
        event.node_id,
        Math.round(event.predicted_count),
        event.confidence ?? null,
        event.algorithm || 'threshold',
        event.features_hash || null,
        event.session_id || null,
      );
      ids.push(Number(info.lastInsertRowid));
    }
  });

  insertAll();

  return { inserted: ids.length, ids };
}

// ---------------------------------------------------------------------------
// Query Functions
// ---------------------------------------------------------------------------

/**
 * Get recent events for a specific node, ordered by timestamp descending.
 *
 * @param {string} nodeId - Node identifier
 * @param {Object} [options]
 * @param {number} [options.limit=100] - Maximum events to return
 * @param {string} [options.since] - ISO 8601 timestamp, only return events after this time
 * @param {string} [options.algorithm] - Filter by algorithm type
 * @returns {Array<Object>} Array of event records
 */
export function getEventsByNode(nodeId, { limit = 100, since, algorithm } = {}) {
  if (!nodeId || typeof nodeId !== 'string') {
    throw new Error('nodeId is required');
  }
  const db = getDb();

  let sql = 'SELECT * FROM events WHERE node_id = ?';
  const params = [nodeId];

  if (since) {
    sql += ' AND timestamp > ?';
    params.push(since);
  }
  if (algorithm) {
    sql += ' AND algorithm = ?';
    params.push(algorithm);
  }

  sql += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

/**
 * Get event count and latest timestamp per node.
 * Useful for health monitoring and admin dashboard.
 *
 * @returns {Array<{ node_id: string, event_count: number, latest_event: string, earliest_event: string }>}
 */
export function getEventSummary() {
  const db = getDb();
  return db.prepare(`
    SELECT
      node_id,
      COUNT(*) as event_count,
      MAX(timestamp) as latest_event,
      MIN(timestamp) as earliest_event
    FROM events
    GROUP BY node_id
    ORDER BY latest_event DESC
  `).all();
}

/**
 * Get events within a time range, optionally filtered by node.
 *
 * @param {string} startTime - ISO 8601 start timestamp (inclusive)
 * @param {string} endTime - ISO 8601 end timestamp (inclusive)
 * @param {Object} [options]
 * @param {string} [options.nodeId] - Filter by node
 * @param {string} [options.algorithm] - Filter by algorithm
 * @param {number} [options.limit=1000] - Maximum results
 * @returns {Array<Object>} Matching event records
 */
export function getEventsInRange(startTime, endTime, { nodeId, algorithm, limit = 1000 } = {}) {
  if (!startTime || !endTime) {
    throw new Error('startTime and endTime are required');
  }
  const db = getDb();

  let sql = 'SELECT * FROM events WHERE timestamp >= ? AND timestamp <= ?';
  const params = [startTime, endTime];

  if (nodeId) {
    sql += ' AND node_id = ?';
    params.push(nodeId);
  }
  if (algorithm) {
    sql += ' AND algorithm = ?';
    params.push(algorithm);
  }

  sql += ' ORDER BY timestamp ASC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

/**
 * Count total events, optionally filtered by node or time range.
 *
 * @param {Object} [options]
 * @param {string} [options.nodeId] - Filter by node
 * @param {string} [options.since] - Only count events after this ISO 8601 timestamp
 * @returns {number} Total event count
 */
export function countEvents({ nodeId, since } = {}) {
  const db = getDb();

  let sql = 'SELECT COUNT(*) as count FROM events WHERE 1=1';
  const params = [];

  if (nodeId) {
    sql += ' AND node_id = ?';
    params.push(nodeId);
  }
  if (since) {
    sql += ' AND timestamp > ?';
    params.push(since);
  }

  return db.prepare(sql).get(...params).count;
}

// ---------------------------------------------------------------------------
// Data Retention
// ---------------------------------------------------------------------------

/**
 * Delete events older than a specified number of days.
 *
 * Called periodically (e.g., daily via cron or on server startup) to enforce
 * the data retention policy. Uses the idx_events_timestamp index for
 * efficient deletion.
 *
 * @param {Object} [options]
 * @param {number} [options.retentionDays=30] - Delete events older than this many days
 * @param {Object} [options.logger] - Pino logger for reporting
 * @returns {{ deleted: number, cutoff: string }} Number of deleted events and cutoff timestamp
 */
export function pruneOldEvents({ retentionDays = DEFAULT_RETENTION_DAYS, logger } = {}) {
  if (typeof retentionDays !== 'number' || retentionDays < 1) {
    throw new Error('retentionDays must be a positive number');
  }

  const db = getDb();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const info = db.prepare('DELETE FROM events WHERE timestamp < ?').run(cutoff);
  const deleted = info.changes;

  if (deleted > 0) {
    logger?.info({ deleted, cutoff, retentionDays }, 'Pruned old detection events');
  }

  return { deleted, cutoff };
}

// ---------------------------------------------------------------------------
// API Route Handler Helpers
// ---------------------------------------------------------------------------

/**
 * Build an Express-compatible route handler for POST /api/v1/events.
 *
 * @example
 *   // In route setup:
 *   import { createEventsRouter } from '../db/event-storage.js';
 *   router.post('/events', createStoreHandler());
 *
 * @returns {Function} Express request handler
 */
export function createStoreHandler() {
  return (req, res) => {
    try {
      const event = req.body;
      const result = storeEvent(event);
      res.status(201).json({ ok: true, data: result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  };
}

/**
 * Build an Express-compatible route handler for POST /api/v1/events/batch.
 *
 * @returns {Function} Express request handler
 */
export function createBatchHandler() {
  return (req, res) => {
    try {
      const { events } = req.body;
      if (!events) {
        return res.status(400).json({ ok: false, error: 'Request body must contain "events" array' });
      }
      const result = storeBatch(events);
      res.status(201).json({ ok: true, data: result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  };
}

/**
 * Build an Express-compatible route handler for GET /api/v1/events.
 *
 * Supports query params: node_id, since, algorithm, limit
 *
 * @returns {Function} Express request handler
 */
export function createListHandler() {
  return (req, res) => {
    try {
      const { node_id, since, algorithm, limit, start, end } = req.query;

      // Range query mode
      if (start && end) {
        const events = getEventsInRange(start, end, {
          nodeId: node_id,
          algorithm,
          limit: limit ? parseInt(limit, 10) : 1000,
        });
        return res.json({ ok: true, data: events, count: events.length });
      }

      // Node-filtered query mode
      if (node_id) {
        const events = getEventsByNode(node_id, {
          since,
          algorithm,
          limit: limit ? parseInt(limit, 10) : 100,
        });
        return res.json({ ok: true, data: events, count: events.length });
      }

      // Summary mode (no filters)
      const summary = getEventSummary();
      const total = countEvents();
      res.json({ ok: true, data: { summary, total_events: total } });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  };
}

// ---------------------------------------------------------------------------
// Default Export
// ---------------------------------------------------------------------------

export default {
  storeEvent,
  storeBatch,
  getEventsByNode,
  getEventSummary,
  getEventsInRange,
  countEvents,
  pruneOldEvents,
  createStoreHandler,
  createBatchHandler,
  createListHandler,
  DEFAULT_RETENTION_DAYS,
  MAX_BATCH_SIZE,
  VALID_ALGORITHMS,
};
