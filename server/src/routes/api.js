// ==============================================================================
// HeartBeatz REST API Routes
// ==============================================================================
// Mounts all REST endpoints for the HeartBeatz demo box. These are consumed
// by the touchscreen UI and can also be used for external integrations.
//
// Endpoint overview:
//   GET  /api/health              - Server + subsystem health check
//   GET  /api/nodes               - List discovered ESP32 nodes
//   PUT  /api/nodes/:id/name      - Rename a node
//   GET  /api/beacons             - List BLE beacons in range
//   PUT  /api/beacons/:mac        - Set beacon identity (name, role)
//   GET  /api/radar               - Latest LD2410S radar reading
//   GET  /api/status              - Full system status snapshot
//   POST /api/calibrate           - Start room calibration
//   GET  /api/config              - Get current config (non-sensitive)
//   GET  /api/sensing/*           - Proxy to upstream RuView sensing server

import { Router } from 'express';
import { existsSync, writeFileSync, readFileSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { asyncHandler } from '../middleware/error-handler.js';

const __apiDirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__apiDirname, '..', '..', 'data');
const FLOORPLAN_PATH = join(DATA_DIR, 'floorplan.png');

/**
 * Create API router with injected services.
 * @param {Object} services
 * @param {Object} services.config
 * @param {import('../discovery.js').DiscoveryService} services.discovery
 * @param {import('../ble-scanner.js').BleScanner} services.ble
 * @param {import('../radar.js').RadarService} services.radar
 * @param {Function} services.loadState
 * @param {Function} services.saveState
 * @param {Object} services.logger
 */
