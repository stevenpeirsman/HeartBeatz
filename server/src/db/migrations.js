// ==============================================================================
// HeartBeatz Database Migrations — Version-Tracked Schema Changes
// ==============================================================================
// DB-02: Provides a structured migration system for the SQLite database.
// Each migration is a numbered function that applies schema changes in a
// transaction. The system tracks the current version via SQLite's user_version
// pragma and only runs migrations that haven't been applied yet.
//
// Usage:
//   import { runMigrations, getCurrentVersion, LATEST_VERSION } from './migrations.js';
//   runMigrations(db, logger);     // applies all pending migrations
//
// Adding a new migration:
//   1. Create a new function: migrate_vN(db, log) { ... }
//   2. Add it to the MIGRATIONS array at the correct index
//   3. Update LATEST_VERSION
//   4. Migrations MUST be idempotent (use IF NOT EXISTS, etc.)
//   5. Each migration runs in a transaction — all-or-nothing
//
// Design decisions:
//   - user_version pragma: lightweight, no extra tables, built into SQLite
//   - Sequential version numbers: simple, deterministic ordering
//   - Each migration is a pure function receiving (db, log) — easy to test
//   - Migrations are append-only: never modify a released migration
// ==============================================================================

/**
 * @typedef {Object} MigrationResult
 * @property {number} fromVersion  - Schema version before migration
 * @property {number} toVersion    - Schema version after migration
 * @property {number} applied      - Number of migrations applied
 * @property {number[]} versions   - List of migration versions that were applied
 * @property {number} durationMs   - Total time taken in milliseconds
 */

// ---------------------------------------------------------------------------
// Migration Definitions
// ---------------------------------------------------------------------------

/**
 * Migration v1: Foundation tables — nodes, labels, events, evaluations, metrics, improvements.
 * This is the initial schema that was previously inline in db/index.js.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} [log] - Pino logger
 */
function migrate_v1(db, log) {
  const statements = [
    // -- Nodes: ESP32 sensor nodes registered in the system --
    `CREATE TABLE IF NOT EXISTS nodes (
      id            TEXT PRIMARY KEY,
      mac           TEXT UNIQUE NOT NULL,
      name          TEXT NOT NULL DEFAULT 'Unnamed Node',
      ip            TEXT,
      type          TEXT NOT NULL DEFAULT 'esp32-s3',
      firmware_ver  TEXT,
      status        TEXT NOT NULL DEFAULT 'offline',
      last_seen     TEXT,
      position_x    REAL,
      position_y    REAL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )`,

    // -- Labeling Sessions: group ground truth labels by collection session --
    `CREATE TABLE IF NOT EXISTS label_sessions (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      annotator     TEXT NOT NULL DEFAULT 'anonymous',
      started_at    TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at      TEXT,
      node_id       TEXT,
      notes         TEXT,
      status        TEXT NOT NULL DEFAULT 'active'
    )`,

    // -- Ground Truth Labels: human-annotated person count observations --
    `CREATE TABLE IF NOT EXISTS labels (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL,
      timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
      true_count    INTEGER NOT NULL,
      annotator     TEXT NOT NULL DEFAULT 'anonymous',
      node_id       TEXT,
      frame_id      TEXT,
      confidence    TEXT DEFAULT 'certain',
      notes         TEXT,
      FOREIGN KEY (session_id) REFERENCES label_sessions(id)
    )`,

    // -- Detection Events: all CSI-based detection results --
    `CREATE TABLE IF NOT EXISTS events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp       TEXT NOT NULL DEFAULT (datetime('now')),
      node_id         TEXT NOT NULL,
      predicted_count INTEGER NOT NULL,
      confidence      REAL,
      algorithm       TEXT NOT NULL DEFAULT 'threshold',
      features_hash   TEXT,
      session_id      TEXT,
      FOREIGN KEY (node_id) REFERENCES nodes(id)
    )`,

    // -- Evaluation Results: accuracy metrics from ground truth comparison --
    `CREATE TABLE IF NOT EXISTS evaluations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp       TEXT NOT NULL DEFAULT (datetime('now')),
      session_id      TEXT,
      algorithm       TEXT NOT NULL,
      total_samples   INTEGER NOT NULL,
      accuracy        REAL NOT NULL,
      precision_avg   REAL,
      recall_avg      REAL,
      f1_avg          REAL,
      confusion_json  TEXT,
      notes           TEXT
    )`,

    // -- Hourly Metrics: aggregated accuracy and performance stats --
    `CREATE TABLE IF NOT EXISTS metrics (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      hour            TEXT NOT NULL,
      node_id         TEXT,
      detection_rate  REAL,
      false_pos_rate  REAL,
      accuracy        REAL,
      avg_latency_ms  REAL,
      sample_count    INTEGER NOT NULL DEFAULT 0,
      UNIQUE(hour, node_id)
    )`,

    // -- Improvement Tracking: log algorithm changes with before/after metrics --
    `CREATE TABLE IF NOT EXISTS improvements (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp       TEXT NOT NULL DEFAULT (datetime('now')),
      version         TEXT NOT NULL,
      algorithm_config TEXT,
      accuracy_before REAL,
      accuracy_after  REAL,
      f1_before       REAL,
      f1_after        REAL,
      notes           TEXT
    )`,

    // -- Indexes for common query patterns --
    `CREATE INDEX IF NOT EXISTS idx_labels_session    ON labels(session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_labels_timestamp  ON labels(timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_events_timestamp  ON events(timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_events_node       ON events(node_id)`,
    `CREATE INDEX IF NOT EXISTS idx_metrics_hour      ON metrics(hour)`,
    `CREATE INDEX IF NOT EXISTS idx_nodes_mac         ON nodes(mac)`,
  ];

  for (const sql of statements) {
    db.exec(sql);
  }

  log?.info({ tables: 7, indexes: 6 }, 'Migration v1 applied: foundation tables');
}

