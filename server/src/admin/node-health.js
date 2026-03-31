// ==============================================================================
// Node Health Check — Ping & Firmware Version for Individual ESP32 Nodes
// ==============================================================================
// ADMIN-07: Provides a /api/v1/nodes/:id/ping endpoint that checks whether
// a registered ESP32 node is reachable on the network and retrieves its
// current firmware version.
//
// How it works:
//   1. Look up node IP from the nodes database
//   2. TCP connect to the node's HTTP port (default 80) with a short timeout
//   3. If reachable, attempt to GET /info from the node's local HTTP server
//      (ESP32-S3 nodes expose a /info endpoint returning firmware version)
//   4. Update the node's status and last_seen in the database
//   5. Return health status to the caller
//
// Network context:
//   All nodes are on the local GL.iNet travel router network (192.168.8.x).
//   The MeLE N100 (server) and ESP32 nodes share this LAN segment.
//   Typical latency: < 5ms. Timeout of 3s handles worst-case WiFi retries.
//
// Usage:
//   import { createNodeHealthRouter } from './node-health.js';
//   router.use('/api/v1/nodes', createNodeHealthRouter({ logger }));
//   // Exposes: GET /api/v1/nodes/:id/ping
// ==============================================================================

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { createConnection } from 'net';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default TCP connection timeout in milliseconds */
export const DEFAULT_TIMEOUT_MS = 3000;

/** Default HTTP port for ESP32 node info endpoint */
export const DEFAULT_NODE_PORT = 80;

/** ESP32 info endpoint path */
export const INFO_ENDPOINT = '/info';

// ---------------------------------------------------------------------------
// Core Health Check Logic
// ---------------------------------------------------------------------------

/**
 * Check TCP reachability of a host:port with a timeout.
 *
 * @param {string} host - IP address or hostname
 * @param {number} port - TCP port number
 * @param {number} timeoutMs - Connection timeout in milliseconds
 * @returns {Promise<{ reachable: boolean, latencyMs: number }>}
 */
export function tcpPing(host, port, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = createConnection({ host, port, timeout: timeoutMs });

    socket.on('connect', () => {
      const latencyMs = Date.now() - start;
      socket.destroy();
      resolve({ reachable: true, latencyMs });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({ reachable: false, latencyMs: timeoutMs });
    });

    socket.on('error', () => {
      socket.destroy();
      resolve({ reachable: false, latencyMs: Date.now() - start });
    });
  });
}

/**
 * Fetch firmware info from an ESP32 node's /info HTTP endpoint.
 *
 * Uses a raw HTTP GET to avoid depending on node-fetch. The ESP32 HTTP
 * server returns a JSON response like:
 *   { "firmware": "1.2.3", "mac": "AA:BB:CC:DD:EE:FF", "uptime": 12345 }
 *
 * @param {string} host - Node IP address
 * @param {number} [port=80] - HTTP port
 * @param {number} [timeoutMs=3000] - Request timeout
 * @returns {Promise<Object|null>} Parsed info object, or null on failure
 */
