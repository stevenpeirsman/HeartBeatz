// ==============================================================================
// Calibration History API — ACC-03-T6
// ==============================================================================
// REST endpoint for querying recalibration event history.
//
// Endpoints:
//   GET /api/v1/calibration/history
//     Query params:
//       - limit (number, default 100, max 100) — max events to return
//       - nodeId (string, optional) — filter by node identifier
//       - triggerType (string, optional) — filter by trigger type
//     Returns: { ok: true, data: { events: [...], summary: {...} } }
//
//   GET /api/v1/calibration/summary
//     Returns: { ok: true, data: { summary: {...} } }
//
// Follows project API conventions: { ok, data } / { ok, error } responses.
// ==============================================================================

import { Router } from 'express';
import { TriggerType } from './recal-logger.js';

/** Maximum events per API request. */
const MAX_LIMIT = 100;

/** Set of valid trigger type values for input validation. */
const VALID_TRIGGER_TYPES = new Set(Object.values(TriggerType));

/**
 * Create the calibration history API router.
 *
 * @param {Object} options
 * @param {Object} options.logger          - Pino logger instance
 * @param {import('./recal-logger.js').RecalibrationLogger} options.recalLogger - Recalibration logger instance
 * @returns {Router} Express router for /api/v1/calibration
 */
export function createCalibrationRouter({ logger, recalLogger }) {
  const router = Router();
  const log = logger.child({ component: 'cal-history-api' });

  /**
   * GET /history — Return recent recalibration events.
   *
   * Query parameters:
   *   limit       — Max events to return (default 100, max 100)
   *   nodeId      — Filter by node identifier
   *   triggerType — Filter by trigger type (scheduled|cusum_shift|empty_room|manual|startup)
   */
  router.get('/history', (req, res) => {
    try {
      const limit = Math.min(
        Math.max(1, parseInt(req.query.limit, 10) || MAX_LIMIT),
        MAX_LIMIT
      );
      const nodeId = req.query.nodeId || null;
      const triggerType = req.query.triggerType || null;

      // Validate triggerType if provided
      if (triggerType && !VALID_TRIGGER_TYPES.has(triggerType)) {
        return res.status(400).json({
          ok: false,
          error: `Invalid triggerType '${triggerType}'. Valid values: ${[...VALID_TRIGGER_TYPES].join(', ')}`,
        });
      }

      let events;

      if (nodeId && triggerType) {
        // Both filters: get by node, then filter by trigger
        events = recalLogger.getHistoryByNode(nodeId, MAX_LIMIT)
          .filter(e => e.triggerType === triggerType)
          .slice(-limit);
      } else if (nodeId) {
        events = recalLogger.getHistoryByNode(nodeId, limit);
      } else if (triggerType) {
        events = recalLogger.getHistoryByTrigger(triggerType, limit);
      } else {
        events = recalLogger.getHistory(limit);
      }

      const summary = recalLogger.getSummary();

      res.json({
        ok: true,
        data: { events, summary },
      });
    } catch (err) {
      log.error({ err: err.message }, 'Error fetching calibration history');
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  /**
   * GET /summary — Return aggregate statistics of recalibration activity.
   */
  router.get('/summary', (req, res) => {
    try {
      const summary = recalLogger.getSummary();
      res.json({ ok: true, data: { summary } });
    } catch (err) {
      log.error({ err: err.message }, 'Error fetching calibration summary');
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  return router;
}
