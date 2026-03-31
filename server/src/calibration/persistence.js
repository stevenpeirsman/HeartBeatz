// ==============================================================================
// Baseline Persistence — ACC-03-T4
// ==============================================================================
// Saves and loads calibration state for all three calibration modules
// (MultiTimescaleTracker, CusumDetector, EmptyRoomDetector) per node.
//
// Persistence strategy:
//   - Save periodically on a configurable interval (default: 1 hour)
//   - Save on graceful shutdown (SIGTERM, SIGINT)
//   - Load on startup, restoring state to each module via restoreState()
//   - Atomic writes: write to temp file, then rename (prevents corruption)
//   - Per-node state stored in a single JSON file in the data directory
//
// File format (JSON):
//   {
//     version: 1,
//     savedAt: "2026-03-31T12:00:00.000Z",
//     nodes: {
//       "aa:bb:cc:dd:ee:ff": {
//         multiTimescale: { ... },  // from MultiTimescaleTracker.getState()
//         cusum: { ... },            // from CusumDetector.getState()
//         emptyRoom: { ... },        // from EmptyRoomDetector.getState()
//         savedAt: "2026-03-31T12:00:00.000Z"
//       }
//     }
//   }
//
// Usage:
//   import { CalibrationPersistence } from './calibration/persistence.js';
//   const persist = new CalibrationPersistence({ dataDir: './data' });
//
//   // Register calibration modules for a node
//   persist.registerNode('aa:bb:cc:dd:ee:ff', {
//     multiTimescale: tracker,
//     cusum: detector,
//     emptyRoom: emptyRoomDetector,
//   });
//
//   // Start periodic saving (returns cleanup function)
//   const cleanup = persist.startPeriodicSave();
//
//   // On shutdown:
//   await persist.saveAll();
//   cleanup();
//
// ==============================================================================

import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';

/**
 * Current persistence file format version.
 * Increment when the schema changes in a backward-incompatible way.
 * @type {number}
 */
const PERSISTENCE_VERSION = 1;

/**
 * Default configuration for calibration persistence.
 *
 * @typedef {Object} PersistenceConfig
 * @property {string}  dataDir          - Directory for persistence files (default: './data')
 * @property {string}  filename         - Name of the persistence file (default: 'calibration-state.json')
 * @property {number}  saveIntervalMs   - Periodic save interval in ms (default: 3600000 = 1 hour)
 * @property {number}  maxNodeAge       - Max age in ms before a node's state is considered stale on load (default: 604800000 = 7 days)
 * @property {boolean} saveOnShutdown   - Register SIGTERM/SIGINT handlers for graceful shutdown save (default: true)
 * @property {Object|null} logger       - Pino logger instance (default: null, uses console)
 */
const DEFAULT_CONFIG = Object.freeze({
  dataDir:        './data',
  filename:       'calibration-state.json',
  saveIntervalMs: 3_600_000,   // 1 hour
  maxNodeAge:     604_800_000,  // 7 days in ms
  saveOnShutdown: true,
  logger:         null,
});

/**
 * Manages persistence of calibration state for all registered nodes.
 *
 * Coordinates saving and loading of state from MultiTimescaleTracker,
 * CusumDetector, and EmptyRoomDetector instances. Uses atomic file
 * writes (write temp + rename) to prevent corruption on power loss.
 *
 * @example
 * const persist = new CalibrationPersistence({ dataDir: './data' });
 * persist.registerNode('aa:bb:cc:dd:ee:ff', { multiTimescale, cusum, emptyRoom });
 * const cleanup = persist.startPeriodicSave();
 * // ... later, on shutdown:
 * await persist.saveAll();
 * cleanup();
 */
export class CalibrationPersistence {
  /**
   * Create a new persistence manager.
   * @param {Partial<PersistenceConfig>} [options={}] - Override default config values
   */
  constructor(options = {}) {
    /** @type {PersistenceConfig} */
    this.config = { ...DEFAULT_CONFIG, ...options };

    /**
     * Registry of calibration modules per node MAC address.
     * @type {Map<string, { multiTimescale: Object|null, cusum: Object|null, emptyRoom: Object|null }>}
     */
    this._nodes = new Map();

    /** @type {number|null} Interval timer ID for periodic saves */
    this._intervalId = null;

    /** @type {boolean} Whether shutdown handlers have been registered */
    this._shutdownRegistered = false;

    /** @type {number} Total successful saves since construction */
    this.saveCount = 0;

    /** @type {number} Total failed saves since construction */
    this.errorCount = 0;

    /** @type {number} Timestamp of last successful save */
    this.lastSaveTime = 0;

    /** @type {string} Full path to the persistence file */
    this.filePath = join(this.config.dataDir, this.config.filename);

    this._log = this.config.logger || this._fallbackLogger();
  }

