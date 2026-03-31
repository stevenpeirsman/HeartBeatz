// ==============================================================================
// HeartBeatz API v1 Router — Aggregates All v1 Endpoints
// ==============================================================================
// Mounts the new database-backed API modules under /api/v1/:
//   /api/v1/ground-truth/*  — Label collection & session management
//   /api/v1/nodes/*         — Node registry CRUD
//   /api/v1/evaluation/*    — Accuracy evaluation & reports
//   /api/v1/features/*      — Feature vectors REST + SSE stream
//   /api/v1/radar/*         — Radar SSE stream + REST snapshot (SENSOR-02)
//
// This router is mounted alongside the existing /api routes in index.js.
// ==============================================================================

import { Router } from 'express';
import { createGroundTruthRouter } from '../ground-truth/label-api.js';
import { createNodesRouter } from '../admin/nodes-api.js';
import { createEvaluationRouter } from '../ground-truth/eval-api.js';
import { createFeaturesRouter, FeatureStore } from '../features/features-api.js';
import { createRadarRouter, RadarStore } from './radar-sse.js';

/**
 * Create the aggregated v1 API router.
 *
 * @param {Object} options
 * @param {Object} options.logger - Pino logger instance
 * @param {FeatureStore} [options.featureStore] - In-memory feature store (created if not provided)
 * @param {RadarStore} [options.radarStore] - In-memory radar store (created if not provided)
 * @returns {{ router: Router, featureStore: FeatureStore, radarStore: RadarStore }}
 *   Express router, feature store, and radar store instances
 */
export function createApiV1Router({ logger, featureStore, radarStore }) {
  const router = Router();

  // Create shared feature store if not provided
  const store = featureStore || new FeatureStore();

  // Ground truth label collection & evaluation
  router.use('/ground-truth', createGroundTruthRouter({ logger }));

  // Node registry (database-backed CRUD, separate from discovery-based /api/nodes)
  router.use('/nodes', createNodesRouter({ logger }));

  // Evaluation reports & accuracy metrics (ACC-08-T5)
  router.use('/evaluation', createEvaluationRouter({ logger }));

  // Feature vectors REST + SSE stream (ACC-01-T8, ACC-01-T9)
  router.use('/features', createFeaturesRouter({ logger, featureStore: store }));

  // Radar SSE stream + REST snapshot (SENSOR-02)
  const radarResult = createRadarRouter({ logger, radarStore });
  router.use('/radar', radarResult.router);

  return { router, featureStore: store, radarStore: radarResult.radarStore };
}

export { FeatureStore, RadarStore };
export default { createApiV1Router, FeatureStore, RadarStore };