/**
 * Migration v2: Add audit_log table and migration_log table for tracking.
 * Also adds discovery_source column to nodes for ADMIN-04 sync tracking.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} [log] - Pino logger
 */
function migrate_v2(db, log) {
  const statements = [
    // -- Audit Log: immutable append-only access log --
    `CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
      action      TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id   TEXT,
      actor       TEXT NOT NULL DEFAULT 'system',
      details     TEXT,
      request_id  TEXT
    )`,

    // -- Migration Log: record when each migration was applied --
    `CREATE TABLE IF NOT EXISTS migration_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      version     INTEGER NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now')),
      duration_ms INTEGER
    )`,

    // -- Add discovery_source to nodes: 'manual' or 'discovery' --
    // SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so check first
    // We wrap this in a try block in the migration runner

    // -- Index for audit log queries --
    `CREATE INDEX IF NOT EXISTS idx_audit_timestamp    ON audit_log(timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_entity       ON audit_log(entity_type, entity_id)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_action       ON audit_log(action)`,
  ];

  for (const sql of statements) {
    db.exec(sql);
  }

  // Add discovery_source column to nodes (safe: check column existence first)
  const columns = db.prepare("PRAGMA table_info(nodes)").all().map(c => c.name);
  if (!columns.includes('discovery_source')) {
    db.exec("ALTER TABLE nodes ADD COLUMN discovery_source TEXT DEFAULT 'manual'");
    log?.info('Added discovery_source column to nodes table');
  }

  log?.info({ tables: 2, indexes: 3 }, 'Migration v2 applied: audit_log, migration_log, discovery_source');
}

// ---------------------------------------------------------------------------
// Migration Registry
// ---------------------------------------------------------------------------

/**
 * Ordered list of all migrations. Index 0 = v1, Index 1 = v2, etc.
 * Each entry has a version number, human-readable name, and migration function.
 *
 * IMPORTANT: Never modify a released migration. Only append new ones.
 *
 * @type {Array<{version: number, name: string, fn: Function}>}
 */
const MIGRATIONS = [
  { version: 1, name: 'foundation-tables',              fn: migrate_v1 },
  { version: 2, name: 'audit-log-migration-log-discovery', fn: migrate_v2 },
];

