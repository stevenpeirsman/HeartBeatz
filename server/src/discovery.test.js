// ==============================================================================
// Discovery Service Tests
// ==============================================================================
// Tests the node discovery polling service that detects ESP32-S3 sensor nodes
// by querying the upstream RuView sensing server. Verifies node registration,
// naming persistence, offline detection, and event emission.
//
// Note: These tests mock the global fetch() to simulate sensing server responses
// without requiring a real upstream server.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DiscoveryService } from './discovery.js';
import {
  createMockLogger,
  createTestConfig,
  createMockStateStore,
  waitForEvent,
  sleep,
} from './test-helpers.js';

describe('DiscoveryService', () => {
  let discovery;
  let config;
  let logger;
  let stateStore;
  let originalFetch;

  // Mock fetch responses
  let fetchResponse;
  let fetchShouldFail;

  beforeEach(() => {
    config = createTestConfig({
      discovery: { intervalMs: 200, timeoutMs: 500 },
    });
    logger = createMockLogger();
    stateStore = createMockStateStore();

    fetchResponse = { nodes: [] };
    fetchShouldFail = false;

    // Replace global fetch with mock
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, _opts) => {
      if (fetchShouldFail) throw new Error('Network error');
      return {
        ok: true,
        json: async () => fetchResponse,
      };
    };

    discovery = new DiscoveryService(config, stateStore.loadState, stateStore.saveState, logger);
  });

  afterEach(() => {
    discovery.stop();
    globalThis.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // Basic Operations
  // -------------------------------------------------------------------------

  describe('basic operations', () => {
    it('should start with empty node list', () => {
      assert.deepEqual(discovery.getNodes(), []);
    });

    it('should return null for unknown node ID', () => {
      assert.equal(discovery.getNode('UNKNOWN'), null);
    });

    it('should stop cleanly even if never started', () => {
      discovery.stop(); // Should not throw
    });
  });

  // -------------------------------------------------------------------------
  // Node Discovery via Polling
  // -------------------------------------------------------------------------

  describe('polling', () => {
    it('should discover nodes from sensing server response', async () => {
      fetchResponse = {
        nodes: [
          { node_id: 'AA:BB:CC:01', ip: '192.168.1.101', rssi: -45 },
          { node_id: 'AA:BB:CC:02', ip: '192.168.1.102', rssi: -50 },
        ],
      };

      discovery.start();
      await sleep(100); // Wait for first poll

      const nodes = discovery.getNodes();
      assert.equal(nodes.length, 2);
      assert.equal(nodes[0].id, 'AA:BB:CC:01');
      assert.equal(nodes[0].ip, '192.168.1.101');
      assert.equal(nodes[0].status, 'online');
    });

    it('should handle array-format response (no wrapper object)', async () => {
      fetchResponse = [
        { node_id: 'AA:BB:CC:01', ip: '192.168.1.101', rssi: -40 },
      ];

      discovery.start();
      await sleep(100);

      const nodes = discovery.getNodes();
      assert.equal(nodes.length, 1);
    });

    it('should emit node:discovered for new nodes', async () => {
      fetchResponse = {
        nodes: [{ node_id: 'NEW:NODE:01', ip: '192.168.1.101', rssi: -42 }],
      };

      const promise = waitForEvent(discovery, 'node:discovered');
      discovery.start();
      const node = await promise;

      assert.equal(node.id, 'NEW:NODE:01');
      assert.equal(node.status, 'online');
    });

    it('should emit discovery:complete after each poll cycle', async () => {
      fetchResponse = { nodes: [{ node_id: 'N1', ip: '10.0.0.1', rssi: -50 }] };

      const promise = waitForEvent(discovery, 'discovery:complete');
      discovery.start();
      const nodes = await promise;

      assert.equal(Array.isArray(nodes), true);
      assert.equal(nodes.length, 1);
    });

    it('should handle fetch failures gracefully (no crash)', async () => {
      fetchShouldFail = true;
      discovery.start();
      await sleep(250);

      // Should still be running with empty nodes
      assert.deepEqual(discovery.getNodes(), []);
    });

    it('should handle non-ok responses gracefully', async () => {
      globalThis.fetch = async () => ({ ok: false, status: 500 });
      discovery.start();
      await sleep(100);

      assert.deepEqual(discovery.getNodes(), []);
    });
  });

  // -------------------------------------------------------------------------
  // Node Naming (Persistence)
  // -------------------------------------------------------------------------

  describe('node naming', () => {
    it('should rename a discovered node', async () => {
      fetchResponse = { nodes: [{ node_id: 'N1', ip: '10.0.0.1', rssi: -50 }] };
      discovery.start();
      await sleep(100);

      discovery.setNodeName('N1', 'Bedside Monitor');

      const node = discovery.getNode('N1');
      assert.equal(node.name, 'Bedside Monitor');
    });

    it('should persist node names to state', async () => {
      fetchResponse = { nodes: [{ node_id: 'N1', ip: '10.0.0.1', rssi: -50 }] };
      discovery.start();
      await sleep(100);

      discovery.setNodeName('N1', 'Wall Sensor');

      const state = stateStore.getState();
      assert.equal(state.nodes.N1.name, 'Wall Sensor');
    });

    it('should restore persisted names on re-discovery', async () => {
      // Pre-populate state with a saved name
      stateStore.saveState({
        nodes: { 'N1': { name: 'Saved Name' } },
        calibration: null,
        firstRunComplete: false,
      });

      fetchResponse = { nodes: [{ node_id: 'N1', ip: '10.0.0.1', rssi: -45 }] };
      discovery.start();
      await sleep(100);

      const node = discovery.getNode('N1');
      assert.equal(node.name, 'Saved Name');
    });

    it('should emit node:updated when renaming', async () => {
      fetchResponse = { nodes: [{ node_id: 'N1', ip: '10.0.0.1', rssi: -50 }] };
      discovery.start();
      await sleep(100);

      const promise = waitForEvent(discovery, 'node:updated');
      discovery.setNodeName('N1', 'New Name');
      const updated = await promise;
      assert.equal(updated.name, 'New Name');
    });

    it('should do nothing when renaming a non-existent node', () => {
      // Should not throw
      discovery.setNodeName('NONEXISTENT', 'Name');
      assert.equal(discovery.getNode('NONEXISTENT'), null);
    });
  });

  // -------------------------------------------------------------------------
  // Offline Detection
  // -------------------------------------------------------------------------

  describe('offline detection', () => {
    it('should mark nodes as offline when they disappear from responses', async () => {
      // First poll: node is present
      fetchResponse = { nodes: [{ node_id: 'N1', ip: '10.0.0.1', rssi: -50 }] };
      discovery.start();
      await sleep(100);
      assert.equal(discovery.getNode('N1').status, 'online');

      // Second poll: node is gone — after timeout, should go offline
      fetchResponse = { nodes: [] };
      await sleep(800); // > timeoutMs (500ms) + polling interval

      const node = discovery.getNode('N1');
      assert.equal(node.status, 'offline');
    });

    it('should emit node:offline when a node goes offline', async () => {
      fetchResponse = { nodes: [{ node_id: 'N1', ip: '10.0.0.1', rssi: -50 }] };
      discovery.start();
      await sleep(100);

      fetchResponse = { nodes: [] };
      const offlineNode = await waitForEvent(discovery, 'node:offline', 3000);
      assert.equal(offlineNode.id, 'N1');
      assert.equal(offlineNode.status, 'offline');
    });
  });

  // -------------------------------------------------------------------------
  // Alternative response field names
  // -------------------------------------------------------------------------

  describe('flexible field parsing', () => {
    it('should accept "mac" as node identifier', async () => {
      fetchResponse = { nodes: [{ mac: 'BY:MAC:01', ip: '10.0.0.1', rssi: -55 }] };
      discovery.start();
      await sleep(100);

      assert.equal(discovery.getNodes().length, 1);
      assert.equal(discovery.getNodes()[0].id, 'BY:MAC:01');
    });

    it('should accept "id" as node identifier', async () => {
      fetchResponse = { nodes: [{ id: 'BY:ID:01', ip: '10.0.0.1', rssi: -55 }] };
      discovery.start();
      await sleep(100);

      assert.equal(discovery.getNodes()[0].id, 'BY:ID:01');
    });

    it('should accept "source_ip" as IP field', async () => {
      fetchResponse = { nodes: [{ node_id: 'N1', source_ip: '10.0.0.5', rssi: -55 }] };
      discovery.start();
      await sleep(100);

      assert.equal(discovery.getNodes()[0].ip, '10.0.0.5');
    });

    it('should skip entries without any ID field', async () => {
      fetchResponse = { nodes: [{ ip: '10.0.0.1', rssi: -55 }] };
      discovery.start();
      await sleep(100);

      assert.equal(discovery.getNodes().length, 0);
    });
  });
});
