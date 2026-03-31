// ==============================================================================
// Node Admin API — CRUD Endpoints for ESP32 Node Management
// ==============================================================================
// ADMIN-01 + ADMIN-02: Database-backed node management with full CRUD.
// Separate from the existing /api/nodes (discovery-based) — this is the
// persistent node registry in SQLite.
//
// Endpoints:
//   GET    /api/v1/nodes           — List all registered nodes
//   GET    /api/v1/nodes/:id       — Get a single node
//   POST   /api/v1/nodes           — Register a new node
//   PUT    /api/v1/nodes/:id       — Update node properties
//   DELETE /api/v1/nodes/:id       — Delete a node
//
// Response format: { ok: true, data: {...} } or { ok: false, error: "message" }
// ==============================================================================

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { randomUUID } from 'crypto';

/**
 * Create the node admin API router.
 *
 * @param {Object} options
 * @param {Object} options.logger - Pino logger instance
 * @returns {Router} Express router for /api/v1/nodes
 */
export function createNodesRouter({ logger }) {
  const log = logger.child({ module: 'nodes-api' });
  const router = Router();

  // -------------------------------------------------------------------------
  // GET / — List all registered nodes
  // -------------------------------------------------------------------------
  /**
   * GET /
   *
   * Query params:
   *   status?: string - Filter by status ('online', 'offline')
   *   type?: string - Filter by node type ('esp32-s3', etc.)
   *
   * Response:
   *   { ok: true, data: [ { id, mac, name, ip, type, ... } ] }
   */
  router.get('/', (req, res) => {
    try {
      const db = getDb();
      let sql = 'SELECT * FROM nodes';
      const conditions = [];
      const params = [];

      if (req.query.status) {
        conditions.push('status = ?');
        params.push(req.query.status);
      }
      if (req.query.type) {
        conditions.push('type = ?');
        params.push(req.query.type);
      }

      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }
      sql += ' ORDER BY name ASC';

      const nodes = db.prepare(sql).all(...params);
      res.json({ ok: true, data: nodes });
    } catch (err) {
      log.error({ err }, 'Failed to list nodes');
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /:id — Get a single node
  // -------------------------------------------------------------------------
  /**
   * GET /:id
   *
   * Response:
   *   { ok: true, data: { id, mac, name, ip, type, firmware_ver, status, ... } }
   */
  router.get('/:id', (req, res) => {
    try {
      const db = getDb();
      const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
      if (!node) {
        return res.status(404).json({ ok: false, error: 'Node not found' });
      }
      res.json({ ok: true, data: node });
    } catch (err) {
      log.error({ err }, 'Failed to get node');
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // POST / — Register a new node
  // -------------------------------------------------------------------------
  /**
   * POST /
   *
   * Request body:
   *   {
   *     mac: string (required, format: "xx:xx:xx:xx:xx:xx"),
   *     name?: string,
   *     ip?: string,
   *     type?: string (default: 'esp32-s3'),
   *     firmware_ver?: string,
   *     position_x?: number,
   *     position_y?: number
   *   }
   *
   * Response (201):
   *   { ok: true, data: { id, mac, name, ... } }
   */
  router.post('/', (req, res) => {
    try {
      const db = getDb();
      const { mac, name, ip, type, firmware_ver, position_x, position_y } = req.body;

      // Validate MAC address
      if (!mac || typeof mac !== 'string') {
        return res.status(400).json({ ok: false, error: 'mac address is required' });
      }
      const macNormalized = mac.toLowerCase().trim();
      if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(macNormalized)) {
        return res.status(400).json({ ok: false, error: 'Invalid MAC address format (expected xx:xx:xx:xx:xx:xx)' });
      }

      // Check for duplicate MAC
      const existing = db.prepare('SELECT id FROM nodes WHERE mac = ?').get(macNormalized);
      if (existing) {
        return res.status(409).json({ ok: false, error: 'Node with this MAC already registered', existingId: existing.id });
      }

      const id = randomUUID();
      db.prepare(`
        INSERT INTO nodes (id, mac, name, ip, type, firmware_ver, position_x, position_y)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        macNormalized,
        name || 'Unnamed Node',
        ip || null,
        type || 'esp32-s3',
        firmware_ver || null,
        position_x ?? null,
        position_y ?? null
      );

      const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
      log.info({ nodeId: id, mac: macNormalized, name: node.name }, 'Node registered');
      res.status(201).json({ ok: true, data: node });
    } catch (err) {
      log.error({ err }, 'Failed to register node');
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // PUT /:id — Update node properties
  // -------------------------------------------------------------------------
  /**
   * PUT /:id
   *
   * Request body (all fields optional):
   *   {
   *     name?: string,
   *     ip?: string,
   *     type?: string,
   *     firmware_ver?: string,
   *     status?: string,
   *     position_x?: number,
   *     position_y?: number
   *   }
   *
   * Response:
   *   { ok: true, data: { ...updated node } }
   */
  router.put('/:id', (req, res) => {
    try {
      const db = getDb();
      const { id } = req.params;

      // Check node exists
      const existing = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
      if (!existing) {
        return res.status(404).json({ ok: false, error: 'Node not found' });
      }

      // Build dynamic UPDATE from provided fields
      const allowed = ['name', 'ip', 'type', 'firmware_ver', 'status', 'position_x', 'position_y'];
      const updates = [];
      const values = [];

      for (const field of allowed) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = ?`);
          values.push(req.body[field]);
        }
      }

      if (updates.length === 0) {
        return res.status(400).json({ ok: false, error: 'No valid fields to update' });
      }

      updates.push("updated_at = datetime('now')");
      values.push(id);

      db.prepare(`UPDATE nodes SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
      log.info({ nodeId: id, updated: Object.keys(req.body) }, 'Node updated');
      res.json({ ok: true, data: node });
    } catch (err) {
      log.error({ err }, 'Failed to update node');
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /:id — Remove a node
  // -------------------------------------------------------------------------
  /**
   * DELETE /:id
   *
   * Response:
   *   { ok: true } or { ok: false, error: "Node not found" }
   */
  router.delete('/:id', (req, res) => {
    try {
      const db = getDb();
      const result = db.prepare('DELETE FROM nodes WHERE id = ?').run(req.params.id);
      if (result.changes === 0) {
        return res.status(404).json({ ok: false, error: 'Node not found' });
      }
      log.info({ nodeId: req.params.id }, 'Node deleted');
      res.json({ ok: true });
    } catch (err) {
      log.error({ err }, 'Failed to delete node');
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

export default { createNodesRouter };