/** The latest schema version (must match last entry in MIGRATIONS) */
export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the current schema version from the database.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {number} Current user_version pragma value
 */
export function getCurrentVersion(db) {
  return db.pragma('user_version', { simple: true });
}

/**
 * Run all pending migrations on the database.
 * Each migration runs in its own transaction for atomicity.
 * Skips migrations that have already been applied (based on user_version).
 *
 * @param {import('better-sqlite3').Database} db - The better-sqlite3 instance
 * @param {Object} [log] - Pino logger instance
 * @returns {MigrationResult} Summary of what was applied
 * @throws {Error} If any migration fails (partially applied migrations are rolled back)
 */
export function runMigrations(db, log) {
  const startTime = Date.now();
  const fromVersion = getCurrentVersion(db);
  const applied = [];

  if (fromVersion >= LATEST_VERSION) {
    log?.debug({ version: fromVersion }, 'Schema is up to date, no migrations needed');
    return {
      fromVersion,
      toVersion: fromVersion,
      applied: 0,
      versions: [],
      durationMs: Date.now() - startTime,
    };
  }

  log?.info(
    { currentVersion: fromVersion, targetVersion: LATEST_VERSION },
    'Running database migrations'
  );

  // Apply each pending migration in order
  for (const migration of MIGRATIONS) {
    if (migration.version <= fromVersion) {
      continue; // Already applied
    }

    const migrationStart = Date.now();
    log?.info(
      { version: migration.version, name: migration.name },
      `Applying migration v${migration.version}: ${migration.name}`
    );

    // Run migration in a transaction for atomicity
    const runMigration = db.transaction(() => {
      migration.fn(db, log);
      db.pragma(`user_version = ${migration.version}`);
    });

    try {
      runMigration();
      const migrationDuration = Date.now() - migrationStart;

      // Log to migration_log if the table exists (v2+)
      _logMigration(db, migration, migrationDuration);

      applied.push(migration.version);
      log?.info(
        { version: migration.version, durationMs: migrationDuration },
        `Migration v${migration.version} applied successfully`
      );
    } catch (err) {
      log?.error(
        { err, version: migration.version, name: migration.name },
        `Migration v${migration.version} failed — transaction rolled back`
      );
      throw new Error(
        `Migration v${migration.version} (${migration.name}) failed: ${err.message}`
      );
    }
  }

  const result = {
    fromVersion,
    toVersion: getCurrentVersion(db),
    applied: applied.length,
    versions: applied,
    durationMs: Date.now() - startTime,
  };

  log?.info(result, 'All migrations complete');
  return result;
}

/**
 * Get the list of all registered migrations with their status.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{version: number, name: string, applied: boolean}>}
 */
export function getMigrationStatus(db) {
  const currentVersion = getCurrentVersion(db);
  return MIGRATIONS.map(m => ({
    version: m.version,
    name: m.name,
    applied: m.version <= currentVersion,
  }));
}

/**
 * Validate that the database schema matches the expected version.
 * Useful for health checks and startup verification.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{valid: boolean, currentVersion: number, expectedVersion: number, pendingMigrations: number}}
 */
export function validateSchema(db) {
  const currentVersion = getCurrentVersion(db);
  const pending = MIGRATIONS.filter(m => m.version > currentVersion).length;
  return {
    valid: currentVersion === LATEST_VERSION,
    currentVersion,
    expectedVersion: LATEST_VERSION,
    pendingMigrations: pending,
  };
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to log a migration to the migration_log table.
 * Silently succeeds if the table doesn't exist yet (e.g., during v1 migration).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{version: number, name: string}} migration
 * @param {number} durationMs
 * @private
 */
function _logMigration(db, migration, durationMs) {
  try {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='migration_log'"
    ).all();
    if (tables.length > 0) {
      db.prepare(
        'INSERT OR IGNORE INTO migration_log (version, name, duration_ms) VALUES (?, ?, ?)'
      ).run(migration.version, migration.name, durationMs);
    }
  } catch {
    // Silently ignore — migration_log may not exist yet
  }
}

export default { runMigrations, getCurrentVersion, getMigrationStatus, validateSchema, LATEST_VERSION };
