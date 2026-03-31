// ==============================================================================
// Discovery → Nodes DB Sync Service (ADMIN-04)
// ==============================================================================
// Bridges the DiscoveryService (in-memory, polling-based) with the persistent
// nodes database (SQLite). When the discovery service detects a new or updated
// ESP32 node, this module ensures the nodes table is kept in sync:
//
//   - New nodes are auto-registered with discovery_source = 'discovery'
//   - Existing nodes get their IP, status, and last_seen updated
//   - Nodes that go offline are marked as 'offline' in the DB
//   - Manually-added nodes are never deleted by sync (only updated if seen)
//
// Usage:
//   import { DiscoverySync } from './admin/discovery-sync.js';
//   const sync = new DiscoverySync({ discovery, logger });
//   sync.start();     // Subscribe to discovery events
//   sync.stop();      // Unsubscribe
//   sync.syncNow();   // Force a full sync cycle
//
// Architecture:
//   DiscoveryService emits:  'node:discovered', 'node:offline', 'discovery:complete'
//   DiscoverySync listens and writes to SQLite nodes table via getDb()
// ==============================================================================

import { getDb } from '../db/index.js';
import { randomUUID } from 'crypto';

/**
 * @typedef {Object} SyncStats
 * @property {number} nodesCreated    - New nodes inserted into DB
 * @property {number} nodesUpdated    - Existing nodes updated (IP, status, last_seen)
 * @property {number} nodesOfflined   - Nodes marked offline
 * @property {number} syncCycles      - Total sync cycles completed
 * @property {string|null} lastSyncAt - ISO timestamp of last successful sync
 */