  /**
   * Create a minimal console-based logger matching pino's API shape.
   * @returns {Object} Logger with info/warn/error methods
   * @private
   */
  _fallbackLogger() {
    return {
      info:  (obj, msg) => console.log(`[persistence] ${msg || ''}`, obj || ''),
      warn:  (obj, msg) => console.warn(`[persistence] ${msg || ''}`, obj || ''),
      error: (obj, msg) => console.error(`[persistence] ${msg || ''}`, obj || ''),
      debug: (obj, msg) => console.debug(`[persistence] ${msg || ''}`, obj || ''),
    };
  }

  /**
   * Register a node's calibration modules for persistence.
   *
   * Each module must implement getState() and restoreState() methods.
   * Any module can be null if not yet created for this node.
   *
   * @param {string} nodeId - Node identifier (typically MAC address)
   * @param {{ multiTimescale?: Object, cusum?: Object, emptyRoom?: Object }} modules - Calibration module instances
   */
  registerNode(nodeId, modules = {}) {
    if (!nodeId || typeof nodeId !== 'string') {
      throw new Error('CalibrationPersistence.registerNode(): nodeId must be a non-empty string');
    }

    this._nodes.set(nodeId, {
      multiTimescale: modules.multiTimescale || null,
      cusum:          modules.cusum || null,
      emptyRoom:      modules.emptyRoom || null,
    });

    this._log.info({ nodeId, modules: Object.keys(modules).filter(k => modules[k]) },
      'Registered node for calibration persistence');
  }

  /**
   * Unregister a node (e.g., on node removal or disconnect).
   *
   * @param {string} nodeId - Node identifier to remove
   * @returns {boolean} True if the node was registered and removed
   */
  unregisterNode(nodeId) {
    const removed = this._nodes.delete(nodeId);
    if (removed) {
      this._log.info({ nodeId }, 'Unregistered node from calibration persistence');
    }
    return removed;
  }

  /**
   * Collect serializable state from all registered nodes.
   *
   * Calls getState() on each module for each registered node.
   * Catches and logs errors from individual modules without failing the whole save.
   *
   * @returns {{ version: number, savedAt: string, nodes: Object }} Serializable persistence envelope
   */
  collectState() {
    const nodes = {};

    for (const [nodeId, modules] of this._nodes.entries()) {
      const nodeState = { savedAt: new Date().toISOString() };

      // Collect state from each module, catching errors per-module
      for (const [key, instance] of Object.entries(modules)) {
        if (instance && typeof instance.getState === 'function') {
          try {
            nodeState[key] = instance.getState();
          } catch (err) {
            this._log.error({ nodeId, module: key, err: err.message },
              'Failed to collect state from calibration module');
            nodeState[key] = null;
          }
        } else {
          nodeState[key] = null;
        }
      }

      nodes[nodeId] = nodeState;
    }

    return {
      version: PERSISTENCE_VERSION,
      savedAt: new Date().toISOString(),
      nodes,
    };
  }

  /**
   * Save all registered node states to disk.
   *
   * Uses atomic write pattern:
   *   1. Write to temporary file (filename + '.tmp')
   *   2. Rename temp file over target file
   *
   * This ensures that a crash during write leaves either the old file
   * intact or the new file fully written — never a partial write.
   *
   * @returns {{ ok: boolean, nodesCount: number, error?: string }} Save result
   */
  saveAll() {
    const state = this.collectState();
    const nodeCount = Object.keys(state.nodes).length;

    if (nodeCount === 0) {
      this._log.debug({}, 'No nodes registered — skipping save');
      return { ok: true, nodesCount: 0 };
    }

    const tempPath = this.filePath + '.tmp';

    try {
      // Ensure data directory exists
      if (!existsSync(this.config.dataDir)) {
        mkdirSync(this.config.dataDir, { recursive: true });
        this._log.info({ dir: this.config.dataDir }, 'Created data directory for persistence');
      }

      // Atomic write: temp file → rename
      const json = JSON.stringify(state, null, 2);
      writeFileSync(tempPath, json, 'utf-8');
      renameSync(tempPath, this.filePath);

      this.saveCount++;
      this.lastSaveTime = Date.now();

      this._log.info({
        nodesCount: nodeCount,
        saveCount: this.saveCount,
        fileSizeBytes: json.length,
      }, 'Calibration state saved to disk');

      return { ok: true, nodesCount: nodeCount };
    } catch (err) {
      this.errorCount++;
      this._log.error({ err: err.message, filePath: this.filePath },
        'Failed to save calibration state');

      // Clean up temp file if it exists
      try {
        if (existsSync(tempPath)) {
          unlinkSync(tempPath);
        }
      } catch { /* ignore cleanup errors */ }

      return { ok: false, nodesCount: nodeCount, error: err.message };
    }
  }

