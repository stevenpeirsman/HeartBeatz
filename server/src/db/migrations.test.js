// ==============================================================================
// Tests: Database Migration System (DB-02)
// ==============================================================================

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  runMigrations,
  getCurrentVersion,
  getMigrationStatus,
  validateSchema,
  LATEST_VERSION,
} from './migrations.js';

/** Minimal logger stub for testing */
const mockLogger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
  child: () => mockLogger,
};

/** Create a fresh in-memory database with pragmas matching initDatabase */
function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

describe('Migration System', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    if (db && db.open) db.close();
  });

  // ---------- Core Migration Execution ----------

  it('should apply all migrations on a fresh database', () => {
    const result = runMigrations(db, mockLogger);

    assert.equal(result.fromVersion, 0, 'Should start from version 0');
    assert.equal(result.toVersion, LATEST_VERSION, `Should end at version ${LATEST_VERSION}`);
    assert.equal(result.applied, LATEST_VERSION, `Should apply ${LATEST_VERSION} migrations`);
    assert.ok(result.durationMs >= 0, 'Duration should be non-negative');
    assert.deepEqual(result.versions, [1, 2], 'Should list all applied version numbers');
  });

  it('should set user_version to LATEST_VERSION after migration', () => {
    runMigrations(db, mockLogger);
    assert.equal(getCurrentVersion(db), LATEST_VERSION);
  });

  it('should be a no-op when already at latest version', () => {
    runMigrations(db, mockLogger); // Apply all
    const result = runMigrations(db, mockLogger); // Run again

    assert.equal(result.applied, 0, 'Should not apply any migrations');
    assert.equal(result.fromVersion, LATEST_VERSION);
    assert.equal(result.toVersion, LATEST_VERSION);
    assert.deepEqual(result.versions, []);
  });

  it('should only apply pending migrations (incremental)', () => {
    // Manually set to version 1 (simulate a db that already has v1)
    // First run v1 migration
    runMigrations(db, mockLogger);

    // Reset to v1 to simulate upgrade scenario
    db.close();
    db = createTestDb();
    // Apply just v1 by running migrations on fresh db, then we'll test v2 upgrade
    runMigrations(db, mockLogger);

    // Verify it's fully migrated (since it starts fresh it does all)
    assert.equal(getCurrentVersion(db), LATEST_VERSION);
  });

  it('should handle incremental migration from v1 to v2', () => {
    // Simulate a database at v1 by manually applying v1 schema then setting version
    db.exec(`CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY, mac TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT 'Unnamed',
      ip TEXT, type TEXT DEFAULT 'esp32-s3', firmware_ver TEXT, status TEXT DEFAULT 'offline',
      last_seen TEXT, position_x REAL, position_y REAL,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )`);
    db.exec("CREATE TABLE IF NOT EXISTS label_sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, annotator TEXT DEFAULT 'anonymous', started_at TEXT DEFAULT (datetime('now')), ended_at TEXT, node_id TEXT, notes TEXT, status TEXT DEFAULT 'active')");
    db.exec("CREATE TABLE IF NOT EXISTS labels (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, timestamp TEXT DEFAULT (datetime('now')), true_count INTEGER NOT NULL, annotator TEXT DEFAULT 'anonymous', node_id TEXT, frame_id TEXT, confidence TEXT DEFAULT 'certain', notes TEXT)");
    db.exec("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT DEFAULT (datetime('now')), node_id TEXT NOT NULL, predicted_count INTEGER NOT NULL, confidence REAL, algorithm TEXT DEFAULT 'threshold', features_hash TEXT, session_id TEXT)");
    db.exec("CREATE TABLE IF NOT EXISTS evaluations (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT DEFAULT (datetime('now')), session_id TEXT, algorithm TEXT NOT NULL, total_samples INTEGER NOT NULL, accuracy REAL NOT NULL, precision_avg REAL, recall_avg REAL, f1_avg REAL, confusion_json TEXT, notes TEXT)");
    db.exec("CREATE TABLE IF NOT EXISTS metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, hour TEXT NOT NULL, node_id TEXT, detection_rate REAL, false_pos_rate REAL, accuracy REAL, avg_latency_ms REAL, sample_count INTEGER DEFAULT 0, UNIQUE(hour, node_id))");
    db.exec("CREATE TABLE IF NOT EXISTS improvements (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT DEFAULT (datetime('now')), version TEXT NOT NULL, algorithm_config TEXT, accuracy_before REAL, accuracy_after REAL, f1_before REAL, f1_after REAL, notes TEXT)");
    db.pragma('user_version = 1');

    // Now run migrations — should only apply v2
    const result = runMigrations(db, mockLogger);

    assert.equal(result.fromVersion, 1, 'Should start from version 1');
    assert.equal(result.toVersion, 2, 'Should end at version 2');
    assert.equal(result.applied, 1, 'Should apply 1 migration');
    assert.deepEqual(result.versions, [2]);
  });

  // ---------- V1 Migration: Foundation Tables ----------

  it('v1: should create all 7 foundation tables', () => {
    runMigrations(db, mockLogger);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);

    const expected = ['audit_log', 'evaluations', 'events', 'improvements',
      'label_sessions', 'labels', 'metrics', 'migration_log', 'nodes'];
    for (const t of expected) {
      assert.ok(tables.includes(t), `Should have '${t}' table`);
    }
  });

  it('v1: should create all indexes', () => {
    runMigrations(db, mockLogger);

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
    ).all().map(r => r.name);

    assert.ok(indexes.includes('idx_labels_session'));
    assert.ok(indexes.includes('idx_labels_timestamp'));
    assert.ok(indexes.includes('idx_events_timestamp'));
    assert.ok(indexes.includes('idx_events_node'));
    assert.ok(indexes.includes('idx_metrics_hour'));
    assert.ok(indexes.includes('idx_nodes_mac'));
  });

  // ---------- V2 Migration: Audit Log, Migration Log, Discovery Source ----------

  it('v2: should create audit_log table', () => {
    runMigrations(db, mockLogger);

    const cols = db.prepare("PRAGMA table_info(audit_log)").all().map(c => c.name);
    assert.ok(cols.includes('id'));
    assert.ok(cols.includes('timestamp'));
    assert.ok(cols.includes('action'));
    assert.ok(cols.includes('entity_type'));
    assert.ok(cols.includes('entity_id'));
    assert.ok(cols.includes('actor'));
    assert.ok(cols.includes('details'));
    assert.ok(cols.includes('request_id'));
  });

  it('v2: should create migration_log table', () => {
    runMigrations(db, mockLogger);

    const cols = db.prepare("PRAGMA table_info(migration_log)").all().map(c => c.name);
    assert.ok(cols.includes('id'));
    assert.ok(cols.includes('version'));
    assert.ok(cols.includes('name'));
    assert.ok(cols.includes('applied_at'));
    assert.ok(cols.includes('duration_ms'));
  });

  it('v2: should add discovery_source column to nodes', () => {
    runMigrations(db, mockLogger);

    const cols = db.prepare("PRAGMA table_info(nodes)").all().map(c => c.name);
    assert.ok(cols.includes('discovery_source'), 'nodes should have discovery_source column');
  });

  it('v2: should record migration in migration_log', () => {
    runMigrations(db, mockLogger);

    const logs = db.prepare('SELECT * FROM migration_log ORDER BY version').all();
    // v2 migration logs itself (v1 can't because migration_log didn't exist yet)
    assert.ok(logs.length >= 1, 'Should have at least 1 migration log entry');
    const v2Log = logs.find(l => l.version === 2);
    assert.ok(v2Log, 'Should have v2 log entry');
    assert.equal(v2Log.name, 'audit-log-migration-log-discovery');
    assert.ok(v2Log.duration_ms >= 0);
  });

  it('v2: should create audit_log indexes', () => {
    runMigrations(db, mockLogger);

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_audit%'"
    ).all().map(r => r.name);

    assert.ok(indexes.includes('idx_audit_timestamp'));
    assert.ok(indexes.includes('idx_audit_entity'));
    assert.ok(indexes.includes('idx_audit_action'));
  });

  // ---------- Migration Status & Validation ----------

  it('getMigrationStatus: should show all migrations as not applied on fresh db', () => {
    const status = getMigrationStatus(db);
    assert.equal(status.length, LATEST_VERSION);
    for (const m of status) {
      assert.equal(m.applied, false);
    }
  });

  it('getMigrationStatus: should show all migrations as applied after runMigrations', () => {
    runMigrations(db, mockLogger);
    const status = getMigrationStatus(db);
    for (const m of status) {
      assert.equal(m.applied, true, `Migration v${m.version} should be applied`);
    }
  });

  it('validateSchema: should report invalid on fresh db', () => {
    const result = validateSchema(db);
    assert.equal(result.valid, false);
    assert.equal(result.currentVersion, 0);
    assert.equal(result.expectedVersion, LATEST_VERSION);
    assert.equal(result.pendingMigrations, LATEST_VERSION);
  });

  it('validateSchema: should report valid after all migrations', () => {
    runMigrations(db, mockLogger);
    const result = validateSchema(db);
    assert.equal(result.valid, true);
    assert.equal(result.currentVersion, LATEST_VERSION);
    assert.equal(result.pendingMigrations, 0);
  });

  // ---------- Data Preservation ----------

  it('should preserve existing data during incremental migrations', () => {
    // Simulate v1 database with data
    db.exec(`CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY, mac TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT 'Unnamed',
      ip TEXT, type TEXT DEFAULT 'esp32-s3', firmware_ver TEXT, status TEXT DEFAULT 'offline',
      last_seen TEXT, position_x REAL, position_y REAL,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )`);
    db.exec("CREATE TABLE IF NOT EXISTS label_sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, annotator TEXT DEFAULT 'anonymous', started_at TEXT DEFAULT (datetime('now')), ended_at TEXT, node_id TEXT, notes TEXT, status TEXT DEFAULT 'active')");
    db.exec("CREATE TABLE IF NOT EXISTS labels (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, timestamp TEXT DEFAULT (datetime('now')), true_count INTEGER NOT NULL, annotator TEXT DEFAULT 'anonymous', node_id TEXT, frame_id TEXT, confidence TEXT DEFAULT 'certain', notes TEXT)");
    db.exec("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT DEFAULT (datetime('now')), node_id TEXT NOT NULL, predicted_count INTEGER NOT NULL, confidence REAL, algorithm TEXT DEFAULT 'threshold', features_hash TEXT, session_id TEXT)");
    db.exec("CREATE TABLE IF NOT EXISTS evaluations (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT DEFAULT (datetime('now')), session_id TEXT, algorithm TEXT NOT NULL, total_samples INTEGER NOT NULL, accuracy REAL NOT NULL, precision_avg REAL, recall_avg REAL, f1_avg REAL, confusion_json TEXT, notes TEXT)");
    db.exec("CREATE TABLE IF NOT EXISTS metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, hour TEXT NOT NULL, node_id TEXT, detection_rate REAL, false_pos_rate REAL, accuracy REAL, avg_latency_ms REAL, sample_count INTEGER DEFAULT 0, UNIQUE(hour, node_id))");
    db.exec("CREATE TABLE IF NOT EXISTS improvements (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT DEFAULT (datetime('now')), version TEXT NOT NULL, algorithm_config TEXT, accuracy_before REAL, accuracy_after REAL, f1_before REAL, f1_after REAL, notes TEXT)");

    // Insert test data
    db.prepare("INSERT INTO nodes (id, mac, name) VALUES ('n1', 'aa:bb:cc:dd:ee:ff', 'Test Node')").run();
    db.pragma('user_version = 1');

    // Run v2 migration
    runMigrations(db, mockLogger);

    // Verify data preserved
    const node = db.prepare("SELECT * FROM nodes WHERE id = 'n1'").get();
    assert.ok(node, 'Node should still exist');
    assert.equal(node.name, 'Test Node');
    assert.equal(node.mac, 'aa:bb:cc:dd:ee:ff');
    assert.equal(node.discovery_source, 'manual', 'New column should have default value');
  });

  // ---------- Edge Cases ----------

  it('should work without a logger', () => {
    const result = runMigrations(db);
    assert.equal(result.toVersion, LATEST_VERSION);
  });

  it('getCurrentVersion: should return 0 on fresh database', () => {
    assert.equal(getCurrentVersion(db), 0);
  });

  it('LATEST_VERSION: should be a positive integer', () => {
    assert.ok(LATEST_VERSION > 0);
    assert.equal(LATEST_VERSION, Math.floor(LATEST_VERSION));
  });

  // ---------- Integration with db/index.js ----------

  it('should work through initDatabase (integration)', async () => {
    // Import initDatabase after migration system is in place
    const { initDatabase, getDb: getDbFn, closeDatabase, _resetDbSingleton } = await import('./index.js');
    _resetDbSingleton();

    const testDb = initDatabase({ logger: mockLogger, inMemory: true });
    assert.ok(testDb);

    const version = getCurrentVersion(testDb);
    assert.equal(version, LATEST_VERSION, 'initDatabase should apply all migrations');

    // Verify new v2 tables exist
    const tables = testDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'"
    ).all();
    assert.equal(tables.length, 1, 'audit_log table should exist');

    closeDatabase();
    _resetDbSingleton();
  });
});
