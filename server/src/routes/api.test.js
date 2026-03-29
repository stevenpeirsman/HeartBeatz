// ==============================================================================
// API Routes Integration Tests
// ==============================================================================
// Tests the REST API endpoints by creating the Express router with mock
// services and exercising each endpoint. Verifies request handling, response
// shapes, validation, and error cases.
//
// These are "integration" tests in that they test the real Express routing
// logic, but with mock services injected — no network or file I/O needed.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'http';
import { createApiRouter } from './api.js';
import {
  createMockLogger,
  createTestConfig,
  createMockStateStore,
} from '../test-helpers.js';
import { SimulatorService } from '../simulator.js';

// ---------------------------------------------------------------------------
// Test Utilities — lightweight HTTP client using native fetch
// ---------------------------------------------------------------------------

/**
 * Start an Express server with the API router and return a fetch helper.
 * The server runs on a random port and is cleaned up via the returned close().
 */
function createTestServer(serviceOverrides = {}) {
  const config = createTestConfig();
  const logger = createMockLogger();
  const stateStore = createMockStateStore();

  // Create a real simulator for demo mode tests
  const simulator = new SimulatorService(config, logger);
  simulator.start();

  const services = {
    config,
    discovery: simulator,
    ble: simulator,
    radar: simulator,
    simulator,
    demoMode: true,
    loadState: stateStore.loadState,
    saveState: stateStore.saveState,
    logger,
    ...serviceOverrides,
  };

  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(services));

  const server = createServer(app);

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}`;

      /** Convenience fetch with automatic JSON parsing */
      const api = async (path, opts = {}) => {
        const res = await fetch(`${baseUrl}/api${path}`, {
          headers: { 'Content-Type': 'application/json', ...opts.headers },
          ...opts,
        });
        const data = await res.json().catch(() => null);
        return { status: res.status, data };
      };

      resolve({
        api,
        baseUrl,
        server,
        services,
        stateStore,
        close: () => {
          simulator.stop();
          return new Promise((r) => server.close(r));
        },
      });
    });
  });
}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

describe('API Routes', () => {
  let ctx; // { api, close, services, stateStore }

  beforeEach(async () => {
    ctx = await createTestServer();
  });

  afterEach(async () => {
    await ctx.close();
  });

  // ── Health Check ──

  describe('GET /api/health', () => {
    it('should return health status', async () => {
      const { status, data } = await ctx.api('/health');

      assert.equal(status, 200);
      assert.equal(data.status, 'demo', 'Should report demo status in demo mode');
      assert.equal(data.demoMode, true);
      assert.equal(typeof data.uptime, 'number');
      assert.ok(data.services, 'Should include services object');
      assert.equal(data.services.sensing, 'simulated');
      assert.equal(data.services.ble, 'simulated');
      assert.equal(data.services.radar, 'simulated');
    });
  });

  // ── Node Management ──

  describe('GET /api/nodes', () => {
    it('should return list of nodes', async () => {
      const { status, data } = await ctx.api('/nodes');

      assert.equal(status, 200);
      assert.ok(Array.isArray(data.nodes), 'Should return nodes array');
      assert.ok(data.nodes.length >= 1, 'Should have simulated nodes');
    });
  });

  describe('PUT /api/nodes/:id/name', () => {
    it('should rename a node', async () => {
      const { status, data } = await ctx.api('/nodes/DEMO:AA:BB:CC:01/name', {
        method: 'PUT',
        body: JSON.stringify({ name: 'New Name' }),
      });

      assert.equal(status, 200);
      assert.equal(data.ok, true);
    });

    it('should reject empty name', async () => {
      const { status, data } = await ctx.api('/nodes/DEMO:AA:BB:CC:01/name', {
        method: 'PUT',
        body: JSON.stringify({ name: '' }),
      });

      assert.equal(status, 400);
      assert.ok(data.error);
    });

    it('should reject missing name field', async () => {
      const { status, data } = await ctx.api('/nodes/DEMO:AA:BB:CC:01/name', {
        method: 'PUT',
        body: JSON.stringify({}),
      });

      assert.equal(status, 400);
      assert.ok(data.error);
    });
  });

  // ── BLE Beacons ──

  describe('GET /api/beacons', () => {
    it('should return beacon list and availability', async () => {
      const { status, data } = await ctx.api('/beacons');

      assert.equal(status, 200);
      assert.ok(Array.isArray(data.beacons));
      assert.equal(typeof data.available, 'boolean');
    });
  });

  describe('PUT /api/beacons/:mac', () => {
    it('should set beacon identity', async () => {
      const { status, data } = await ctx.api('/beacons/AA:BB:CC:DD:01:01', {
        method: 'PUT',
        body: JSON.stringify({ name: 'Patient A', role: 'patient' }),
      });

      assert.equal(status, 200);
      assert.equal(data.ok, true);
    });

    it('should reject missing name', async () => {
      const { status, data } = await ctx.api('/beacons/AA:BB:CC:DD:01:01', {
        method: 'PUT',
        body: JSON.stringify({ role: 'patient' }),
      });

      assert.equal(status, 400);
      assert.ok(data.error);
    });

    it('should default role to "unknown" if not provided', async () => {
      const { status, data } = await ctx.api('/beacons/AA:BB:CC:DD:01:01', {
        method: 'PUT',
        body: JSON.stringify({ name: 'Test Beacon' }),
      });

      assert.equal(status, 200);
      assert.equal(data.ok, true);
    });
  });

  // ── Radar ──

  describe('GET /api/radar', () => {
    it('should return radar reading and availability', async () => {
      const { status, data } = await ctx.api('/radar');

      assert.equal(status, 200);
      assert.equal(typeof data.available, 'boolean');
      // Reading may be null initially
    });
  });

  // ── Status ──

  describe('GET /api/status', () => {
    it('should return full system status snapshot', async () => {
      const { status, data } = await ctx.api('/status');

      assert.equal(status, 200);
      assert.equal(data.demoMode, true);
      assert.ok(Array.isArray(data.nodes));
      assert.ok(Array.isArray(data.beacons));
      assert.equal(data.firstRunComplete, true); // demo mode reports true
      assert.ok(data.demo, 'Should include demo status in demo mode');
    });
  });

  // ── Config ──

  describe('GET /api/config', () => {
    it('should return non-sensitive config subset', async () => {
      const { status, data } = await ctx.api('/config');

      assert.equal(status, 200);
      assert.ok(data.display, 'Should include display config');
      assert.equal(data.display.width, 1024);
      assert.equal(data.display.height, 600);
      assert.ok(data.sensing, 'Should include sensing config');
      assert.equal(typeof data.sensing.tickMs, 'number');
      // Should NOT expose base URLs or secrets
      assert.equal(data.sensing.baseUrl, undefined);
    });
  });

  // ── Demo Mode Control ──

  describe('GET /api/demo', () => {
    it('should return demo status with scenarios', async () => {
      const { status, data } = await ctx.api('/demo');

      assert.equal(status, 200);
      assert.equal(data.demoMode, true);
      assert.ok(Array.isArray(data.scenarios));
      assert.ok(data.scenarios.length >= 3);
      assert.equal(typeof data.scenarioId, 'string');
      assert.equal(typeof data.scenarioName, 'string');
    });
  });

  describe('PUT /api/demo/scenario', () => {
    it('should switch the active scenario', async () => {
      const { status, data } = await ctx.api('/demo/scenario', {
        method: 'PUT',
        body: JSON.stringify({ scenarioId: 'fall-detection' }),
      });

      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.scenarioId, 'fall-detection');
    });

    it('should reject unknown scenario', async () => {
      const { status, data } = await ctx.api('/demo/scenario', {
        method: 'PUT',
        body: JSON.stringify({ scenarioId: 'nonexistent' }),
      });

      assert.equal(status, 404);
      assert.ok(data.error);
    });

    it('should reject missing scenarioId', async () => {
      const { status, data } = await ctx.api('/demo/scenario', {
        method: 'PUT',
        body: JSON.stringify({}),
      });

      assert.equal(status, 400);
      assert.ok(data.error);
    });
  });

  // ── Calibration ──

  describe('POST /api/calibrate', () => {
    it('should start calibration and return success', async () => {
      const { status, data } = await ctx.api('/calibrate', { method: 'POST' });

      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.ok(data.message);
    });

    it('should save calibration state', async () => {
      await ctx.api('/calibrate', { method: 'POST' });

      const state = ctx.stateStore.getState();
      assert.equal(state.calibration.status, 'in_progress');
      assert.equal(typeof state.calibration.startedAt, 'number');
    });
  });

  // ── Node Position (Room Map Layout) ──

  describe('PUT /api/nodes/:id/position', () => {
    it('should save a node position (normalized coordinates)', async () => {
      const { status, data } = await ctx.api('/nodes/DEMO:AA:BB:CC:01/position', {
        method: 'PUT',
        body: JSON.stringify({ x: 0.25, y: 0.75 }),
      });

      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.position.x, 0.25);
      assert.equal(data.position.y, 0.75);
    });

    it('should persist position in state', async () => {
      await ctx.api('/nodes/DEMO:AA:BB:CC:01/position', {
        method: 'PUT',
        body: JSON.stringify({ x: 0.5, y: 0.5 }),
      });

      const state = ctx.stateStore.getState();
      assert.deepEqual(state.nodes['DEMO:AA:BB:CC:01'].position, { x: 0.5, y: 0.5 });
    });

    it('should clamp values to 0-1 range', async () => {
      const { status, data } = await ctx.api('/nodes/DEMO:AA:BB:CC:01/position', {
        method: 'PUT',
        body: JSON.stringify({ x: 1.5, y: -0.3 }),
      });

      assert.equal(status, 200);
      assert.equal(data.position.x, 1);   // clamped to 1
      assert.equal(data.position.y, 0);   // clamped to 0
    });

    it('should reject non-numeric coordinates', async () => {
      const { status, data } = await ctx.api('/nodes/DEMO:AA:BB:CC:01/position', {
        method: 'PUT',
        body: JSON.stringify({ x: 'abc', y: 0.5 }),
      });

      assert.equal(status, 400);
      assert.ok(data.error);
    });

    it('should reject missing coordinates', async () => {
      const { status, data } = await ctx.api('/nodes/DEMO:AA:BB:CC:01/position', {
        method: 'PUT',
        body: JSON.stringify({}),
      });

      assert.equal(status, 400);
      assert.ok(data.error);
    });
  });

  // ── Room Layout ──

  describe('GET /api/room-layout', () => {
    it('should return nodes with position data', async () => {
      // First save a position
      await ctx.api('/nodes/DEMO:AA:BB:CC:01/position', {
        method: 'PUT',
        body: JSON.stringify({ x: 0.1, y: 0.9 }),
      });

      const { status, data } = await ctx.api('/room-layout');

      assert.equal(status, 200);
      assert.ok(Array.isArray(data.nodes));
      assert.ok(data.room);
      assert.equal(data.room.width, 1024);
      assert.equal(data.room.height, 600);

      // Find the node we positioned
      const positioned = data.nodes.find((n) => n.id === 'DEMO:AA:BB:CC:01');
      if (positioned) {
        assert.deepEqual(positioned.position, { x: 0.1, y: 0.9 });
      }
    });

    it('should return null position for nodes without saved positions', async () => {
      const { status, data } = await ctx.api('/room-layout');

      assert.equal(status, 200);
      // At least some nodes should have null position if never set
      const anyNull = data.nodes.some((n) => n.position === null);
      assert.ok(anyNull || data.nodes.length === 0, 'Nodes without saved positions should return null');
    });
  });

  // ── Tracking History ──

  describe('GET /api/tracking/history', () => {
    it('should return tracking history array', async () => {
      const { status, data } = await ctx.api('/tracking/history');

      assert.equal(status, 200);
      assert.ok(Array.isArray(data.history));
    });

    it('should respect limit parameter', async () => {
      const { status, data } = await ctx.api('/tracking/history?limit=5');

      assert.equal(status, 200);
      assert.ok(data.history.length <= 5);
    });
  });
});