  /**
   * Load persisted calibration state from disk.
   *
   * Returns the raw state envelope. Does NOT automatically restore state
   * to modules — call restoreNode() or restoreAll() after loading.
   *
   * @returns {{ ok: boolean, data?: Object, error?: string, stale?: boolean }} Load result
   */
  loadFromDisk() {
    if (!existsSync(this.filePath)) {
      this._log.info({ filePath: this.filePath }, 'No persisted calibration state found');
      return { ok: false, error: 'file_not_found' };
    }

    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw);

      // Version check
      if (data.version !== PERSISTENCE_VERSION) {
        this._log.warn({
          fileVersion: data.version,
          expectedVersion: PERSISTENCE_VERSION,
        }, 'Calibration state version mismatch — ignoring stale file');
        return { ok: false, error: 'version_mismatch' };
      }

      // Staleness check
      const savedAt = new Date(data.savedAt).getTime();
      const age = Date.now() - savedAt;
      const stale = age > this.config.maxNodeAge;

      if (stale) {
        this._log.warn({
          savedAt: data.savedAt,
          ageMs: age,
          maxAge: this.config.maxNodeAge,
        }, 'Calibration state is older than maxNodeAge — flagging as stale');
      }

      this._log.info({
        savedAt: data.savedAt,
        nodesCount: Object.keys(data.nodes || {}).length,
        stale,
      }, 'Loaded calibration state from disk');

