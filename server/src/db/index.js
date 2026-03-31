// ==============================================================================
// HeartBeatz Database Module — SQLite Initialization & Connection Management
// ==============================================================================
// INFRA-01 + DB-01 + DB-02: Provides a centralized database layer using
// better-sqlite3 with version-tracked migrations.
//
// Usage:
//   import { initDatabase, getDb } from './db/index.js';
//   const db = initDatabase({ logger, dataDir: './data' });
//   // ... or later ...
//   const db = getDb();
//
// Architecture decisions:
//   - better-sqlite3: synchronous API, zero-config, fast, portable (ADR-2026-03-31)
//   - Single .sqlite file in server/data/ directory
//   - WAL mode for concurrent reads during SSE streaming
//   - Schema version tracked in user_version pragma
//   - Migrations managed via db/migrations.js (DB-02)
// ==============================================================================

import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { runMigrations, LATEST_VERSION, getCurrentVersion, getMigrationStatus, validateSchema } from './migrations.js';

/** @type {Database.Database|null} Singleton database instance */
let _db = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the database connection and run schema migrations.
 * Safe to call multiple times — returns existing connection if already init'd.
 *
 * @param {Object} options
 * @param {Object} options.logger - Pino logger instance
 * @param {string} [options.dataDir] - Directory for the .sqlite file (default: server/data/)
 * @param {string} [options.filename] - Database filename (default: heartbeatz.sqlite)
 * @param {boolean} [options.inMemory] - Use in-memory database (for testing)
 * @returns {Database.Database} The better-sqlite3 database instance
 */
export function initDatabase({ logger, dataDir, filename = 'heartbeatz.sqlite', inMemory = false } = {}) {
  if (_db) {
    logger?.debug('Database already initialized, returning existing connection');
    return _db;
  }

  const log = logger?.child({ module: 'db' });

  // Resolve database path
  let dbPath;
  if (inMemory) {
    dbPath = ':memory:';
    log?.info('Initializing in-memory database (testing mode)');
  } else {
    const dir = dataDir || join(process.cwd(), 'data');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      log?.info({ dir }, 'Created data directory');
    }
    dbPath = join(dir, filename);
    log?.info({ path: dbPath }, 'Initializing SQLite database');
  }

  // Open connection with WAL mode for better concurrent read performance
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');

  // Run all pending migrations via the migration system (DB-02)
  const result = runMigrations(_db, log);
  if (result.applied > 0) {
    log?.info(
      { migrationsApplied: result.applied, schemaVersion: result.toVersion },
      'Database migrations complete'
    );
  }

  return _db;
}

/**
 * Get the current database instance. Throws if not initialized.
 *
 * @returns {Database.Database} The better-sqlite3 database instance
 * @throws {Error} If initDatabase() hasn't been called yet
 */
export function getDb() {
  if (!_db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return _db;
}

/**
 * Close the database connection gracefully.
 * Should be called during server shutdown.
 *
 * @param {Object} [logger] - Optional pino logger
 */
export function closeDatabase(logger) {
  if (_db) {
    logger?.info('Closing database connection');
    _db.close();
    _db = null;
  }
}

/**
 * Reset the singleton for testing purposes.
 * @private
 */
export function _resetDbSingleton() {
  _db = null;
}

// Re-export migration utilities for use by health checks and admin endpoints
export { getCurrentVersion, getMigrationStatus, validateSchema, LATEST_VERSION };

export default { initDatabase, getDb, closeDatabase };