export class DiscoverySync {
  /**
   * @param {Object} options
   * @param {import('../discovery.js').DiscoveryService} options.discovery - Discovery service instance
   * @param {Object} options.logger - Pino logger instance
   */
  constructor({ discovery, logger }) {
    this.discovery = discovery;
    this.log = logger.child({ module: 'discovery-sync' });

    /** @type {SyncStats} */
    this.stats = {
      nodesCreated: 0,
      nodesUpdated: 0,
      nodesOfflined: 0,
      syncCycles: 0,
      lastSyncAt: null,
    };

    // Bound handlers for clean add/remove
    this._onDiscovered = this._handleNodeDiscovered.bind(this);
    this._onOffline = this._handleNodeOffline.bind(this);
    this._onComplete = this._handleDiscoveryComplete.bind(this);
    this._started = false;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Start listening to discovery events and syncing to the database.
   * Safe to call multiple times — only subscribes once.
   */
  start() {
    if (this._started) {
      this.log.debug('Discovery sync already started');
      return;
    }

    this.discovery.on('node:discovered', this._onDiscovered);
    this.discovery.on('node:offline', this._onOffline);
    this.discovery.on('discovery:complete', this._onComplete);
    this._started = true;

    this.log.info('Discovery-to-DB sync started');
  }

  /**
   * Stop listening to discovery events.
   */
  stop() {
    if (!this._started) return;

    this.discovery.off('node:discovered', this._onDiscovered);
    this.discovery.off('node:offline', this._onOffline);
    this.discovery.off('discovery:complete', this._onComplete);
    this._started = false;

    this.log.info('Discovery-to-DB sync stopped');
  }

  /**
   * Force a full sync cycle: reconcile all currently-known discovery nodes
   * with the database. Useful at startup to ensure consistency.
   *
   * @returns {SyncStats} Current sync statistics
   */
  syncNow() {
    const discoveredNodes = this.discovery.getNodes();
    this.log.info({ nodeCount: discoveredNodes.length }, 'Running full discovery sync');

    for (const node of discoveredNodes) {
      this._upsertNode(node);
    }

    // Mark DB nodes as offline if not in discovery set
    this._reconcileOfflineNodes(discoveredNodes);

    this.stats.syncCycles++;
    this.stats.lastSyncAt = new Date().toISOString();
    return { ...this.stats };
  }

  /**
   * Get current sync statistics.
   *
   * @returns {SyncStats}
   */
  getStats() {
    return { ...this.stats };
  }

  // ---------------------------------------------------------------------------
  // Event Handlers
  // ---------------------------------------------------------------------------

  /**
   * Handle a newly discovered node — upsert into the database.
   *
   * @param {import('../discovery.js').NodeInfo} node
   * @private
   */
  _handleNodeDiscovered(node) {
    try {
      this._upsertNode(node);
    } catch (err) {
      this.log.error({ err, nodeId: node.id }, 'Failed to sync discovered node to DB');
    }
  }

  /**
   * Handle a node going offline — update status in the database.
   *
   * @param {import('../discovery.js').NodeInfo} node
   * @private
   */
  _handleNodeOffline(node) {
    try {
      this._markOffline(node.id);
    } catch (err) {
      this.log.error({ err, nodeId: node.id }, 'Failed to mark node offline in DB');
    }
  }

  /**
   * Handle discovery cycle completion — run reconciliation.
   *
   * @param {import('../discovery.js').NodeInfo[]} nodes - All currently known nodes
   * @private
   */
  _handleDiscoveryComplete(nodes) {
    try {
      this._reconcileOfflineNodes(nodes);
      this.stats.syncCycles++;
      this.stats.lastSyncAt = new Date().toISOString();
    } catch (err) {
      this.log.error({ err }, 'Failed to reconcile nodes after discovery cycle');
    }
  }

  // ---------------------------------------------------------------------------
  // Database Operations
  // ---------------------------------------------------------------------------

  /**
   * Insert or update a node in the database based on discovery data.
   * Matches by MAC address (normalized). If a node with the same MAC exists,
   * updates its IP, status, last_seen, and firmware_ver. If not, creates it.
   *
   * @param {import('../discovery.js').NodeInfo} discoveryNode
   * @private
   */
  _upsertNode(discoveryNode) {
    const db = getDb();
    const mac = this._normalizeMac(discoveryNode.id);
    if (!mac) {
      this.log.warn({ nodeId: discoveryNode.id }, 'Cannot sync node: invalid MAC format');
      return;
    }

    const now = new Date().toISOString();
    const existing = db.prepare('SELECT id, discovery_source FROM nodes WHERE mac = ?').get(mac);

    if (existing) {
      // Update existing node: IP, status, last_seen, firmware
      db.prepare(`
        UPDATE nodes
        SET ip = ?,
            status = ?,
            last_seen = ?,
            firmware_ver = COALESCE(?, firmware_ver),
            updated_at = datetime('now')
        WHERE mac = ?
      `).run(
        discoveryNode.ip || null,
        discoveryNode.status || 'online',
        now,
        discoveryNode.meta?.firmware_version || null,
        mac
      );

      this.stats.nodesUpdated++;
      this.log.debug(
        { nodeId: existing.id, mac, ip: discoveryNode.ip },
        'Updated node from discovery'
      );
    } else {
      // Create new node from discovery
      const id = randomUUID();
      const name = discoveryNode.name || `Node ${mac.slice(-5).replace(':', '')}`;

      db.prepare(`
        INSERT INTO nodes (id, mac, name, ip, type, firmware_ver, status, last_seen, discovery_source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        mac,
        name,
        discoveryNode.ip || null,
        'esp32-s3',
        discoveryNode.meta?.firmware_version || null,
        'online',
        now,
        'discovery'
      );

      this.stats.nodesCreated++;
      this.log.info(
        { nodeId: id, mac, name, ip: discoveryNode.ip },
        'Auto-registered new node from discovery'
      );
    }
  }

  /**
   * Mark a node as offline in the database by its discovery ID (MAC).
   *
   * @param {string} discoveryId - The node ID from discovery (typically a MAC)
   * @private
   */
  _markOffline(discoveryId) {
    const db = getDb();
    const mac = this._normalizeMac(discoveryId);
    if (!mac) return;

    const result = db.prepare(`
      UPDATE nodes
      SET status = 'offline', updated_at = datetime('now')
      WHERE mac = ? AND status != 'offline'
    `).run(mac);

    if (result.changes > 0) {
      this.stats.nodesOfflined++;
      this.log.info({ mac }, 'Node marked offline in DB');
    }
  }

  /**
   * Reconcile the database against the current discovery snapshot.
   * Any node in the DB with discovery_source='discovery' that is NOT in the
   * current discovery set and has been offline for a while is kept as-is
   * (we never auto-delete). Nodes marked 'online' but missing from discovery
   * are set to 'offline'.
   *
   * @param {import('../discovery.js').NodeInfo[]} discoveredNodes
   * @private
   */
  _reconcileOfflineNodes(discoveredNodes) {
    const db = getDb();
    const discoveredMacs = new Set(
      discoveredNodes
        .map(n => this._normalizeMac(n.id))
        .filter(Boolean)
    );

    // Find DB nodes that are 'online' but not in the discovery set
    const onlineDbNodes = db.prepare(
      "SELECT id, mac FROM nodes WHERE status = 'online'"
    ).all();

    for (const dbNode of onlineDbNodes) {
      if (!discoveredMacs.has(dbNode.mac)) {
        db.prepare(`
          UPDATE nodes SET status = 'offline', updated_at = datetime('now')
          WHERE id = ? AND status = 'online'
        `).run(dbNode.id);

        this.stats.nodesOfflined++;
        this.log.debug({ nodeId: dbNode.id, mac: dbNode.mac }, 'Reconciled node to offline');
      }
    }
  }

  /**
   * Normalize a discovery node ID to a MAC address format.
   * Discovery IDs can be MAC addresses (with colons) or raw hex strings.
   *
   * @param {string} id - Discovery node identifier
   * @returns {string|null} Normalized MAC (xx:xx:xx:xx:xx:xx) or null if invalid
   * @private
   */
  _normalizeMac(id) {
    if (!id || typeof id !== 'string') return null;

    // Already in MAC format
    const cleaned = id.toLowerCase().trim();
    if (/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(cleaned)) {
      return cleaned;
    }

    // Raw hex without colons (12 chars)
    const hex = cleaned.replace(/[^0-9a-f]/g, '');
    if (hex.length === 12) {
      return hex.match(/.{2}/g).join(':');
    }

    // Not a valid MAC — return as-is for logging but flag as unusable
    this.log.debug({ id }, 'Discovery node ID is not a valid MAC address');
    return null;
  }
}

export default { DiscoverySync };