export function createApiRouter(services) {
  const { config, discovery, ble, radar, simulator, demoMode, loadState, saveState, logger } = services;
  const log = logger.child({ module: 'api' });
  const router = Router();

  // -------------------------------------------------------------------------
  // Health check
  // -------------------------------------------------------------------------
  router.get('/health', asyncHandler(async (_req, res) => {
    // Check upstream sensing server
    let sensingOk = false;
    try {
      const r = await fetch(`${config.sensing.baseUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      sensingOk = r.ok;
    } catch { /* not ready */ }

    const state = loadState();
    res.json({
      status: demoMode ? 'demo' : (sensingOk ? 'healthy' : 'degraded'),
      uptime: process.uptime(),
      demoMode,
      services: {
        sensing: demoMode ? 'simulated' : (sensingOk ? 'up' : 'down'),
        ble: demoMode ? 'simulated' : (ble.isAvailable ? 'up' : 'disabled'),
        radar: demoMode ? 'simulated' : (radar.isAvailable ? 'up' : 'disabled'),
        discovery: discovery.getNodes().length > 0 ? 'active' : 'waiting',
      },
      nodes: discovery.getNodes().length,
      firstRunComplete: demoMode ? true : (state.firstRunComplete || false),
    });
  }));

  // -------------------------------------------------------------------------
  // Node management
  // -------------------------------------------------------------------------
  router.get('/nodes', (_req, res) => {
    res.json({ nodes: discovery.getNodes() });
  });

  router.put('/nodes/:id/name', (req, res) => {
    const { id } = req.params;
    const { name } = req.body;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required' });
    }
    discovery.setNodeName(id, name.trim());
    res.json({ ok: true, node: discovery.getNode(id) });
  });

  // ── Node position (for room map layout) ──

  /** PUT /api/nodes/:id/position — Save node's x,y position on the room map */
  router.put('/nodes/:id/position', (req, res) => {
    const { id } = req.params;
    const { x, y } = req.body;
    if (typeof x !== 'number' || typeof y !== 'number') {
      return res.status(400).json({ error: 'x and y (0-1 normalized) are required' });
    }
    // Clamp to 0-1 range (normalized room coordinates)
    const nx = Math.max(0, Math.min(1, x));
    const ny = Math.max(0, Math.min(1, y));

    // Persist the position in state.json
    const state = loadState();
    if (!state.nodes) state.nodes = {};
    if (!state.nodes[id]) state.nodes[id] = {};
    state.nodes[id].position = { x: nx, y: ny };
    saveState(state);

    log.info({ id, x: nx, y: ny }, 'Node position updated');
    res.json({ ok: true, position: { x: nx, y: ny } });
  });

  /** GET /api/room-layout — All node positions + room config */
  router.get('/room-layout', (_req, res) => {
    const state = loadState();
    const nodes = discovery.getNodes();

    // Merge persisted positions into live node data
    const layout = nodes.map((node) => {
      const persisted = state.nodes?.[node.id];
      return {
        id: node.id,
        name: node.name,
        status: node.status,
        rssi: node.rssi,
        position: persisted?.position || null,
      };
    });

    res.json({
      nodes: layout,
      room: {
        width: config.display.width,
        height: config.display.height,
      },
    });
  });

  // -------------------------------------------------------------------------
  // BLE beacons
  // -------------------------------------------------------------------------
  router.get('/beacons', (_req, res) => {
    res.json({
      beacons: ble.getBeacons(),
      available: ble.isAvailable,
    });
  });

  router.put('/beacons/:mac', (req, res) => {
    const { mac } = req.params;
    const { name, role } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    ble.setBeaconIdentity(mac, name, role || 'unknown');
    res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Radar
  // -------------------------------------------------------------------------
  router.get('/radar', (_req, res) => {
    res.json({
      reading: radar.lastReading,
      available: radar.isAvailable,
    });
  });

  // -------------------------------------------------------------------------
  // Full status snapshot (used by UI splash screen)
  // -------------------------------------------------------------------------
  router.get('/status', asyncHandler(async (_req, res) => {
    let sensingOk = false;
    try {
      const r = await fetch(`${config.sensing.baseUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      sensingOk = r.ok;
    } catch { /* */ }

    const state = loadState();
    const statusPayload = {
      sensing: demoMode ? true : sensingOk,
      demoMode,
      nodes: discovery.getNodes(),
      beacons: ble.getBeacons(),
      radar: radar.lastReading,
      firstRunComplete: demoMode ? true : state.firstRunComplete,
      calibration: demoMode ? { status: 'complete' } : state.calibration,
    };
    if (demoMode && simulator) {
      statusPayload.demo = simulator.getStatus();
    }
    res.json(statusPayload);
  }));

  // -------------------------------------------------------------------------
  // Calibration
  // -------------------------------------------------------------------------
  router.post('/calibrate', (_req, res) => {
    const state = loadState();
    state.calibration = {
      startedAt: Date.now(),
      status: 'in_progress',
      nodeCount: discovery.getNodes().filter((n) => n.status === 'online').length,
    };
    saveState(state);
    log.info('Room calibration started');

    // In a real implementation, this would tell the sensing server to capture
    // a baseline CSI fingerprint for the empty room. For the demo, we simulate
    // a 10-second calibration period.
    setTimeout(() => {
      const s = loadState();
      if (s.calibration?.status === 'in_progress') {
        s.calibration.status = 'complete';
        s.calibration.completedAt = Date.now();
        s.firstRunComplete = true;
        saveState(s);
        log.info('Room calibration complete');
      }
    }, 10_000);

    res.json({ ok: true, message: 'Calibration started (10s)' });
  });

  // -------------------------------------------------------------------------
  // Config (non-sensitive subset)
  // -------------------------------------------------------------------------
  router.get('/config', (_req, res) => {
    res.json({
      display: config.display,
      sensing: {
        source: config.sensing.source,
        tickMs: config.sensing.tickMs,
      },
      ble: { enabled: config.ble.enabled },
      radar: { enabled: config.radar.enabled },
      discovery: { intervalMs: config.discovery.intervalMs },
    });
  });

  // -------------------------------------------------------------------------
  // Demo Mode Control (only available when simulator is active)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Tracking History (person movement trails for room map)
  // -------------------------------------------------------------------------
  router.get('/tracking/history', (_req, res) => {
    if (demoMode && simulator) {
      const limit = parseInt(_req.query.limit, 10) || 100;
      res.json({ history: simulator.getTrackingHistory(limit) });
    } else {
      // Real mode: tracking history would come from the sensing server
      res.json({ history: [] });
    }
  });

  // -------------------------------------------------------------------------
  // Demo Mode Control (only available when simulator is active)
  // -------------------------------------------------------------------------

  /** GET /api/demo — Current demo status, scenario info, available scenarios */
  router.get('/demo', (_req, res) => {
    if (!demoMode || !simulator) {
      return res.json({ demoMode: false });
    }
    res.json({
      demoMode: true,
      ...simulator.getStatus(),
      scenarios: simulator.getScenarios(),
      vitals: simulator.lastVitals,
    });
  });

  /** PUT /api/demo/scenario — Switch the active scenario */
  router.put('/demo/scenario', (req, res) => {
    if (!demoMode || !simulator) {
      return res.status(400).json({ error: 'Demo mode not active' });
    }
    const { scenarioId } = req.body;
    if (!scenarioId) {
      return res.status(400).json({ error: 'scenarioId is required' });
    }
    const ok = simulator.setScenario(scenarioId);
    if (!ok) {
      return res.status(404).json({ error: `Unknown scenario: ${scenarioId}` });
    }
    log.info({ scenario: scenarioId }, 'Demo scenario switched via API');
    res.json({ ok: true, ...simulator.getStatus() });
  });

  // -------------------------------------------------------------------------
  // Floor Plan Upload & Room Configuration
  // -------------------------------------------------------------------------

  /** POST /api/floorplan — Upload a floor plan image (accepts base64 JSON or raw binary) */
  router.post('/floorplan', asyncHandler(async (req, res) => {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

    let buffer;
    const ct = req.headers['content-type'] || '';

    if (ct.includes('application/json')) {
      // Base64-encoded image in JSON body: { image: "data:image/png;base64,..." }
      const { image } = req.body;
      if (!image) return res.status(400).json({ error: 'image field required' });
      const match = image.match(/^data:image\/\w+;base64,(.+)$/);
      if (!match) return res.status(400).json({ error: 'Invalid data URL format' });
      buffer = Buffer.from(match[1], 'base64');
    } else {
      // Raw binary upload
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      buffer = Buffer.concat(chunks);
    }

    if (buffer.length < 100) return res.status(400).json({ error: 'Image too small' });
    if (buffer.length > 10 * 1024 * 1024) return res.status(413).json({ error: 'Image too large (max 10MB)' });

    writeFileSync(FLOORPLAN_PATH, buffer);
    log.info({ size: buffer.length }, 'Floor plan image saved');
    res.json({ ok: true, size: buffer.length });
  }));

  /** GET /api/floorplan — Serve the stored floor plan image */
  router.get('/floorplan', (_req, res) => {
    if (!existsSync(FLOORPLAN_PATH)) {
      return res.status(404).json({ error: 'No floor plan uploaded' });
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(readFileSync(FLOORPLAN_PATH));
  });

  /** DELETE /api/floorplan — Remove the stored floor plan */
  router.delete('/floorplan', (_req, res) => {
    if (existsSync(FLOORPLAN_PATH)) {
      try { unlinkSync(FLOORPLAN_PATH); } catch { /* ignore */ }
    }
    // Also clear room config
    const state = loadState();
    delete state.roomConfig;
    saveState(state);
    res.json({ ok: true });
  });

  /** POST /api/room-config — Save room outline polygon + floor plan transform */
  router.post('/room-config', (req, res) => {
    const { outline, floorplanScale, floorplanOffset, floorplanSize } = req.body;

    const state = loadState();
    state.roomConfig = {
      outline: outline || [],              // [{x, y}, ...] normalized 0-1
      floorplanScale: floorplanScale || 1,
      floorplanOffset: floorplanOffset || { x: 0, y: 0 },
      floorplanSize: floorplanSize || null, // { width, height } of original image
      updatedAt: new Date().toISOString(),
    };
    saveState(state);

    log.info({ vertices: (outline || []).length }, 'Room config saved');
    res.json({ ok: true, roomConfig: state.roomConfig });
  });

  /** GET /api/room-config — Get room outline and floor plan metadata */
  router.get('/room-config', (_req, res) => {
    const state = loadState();
    res.json({
      roomConfig: state.roomConfig || null,
      hasFloorplan: existsSync(FLOORPLAN_PATH),
    });
  });

  // -------------------------------------------------------------------------
  // Sensing server proxy (pass-through to upstream RuView)
  // -------------------------------------------------------------------------
  router.all('/sensing/*', asyncHandler(async (req, res) => {
    const upstreamPath = req.path.replace('/sensing', '');
    const url = `${config.sensing.baseUrl}/api/v1${upstreamPath}`;

    try {
      const upstreamRes = await fetch(url, {
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: ['POST', 'PUT', 'PATCH'].includes(req.method)
          ? JSON.stringify(req.body)
          : undefined,
        signal: AbortSignal.timeout(5000),
      });

      const data = await upstreamRes.json();
      res.status(upstreamRes.status).json(data);
    } catch (err) {
      res.status(502).json({ error: 'Sensing server unavailable', detail: err.message });
    }
  }));

  return router;
}
