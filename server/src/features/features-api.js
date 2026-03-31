// ==============================================================================
// Feature Vector REST API & SSE Stream (ACC-01-T8, ACC-01-T9)
// ==============================================================================
// Provides two endpoints for consuming computed feature vectors:
//
//   GET  /api/v1/features          — Current feature vectors per node (ACC-01-T8)
//   GET  /api/v1/features/stream   — SSE stream at 5Hz with latest features (ACC-01-T9)
//
// The API reads from an in-memory FeatureStore that is populated by the CSI
// processing pipeline. The store holds the latest feature vector per node MAC,
// overwritten on each processing cycle.
//
// SSE clients receive a JSON-serialized event every 200ms (5Hz) containing
// feature vectors for all active nodes. Clients can filter by node MAC via
// query parameter: /api/v1/features/stream?node=AA:BB:CC:DD:EE:FF
//
// Follows project API conventions:
//   - Response format: { ok: true, data: {...} } or { ok: false, error: "..." }
//   - Pino child logger for structured logging
//   - All timestamps in ISO 8601 UTC
// ==============================================================================

import { Router } from 'express';
import { serializeToJSON } from './serializer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** SSE push interval in milliseconds (5Hz = 200ms). */
export const SSE_INTERVAL_MS = 200;

/** Maximum idle time before closing an SSE connection (5 minutes). */
export const SSE_MAX_IDLE_MS = 5 * 60 * 1000;

/** SSE keep-alive comment interval (30 seconds). */
export const SSE_KEEPALIVE_MS = 30 * 1000;

// ---------------------------------------------------------------------------
// In-Memory Feature Store
// ---------------------------------------------------------------------------

/**
 * Simple in-memory store holding the latest feature vector per node.
 * Designed to be written by the CSI processing pipeline and read by the API.
 *
 * Thread-safe for single-threaded Node.js — no locking needed.
 */
export class FeatureStore {
  constructor() {
    /**
     * Map of node MAC → latest feature vector.
     * @type {Map<string, Object>}
     */
    this._store = new Map();

    /**
     * Map of node MAC → last update timestamp (epoch ms).
     * @type {Map<string, number>}
     */
    this._timestamps = new Map();
  }

  /**
   * Store a feature vector for a node, replacing any previous value.
   *
   * @param {string} nodeMAC - Node MAC address (e.g., 'AA:BB:CC:DD:EE:FF')
   * @param {Object} featureVector - Computed feature vector object
   */
  put(nodeMAC, featureVector) {
    const mac = nodeMAC.toUpperCase();
    this._store.set(mac, featureVector);
    this._timestamps.set(mac, Date.now());
  }

  /**
   * Get the latest feature vector for a specific node.
   *
   * @param {string} nodeMAC - Node MAC address
   * @returns {{ vector: Object, updatedAt: number } | null} Feature vector and timestamp, or null
   */
  get(nodeMAC) {
    const mac = nodeMAC.toUpperCase();
    const vector = this._store.get(mac);
    if (!vector) return null;
    return {
      vector,
      updatedAt: this._timestamps.get(mac),
    };
  }

  /**
   * Get feature vectors for all known nodes.
   *
   * @returns {Object[]} Array of { nodeMAC, vector, updatedAt } objects
   */
  getAll() {
    const results = [];
    for (const [mac, vector] of this._store) {
      results.push({
        nodeMAC: mac,
        vector,
        updatedAt: this._timestamps.get(mac),
      });
    }
    return results;
  }

  /**
   * Get the list of known node MACs.
   *
   * @returns {string[]} Array of MAC addresses
   */
  getNodeMACs() {
    return Array.from(this._store.keys());
  }

  /**
   * Remove a node from the store.
   *
   * @param {string} nodeMAC - Node MAC address
   * @returns {boolean} True if the node was found and removed
   */
  remove(nodeMAC) {
    const mac = nodeMAC.toUpperCase();
    this._timestamps.delete(mac);
    return this._store.delete(mac);
  }

  /**
   * Clear all stored feature vectors.
   */
  clear() {
    this._store.clear();
    this._timestamps.clear();
  }

  /**
   * Get the number of nodes in the store.
   * @returns {number}
   */
  get size() {
    return this._store.size;
  }
}

// ---------------------------------------------------------------------------
// Router Factory
// ---------------------------------------------------------------------------

