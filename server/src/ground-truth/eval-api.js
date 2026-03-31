// ==============================================================================
// Evaluation Report API — REST Endpoints
// ==============================================================================
// ACC-08-T5: REST API for running evaluations and retrieving accuracy reports.
//
// Endpoints:
//   POST /api/v1/evaluation/run/:sessionId   — Run evaluation for a session
//   POST /api/v1/evaluation/run              — Run evaluation across multiple sessions
//   GET  /api/v1/evaluation/report           — Get latest evaluation report
//   GET  /api/v1/evaluation/history          — Get evaluation history
//   GET  /api/v1/evaluation/report/:id       — Get a specific evaluation by ID
//
// Response format: { ok: true, data: {...} } or { ok: false, error: "message" }
// ==============================================================================

import { Router } from 'express';
import {
  evaluateSession,
  evaluateMultipleSessions,
  getEvaluationHistory,
} from './evaluator.js';
import { getDb } from '../db/index.js';

/**
 * Create the evaluation report API router.
 *
 * @param {Object} options
 * @param {Object} options.logger - Pino logger instance
 * @returns {Router} Express router for /api/v1/evaluation
 */
export function createEvaluationRouter({ logger }) {
  const log = logger.child({ module: 'eval-api' });
  const router = Router();

  // -------------------------------------------------------------------------
  // POST /run/:sessionId — Run evaluation for a single session
  // -------------------------------------------------------------------------
  //
  // Request body (all optional):
  //   {
  //     nodeId?: string,
  //     maxDeltaMs?: number,
  //     confidenceFilter?: 'certain' | 'likely' | 'unsure',
  //     algorithm?: string,
  //     persist?: boolean,
  //     notes?: string
  //   }
  //
  // Response (200):
  //   {
  //     ok: true,
  //     data: {
  //       session_id, algorithm, timestamp, alignment,
  //       confusion_matrix, per_class, aggregate, error_analysis,
  //       evaluation_id
  //     }
  //   }
  router.post('/run/:sessionId', (req, res) => {
    try {
      const { sessionId } = req.params;
      const {
        nodeId,
        maxDeltaMs,
        confidenceFilter,
        algorithm,
        persist,
        notes,
      } = req.body || {};

      log.info({ sessionId, algorithm, persist }, 'Running evaluation for session');

      const result = evaluateSession(sessionId, {
        nodeId,
        maxDeltaMs: maxDeltaMs ? Number(maxDeltaMs) : undefined,
        confidenceFilter,
        algorithm,
        persist: persist === true,
        notes,
      });

      log.info({
        sessionId,
        accuracy: result.aggregate.accuracy,
        total: result.aggregate.total_samples,
        f1: result.aggregate.macro.f1,
      }, 'Evaluation complete');

      res.json({ ok: true, data: result });
    } catch (err) {
      log.error({ err, sessionId: req.params.sessionId }, 'Evaluation failed');
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // POST /run — Run evaluation across multiple sessions
  // -------------------------------------------------------------------------
  //
  // Request body:
  //   {
  //     sessionIds: string[],
  //     nodeId?: string,
  //     maxDeltaMs?: number,
  //     confidenceFilter?: string,
  //     algorithm?: string,
  //     persist?: boolean,
  //     notes?: string
  //   }
  //
  // Response (200): same shape as single-session but with session_ids array
  router.post('/run', (req, res) => {
    try {
      const {
        sessionIds,
        nodeId,
        maxDeltaMs,
        confidenceFilter,
        algorithm,
        persist,
        notes,
      } = req.body || {};

      if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
        return res.status(400).json({
          ok: false,
          error: 'sessionIds must be a non-empty array of session UUIDs',
        });
      }

      log.info({
        sessionCount: sessionIds.length,
        algorithm,
        persist,
      }, 'Running multi-session evaluation');

      const result = evaluateMultipleSessions(sessionIds, {
        nodeId,
        maxDeltaMs: maxDeltaMs ? Number(maxDeltaMs) : undefined,
        confidenceFilter,
        algorithm,
        persist: persist === true,
        notes,
      });

      log.info({
        sessions: sessionIds.length,
        accuracy: result.aggregate.accuracy,
        total: result.aggregate.total_samples,
        f1: result.aggregate.macro.f1,
      }, 'Multi-session evaluation complete');

      res.json({ ok: true, data: result });
    } catch (err) {
      log.error({ err }, 'Multi-session evaluation failed');
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /report — Get the latest persisted evaluation report
  // -------------------------------------------------------------------------
  //
  // Query params:
  //   sessionId?: string  — Filter by session
  //   algorithm?: string  — Filter by algorithm name
  //
  // Response (200):
  //   { ok: true, data: { ...evaluation record } }
  // Response (404):
  //   { ok: false, error: "No evaluation reports found" }
  router.get('/report', (req, res) => {
    try {
      const { sessionId, algorithm } = req.query;

      const results = getEvaluationHistory({
        sessionId,
        algorithm,
        limit: 1,
      });

      if (results.length === 0) {
        return res.status(404).json({
          ok: false,
          error: 'No evaluation reports found',
        });
      }

      res.json({ ok: true, data: results[0] });
    } catch (err) {
      log.error({ err }, 'Failed to retrieve evaluation report');
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /history — Get evaluation history
  // -------------------------------------------------------------------------
  //
  // Query params:
  //   sessionId?: string
  //   algorithm?: string
  //   limit?: number (default 20)
  //
  // Response (200):
  //   { ok: true, data: [ ...evaluation records ] }
  router.get('/history', (req, res) => {
    try {
      const { sessionId, algorithm, limit } = req.query;

      const results = getEvaluationHistory({
        sessionId,
        algorithm,
        limit: limit ? Number(limit) : 20,
      });

      res.json({ ok: true, data: results });
    } catch (err) {
      log.error({ err }, 'Failed to retrieve evaluation history');
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /report/:id — Get a specific evaluation by ID
  // -------------------------------------------------------------------------
  //
  // Response (200):
  //   { ok: true, data: { ...evaluation record } }
  // Response (404):
  //   { ok: false, error: "Evaluation not found" }
  router.get('/report/:id', (req, res) => {
    try {
      const id = Number(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ ok: false, error: 'Invalid evaluation ID' });
      }

      const db = getDb();
      const row = db.prepare('SELECT * FROM evaluations WHERE id = ?').get(id);

      if (!row) {
        return res.status(404).json({ ok: false, error: 'Evaluation not found' });
      }

      // Parse confusion_json
      const result = {
        ...row,
        confusion_json: row.confusion_json ? JSON.parse(row.confusion_json) : null,
      };

      res.json({ ok: true, data: result });
    } catch (err) {
      log.error({ err, id: req.params.id }, 'Failed to retrieve evaluation');
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

export default { createEvaluationRouter };
