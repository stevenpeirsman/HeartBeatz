// ==============================================================================
// Ground Truth Label API — REST Endpoints
// ==============================================================================
// ACC-08-T1: REST API for ground truth label collection and session management.
//
// Endpoints:
//   POST   /api/v1/ground-truth/sessions          — Create labeling session
//   GET    /api/v1/ground-truth/sessions           — List sessions
//   GET    /api/v1/ground-truth/sessions/:id       — Get session details
//   POST   /api/v1/ground-truth/sessions/:id/end   — End a session
//   POST   /api/v1/ground-truth/labels             — Record a label
//   GET    /api/v1/ground-truth/labels/:sessionId  — Get labels for session
//   GET    /api/v1/ground-truth/recent             — Get recent labels
//   DELETE /api/v1/ground-truth/labels/:id         — Delete a label
//
// Response format: { ok: true, data: {...} } or { ok: false, error: "message" }
// ==============================================================================

import { Router } from 'express';
import {
  createSession,
  getSession,
  listSessions,
  endSession,
  addLabel,
  getLabels,
  getRecentLabels,
  getLabelDistribution,
  deleteLabel,
} from './storage.js';

/**
 * Create the ground truth API router.
 *
 * @param {Object} options
 * @param {Object} options.logger - Pino logger instance
 * @returns {Router} Express router for /api/v1/ground-truth
 */
export function createGroundTruthRouter({ logger }) {
  const log = logger.child({ module: 'ground-truth-api' });
  const router = Router();

  // -------------------------------------------------------------------------
  // Session Endpoints
  // -------------------------------------------------------------------------

  /**
   * POST /sessions — Create a new labeling session.
   *
   * Request body:
   *   { name?: string, annotator?: string, nodeId?: string, notes?: string }
   *
   * Response (201):
   *   { ok: true, data: { id, name, annotator, started_at, status, label_count } }
   */
  router.post('/sessions', (req, res) => {
    try {
      const { name, annotator, nodeId, notes } = req.body;
      const session = createSession({ name, annotator, nodeId, notes });
      log.info({ sessionId: session.id, annotator: session.annotator }, 'Labeling session created');
      res.status(201).json({ ok: true, data: session });
    } catch (err) {
      log.error({ err }, 'Failed to create session');
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /sessions — List labeling sessions.
   *
   * Query params:
   *   status?: 'active' | 'ended'
   *   limit?: number (default 50)
   *
   * Response:
   *   { ok: true, data: [ { id, name, annotator, started_at, status, label_count } ] }
   */
  router.get('/sessions', (req, res) => {
    try {
      const { status, limit } = req.query;
      const sessions = listSessions({
        status: status || undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
      });
      res.json({ ok: true, data: sessions });
    } catch (err) {
      log.error({ err }, 'Failed to list sessions');
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /sessions/:id — Get a single session with label count and distribution.
   *
   * Response:
   *   { ok: true, data: { ...session, distribution: { count_0, count_1, ... } } }
   */
  router.get('/sessions/:id', (req, res) => {
    try {
      const session = getSession(req.params.id);
      if (!session) {
        return res.status(404).json({ ok: false, error: 'Session not found' });
      }
      const distribution = getLabelDistribution(req.params.id);
      res.json({ ok: true, data: { ...session, distribution } });
    } catch (err) {
      log.error({ err }, 'Failed to get session');
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /sessions/:id/end — End an active labeling session.
   *
   * Response:
   *   { ok: true, data: { ...session, ended_at, status: 'ended' } }
   */
  router.post('/sessions/:id/end', (req, res) => {
    try {
      const session = endSession(req.params.id);
      if (!session) {
        return res.status(404).json({ ok: false, error: 'Session not found' });
      }
      log.info({ sessionId: session.id }, 'Labeling session ended');
      res.json({ ok: true, data: session });
    } catch (err) {
      log.error({ err }, 'Failed to end session');
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // Label Endpoints
  // -------------------------------------------------------------------------

  /**
   * POST /labels — Record a ground truth label.
   *
   * Request body:
   *   {
   *     session_id: string (required),
   *     true_count: number (required, 0-3),
   *     annotator?: string,
   *     node_id?: string,
   *     frame_id?: string,
   *     confidence?: 'certain' | 'likely' | 'unsure',
   *     notes?: string
   *   }
   *
   * Response (201):
   *   { ok: true, data: { id, session_id, timestamp, true_count, ... } }
   */
  router.post('/labels', (req, res) => {
    try {
      const { session_id, true_count, annotator, node_id, frame_id, confidence, notes } = req.body;

      if (!session_id) {
        return res.status(400).json({ ok: false, error: 'session_id is required' });
      }
      if (typeof true_count !== 'number') {
        return res.status(400).json({ ok: false, error: 'true_count must be a number (0, 1, 2, or 3)' });
      }

      const label = addLabel({
        sessionId: session_id,
        trueCount: true_count,
        annotator,
        nodeId: node_id,
        frameId: frame_id,
        confidence,
        notes,
      });

      log.debug({ labelId: label.id, trueCount: true_count, sessionId: session_id }, 'Label recorded');
      res.status(201).json({ ok: true, data: label });
    } catch (err) {
      const status = err.message.includes('not found') || err.message.includes('not active') ? 400 : 500;
      log.warn({ err: err.message }, 'Failed to record label');
      res.status(status).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /labels/:sessionId — Get labels for a specific session.
   *
   * Query params:
   *   limit?: number (default 100)
   *   offset?: number (default 0)
   *
   * Response:
   *   { ok: true, data: [ { id, timestamp, true_count, ... } ] }
   */
  router.get('/labels/:sessionId', (req, res) => {
    try {
      const { limit, offset } = req.query;
      const labels = getLabels(req.params.sessionId, {
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      });
      res.json({ ok: true, data: labels });
    } catch (err) {
      log.error({ err }, 'Failed to get labels');
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /recent — Get recent labels across all sessions.
   *
   * Query params:
   *   limit?: number (default 20)
   *
   * Response:
   *   { ok: true, data: [ { id, timestamp, true_count, session_name, ... } ] }
   */
  router.get('/recent', (req, res) => {
    try {
      const { limit } = req.query;
      const labels = getRecentLabels({
        limit: limit ? parseInt(limit, 10) : undefined,
      });
      res.json({ ok: true, data: labels });
    } catch (err) {
      log.error({ err }, 'Failed to get recent labels');
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * DELETE /labels/:id — Delete a single label.
   *
   * Response:
   *   { ok: true } or { ok: false, error: "Not found" }
   */
  router.delete('/labels/:id', (req, res) => {
    try {
      const deleted = deleteLabel(parseInt(req.params.id, 10));
      if (!deleted) {
        return res.status(404).json({ ok: false, error: 'Label not found' });
      }
      log.info({ labelId: req.params.id }, 'Label deleted');
      res.json({ ok: true });
    } catch (err) {
      log.error({ err }, 'Failed to delete label');
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

export default { createGroundTruthRouter };
