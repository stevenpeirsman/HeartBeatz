// ==============================================================================
// WebSocket Aggregation Hub
// ==============================================================================
// Connects to the upstream RuView sensing server's WebSocket and enriches
// the data stream with HeartBeatz-specific context (node names, BLE beacon
// correlations, radar readings). Broadcasts the enriched stream to all
// connected UI clients.
//
// Data flow:
//   ESP32 nodes → UDP → Sensing Server → WS → [this hub] → WS → UI clients
//                               ↑                ↑
//                           radar data      BLE sightings

import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';

export class WsHub extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {Object} opts.config         - Full config
   * @param {Object} opts.discovery      - DiscoveryService instance
   * @param {Object} opts.bleScanner     - BleScanner instance (may be disabled)
   * @param {Object} opts.radar          - RadarService instance (may be disabled)
   * @param {Object} opts.logger         - Pino logger
   * @param {import('http').Server} opts.server - HTTP server to attach WS to
   */
  /**
   * @param {Object} opts
   * @param {Object} opts.config         - Full config
   * @param {Object} opts.discovery      - DiscoveryService or SimulatorService
   * @param {Object} opts.bleScanner     - BleScanner or SimulatorService (may be disabled)
   * @param {Object} opts.radar          - RadarService or SimulatorService (may be disabled)
   * @param {Object} [opts.simulator]    - SimulatorService instance (if demo mode)
   * @param {boolean} opts.demoMode      - Whether running in demo mode
   * @param {Object} opts.logger         - Pino logger
   * @param {import('http').Server} opts.server - HTTP server to attach WS to
   */
  constructor({ config, discovery, bleScanner, radar, simulator, demoMode, logger, server }) {
    super();
    this.config = config;
    this.discovery = discovery;
    this.ble = bleScanner;
    this.radar = radar;
    this.simulator = simulator || null;
    this.demoMode = demoMode || false;
    this.log = logger.child({ module: 'ws-hub' });

    // WebSocket server for UI clients (attached to the Express HTTP server)
    this.wss = new WebSocketServer({ server, path: '/ws/live' });
    this._upstreamWs = null;
    this._reconnectTimer = null;
    this._clientCount = 0;
  }

  /** Start: connect to upstream WS and accept UI client connections. */
  start() {
    // Accept UI client connections
    this.wss.on('connection', (ws, req) => {
      this._clientCount++;
      this.log.info({ clients: this._clientCount }, 'UI client connected');

      // Send initial state snapshot (includes demo mode + health status)
      const snapshot = {
        type: 'snapshot',
        nodes: this.discovery.getNodes(),
        beacons: this.ble.getBeacons(),
        radar: this.radar.lastReading,
        demoMode: this.demoMode,
        serverVersion: '0.1.0',
      };
      if (this.demoMode && this.simulator) {
        snapshot.demo = this.simulator.getStatus();
      }
      try {
        ws.send(JSON.stringify(snapshot));
      } catch (err) {
        this.log.warn({ err: err.message }, 'Failed to send snapshot to client');
      }

      ws.on('close', () => {
        this._clientCount--;
        this.log.info({ clients: this._clientCount }, 'UI client disconnected');
      });

      ws.on('message', (msg) => {
        this._handleClientMessage(ws, msg);
      });
    });

    // Connect to upstream RuView sensing server WS (skip in demo mode)
    if (this.demoMode && this.simulator) {
      // In demo mode, forward simulator sensing frames to UI clients
      this.simulator.on('sensing:frame', (frame) => {
        this._broadcast(frame);
      });
      // Forward scenario/phase change events so the UI can show labels
      this.simulator.on('phase:changed', (status) => {
        this._broadcast({ type: 'demo:phase', ...status });
      });
      this.simulator.on('scenario:changed', (status) => {
        this._broadcast({ type: 'demo:scenario', ...status });
      });
      this.log.info('Demo mode: simulator sensing frames wired to WS hub');
    } else {
      this._connectUpstream();
    }

    // Forward discovery events to all UI clients
    this.discovery.on('node:discovered', (node) => {
      this._broadcast({ type: 'node:discovered', node });
    });
    this.discovery.on('node:offline', (node) => {
      this._broadcast({ type: 'node:offline', node });
    });
    this.discovery.on('discovery:complete', (nodes) => {
      this._broadcast({ type: 'nodes', nodes });
    });

    // Forward BLE events
    this.ble.on('beacon:sighting', (beacon) => {
      this._broadcast({ type: 'beacon', beacon });
    });
    this.ble.on('beacon:discovered', (beacon) => {
      this._broadcast({ type: 'beacon:discovered', beacon });
    });
    this.ble.on('beacon:lost', (beacon) => {
      this._broadcast({ type: 'beacon:lost', beacon });
    });

    // Forward radar readings (throttled to ~5Hz for UI)
    let lastRadarBroadcast = 0;
    this.radar.on('reading', (reading) => {
      const now = Date.now();
      if (now - lastRadarBroadcast > 200) {
        this._broadcast({ type: 'radar', reading });
        lastRadarBroadcast = now;
      }
    });

    this.log.info('WebSocket hub started');
  }

  /** Stop all connections. */
  stop() {
    this._upstreamWs?.close();
    this.wss.close();
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
  }

  // ---------------------------------------------------------------------------
  // Upstream connection (to RuView sensing server)
  // ---------------------------------------------------------------------------

  _connectUpstream() {
    const url = `${this.config.sensing.wsUrl}/ws/sensing`;
    this.log.info({ url }, 'Connecting to upstream sensing WS');

    try {
      this._upstreamWs = new WebSocket(url);

      this._upstreamWs.on('open', () => {
        this.log.info('Upstream WS connected');
        this.emit('upstream:connected');
      });

      this._upstreamWs.on('message', (data) => {
        // Enrich and forward to UI clients
        try {
          const frame = JSON.parse(data.toString());
          frame._enriched = true;
          frame._nodes = this.discovery.getNodes();
          this._broadcast({ type: 'sensing', data: frame });
        } catch {
          // Binary frame — forward as-is
          this._broadcastRaw(data);
        }
      });

      this._upstreamWs.on('close', () => {
        this.log.warn('Upstream WS disconnected — reconnecting in 3s');
        this._scheduleReconnect();
      });

      this._upstreamWs.on('error', (err) => {
        this.log.debug({ err: err.message }, 'Upstream WS error');
      });
    } catch (err) {
      this.log.warn({ err: err.message }, 'Failed to connect upstream');
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this._connectUpstream(), 3000);
  }

  // ---------------------------------------------------------------------------
  // Broadcasting to UI clients
  // ---------------------------------------------------------------------------

  _broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  _broadcastRaw(data) {
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Client message handling
  // ---------------------------------------------------------------------------

  _handleClientMessage(ws, msg) {
    try {
      const data = JSON.parse(msg.toString());

      switch (data.action) {
        case 'rename_node':
          this.discovery.setNodeName(data.nodeId, data.name);
          break;
        case 'set_beacon_identity':
          this.ble.setBeaconIdentity(data.mac, data.name, data.role);
          break;
        case 'start_calibration':
          this.emit('calibration:start');
          break;
        default:
          this.log.debug({ action: data.action }, 'Unknown client action');
      }
    } catch {
      // Ignore malformed messages
    }
  }
}
