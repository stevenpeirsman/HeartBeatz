// ==============================================================================
// Ground Truth Storage — Label CRUD Operations
// ==============================================================================
// Handles all database operations for ground truth labels and sessions.
// Uses better-sqlite3 prepared statements for performance.
//
// Data model:
//   Label: { id, session_id, timestamp, true_count, annotator, node_id,
//            frame_id, confidence, notes }
//   Session: { id, name, annotator, started_at, ended_at, node_id, notes, status }
// ==============================================================================

import { getDb } from '../db/index.js';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Label Sessions
// ---------------------------------------------------------------------------

/**
 * Create a new labeling session.
 *
 * @param {Object} params
 * @param {string} [params.name] - Session name (auto-generated if omitted)
 * @param {string} [params.annotator='anonymous'] - Who is labeling
 * @param {string} [params.nodeId] - Target node being labeled
 * @param {string} [params.notes] - Optional session notes
 * @returns {{ id: string, name: string, annotator: string, started_at: string, status: string }}
 */
export function createSession({ name, annotator = 'anonymous', nodeId, notes } = {}) {
  const db = getDb();
  const id = randomUUID();
  const sessionName = name || `session-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}`;

  const stmt = db.prepare(`
    INSERT INTO label_sessions (id, name, annotator, node_id, notes)
    VALUES (?, ?, ?, ?, ?)
  `);

  stmt.run(id, sessionName, annotator, nodeId || null, notes || null);

  return getSession(id);
}

/**
 * Get a labeling session by ID.
 *
 * @param {string} id - Session UUID
 * @returns {Object|null} Session record or null if not found
 */
export function getSession(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM label_sessions WHERE id = ?').get(id);
  if (!row) return null;

  // Attach label count
  const countRow = db.prepare('SELECT COUNT(*) as count FROM labels WHERE session_id = ?').get(id);
  return { ...row, label_count: countRow.count };
}

/**
 * List all labeling sessions, optionally filtered by status.
 *
 * @param {Object} [options]
 * @param {string} [options.status] - Filter by status ('active', 'ended')
 * @param {number} [options.limit=50] - Max sessions to return
 * @returns {Object[]} Array of session records with label counts
 */
export function listSessions({ status, limit = 50 } = {}) {
  const db = getDb();
  let sql = `
    SELECT ls.*, COUNT(l.id) as label_count
    FROM label_sessions ls
    LEFT JOIN labels l ON l.session_id = ls.id
  `;
  const params = [];

  if (status) {
    sql += ' WHERE ls.status = ?';
    params.push(status);
  }

  sql += ' GROUP BY ls.id ORDER BY ls.started_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

/**
 * End an active labeling session.
 *
 * @param {string} id - Session UUID
 * @returns {Object|null} Updated session or null if not found
 */
export function endSession(id) {
  const db = getDb();
  db.prepare(`
    UPDATE label_sessions
    SET ended_at = datetime('now'), status = 'ended'
    WHERE id = ? AND status = 'active'
  `).run(id);
  return getSession(id);
}

// ---------------------------------------------------------------------------
// Ground Truth Labels
// ---------------------------------------------------------------------------

/**
 * Record a ground truth label (person count observation).
 *
 * @param {Object} params
 * @param {string} params.sessionId - Labeling session UUID
 * @param {number} params.trueCount - Observed person count (0, 1, 2, or 3 for 3+)
 * @param {string} [params.annotator='anonymous'] - Who recorded this
 * @param {string} [params.nodeId] - Which node this label applies to
 * @param {string} [params.frameId] - Optional CSI frame ID for alignment
 * @param {string} [params.confidence='certain'] - 'certain', 'likely', 'unsure'
 * @param {string} [params.notes] - Optional notes
 * @returns {{ id: number, session_id: string, timestamp: string, true_count: number }}
 */
export function addLabel({ sessionId, trueCount, annotator = 'anonymous', nodeId, frameId, confidence = 'certain', notes } = {}) {
  const db = getDb();

  // Validate session exists and is active
  const session = db.prepare('SELECT id, status FROM label_sessions WHERE id = ?').get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  if (session.status !== 'active') {
    throw new Error(`Session is not active: ${sessionId} (status: ${session.status})`);
  }

  // Validate true_count
  if (typeof trueCount !== 'number' || trueCount < 0 || trueCount > 3) {
    throw new Error(`Invalid true_count: ${trueCount}. Must be 0, 1, 2, or 3 (for 3+).`);
  }

  const result = db.prepare(`
    INSERT INTO labels (session_id, true_count, annotator, node_id, frame_id, confidence, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, trueCount, annotator, nodeId || null, frameId || null, confidence, notes || null);

  return db.prepare('SELECT * FROM labels WHERE id = ?').get(result.lastInsertRowid);
}

/**
 * Get labels for a session, optionally with pagination.
 *
 * @param {string} sessionId - Session UUID
 * @param {Object} [options]
 * @param {number} [options.limit=100] - Max labels to return
 * @param {number} [options.offset=0] - Offset for pagination
 * @returns {Object[]} Array of label records
 */
export function getLabels(sessionId, { limit = 100, offset = 0 } = {}) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM labels
    WHERE session_id = ?
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `).all(sessionId, limit, offset);
}

/**
 * Get recent labels across all sessions (for dashboard display).
 *
 * @param {Object} [options]
 * @param {number} [options.limit=20] - Max labels to return
 * @returns {Object[]} Array of label records with session name
 */
export function getRecentLabels({ limit = 20 } = {}) {
  const db = getDb();
  return db.prepare(`
    SELECT l.*, ls.name as session_name
    FROM labels l
    JOIN label_sessions ls ON ls.id = l.session_id
    ORDER BY l.timestamp DESC
    LIMIT ?
  `).all(limit);
}

/**
 * Get label count distribution for a session (for confusion matrix input).
 *
 * @param {string} sessionId - Session UUID
 * @returns {{ count_0: number, count_1: number, count_2: number, count_3: number, total: number }}
 */
export function getLabelDistribution(sessionId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT true_count, COUNT(*) as cnt
    FROM labels
    WHERE session_id = ?
    GROUP BY true_count
  `).all(sessionId);

  const dist = { count_0: 0, count_1: 0, count_2: 0, count_3: 0, total: 0 };
  for (const row of rows) {
    dist[`count_${row.true_count}`] = row.cnt;
    dist.total += row.cnt;
  }
  return dist;
}

/**
 * Delete a single label by ID.
 *
 * @param {number} id - Label ID
 * @returns {boolean} True if deleted, false if not found
 */
export function deleteLabel(id) {
  const db = getDb();
  const result = db.prepare('DELETE FROM labels WHERE id = ?').run(id);
  return result.changes > 0;
}

export default {
  createSession,
  getSession,
  listSessions,
  endSession,
  addLabel,
  getLabels,
  getRecentLabels,
  getLabelDistribution,
  deleteLabel,
};