export function fetchNodeInfo(host, port = DEFAULT_NODE_PORT, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: timeoutMs });
    let data = '';

    socket.on('connect', () => {
      socket.write(`GET ${INFO_ENDPOINT} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });

    socket.on('data', (chunk) => {
      data += chunk.toString();
    });

    socket.on('end', () => {
      try {
        // Extract JSON body from HTTP response (after \r\n\r\n)
        const bodyStart = data.indexOf('\r\n\r\n');
        if (bodyStart === -1) {
          resolve(null);
          return;
        }
        const body = data.slice(bodyStart + 4).trim();
        resolve(JSON.parse(body));
      } catch {
        resolve(null);
      }
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(null);
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(null);
    });
  });
}

/**
 * Perform a full health check on a registered node.
 *
 * Looks up the node in the database, pings its IP, optionally fetches
 * firmware info, and updates the node's status and last_seen fields.
 *
 * @param {string} nodeId - Node ID from the nodes table
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=3000] - Connection timeout
 * @param {boolean} [options.fetchInfo=true] - Whether to fetch /info endpoint
 * @param {boolean} [options.updateDb=true] - Whether to update node status in DB
 * @param {Object} [options.logger] - Pino logger instance
 * @returns {Promise<{
 *   node_id: string,
 *   name: string,
 *   ip: string,
 *   reachable: boolean,
 *   latency_ms: number,
 *   firmware_version: string|null,
 *   node_info: Object|null,
 *   previous_status: string,
 *   new_status: string,
 *   checked_at: string,
 * }>}
 * @throws {Error} If node not found or has no IP address
 */
export async function checkNodeHealth(nodeId, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchInfo = true,
  updateDb = true,
  logger,
} = {}) {
  const db = getDb();

  // Look up node
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
  if (!node) {
    throw new Error(`Node not found: ${nodeId}`);
  }
  if (!node.ip) {
    throw new Error(`Node ${nodeId} (${node.name}) has no IP address configured`);
  }

  const checkedAt = new Date().toISOString();
  const log = logger?.child({ nodeId, ip: node.ip });

  // TCP ping
  const ping = await tcpPing(node.ip, DEFAULT_NODE_PORT, timeoutMs);

  let nodeInfo = null;
  let firmwareVersion = node.firmware_ver;

  // Fetch firmware info if reachable and requested
  if (ping.reachable && fetchInfo) {
    nodeInfo = await fetchNodeInfo(node.ip, DEFAULT_NODE_PORT, timeoutMs);
    if (nodeInfo?.firmware) {
      firmwareVersion = nodeInfo.firmware;
    }
  }

  const previousStatus = node.status;
  const newStatus = ping.reachable ? 'online' : 'offline';

  // Update database if requested
  if (updateDb) {
    const updates = {
      status: newStatus,
      last_seen: ping.reachable ? checkedAt : node.last_seen,
    };
    if (firmwareVersion && firmwareVersion !== node.firmware_ver) {
      updates.firmware_ver = firmwareVersion;
    }

    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), checkedAt, nodeId];
    db.prepare(`UPDATE nodes SET ${setClauses}, updated_at = ? WHERE id = ?`).run(...values);

    if (previousStatus !== newStatus) {
      log?.info({ from: previousStatus, to: newStatus, latencyMs: ping.latencyMs }, 'Node status changed');
    }
  }

  return {
    node_id: nodeId,
    name: node.name,
    ip: node.ip,
    reachable: ping.reachable,
    latency_ms: ping.latencyMs,
    firmware_version: firmwareVersion,
    node_info: nodeInfo,
    previous_status: previousStatus,
    new_status: newStatus,
    checked_at: checkedAt,
  };
}

/**
 * Ping all registered nodes and return a summary.
 *
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=3000] - Connection timeout per node
 * @param {boolean} [options.updateDb=true] - Whether to update status in DB
 * @param {Object} [options.logger] - Pino logger
 * @returns {Promise<{
 *   total: number,
 *   online: number,
 *   offline: number,
 *   results: Array<Object>,
 *   checked_at: string,
 * }>}
 */
export async function pingAllNodes({ timeoutMs = DEFAULT_TIMEOUT_MS, updateDb = true, logger } = {}) {
  const db = getDb();
  const nodes = db.prepare('SELECT id FROM nodes WHERE ip IS NOT NULL').all();

  const results = [];
  for (const { id } of nodes) {
    try {
      const result = await checkNodeHealth(id, { timeoutMs, fetchInfo: false, updateDb, logger });
      results.push(result);
    } catch (err) {
      results.push({
        node_id: id,
        reachable: false,
        error: err.message,
      });
    }
  }

  const online = results.filter(r => r.reachable).length;

  return {
    total: results.length,
    online,
    offline: results.length - online,
    results,
    checked_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Express Router
// ---------------------------------------------------------------------------

/**
 * Create an Express router for node health check endpoints.
 *
 * Endpoints:
 *   GET /api/v1/nodes/:id/ping  — Ping a specific node
 *   GET /api/v1/nodes/ping/all  — Ping all registered nodes
 *
 * @param {Object} options
 * @param {Object} options.logger - Pino logger instance
 * @returns {Router} Express router
 */
export function createNodeHealthRouter({ logger }) {
  const log = logger.child({ module: 'node-health' });
  const router = Router();

  /**
   * GET /:id/ping
   *
   * Check reachability and firmware version for a single node.
   *
   * Response:
   *   { ok: true, data: { node_id, name, ip, reachable, latency_ms, firmware_version, ... } }
   *   { ok: false, error: "Node not found: xyz" } (404)
   */
  router.get('/:id/ping', async (req, res) => {
    try {
      const result = await checkNodeHealth(req.params.id, { logger: log });
      res.json({ ok: true, data: result });
    } catch (err) {
      const status = err.message.includes('not found') ? 404
        : err.message.includes('no IP') ? 422
        : 500;
      log.warn({ err: err.message, nodeId: req.params.id }, 'Health check failed');
      res.status(status).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /ping/all
   *
   * Ping all nodes that have an IP address configured.
   *
   * Response:
   *   { ok: true, data: { total, online, offline, results: [...], checked_at } }
   */
  router.get('/ping/all', async (_req, res) => {
    try {
      const result = await pingAllNodes({ logger: log });
      res.json({ ok: true, data: result });
    } catch (err) {
      log.error({ err }, 'Bulk health check failed');
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Default Export
// ---------------------------------------------------------------------------

export default {
  tcpPing,
  fetchNodeInfo,
  checkNodeHealth,
  pingAllNodes,
  createNodeHealthRouter,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_NODE_PORT,
  INFO_ENDPOINT,
};
