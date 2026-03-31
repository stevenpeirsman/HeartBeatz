// ==============================================================================
// Tests for CalibrationPersistence — ACC-03-T4
// ==============================================================================
// Validates save/load/restore cycle for calibration state, atomic writes,
// version checking, staleness detection, per-module error isolation, and
// periodic save lifecycle.
//
// Uses synthetic calibration module stubs with getState()/restoreState()
// to test persistence in isolation from the real calibration classes.
// ==============================================================================

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CalibrationPersistence } from './persistence.js';

// ---------------------------------------------------------------------------
// Test helpers: synthetic calibration module stubs
// ---------------------------------------------------------------------------

/**
 * Create a stub MultiTimescaleTracker-like object with getState/restoreState.
 * @param {Object} state - Initial state values
 * @returns {Object} Stub module
 */
function createTrackerStub(state = {}) {
  const defaultState = {
    fastEma: 1.2,
    mediumEma: 1.1,
    slowEma: 1.0,
    fastMeanAmp: 45.0,
    mediumMeanAmp: 44.0,
    slowMeanAmp: 43.0,
    baseline: 1.05,
    baselineMeanAmp: 44.0,
    activeScale: 'slow',
    updateCount: 100,
    sampleCount: 5000,
    lastUpdateTime: Date.now(),
    config: { fastAlpha: 0.1 },
  };
  const _state = { ...defaultState, ...state };
  let _restored = null;

  return {
    getState: () => ({ ..._state }),
    restoreState: (s) => {
      _restored = s;
      Object.assign(_state, s);
    },
    getRestoredState: () => _restored,
    _state,
  };
}

/**
 * Create a stub CusumDetector-like object.
 * @param {Object} state - Initial state values
 * @returns {Object} Stub module
 */
function createCusumStub(state = {}) {
  const defaultState = {
    cusumHigh: [0.1, 0.2, 0.3],
    cusumLow: [0.05, 0.1, 0.15],
    baselines: [10.0, 11.0, 12.0],
    runningStd: [0.5, 0.6, 0.7],
    sampleCount: 3000,
    changeCount: 2,
    lastChangeTime: Date.now() - 60000,
    config: { numChannels: 3 },
  };
  const _state = { ...defaultState, ...state };
  let _restored = null;

  return {
    getState: () => ({ ..._state }),
    restoreState: (s) => {
      _restored = s;
      Object.assign(_state, s);
    },
    getRestoredState: () => _restored,
    _state,
  };
}

/**
 * Create a stub EmptyRoomDetector-like object.
 * @param {Object} state - Initial state values
 * @returns {Object} Stub module
 */