      return { ok: true, data, stale };
    } catch (err) {
      this._log.error({ err: err.message, filePath: this.filePath },
        'Failed to load calibration state from disk');
      return { ok: false, error: err.message };
    }
  }

  /**
   * Restore persisted state to a single node's calibration modules.
   *
   * Looks up the node in the loaded state and calls restoreState() on
   * each module that has persisted data. Returns a summary of which
   * modules were restored.
   *
   * @param {string} nodeId   - Node identifier to restore
   * @param {Object} loadedState - State envelope from loadFromDisk().data
   * @returns {{ restored: string[], skipped: string[], errors: string[] }} Restoration result
   */
  restoreNode(nodeId, loadedState) {
    const result = { restored: [], skipped: [], errors: [] };

    if (!loadedState || !loadedState.nodes || !loadedState.nodes[nodeId]) {
      this._log.info({ nodeId }, 'No persisted state found for node');
      return result;
    }

    const nodeState = loadedState.nodes[nodeId];
    const modules = this._nodes.get(nodeId);

    if (!modules) {
      this._log.warn({ nodeId }, 'Node not registered — cannot restore state');
      result.errors.push('node_not_registered');
      return result;
    }

    // Check per-node staleness
    if (nodeState.savedAt) {
      const nodeAge = Date.now() - new Date(nodeState.savedAt).getTime();
      if (nodeAge > this.config.maxNodeAge) {
        this._log.warn({ nodeId, ageMs: nodeAge },
          'Node state is stale — skipping restoration');
        result.skipped.push('all_stale');
        return result;
      }
    }

    // Restore each module
    for (const key of ['multiTimescale', 'cusum', 'emptyRoom']) {
      const instance = modules[key];
      const savedModuleState = nodeState[key];

      if (!instance) {
        result.skipped.push(key);
        continue;
      }

      if (!savedModuleState) {
        result.skipped.push(key);
        continue;
      }

      if (typeof instance.restoreState !== 'function') {
        this._log.warn({ nodeId, module: key },
          'Module does not implement restoreState()');
        result.errors.push(key);
        continue;
      }

      try {
        instance.restoreState(savedModuleState);
        result.restored.push(key);
        this._log.info({ nodeId, module: key }, 'Restored calibration module state');
      } catch (err) {
        this._log.error({ nodeId, module: key, err: err.message },
          'Failed to restore calibration module state');
        result.errors.push(key);
      }
    }

    return result;
  }

  /**
   * Load from disk and restore state to all registered nodes.
   *
   * Convenience method that combines loadFromDisk() and restoreNode()
   * for all registered nodes. Safe to call at startup.
   *
   * @returns {{ loaded: boolean, stale: boolean, results: Object<string, Object> }} Summary of restoration
   */
  loadAndRestoreAll() {
    const loadResult = this.loadFromDisk();

    if (!loadResult.ok) {
      this._log.info({ error: loadResult.error },
        'No state to restore — starting fresh calibration');
      return { loaded: false, stale: false, results: {} };
    }

    const results = {};
    for (const nodeId of this._nodes.keys()) {
      results[nodeId] = this.restoreNode(nodeId, loadResult.data);
    }

    this._log.info({
      nodesRestored: Object.keys(results).length,
      stale: loadResult.stale,
    }, 'Calibration state restoration complete');

    return { loaded: true, stale: loadResult.stale || false, results };
  }

  /**
   * Start periodic automatic saves on a configurable interval.
   *
   * Optionally registers process signal handlers for graceful shutdown.
   * Returns a cleanup function that stops the interval and removes handlers.
   *
   * @returns {Function} Cleanup function — call to stop periodic saves
   */
  startPeriodicSave() {
    if (this._intervalId !== null) {
      this._log.warn({}, 'Periodic save already running — ignoring duplicate start');
      return this._makeCleanup();
    }

    this._intervalId = setInterval(() => {
      this.saveAll();
    }, this.config.saveIntervalMs);

    // Prevent interval from keeping the process alive
    if (this._intervalId.unref) {
      this._intervalId.unref();
    }

    this._log.info({
      intervalMs: this.config.saveIntervalMs,
      intervalHuman: `${(this.config.saveIntervalMs / 60_000).toFixed(1)} min`,
    }, 'Started periodic calibration state save');

    // Register shutdown handlers if configured
    if (this.config.saveOnShutdown && !this._shutdownRegistered) {
      this._registerShutdownHandlers();
    }

    return this._makeCleanup();
  }

  /**
   * Register process signal handlers for graceful shutdown save.
   *
   * Saves state on SIGTERM and SIGINT before the process exits.
   * Handlers are registered once and tracked to prevent duplicates.
   *
   * @private
   */
  _registerShutdownHandlers() {
    const shutdownHandler = (signal) => {
      this._log.info({ signal }, 'Shutdown signal received — saving calibration state');
      this.saveAll();
      // Do not call process.exit() — let the normal shutdown continue
    };

    this._sigTermHandler = shutdownHandler;
    this._sigIntHandler = shutdownHandler;

    process.on('SIGTERM', this._sigTermHandler);
    process.on('SIGINT', this._sigIntHandler);
    this._shutdownRegistered = true;

    this._log.info({}, 'Registered shutdown handlers for calibration persistence');
  }

  /**
   * Create a cleanup function that stops periodic saves and removes handlers.
   *
   * @returns {Function} Cleanup function
   * @private
   */
  _makeCleanup() {
    return () => {
      if (this._intervalId !== null) {
        clearInterval(this._intervalId);
        this._intervalId = null;
        this._log.info({}, 'Stopped periodic calibration state save');
      }

      if (this._shutdownRegistered) {
        if (this._sigTermHandler) process.removeListener('SIGTERM', this._sigTermHandler);
        if (this._sigIntHandler) process.removeListener('SIGINT', this._sigIntHandler);
        this._shutdownRegistered = false;
        this._log.info({}, 'Removed shutdown handlers for calibration persistence');
      }
    };
  }

  /**
   * Get diagnostic summary for health/status endpoints.
   *
   * @returns {Object} Persistence health summary
   */
  getStatus() {
    return {
      registeredNodes: this._nodes.size,
      saveCount: this.saveCount,
      errorCount: this.errorCount,
      lastSaveTime: this.lastSaveTime > 0 ? new Date(this.lastSaveTime).toISOString() : null,
      periodicSaveActive: this._intervalId !== null,
      filePath: this.filePath,
      saveIntervalMs: this.config.saveIntervalMs,
    };
  }

  /**
   * Delete the persisted state file from disk.
   * Useful for forcing a fresh calibration on next startup.
   *
   * @returns {{ ok: boolean, error?: string }} Deletion result
   */
  clearPersistedState() {
    try {
      if (existsSync(this.filePath)) {
        unlinkSync(this.filePath);
        this._log.info({ filePath: this.filePath }, 'Cleared persisted calibration state');
      }
      return { ok: true };
    } catch (err) {
      this._log.error({ err: err.message }, 'Failed to clear persisted state');
      return { ok: false, error: err.message };
    }
  }
}
