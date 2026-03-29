// ==============================================================================
// WebSocket Hub Tests
// ==============================================================================
// Tests the WS aggregation hub that broadcasts enriched data to UI clients.
// Verifies client connection handling, initial snapshot delivery, message
// routing from simulator events, and client-to-server command handling.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import { WebSocket } from 'ws';
import { WsHub } from './websocket.js';
import { SimulatorService } from './simulator.js';
import { createMockLogger, createTestConfig, sleep } from './test-helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Connect a WS client and buffer all messages from the start.
 * Returns the client with a `messages` array and helper methods.
 * This ensures we never miss the snapshot due to listener timing.
 */
function connectAndBuffer(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.messages = [];       // All received messages in order
    ws._listeners = [];     // Pending waiters

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      ws.messages.push(msg);

      // Notify any pending waiters
      for (let i = ws._listeners.length - 1; i >= 0; i--) {
        if (ws._listeners[i](msg)) {
          ws._listeners.splice(i, 1);
        }
      }
    });

    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/**
 * Wait for a message of a given type.
 * First checks already-buffered messages, then waits for new ones.
 */
function waitForType(ws, type, timeoutMs = 5000) {
  // Check already-received messages
  const existing = ws.messages.find((m) => m.type === type);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = ws._listeners.indexOf(handler);
      if (idx >= 0) ws._listeners.splice(idx, 1);
      reject(new Error(`Timeout waiting for message type: ${type} (received: ${ws.messages.map(m => m.type).join(', ')})`));
    }, timeoutMs);

    const handler = (msg) => {
      if (msg.type === type) {
        clearTimeout(timer);
        resolve(msg);
        return true; // Remove from listeners
      }
      return false;
    };

    ws._listeners.push(handler);
  });
}

/** Cleanly close a WS client. */
function closeWs(ws) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === WebSocket.CLOSED) return resolve();
    ws.on('close', resolve);
    ws.close();
  });
}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

describe('WsHub', () => {
  let server;
  let simulator;
  let wsHub;
  let wsUrl;

  before(async () => {
    const config = createTestConfig({ sensing: { tickMs: 100 } });
    const logger = createMockLogger();
    simulator = new SimulatorService(config, logger);
    simulator.start();

    server = createServer();

    wsHub = new WsHub({
      config,
      discovery: simulator,
      bleScanner: simulator,
      radar: simulator,
      simulator,
      demoMode: true,
      logger,
      server,
    });

    wsHub.start();

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    const { port } = server.address();
    wsUrl = `ws://127.0.0.1:${port}/ws/live`;
  });

  after(async () => {
    simulator.stop();
    wsHub.stop();
    await new Promise((r) => server.close(r));
  });

  // ── Connection & Snapshot ──

  it('should accept WebSocket connections', async () => {
    const ws = await connectAndBuffer(wsUrl);
    assert.equal(ws.readyState, WebSocket.OPEN);
    await closeWs(ws);
  });

  it('should send snapshot message on connect', async () => {
    const ws = await connectAndBuffer(wsUrl);
    const snapshot = await waitForType(ws, 'snapshot');

    assert.ok(Array.isArray(snapshot.nodes), 'Snapshot should include nodes');
    assert.ok(Array.isArray(snapshot.beacons), 'Snapshot should include beacons');
    assert.equal(snapshot.demoMode, true);
    assert.ok(snapshot.demo, 'Should include demo status');

    await closeWs(ws);
  });

  it('should include simulated nodes in snapshot', async () => {
    const ws = await connectAndBuffer(wsUrl);
    const snapshot = await waitForType(ws, 'snapshot');

    assert.ok(snapshot.nodes.length >= 1, 'Should have simulated nodes');
    assert.equal(typeof snapshot.nodes[0].id, 'string');
    assert.equal(typeof snapshot.nodes[0].ip, 'string');

    await closeWs(ws);
  });

  // ── Data Broadcasting ──

  it('should broadcast sensing frames from simulator', async () => {
    const ws = await connectAndBuffer(wsUrl);
    await sleep(500); // Let some frames arrive

    const types = new Set(ws.messages.map((m) => m.type));
    assert.ok(types.has('sensing') || types.has('nodes'),
      `Should receive data frames, got: ${[...types].join(', ')}`);

    await closeWs(ws);
  });

  it('should broadcast to multiple clients', async () => {
    const ws1 = await connectAndBuffer(wsUrl);
    const ws2 = await connectAndBuffer(wsUrl);

    const snap1 = await waitForType(ws1, 'snapshot');
    const snap2 = await waitForType(ws2, 'snapshot');

    assert.equal(snap1.type, 'snapshot');
    assert.equal(snap2.type, 'snapshot');

    await closeWs(ws1);
    await closeWs(ws2);
  });

  // ── Client Commands ──

  it('should handle rename_node command via WS', async () => {
    const ws = await connectAndBuffer(wsUrl);
    await waitForType(ws, 'snapshot');

    ws.send(JSON.stringify({
      action: 'rename_node',
      nodeId: 'DEMO:AA:BB:CC:03',
      name: 'WS-Renamed-Test',
    }));

    await sleep(150);

    const nodes = simulator.getNodes();
    const renamed = nodes.find((n) => n.id === 'DEMO:AA:BB:CC:03');
    assert.equal(renamed?.name, 'WS-Renamed-Test');

    await closeWs(ws);
  });

  it('should handle malformed messages without crashing', async () => {
    const ws = await connectAndBuffer(wsUrl);
    await waitForType(ws, 'snapshot');

    // Send garbage — server should not crash
    ws.send('not valid json');
    ws.send(JSON.stringify({ action: 'unknown_action' }));
    ws.send('');

    await sleep(150);

    // Server still works
    const ws2 = await connectAndBuffer(wsUrl);
    const snap = await waitForType(ws2, 'snapshot');
    assert.equal(snap.type, 'snapshot');

    await closeWs(ws);
    await closeWs(ws2);
  });

  // ── Demo Events ──

  it('should broadcast scenario:changed events', async () => {
    const ws = await connectAndBuffer(wsUrl);
    await waitForType(ws, 'snapshot');

    // Switch scenario — should broadcast demo:scenario event
    simulator.setScenario('occupancy-tracking');
    const scenarioMsg = await waitForType(ws, 'demo:scenario', 3000);

    assert.equal(scenarioMsg.scenarioId, 'occupancy-tracking');

    // Reset
    simulator.setScenario('patient-monitoring');
    await closeWs(ws);
  });

  // ── Disconnect ──

  it('should handle client disconnection gracefully', async () => {
    const ws = await connectAndBuffer(wsUrl);
    await waitForType(ws, 'snapshot');
    await closeWs(ws);

    await sleep(50);

    // Server still works after client disconnects
    const ws2 = await connectAndBuffer(wsUrl);
    const snap = await waitForType(ws2, 'snapshot');
    assert.equal(snap.type, 'snapshot');
    await closeWs(ws2);
  });
});
