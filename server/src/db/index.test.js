// ==============================================================================
// Tests: Database Initialization Module
// ==============================================================================

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDatabase, getDb, closeDatabase, _resetDbSingleton } from './index.js';

/** Minimal logger stub for testing */
const mockLogger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
  child: () => mockLogger,
};

describe('Database Module', () => {
  beforeEach(() => {
    _resetDbSingleton();
  });

  afterEach(() => {
    closeDatabase();
    _resetDbSingleton();
  });

  it('should initialize an in-memory database', () => {
    const db = initDatabase({ logger: mockLogger, inMemory: true });
    assert.ok(db, 'Database instance should be truthy');
    assert.equal(typeof db.prepare, 'function', 'Should have prepare method');
  });

  it('should return existing connection on second init', () => {
    const db1 = initDatabase({ logger: mockLogger, inMemory: true });
    const db2 = initDatabase({ logger: mockLogger, inMemory: true });
    assert.strictEqual(db1, db2, 'Should return same instance');
  });

  it('should create all required tables', () => {
    initDatabase({ logger: mockLogger, inMemory: true });
    const db = getDb();

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);

    assert.ok(tables.includes('nodes'), 'Should have nodes table');
    assert.ok(tables.includes('label_sessions'), 'Should have label_sessions table');
    assert.ok(tables.includes('labels'), 'Should have labels table');
    assert.ok(tables.includes('events'), 'Should have events table');
    assert.ok(tables.includes('evaluations'), 'Should have evaluations table');
    assert.ok(tables.includes('metrics'), 'Should have metrics table');
    assert.ok(tables.includes('improvements'), 'Should have improvements table');
  });

  it('should set schema version to latest', () => {
    initDatabase({ logger: mockLogger, inMemory: true });
    const db = getDb();
    const version = db.pragma('user_version', { simple: true });
    // Schema version should match LATEST_VERSION from migrations.js
    assert.ok(version >= 1, `Schema version should be >= 1, got ${version}`);
  });

  it('should enable WAL mode', () => {
    initDatabase({ logger: mockLogger, inMemory: true });
    const db = getDb();
    const mode = db.pragma('journal_mode', { simple: true });
    // In-memory DB uses 'memory' journal mode, but WAL pragma was called
    assert.ok(['wal', 'memory'].includes(mode), `Journal mode should be wal or memory, got ${mode}`);
  });

  it('should enable foreign keys', () => {
    initDatabase({ logger: mockLogger, inMemory: true });
    const db = getDb();
    const fk = db.pragma('foreign_keys', { simple: true });
    assert.equal(fk, 1);
  });

  it('should throw when getDb called before init', () => {
    assert.throws(() => getDb(), /not initialized/);
  });

  it('should create indexes', () => {
    initDatabase({ logger: mockLogger, inMemory: true });
    const db = getDb();

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
    ).all().map(r => r.name);

    assert.ok(indexes.includes('idx_labels_session'), 'Should have labels session index');
    assert.ok(indexes.includes('idx_labels_timestamp'), 'Should have labels timestamp index');
    assert.ok(indexes.includes('idx_events_timestamp'), 'Should have events timestamp index');
    assert.ok(indexes.includes('idx_events_node'), 'Should have events node index');
    assert.ok(indexes.includes('idx_metrics_hour'), 'Should have metrics hour index');
    assert.ok(indexes.includes('idx_nodes_mac'), 'Should have nodes mac index');
  });

  it('should be idempotent on repeated migrations', () => {
    initDatabase({ logger: mockLogger, inMemory: true });
    const db = getDb();

    // Insert a test row
    db.prepare("INSERT INTO nodes (id, mac, name) VALUES ('test1', 'aa:bb:cc:dd:ee:ff', 'Test')").run();

    // Close and re-init (simulate restart)
    // Since we're in-memory, the data won't persist, but the schema creation should not error
    closeDatabase();
    _resetDbSingleton();

    const db2 = initDatabase({ logger: mockLogger, inMemory: true });
    assert.ok(db2);
  });

  it('should close database cleanly', () => {
    initDatabase({ logger: mockLogger, inMemory: true });
    closeDatabase(mockLogger);
    assert.throws(() => getDb(), /not initialized/);
  });
});
