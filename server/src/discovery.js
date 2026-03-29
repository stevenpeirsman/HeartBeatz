// ==============================================================================
// Node Discovery Service
// ==============================================================================
// Periodically polls the RuView sensing server's /api/v1/sensing/latest endpoint
// to detect which ESP32-S3 nodes are online. Maintains a live registry of nodes
// with connection state, RSSI, and last-seen timestamps.
//
// Design decision: We rely on the sensing server as the source of truth for
// node presence rather than doing our own mDNS/ARP scanning. This is simpler
// and guarantees that a "discovered" node is actually sending CSI data.

import { EventEmitter } from 'events';

/**
 * @typedef {Object} NodeInfo
 * @property {string} id        - Node MAC or identifier
 * @property {string} ip        - Last known IP address
 * @property {number} rssi      - WiFi signal strength (dBm)
 * @property {string} status    - 'online' | 'offline' | 'calibrating'
 * @property {number} lastSeen  - Unix timestamp (ms) of last data frame
 * @property {string} [name]    - Human-friendly name (from persistent state)
 * @property {Object} [meta]    - Extra metadata from the node (firmware version, etc.)
 */

export class DiscoveryService extends EventEmitter {
  /**
   * @param {Object} config       - config.discovery + config.sensing
   * @param {Function} loadState  - returns persistent state
   * @param {Function} saveState  - persists state to disk
   * @param {Object} logger       - pino logger instance
   */
  constructor(config, loadState, saveState, logger) {
    super();
    this.config = config;
    this.loadState = loadState;
    this.saveState = saveState;
    this.log = logger.child({ module: 'discovery' });

    /** @type {Map<string, NodeInfo>} */
    this.nodes = new Map();
    this._timer = null;
    this._sensingBaseUrl = config.sensing.baseUrl;
  }

  /** Start periodic discovery polling. */
  start() {
    this.log.info(
      { interval: this.config.discovery.intervalMs },
      'Starting node discovery'
    );
    // Run immediately, then on interval
    this._poll();
    this._timer = setInterval(
      () => this._poll(),
      this.config.discovery.intervalMs
    );
  }

  /** Stop polling. */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** Get all known nodes as a plain array. */
  getNodes() {
    return Array.from(this.nodes.values());
  }

  /** Get a single node by ID. */
  getNode(id) {
    return this.nodes.get(id) || null;
  }

  /** Update a node's human-friendly name (persisted). */
  setNodeName(id, name) {
    const node = this.nodes.get(id);
    if (node) {
      node.name = name;
      // Persist the name
      const state = this.loadState();
      if (!state.nodes) state.nodes = {};
      if (!state.nodes[id]) state.nodes[id] = {};
      state.nodes[id].name = name;
      this.saveState(state);
      this.emit('node:updated', node);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  async _poll() {
    try {
      const res = await fetch(`${this._sensingBaseUrl}/api/v1/sensing/latest`, {
        signal: AbortSignal.timeout(3000),
      });

      if (!res.ok) {
        this.log.warn({ status: res.status }, 'Sensing server returned error');
        return;
      }

      const data = await res.json();
      const now = Date.now();
      const state = this.loadState();
      const seenIds = new Set();

      // The /sensing/latest endpoint returns an array of node snapshots
      // Each has: node_id, ip, rssi, timestamp, ...
      const entries = Array.isArray(data) ? data : data.nodes || [];

      for (const entry of entries) {
        const id = entry.node_id || entry.mac || entry.id;
        if (!id) continue;
        seenIds.add(id);

        const existing = this.nodes.get(id);
        const persistedName = state.nodes?.[id]?.name;

        const node = {
          id,
          ip: entry.ip || entry.source_ip || '',
          rssi: entry.rssi ?? -999,
          status: 'online',
          lastSeen: now,
          name: persistedName || existing?.name || `Node ${this.nodes.size + 1}`,
          meta: entry.meta || existing?.meta || {},
        };

        if (!existing) {
          this.log.info({ id, ip: node.ip }, 'New node discovered');
          this.emit('node:discovered', node);
        }

        this.nodes.set(id, node);
      }

      // Mark nodes that haven't been seen as offline
      for (const [id, node] of this.nodes) {
        if (!seenIds.has(id) && node.status === 'online') {
          if (now - node.lastSeen > this.config.discovery.timeoutMs) {
            node.status = 'offline';
            this.log.info({ id }, 'Node went offline');
            this.emit('node:offline', node);
          }
        }
      }

      this.emit('discovery:complete', this.getNodes());
    } catch (err) {
      // Sensing server not ready yet — that's fine during boot
      if (err.name !== 'AbortError') {
        this.log.debug({ err: err.message }, 'Discovery poll failed');
      }
    }
  }
}
