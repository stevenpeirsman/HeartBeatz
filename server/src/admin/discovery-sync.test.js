// ==============================================================================
// Tests: Discovery → Nodes DB Sync (ADMIN-04)
// ==============================================================================

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { initDatabase, getDb, closeDatabase, _resetDbSingleton } from '../db/index.js';
import { DiscoverySync } from './discovery-sync.js';

/** Minimal logger stub */
const mockLogger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
  child: () => mockLogger,
};

/** Create a mock discovery service that extends EventEmitter */
function createMockDiscovery(nodes = []) {
  const discovery = new EventEmitter();
  discovery._nodes = new Map(nodes.map(n => [n.id, n]));
  discovery.getNodes = () => Array.from(discovery._nodes.values());
  discovery.getNode = (id) => discovery._nodes.get(id) || null;
  return discovery;
}

/** Helper to create a discovery node object */
function makeNode(id, overrides = {}) {
  return {
    id,
    ip: overrides.ip || '192.168.1.100',
    rssi: overrides.rssi ?? -45,
    status: overrides.status || 'online',
    lastSeen: Date.now(),
    name: overrides.name || `Node ${id.slice(-5)}`,
    meta: overrides.meta || {},
  };
}

describe('DiscoverySync', () => {
  let db;

  beforeEach(() => {
    _resetDbSingleton();
    db = initDatabase({ logger: mockLogger, inMemory: true });
  });

  afterEach(() => {
    closeDatabase();
    _resetDbSingleton();
  });

  // ---------- Lifecycle ----------

  describe('start/stop', () => {
    it('should subscribe to discovery events on start', () => {
      const discovery = createMockDiscovery();
      const sync = new DiscoverySync({ discovery, logger: mockLogger });

      sync.start();
      assert.ok(discovery.listenerCount('node:discovered') > 0);
      assert.ok(discovery.listenerCount('node:offline') > 0);
      assert.ok(discovery.listenerCount('discovery:complete') > 0);
    });

    it('should unsubscribe from discovery events on stop', () => {
      const discovery = createMockDiscovery();
      const sync = new DiscoverySync({ discovery, logger: mockLogger });

      sync.start();
      sync.stop();

      assert.equal(discovery.listenerCount('node:discovered'), 0);
      assert.equal(discovery.listenerCount('node:offline'), 0);
      assert.equal(discovery.listenerCount('discovery:complete'), 0);
    });

    it('should be safe to call start multiple times', () => {
      const discovery = createMockDiscovery();
      const sync = new DiscoverySync({ discovery, logger: mockLogger });

      sync.start();
      sync.start();
      assert.equal(discovery.listenerCount('node:discovered'), 1, 'Should only subscribe once');
    });

    it('should be safe to call stop without start', () => {
      const discovery = createMockDiscovery();
      const sync = new DiscoverySync({ discovery, logger: mockLogger });
      sync.stop(); // Should not throw
    });
  });

  // ---------- Auto-Registration ----------

  describe('node:discovered event', () => {
    it('should auto-register a new node in the database', () => {
      const discovery = createMockDiscovery();
      const sync = new DiscoverySync({ discovery, logger: mockLogger });
      sync.start();

      const node = makeNode('aa:bb:cc:dd:ee:ff', { ip: '192.168.1.50' });
      discovery.emit('node:discovered', node);

      const dbNode = db.prepare("SELECT * FROM nodes WHERE mac = 'aa:bb:cc:dd:ee:ff'").get();
      assert.ok(dbNode, 'Node should exist in DB');
      assert.equal(dbNode.ip, '192.168.1.50');
      assert.equal(dbNode.status, 'online');
      assert.equal(dbNode.discovery_source, 'discovery');
    });

    it('should update existing node instead of creating duplicate', () => {
      const discovery = createMockDiscovery();
      const sync = new DiscoverySync({ discovery, logger: mockLogger });
      sync.start();

      // First discovery
      discovery.emit('node:discovered', makeNode('aa:bb:cc:dd:ee:ff', { ip: '192.168.1.50' }));
      // Second discovery with new IP
      discovery.emit('node:discovered', makeNode('aa:bb:cc:dd:ee:ff', { ip: '192.168.1.51' }));

      const nodes = db.prepare("SELECT * FROM nodes WHERE mac = 'aa:bb:cc:dd:ee:ff'").all();
      assert.equal(nodes.length, 1, 'Should not create duplicate');
      assert.equal(nodes[0].ip, '192.168.1.51', 'IP should be updated');
    });

    it('should update a manually-added node when discovered', () => {
      // Add a manual node first
      db.prepare(`
        INSERT INTO nodes (id, mac, name, ip, type, discovery_source)
        VALUES ('manual-1', 'aa:bb:cc:dd:ee:ff', 'Lobby Sensor', '192.168.1.10', 'esp32-s3', 'manual')
      `).run();

      const discovery = createMockDiscovery();
      const sync = new DiscoverySync({ discovery, logger: mockLogger });
      sync.start();

      discovery.emit('node:discovered', makeNode('aa:bb:cc:dd:ee:ff', { ip: '192.168.1.50' }));

      const node = db.prepare("SELECT * FROM nodes WHERE id = 'manual-1'").get();
      assert.equal(node.ip, '192.168.1.50', 'IP should be updated');
      assert.equal(node.status, 'online', 'Status should be online');
      assert.equal(node.name, 'Lobby Sensor', 'Manual name should be preserved');
      assert.equal(node.discovery_source, 'manual', 'Source should remain manual');
    });

    it('should update firmware version from metadata', () => {
      const discovery = createMockDiscovery();
      const sync = new DiscoverySync({ discovery, logger: mockLogger });
      sync.start();

      discovery.emit('node:discovered', makeNode('aa:bb:cc:dd:ee:ff', {
        meta: { firmware_version: '1.2.3' }
      }));

      const node = db.prepare("SELECT * FROM nodes WHERE mac = 'aa:bb:cc:dd:ee:ff'").get();
      assert.equal(node.firmware_ver, '1.2.3');
    });

    it('should not overwrite firmware_ver with null', () => {
      db.prepare(`
        INSERT INTO nodes (id, mac, name, firmware_ver, discovery_source)
        VALUES ('fw-1', 'aa:bb:cc:dd:ee:ff', 'Test', '1.0.0', 'manual')
      `).run();

      const discovery = createMockDiscovery();
      const sync = new DiscoverySync({ discovery, logger: mockLogger });
      sync.start();

      // Discover without firmware info
      discovery.emit('node:discovered', makeNode('aa:bb:cc:dd:ee:ff', { meta: {} }));

      const node = db.prepare("SELECT * FROM nodes WHERE id = 'fw-1'").get();
      assert.equal(node.firmware_ver, '1.0.0', 'Firmware version should be preserved');
    });
  });

  // ---------- MAC Normalization ----------

  describe('MAC normalization', () => {
    it('should handle uppercase MAC addresses', () => {
      const discovery = createMockDiscovery();
      const sync = new DiscoverySync({ discovery, logger: mockLogger });
      sync.start();

      discovery.emit('node:discovered', makeNode('AA:BB:CC:DD:EE:FF'));

      const node = db.prepare("SELECT * FROM nodes WHERE mac = 'aa:bb:cc:dd:ee:ff'").get();
      assert.ok(node, 'Should normalize to lowercase');
    });

    it('should handle raw hex without colons (12 chars)', () => {
      const discovery = createMockDiscovery();
      const sync = new DiscoverySync({ discovery, logger: mockLogger });
      sync.start();

      discovery.emit('node:discovered', makeNode('aabbccddeeff'));

      const node = db.prepare("SELECT * FROM nodes WHERE mac = 'aa:bb:cc:dd:ee:ff'").get();
      assert.ok(node, 'Should convert raw hex to MAC format');
    });

    it('should skip nodes with invalid IDs', () => {
      const discovery = createMockDiscovery();
      const sync = new DiscoverySync({ discovery, logger: mockLogger });
      sync.start();

      // Invalid — too short
      discovery.emit('node:discovered', makeNode('xyz'));

      const count = db.prepare("SELECT COUNT(*) as c FROM nodes").get().c;
      assert.equal(count, 0, 'Should not insert node with invalid MAC');
    });
  });

  // ---------- Offline Handling ----------

  describe('node:offline event', () => {
    it('should mark a node as offline in the database', () => {
      const discovery = createMockDiscovery();
      const sync = new DiscoverySync({ discovery, logger: mockLogger });
      sync.start();

      // First register the node
      discovery.emit('node:discovered', makeNode('aa:bb:cc:dd:ee:ff'));

      // Then mark offline
      discovery.emit('node:offline', { id: 'aa:bb:cc:dd:ee:ff', status: 'offline' });

      const node = db.prepare("SELECT * FROM nodes WHERE mac = 'aa:bb:cc:dd:ee:ff'").get();
      assert.equal(node.status, 'offline');
    });

    it('should not error when offlining a non-existent node', () => {
      const discovery = createMockDiscovery();
      const sync = new DiscoverySync({ discovery, logger: mockLogger });
      sync.start();

      // Should not throw
      discovery.emit('node:offline', { id: 'ff:ff:ff:ff:ff:ff', status: 'offline' });
    });
  });

  // ---------- Discovery Complete & Reconciliation ----------

  describe('discovery:complete event', () => {
    it('should mark online DB nodes as offline if not in discovery set', () => {
      // Pre-populate DB with two online nodes
      db.prepare("INSERT INTO nodes (id, mac, name, status) VALUES ('n1', 'aa:aa:aa:aa:aa:aa', 'A', 'online')").run();
      db.prepare("INSERT INTO nodes (id, mac, name, status) VALUES ('n2', 'bb:bb:bb:bb:bb:bb', 'B', 'online')").run();

      const discovery = createMockDiscovery();
      const sync = new DiscoverySync({ discovery, logger: mockLogger });
      sync.start();

      // Only node A is in the discovery set
      discovery.emit('discovery:complete', [
        makeNode('aa:aa:aa:aa:aa:aa'),
      ]);

      const nodeA = db.prepare("SELECT status FROM nodes WHERE id = 'n1'").get();
      const nodeB = db.prepare("SELECT status FROM nodes WHERE id = 'n2'").get();

      assert.equal(nodeA.status, 'online', 'Node A should remain online');
      assert.equal(nodeB.status, 'offline', 'Node B should be marked offline');
    });

    it('should not affect already-offline nodes', () => {
      db.prepare("INSERT INTO nodes (id, mac, name, status) VALUES ('n1', 'aa:aa:aa:aa:aa:aa', 'A', 'offline')").run();

      const discovery = createMockDiscovery();
      const sync = new DiscoverySync({ discovery, logger: mockLogger });
      sync.start();

      discovery.emit('discovery:complete', []);

      const node = db.prepare("SELECT status FROM nodes WHERE id = 'n1'").get();
      assert.equal(node.status, 'offline');
    });
  });

  // ---------- syncNow (Manual Full Sync) ----------

  describe('syncNow', () => {
    it('should register all discovery nodes into the database', () => {
      const discovery = createMockDiscovery([
        makeNode('aa:aa:aa:aa:aa:aa', { name: 'Node A' }),
        makeNode('bb:bb:bb:bb:bb:bb', { name: 'Node B' }),
      ]);

      const sync = new DiscoverySync({ discovery, logger: mockLogger });
      const stats = sync.syncNow();

      const count = db.prepare("SELECT COUNT(*) as c FROM nodes").get().c;
      assert.equal(count, 2);
      assert.equal(stats.nodesCreated, 2);
      assert.equal(stats.syncCycles, 1);
      assert.ok(stats.lastSyncAt);
    });

    it('should reconcile offline nodes during syncNow', () => {
      // Pre-existing online node not in discovery
      db.prepare("INSERT INTO nodes (id, mac, name, status) VALUES ('old1', 'cc:cc:cc:cc:cc:cc', 'Old', 'online')").run();

      const discovery = createMockDiscovery([
        makeNode('aa:aa:aa:aa:aa:aa'),
      ]);

      const sync = new DiscoverySync({ discovery, logger: mockLogger });
      sync.syncNow();

      const oldNode = db.prepare("SELECT status FROM nodes WHERE id = 'old1'").get();
      assert.equal(oldNode.status, 'offline');
    });
  });

  // ---------- Stats ----------

  describe('getStats', () => {
    it('should return accurate sync statistics', () => {
      const discovery = createMockDiscovery();
      const sync = new DiscoverySync({ discovery, logger: mockLogger });
      sync.start();

      // Create 2 nodes
      discovery.emit('node:discovered', makeNode('aa:aa:aa:aa:aa:aa'));
      discovery.emit('node:discovered', makeNode('bb:bb:bb:bb:bb:bb'));

      // Update 1 node
      discovery.emit('node:discovered', makeNode('aa:aa:aa:aa:aa:aa', { ip: '10.0.0.1' }));

      // Offline 1 node
      discovery.emit('node:offline', { id: 'bb:bb:bb:bb:bb:bb' });

      const stats = sync.getStats();
      assert.equal(stats.nodesCreated, 2);
      assert.equal(stats.nodesUpdated, 1);
      assert.equal(stats.nodesOfflined, 1);
    });

    it('should return a copy (not a reference)', () => {
      const discovery = createMockDiscovery();
      const sync = new DiscoverySync({ discovery, logger: mockLogger });

      const stats1 = sync.getStats();
      stats1.nodesCreated = 999;

      const stats2 = sync.getStats();
      assert.equal(stats2.nodesCreated, 0, 'Should not be mutated');
    });
  });

  // ---------- Error Handling ----------

  describe('error handling', () => {
    it('should not crash on event handler errors', () => {
      const discovery = createMockDiscovery();
      const sync = new DiscoverySync({ discovery, logger: mockLogger });
      sync.start();

      // Emit with null id — should log warning, not crash
      discovery.emit('node:discovered', { id: null, ip: '1.2.3.4' });
      discovery.emit('node:offline', { id: null });

      // Should still work after error
      discovery.emit('node:discovered', makeNode('aa:aa:aa:aa:aa:aa'));
      const count = db.prepare("SELECT COUNT(*) as c FROM nodes").get().c;
      assert.equal(count, 1);
    });
  });
});
