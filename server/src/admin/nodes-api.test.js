// ==============================================================================
// Tests: Node Admin API & Database Operations
// ==============================================================================

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDatabase, getDb, closeDatabase, _resetDbSingleton } from '../db/index.js';

const mockLogger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
  child: () => mockLogger,
};

/**
 * Helper: directly insert/query nodes via the DB to test the data layer
 * that the API routes use. Integration tests for HTTP are separate.
 */
describe('Nodes Database Operations', () => {
  beforeEach(() => {
    _resetDbSingleton();
    initDatabase({ logger: mockLogger, inMemory: true });
  });

  afterEach(() => {
    closeDatabase();
    _resetDbSingleton();
  });

  it('should insert and retrieve a node', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO nodes (id, mac, name, ip, type, firmware_ver)
      VALUES ('n1', 'aa:bb:cc:dd:ee:01', 'Node Alpha', '192.168.1.101', 'esp32-s3', '1.0.0')
    `).run();

    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get('n1');
    assert.equal(node.name, 'Node Alpha');
    assert.equal(node.mac, 'aa:bb:cc:dd:ee:01');
    assert.equal(node.type, 'esp32-s3');
    assert.equal(node.status, 'offline'); // default
  });

  it('should enforce unique MAC constraint', () => {
    const db = getDb();
    db.prepare("INSERT INTO nodes (id, mac) VALUES ('n1', 'aa:bb:cc:dd:ee:01')").run();

    assert.throws(() => {
      db.prepare("INSERT INTO nodes (id, mac) VALUES ('n2', 'aa:bb:cc:dd:ee:01')").run();
    }, /UNIQUE constraint failed/);
  });

  it('should update node properties', () => {
    const db = getDb();
    db.prepare("INSERT INTO nodes (id, mac, name) VALUES ('n1', 'aa:bb:cc:dd:ee:01', 'Old Name')").run();

    db.prepare("UPDATE nodes SET name = ?, status = ?, updated_at = datetime('now') WHERE id = ?")
      .run('New Name', 'online', 'n1');

    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get('n1');
    assert.equal(node.name, 'New Name');
    assert.equal(node.status, 'online');
  });

  it('should delete a node', () => {
    const db = getDb();
    db.prepare("INSERT INTO nodes (id, mac) VALUES ('n1', 'aa:bb:cc:dd:ee:01')").run();

    const result = db.prepare('DELETE FROM nodes WHERE id = ?').run('n1');
    assert.equal(result.changes, 1);

    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get('n1');
    assert.equal(node, undefined);
  });

  it('should list all nodes ordered by name', () => {
    const db = getDb();
    db.prepare("INSERT INTO nodes (id, mac, name) VALUES ('n2', 'aa:bb:cc:dd:ee:02', 'Beta')").run();
    db.prepare("INSERT INTO nodes (id, mac, name) VALUES ('n1', 'aa:bb:cc:dd:ee:01', 'Alpha')").run();

    const nodes = db.prepare('SELECT * FROM nodes ORDER BY name ASC').all();
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0].name, 'Alpha');
    assert.equal(nodes[1].name, 'Beta');
  });

  it('should filter nodes by status', () => {
    const db = getDb();
    db.prepare("INSERT INTO nodes (id, mac, name, status) VALUES ('n1', 'aa:bb:cc:dd:ee:01', 'Online Node', 'online')").run();
    db.prepare("INSERT INTO nodes (id, mac, name, status) VALUES ('n2', 'aa:bb:cc:dd:ee:02', 'Offline Node', 'offline')").run();

    const online = db.prepare("SELECT * FROM nodes WHERE status = 'online'").all();
    assert.equal(online.length, 1);
    assert.equal(online[0].name, 'Online Node');
  });

  it('should store and retrieve position coordinates', () => {
    const db = getDb();
    db.prepare("INSERT INTO nodes (id, mac, position_x, position_y) VALUES ('n1', 'aa:bb:cc:dd:ee:01', 0.5, 0.75)").run();

    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get('n1');
    assert.equal(node.position_x, 0.5);
    assert.equal(node.position_y, 0.75);
  });

  it('should have created_at and updated_at timestamps', () => {
    const db = getDb();
    db.prepare("INSERT INTO nodes (id, mac) VALUES ('n1', 'aa:bb:cc:dd:ee:01')").run();

    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get('n1');
    assert.ok(node.created_at, 'Should have created_at');
    assert.ok(node.updated_at, 'Should have updated_at');
  });

  it('should allow null for optional fields', () => {
    const db = getDb();
    db.prepare("INSERT INTO nodes (id, mac) VALUES ('n1', 'aa:bb:cc:dd:ee:01')").run();

    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get('n1');
    assert.equal(node.ip, null);
    assert.equal(node.firmware_ver, null);
    assert.equal(node.position_x, null);
    assert.equal(node.position_y, null);
  });
});