function createEmptyRoomStub(state = {}) {
  const defaultState = {
    state: 'occupied',
    confidence: 0.8,
    observations: [{ t: Date.now(), ratio: 0.9, isQuiet: true }],
    quietStartTime: 0,
    lastSampleTime: Date.now(),
    totalObservations: 500,
    transitionCount: 3,
    config: { varianceRatioThreshold: 1.2 },
  };
  const _state = { ...defaultState, ...state };
  let _restored = null;

  return {
    getState: () => ({ ..._state }),
    restoreState: (s) => {
      _restored = s;
      Object.assign(_state, s);
    },
    getRestoredState: () => _restored,
    _state,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

const TEST_DIR = join('/tmp', `heartbeatz-persist-test-${process.pid}`);

/** Silent logger that suppresses all output during tests. */
const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe('CalibrationPersistence', () => {
  beforeEach(() => {
    // Clean test directory before each test
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  // -------------------------------------------------------------------------
  // Construction and configuration
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('should use default config when no options provided', () => {
      const p = new CalibrationPersistence({ logger: silentLogger });
      assert.equal(p.config.saveIntervalMs, 3_600_000);
      assert.equal(p.config.maxNodeAge, 604_800_000);
      assert.equal(p.config.filename, 'calibration-state.json');
      assert.equal(p.saveCount, 0);
      assert.equal(p.errorCount, 0);
    });

    it('should override defaults with provided options', () => {
      const p = new CalibrationPersistence({
        dataDir: TEST_DIR,
        saveIntervalMs: 60_000,
        maxNodeAge: 86_400_000,
        logger: silentLogger,
      });
      assert.equal(p.config.saveIntervalMs, 60_000);
      assert.equal(p.config.maxNodeAge, 86_400_000);
      assert.equal(p.config.dataDir, TEST_DIR);
    });
  });

  // -------------------------------------------------------------------------
  // Node registration
  // -------------------------------------------------------------------------

  describe('registerNode / unregisterNode', () => {
    it('should register a node with all modules', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      const tracker = createTrackerStub();
      const cusum = createCusumStub();
      const emptyRoom = createEmptyRoomStub();

      p.registerNode('aa:bb:cc:dd:ee:ff', { multiTimescale: tracker, cusum, emptyRoom });
      assert.equal(p._nodes.size, 1);
    });

    it('should register a node with partial modules', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      p.registerNode('node-1', { multiTimescale: createTrackerStub() });
      assert.equal(p._nodes.size, 1);
    });

    it('should throw on empty nodeId', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      assert.throws(() => p.registerNode(''), /nodeId must be a non-empty string/);
      assert.throws(() => p.registerNode(null), /nodeId must be a non-empty string/);
    });

    it('should unregister a node', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      p.registerNode('node-1', { multiTimescale: createTrackerStub() });
      assert.equal(p.unregisterNode('node-1'), true);
      assert.equal(p._nodes.size, 0);
    });

    it('should return false when unregistering unknown node', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      assert.equal(p.unregisterNode('unknown'), false);
    });
  });

  // -------------------------------------------------------------------------
  // State collection
  // -------------------------------------------------------------------------

  describe('collectState', () => {
    it('should collect state from all registered modules', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      const tracker = createTrackerStub();
      const cusum = createCusumStub();
      const emptyRoom = createEmptyRoomStub();

      p.registerNode('node-1', { multiTimescale: tracker, cusum, emptyRoom });
      const state = p.collectState();

      assert.equal(state.version, 1);
      assert.ok(state.savedAt);
      assert.ok(state.nodes['node-1']);
      assert.ok(state.nodes['node-1'].multiTimescale);
      assert.ok(state.nodes['node-1'].cusum);
      assert.ok(state.nodes['node-1'].emptyRoom);
      assert.equal(state.nodes['node-1'].multiTimescale.fastEma, 1.2);
    });

    it('should set null for missing modules', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      p.registerNode('node-1', { multiTimescale: createTrackerStub() });
      const state = p.collectState();

      assert.ok(state.nodes['node-1'].multiTimescale);
      assert.equal(state.nodes['node-1'].cusum, null);
      assert.equal(state.nodes['node-1'].emptyRoom, null);
    });

    it('should handle getState() throwing an error gracefully', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      const brokenModule = {
        getState: () => { throw new Error('module error'); },
        restoreState: () => {},
      };
      p.registerNode('node-1', { multiTimescale: brokenModule });
      const state = p.collectState();

      // Should not throw, but set the module state to null
      assert.equal(state.nodes['node-1'].multiTimescale, null);
    });

    it('should collect state from multiple nodes', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      p.registerNode('node-1', { multiTimescale: createTrackerStub({ fastEma: 1.0 }) });
      p.registerNode('node-2', { multiTimescale: createTrackerStub({ fastEma: 2.0 }) });
      const state = p.collectState();

      assert.equal(Object.keys(state.nodes).length, 2);
      assert.equal(state.nodes['node-1'].multiTimescale.fastEma, 1.0);
      assert.equal(state.nodes['node-2'].multiTimescale.fastEma, 2.0);
    });
  });

  // -------------------------------------------------------------------------
  // Save to disk
  // -------------------------------------------------------------------------

  describe('saveAll', () => {
    it('should save state to a JSON file', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      p.registerNode('node-1', { multiTimescale: createTrackerStub() });

      const result = p.saveAll();
      assert.equal(result.ok, true);
      assert.equal(result.nodesCount, 1);
      assert.ok(existsSync(p.filePath));

      // Verify file content is valid JSON
      const raw = readFileSync(p.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      assert.equal(parsed.version, 1);
      assert.ok(parsed.nodes['node-1']);
    });

    it('should increment saveCount on success', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      p.registerNode('node-1', { multiTimescale: createTrackerStub() });

      p.saveAll();
      assert.equal(p.saveCount, 1);
      p.saveAll();
      assert.equal(p.saveCount, 2);
    });

    it('should update lastSaveTime on success', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      p.registerNode('node-1', { multiTimescale: createTrackerStub() });

      const before = Date.now();
      p.saveAll();
      assert.ok(p.lastSaveTime >= before);
    });

    it('should skip save when no nodes registered', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      const result = p.saveAll();

      assert.equal(result.ok, true);
      assert.equal(result.nodesCount, 0);
      assert.ok(!existsSync(p.filePath));
    });

    it('should create data directory if it does not exist', () => {
      const nestedDir = join(TEST_DIR, 'nested', 'dir');
      const p = new CalibrationPersistence({ dataDir: nestedDir, logger: silentLogger });
      p.registerNode('node-1', { multiTimescale: createTrackerStub() });

      const result = p.saveAll();
      assert.equal(result.ok, true);
      assert.ok(existsSync(nestedDir));
    });

    it('should not leave a temp file on successful save', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      p.registerNode('node-1', { multiTimescale: createTrackerStub() });

      p.saveAll();
      assert.ok(!existsSync(p.filePath + '.tmp'));
    });

    it('should handle write errors gracefully', () => {
      // Use a path that should fail (directory as filename)
      const p = new CalibrationPersistence({
        dataDir: TEST_DIR,
        filename: '', // empty filename should cause error
        logger: silentLogger,
      });
      p.registerNode('node-1', { multiTimescale: createTrackerStub() });

      // This may or may not error depending on OS — just ensure no crash
      const result = p.saveAll();
      // Either ok or error, but no exception thrown
      assert.ok(typeof result.ok === 'boolean');
    });
  });

  // -------------------------------------------------------------------------
  // Load from disk
  // -------------------------------------------------------------------------

  describe('loadFromDisk', () => {
    it('should return file_not_found when no file exists', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      const result = p.loadFromDisk();

      assert.equal(result.ok, false);
      assert.equal(result.error, 'file_not_found');
    });

    it('should load a previously saved state', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      p.registerNode('node-1', { multiTimescale: createTrackerStub() });
      p.saveAll();

      const result = p.loadFromDisk();
      assert.equal(result.ok, true);
      assert.ok(result.data);
      assert.equal(result.data.version, 1);
      assert.ok(result.data.nodes['node-1']);
    });

    it('should reject wrong version number', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(p.filePath, JSON.stringify({ version: 99, savedAt: new Date().toISOString(), nodes: {} }));

      const result = p.loadFromDisk();
      assert.equal(result.ok, false);
      assert.equal(result.error, 'version_mismatch');
    });

    it('should handle corrupted JSON gracefully', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(p.filePath, '{ invalid json !!!');

      const result = p.loadFromDisk();
      assert.equal(result.ok, false);
      assert.ok(result.error);
    });

    it('should flag stale state when older than maxNodeAge', () => {
      const p = new CalibrationPersistence({
        dataDir: TEST_DIR,
        maxNodeAge: 1000,  // 1 second max age
        logger: silentLogger,
      });
      mkdirSync(TEST_DIR, { recursive: true });

      // Write state with old timestamp
      const oldDate = new Date(Date.now() - 5000).toISOString();
      writeFileSync(p.filePath, JSON.stringify({
        version: 1,
        savedAt: oldDate,
        nodes: { 'node-1': { savedAt: oldDate, multiTimescale: {} } },
      }));

      const result = p.loadFromDisk();
      assert.equal(result.ok, true);
      assert.equal(result.stale, true);
    });

    it('should not flag recent state as stale', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      p.registerNode('node-1', { multiTimescale: createTrackerStub() });
      p.saveAll();

      const result = p.loadFromDisk();
      assert.equal(result.ok, true);
      assert.equal(result.stale, false);
    });
  });

  // -------------------------------------------------------------------------
  // Restore state to modules
  // -------------------------------------------------------------------------

  describe('restoreNode', () => {
    it('should restore state to all registered modules', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      const tracker = createTrackerStub();
      const cusum = createCusumStub();
      const emptyRoom = createEmptyRoomStub();

      p.registerNode('node-1', { multiTimescale: tracker, cusum, emptyRoom });

      // Save and reload
      p.saveAll();
      const loaded = p.loadFromDisk();

      // Create fresh stubs for restoration
      const newTracker = createTrackerStub({ fastEma: 0 });
      const newCusum = createCusumStub({ sampleCount: 0 });
      const newEmptyRoom = createEmptyRoomStub({ state: 'unknown' });
      p.registerNode('node-1', { multiTimescale: newTracker, cusum: newCusum, emptyRoom: newEmptyRoom });

      const result = p.restoreNode('node-1', loaded.data);
      assert.deepEqual(result.restored, ['multiTimescale', 'cusum', 'emptyRoom']);
      assert.deepEqual(result.errors, []);

      // Verify state was actually restored
      assert.ok(newTracker.getRestoredState());
      assert.equal(newTracker.getRestoredState().fastEma, 1.2);
    });

    it('should skip modules with no persisted state', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      p.registerNode('node-1', { multiTimescale: createTrackerStub() });
      p.saveAll();
      const loaded = p.loadFromDisk();

      // Register with all three modules but only one was saved
      p.registerNode('node-1', {
        multiTimescale: createTrackerStub(),
        cusum: createCusumStub(),
        emptyRoom: createEmptyRoomStub(),
      });

      const result = p.restoreNode('node-1', loaded.data);
      assert.ok(result.restored.includes('multiTimescale'));
      assert.ok(result.skipped.includes('cusum'));
      assert.ok(result.skipped.includes('emptyRoom'));
    });

    it('should return empty result for unknown node', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      const result = p.restoreNode('unknown', { version: 1, nodes: {} });

      assert.deepEqual(result.restored, []);
      assert.deepEqual(result.errors, []);
    });

    it('should error when node is not registered', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      const result = p.restoreNode('node-1', {
        version: 1,
        nodes: { 'node-1': { multiTimescale: {} } },
      });

      assert.ok(result.errors.includes('node_not_registered'));
    });

    it('should handle restoreState() throwing an error', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      const brokenModule = {
        getState: () => ({ broken: true }),
        restoreState: () => { throw new Error('restore failed'); },
      };
      p.registerNode('node-1', { multiTimescale: brokenModule });

      const state = {
        version: 1,
        nodes: { 'node-1': { savedAt: new Date().toISOString(), multiTimescale: { broken: true } } },
      };

      const result = p.restoreNode('node-1', state);
      assert.ok(result.errors.includes('multiTimescale'));
    });

    it('should skip stale per-node state', () => {
      const p = new CalibrationPersistence({
        dataDir: TEST_DIR,
        maxNodeAge: 1000,  // 1 second
        logger: silentLogger,
      });
      p.registerNode('node-1', { multiTimescale: createTrackerStub() });

      const oldDate = new Date(Date.now() - 5000).toISOString();
      const state = {
        version: 1,
        nodes: { 'node-1': { savedAt: oldDate, multiTimescale: { fastEma: 1.0 } } },
      };

      const result = p.restoreNode('node-1', state);
      assert.ok(result.skipped.includes('all_stale'));
    });
  });

  // -------------------------------------------------------------------------
  // Full save/load/restore cycle
  // -------------------------------------------------------------------------

  describe('loadAndRestoreAll', () => {
    it('should perform full save-load-restore cycle', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      const tracker = createTrackerStub({ fastEma: 5.5, baseline: 3.3 });
      const cusum = createCusumStub({ sampleCount: 999 });

      p.registerNode('node-1', { multiTimescale: tracker, cusum });
      p.saveAll();

      // Create new persistence instance (simulating restart)
      const p2 = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      const newTracker = createTrackerStub({ fastEma: 0 });
      const newCusum = createCusumStub({ sampleCount: 0 });
      p2.registerNode('node-1', { multiTimescale: newTracker, cusum: newCusum });

      const summary = p2.loadAndRestoreAll();
      assert.equal(summary.loaded, true);
      assert.equal(summary.stale, false);
      assert.ok(summary.results['node-1']);
      assert.ok(summary.results['node-1'].restored.includes('multiTimescale'));
      assert.ok(summary.results['node-1'].restored.includes('cusum'));

      // Verify actual state restoration
      assert.equal(newTracker.getRestoredState().fastEma, 5.5);
      assert.equal(newCusum.getRestoredState().sampleCount, 999);
    });

    it('should handle no file gracefully on restart', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      p.registerNode('node-1', { multiTimescale: createTrackerStub() });

      const summary = p.loadAndRestoreAll();
      assert.equal(summary.loaded, false);
    });
  });

  // -------------------------------------------------------------------------
  // Periodic save lifecycle
  // -------------------------------------------------------------------------

  describe('startPeriodicSave', () => {
    it('should return a cleanup function', () => {
      const p = new CalibrationPersistence({
        dataDir: TEST_DIR,
        saveIntervalMs: 100_000,  // long interval so it doesn't fire during test
        saveOnShutdown: false,
        logger: silentLogger,
      });

      const cleanup = p.startPeriodicSave();
      assert.equal(typeof cleanup, 'function');
      assert.ok(p._intervalId !== null);

      cleanup();
      assert.equal(p._intervalId, null);
    });

    it('should not start duplicate intervals', () => {
      const p = new CalibrationPersistence({
        dataDir: TEST_DIR,
        saveIntervalMs: 100_000,
        saveOnShutdown: false,
        logger: silentLogger,
      });

      const cleanup1 = p.startPeriodicSave();
      const id1 = p._intervalId;

      const cleanup2 = p.startPeriodicSave();
      const id2 = p._intervalId;

      // Should be the same interval
      assert.equal(id1, id2);

      cleanup1();
      cleanup2();
    });
  });

  // -------------------------------------------------------------------------
  // Status and diagnostics
  // -------------------------------------------------------------------------

  describe('getStatus', () => {
    it('should return diagnostic summary', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      p.registerNode('node-1', { multiTimescale: createTrackerStub() });

      const status = p.getStatus();
      assert.equal(status.registeredNodes, 1);
      assert.equal(status.saveCount, 0);
      assert.equal(status.errorCount, 0);
      assert.equal(status.lastSaveTime, null);
      assert.equal(status.periodicSaveActive, false);
    });

    it('should reflect state after save', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      p.registerNode('node-1', { multiTimescale: createTrackerStub() });
      p.saveAll();

      const status = p.getStatus();
      assert.equal(status.saveCount, 1);
      assert.ok(status.lastSaveTime);
    });
  });

  // -------------------------------------------------------------------------
  // Clear persisted state
  // -------------------------------------------------------------------------

  describe('clearPersistedState', () => {
    it('should delete the persistence file', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      p.registerNode('node-1', { multiTimescale: createTrackerStub() });
      p.saveAll();

      assert.ok(existsSync(p.filePath));
      const result = p.clearPersistedState();
      assert.equal(result.ok, true);
      assert.ok(!existsSync(p.filePath));
    });

    it('should succeed even if file does not exist', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      const result = p.clearPersistedState();
      assert.equal(result.ok, true);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases and robustness
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should handle multiple nodes with different module combinations', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      p.registerNode('node-1', { multiTimescale: createTrackerStub({ fastEma: 1.0 }) });
      p.registerNode('node-2', { cusum: createCusumStub({ sampleCount: 42 }) });
      p.registerNode('node-3', { emptyRoom: createEmptyRoomStub({ state: 'empty' }) });

      p.saveAll();
      const loaded = p.loadFromDisk();

      assert.equal(loaded.ok, true);
      assert.equal(Object.keys(loaded.data.nodes).length, 3);
      assert.ok(loaded.data.nodes['node-1'].multiTimescale);
      assert.equal(loaded.data.nodes['node-1'].cusum, null);
      assert.ok(loaded.data.nodes['node-2'].cusum);
      assert.ok(loaded.data.nodes['node-3'].emptyRoom);
    });

    it('should overwrite previous save file', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      p.registerNode('node-1', { multiTimescale: createTrackerStub({ fastEma: 1.0 }) });
      p.saveAll();

      // Re-register with different state
      p.registerNode('node-1', { multiTimescale: createTrackerStub({ fastEma: 99.0 }) });
      p.saveAll();

      const loaded = p.loadFromDisk();
      assert.equal(loaded.data.nodes['node-1'].multiTimescale.fastEma, 99.0);
    });

    it('should survive a module with no getState method', () => {
      const p = new CalibrationPersistence({ dataDir: TEST_DIR, logger: silentLogger });
      p.registerNode('node-1', { multiTimescale: { foo: 'bar' } });

      const state = p.collectState();
      assert.equal(state.nodes['node-1'].multiTimescale, null);
    });
  });
});