/**
 * Create the features API router.
 *
 * @param {Object} options
 * @param {Object} options.logger - Pino logger instance
 * @param {FeatureStore} options.featureStore - In-memory feature store
 * @returns {Router} Express router for /api/v1/features
 */
export function createFeaturesRouter({ logger, featureStore }) {
  const router = Router();
  const log = logger.child({ module: 'features-api' });

  // Track active SSE connections for cleanup
  const sseClients = new Set();

  // -------------------------------------------------------------------------
  // GET /api/v1/features — Current feature vectors per node (ACC-01-T8)
  // -------------------------------------------------------------------------

  /**
   * Returns the latest feature vectors for all nodes, or a specific node
   * if the `node` query parameter is provided.
   *
   * Query params:
   *   ?node=AA:BB:CC:DD:EE:FF — Filter to a single node
   *   ?format=json|csv        — Output format (default: json)
   */
  router.get('/', (req, res) => {
    try {
      const nodeFilter = req.query.node;

      if (nodeFilter) {
        // Single node lookup
        const entry = featureStore.get(nodeFilter);
        if (!entry) {
          return res.status(404).json({
            ok: false,
            error: `No feature data for node ${nodeFilter}`,
          });
        }

        return res.json({
          ok: true,
          data: {
            nodeMAC: nodeFilter.toUpperCase(),
            features: entry.vector,
            updatedAt: new Date(entry.updatedAt).toISOString(),
          },
        });
      }

      // All nodes
      const allEntries = featureStore.getAll();

      return res.json({
        ok: true,
        data: {
          nodes: allEntries.map(e => ({
            nodeMAC: e.nodeMAC,
            features: e.vector,
            updatedAt: new Date(e.updatedAt).toISOString(),
          })),
          count: allEntries.length,
        },
      });
    } catch (err) {
      log.error({ err }, 'Error fetching features');
      return res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/features/stream — SSE endpoint at 5Hz (ACC-01-T9)
  // -------------------------------------------------------------------------

  /**
   * Server-Sent Events stream pushing feature vectors at 5Hz.
   * Each event contains feature vectors for all active nodes (or a filtered node).
   *
   * Query params:
   *   ?node=AA:BB:CC:DD:EE:FF — Filter to a single node
   *
   * Event format:
   *   event: features
   *   data: { "nodes": [...], "timestamp": "..." }
   */
  router.get('/stream', (req, res) => {
    const nodeFilter = req.query.node?.toUpperCase();

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    });

    // Send initial comment to establish connection
    res.write(':ok\n\n');

    log.info({ nodeFilter: nodeFilter || 'all' }, 'SSE client connected');

    // Track this connection
    const client = { res, nodeFilter, connectedAt: Date.now() };
    sseClients.add(client);

    // Push features at 5Hz
    const pushInterval = setInterval(() => {
      try {
        const entries = nodeFilter
          ? (() => {
              const e = featureStore.get(nodeFilter);
              return e ? [{ nodeMAC: nodeFilter, vector: e.vector, updatedAt: e.updatedAt }] : [];
            })()
          : featureStore.getAll();

        const payload = JSON.stringify({
          nodes: entries.map(e => ({
            nodeMAC: e.nodeMAC,
            features: e.vector,
            updatedAt: e.updatedAt,
          })),
          timestamp: Date.now(),
        });

        res.write(`event: features\ndata: ${payload}\n\n`);
      } catch (err) {
        log.warn({ err }, 'Error pushing SSE features');
      }
    }, SSE_INTERVAL_MS);

    // Keep-alive to prevent proxy timeouts
    const keepaliveInterval = setInterval(() => {
      res.write(':keepalive\n\n');
    }, SSE_KEEPALIVE_MS);

    // Clean up on client disconnect
    const cleanup = () => {
      clearInterval(pushInterval);
      clearInterval(keepaliveInterval);
      sseClients.delete(client);
      log.info({ nodeFilter: nodeFilter || 'all' }, 'SSE client disconnected');
    };

    req.on('close', cleanup);
    req.on('error', cleanup);
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/features/nodes — List nodes with available features
  // -------------------------------------------------------------------------

  router.get('/nodes', (_req, res) => {
    const macs = featureStore.getNodeMACs();
    res.json({
      ok: true,
      data: { nodes: macs, count: macs.length },
    });
  });

  return router;
}

export default { createFeaturesRouter, FeatureStore };
