// ==============================================================================
// HeartBeatz Server — Main Entry Point
// ==============================================================================
// Orchestration layer for the HeartBeatz portable demo box. Starts all
// subsystems and serves the unified API + UI to the kiosk touchscreen.
//
// Architecture:
//   ┌─────────────────────────────────────────────────────────┐
//   │  HeartBeatz Server (this process, :8080)                │
//   │  ├── Express: REST API + static UI                      │
//   │  ├── WS Hub: enriched real-time stream to UI            │
//   │  ├── Discovery: polls sensing server for ESP32 nodes    │
//   │  ├── BLE Scanner: iBeacon wristband tracking            │
//   │  └── Radar: LD2410S mmWave presence reader              │
//   └──────────────────────┬──────────────────────────────────┘
//                          │ proxy + WS
//   ┌──────────────────────▼──────────────────────────────────┐
//   │  RuView Sensing Server (Docker, :3000/:3001/:5005)      │
//   │  ├── CSI signal processing pipeline                     │
//   │  ├── REST API (40+ endpoints)                           │
//   │  └── WebSocket real-time stream                         │
//   └─────────────────────────────────────────────────────────┘

import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import pino from 'pino';

import { loadConfig, loadState, saveState } from './config.js';
import { DiscoveryService } from './discovery.js';
import { BleScanner } from './ble-scanner.js';
import { RadarService } from './radar.js';
import { SimulatorService } from './simulator.js';
import { HealthMonitor } from './health-monitor.js';
import { OtaManager } from './ota-manager.js';
import { WsHub } from './websocket.js';
import { createApiRouter } from './routes/api.js';
import { createOtaRouter } from './routes/ota.js';
import {
  requestIdMiddleware,
  notFoundHandler,
  errorHandler,
} from './middleware/error-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main() {
  // Load config from .env
  const config = loadConfig();

  // Logger
  const logger = pino({
    level: config.logLevel,
    transport:
      config.nodeEnv === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  });

  logger.info('=== HeartBeatz Server Starting ===');
  logger.info({ port: config.port, env: config.nodeEnv, csiSource: config.sensing.source });

  // --- Determine demo mode ---
  // 'true' → always simulate, 'auto' → simulate if sensing server unreachable, 'false' → never
  let demoMode = config.demo.mode === 'true';

  if (config.demo.mode === 'auto') {
    try {
      const probe = await fetch(`${config.sensing.baseUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      demoMode = !probe.ok;
    } catch {
      demoMode = true;
    }
    logger.info({ demoMode }, 'Auto-detected demo mode (sensing server probe)');
  }

  // --- Initialize subsystems (real or simulated) ---
  let discovery, bleScanner, radar, simulator;

  if (demoMode) {
    logger.info('🎬 Starting in DEMO MODE — all data is simulated');
    simulator = new SimulatorService(config, logger);
    // The simulator implements the same interfaces as the real services,
    // so downstream code (WsHub, API routes) works without changes.
    discovery = simulator;   // Same getNodes(), getNode(), setNodeName() API
    bleScanner = simulator;  // Same getBeacons(), setBeaconIdentity() API
    radar = simulator;       // Same lastReading, isAvailable API
  } else {
    discovery = new DiscoveryService(config, loadState, saveState, logger);
    bleScanner = new BleScanner(config, loadState, saveState, logger);
    radar = new RadarService(config, logger);
    simulator = null;
  }

  // --- OTA Firmware Update Manager ---
  const otaManager = new OtaManager(config, loadState, saveState, logger);
  await otaManager.init();

  // --- Express app ---
  const app = express();
  app.use(express.json());

  // Request ID for log correlation (every request gets a unique ID)
  app.use(requestIdMiddleware);

  // CORS for development
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Request-Id');
    if (_req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Request logging (with request ID for correlation)
  app.use((req, _res, next) => {
    if (req.path !== '/api/health' && req.path !== '/api/status') {
      logger.debug({ method: req.method, path: req.path, requestId: req.id });
    }
    next();
  });

  // --- Mount API routes ---
  const services = {
    config, discovery, ble: bleScanner, radar, simulator,
    demoMode, loadState, saveState, logger,
  };
  app.use('/api', createApiRouter(services));

  // --- Mount OTA firmware routes (raw body for binary uploads) ---
  app.use('/api/firmware', createOtaRouter({
    otaManager, discovery, logger,
  }));

  // --- 404 handler for unknown API routes ---
  app.use('/api', notFoundHandler);

  // --- Global error handler (must be last middleware) ---
  app.use(errorHandler(logger));

  // --- Serve static UI ---
  const uiPath = join(__dirname, '..', '..', 'ui');
  app.use(express.static(uiPath));

  // SPA fallback: serve index.html for any non-API, non-file route
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
    res.sendFile(join(uiPath, 'index.html'));
  });

  // --- HTTP + WebSocket server ---
  const server = createServer(app);

  const wsHub = new WsHub({
    config,
    discovery,
    bleScanner,
    radar,
    simulator,
    demoMode,
    logger,
    server,
  });

  // --- Health Monitor (watches all subsystems, auto-recovers) ---
  const healthMonitor = new HealthMonitor({
    config, discovery, ble: bleScanner, radar, simulator, demoMode, logger,
  });

  // Forward health changes to WS hub for UI display
  healthMonitor.on('health:changed', (health) => {
    wsHub._broadcast({ type: 'health', health });
  });

  // Forward OTA events to WS hub for real-time UI progress
  otaManager.on('firmware:uploaded', (meta) => {
    wsHub._broadcast({ type: 'ota:firmware', firmware: meta });
  });
  otaManager.on('ota:started', (data) => {
    wsHub._broadcast({ type: 'ota:started', ...data });
  });
  otaManager.on('ota:progress', (data) => {
    wsHub._broadcast({ type: 'ota:progress', ...data });
  });
  otaManager.on('ota:complete', (data) => {
    wsHub._broadcast({ type: 'ota:complete', ...data });
  });

  // --- Start everything ---
  if (demoMode) {
    simulator.start();
    simulator.setScenario(config.demo.scenario);
  } else {
    await radar.start();
    await bleScanner.start();
    discovery.start();
  }
  wsHub.start();
  healthMonitor.start();

  server.listen(config.port, '0.0.0.0', () => {
    logger.info(`HeartBeatz server listening on http://0.0.0.0:${config.port}`);
    logger.info(`UI available at http://localhost:${config.port}`);
    logger.info(`API available at http://localhost:${config.port}/api/health`);
  });

  // --- Graceful shutdown ---
  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutting down...');
    healthMonitor.stop();
    if (simulator) {
      simulator.stop();
    } else {
      discovery.stop();
      bleScanner.stop();
      radar.stop();
    }
    wsHub.stop();
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
    // Force exit after 5s
    setTimeout(() => process.exit(1), 5000);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
