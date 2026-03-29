// ==============================================================================
// OTA Manager — Unit Tests
// ==============================================================================
// Tests the OtaManager service: firmware storage, version checking, update
// tracking, and state persistence. Uses Node.js built-in test runner.
//
// Run: node --test src/ota-manager.test.js

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OtaManager } from './ota-manager.js';
import { createMockLogger, createTestConfig, createMockStateStore, waitForEvent } from './test-helpers.js';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_FW_DIR = join(__dirname, '..', '..', 'data', 'firmware');

/**
 * Create a fake ESP-IDF firmware binary for testing.
 * Real ESP-IDF binaries start with 0xE9; we simulate that.
 *
 * @param {number} size - Binary size in bytes
 * @returns {Buffer}
 */
function createFakeFirmware(size = 100 * 1024) {
  const buf = Buffer.alloc(size);
  buf[0] = 0xE9; // ESP-IDF magic byte
  // Fill with pseudo-random data so checksums differ between calls
  for (let i = 1; i < size; i++) {
    buf[i] = (i * 7 + 3) & 0xFF;
  }
  return buf;
}

/**
 * Helper to create a fresh OtaManager for each test.
 */
function createOtaManager(initialState = null) {
  const config = createTestConfig();
  const logger = createMockLogger();
  const store = createMockStateStore(initialState);
  const ota = new OtaManager(config, store.loadState, store.saveState, logger);
  return { ota, config, logger, store };
}

// Clean up test firmware directory after all tests
function cleanupFirmwareDir() {
  if (existsSync(TEST_FW_DIR)) {
    try { rmSync(TEST_FW_DIR, { recursive: true }); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
describe('OtaManager', () => {

  beforeEach(() => { cleanupFirmwareDir(); });
  afterEach(() => { cleanupFirmwareDir(); });

  // ── Initialization ──

  describe('init()', () => {
    it('creates the firmware directory if it does not exist', async () => {
      const { ota } = createOtaManager();
      await ota.init();
      assert.ok(existsSync(TEST_FW_DIR), 'Firmware dir should exist after init');
    });

    it('clears metadata if the referenced firmware file is missing', async () => {
      // Pre-seed state with firmware metadata pointing to a non-existent file
      const { ota, store } = createOtaManager({
        nodes: {},
        calibration: null,
        firstRunComplete: false,
        firmware: {
          version: '0.9.0',
          filename: 'ghost-firmware.bin',
          size: 50000,
          checksum: 'abc123',
        },
      });
      await ota.init();

      const state = store.getState();
      assert.equal(state.firmware, undefined, 'Stale firmware metadata should be cleared');
    });
  });

  // ── Firmware Storage ──

  describe('storeFirmware()', () => {
    it('stores a valid firmware binary and returns metadata', async () => {
      const { ota } = createOtaManager();
      await ota.init();

      const binary = createFakeFirmware(100 * 1024);
      const result = ota.storeFirmware(binary, '1.1.0', 'Test release');

      assert.ok(result.ok, 'storeFirmware should return ok=true');
      assert.equal(result.firmware.version, '1.1.0');
      assert.equal(result.firmware.size, binary.length);
      assert.equal(result.firmware.notes, 'Test release');
      assert.ok(result.firmware.checksum, 'Should have a checksum');
      assert.ok(result.firmware.uploadedAt > 0, 'Should have an upload timestamp');
    });

    it('rejects firmware that is too small', async () => {
      const { ota } = createOtaManager();
      await ota.init();

      const tinyBuf = Buffer.alloc(100); // Way too small
      const result = ota.storeFirmware(tinyBuf, '0.0.1');

      assert.equal(result.ok, false);
      assert.ok(result.error.includes('too small'), 'Error should mention size');
    });

    it('rejects firmware that is too large', async () => {
      const { ota } = createOtaManager();
      await ota.init();

      const hugeBuf = Buffer.alloc(2 * 1024 * 1024); // 2MB — exceeds 1.75MB limit
      const result = ota.storeFirmware(hugeBuf, '99.0.0');

      assert.equal(result.ok, false);
      assert.ok(result.error.includes('too large'), 'Error should mention size');
    });

    it('rejects non-buffer input', async () => {
      const { ota } = createOtaManager();
      await ota.init();

      const result = ota.storeFirmware('not-a-buffer', '1.0.0');
      assert.equal(result.ok, false);
    });

    it('rejects missing version string', async () => {
      const { ota } = createOtaManager();
      await ota.init();

      const binary = createFakeFirmware();
      const result = ota.storeFirmware(binary, '');
      assert.equal(result.ok, false);
    });

    it('emits firmware:uploaded event on success', async () => {
      const { ota } = createOtaManager();
      await ota.init();

      const binary = createFakeFirmware();
      const eventPromise = waitForEvent(ota, 'firmware:uploaded', 1000);
      ota.storeFirmware(binary, '2.0.0');

      const meta = await eventPromise;
      assert.equal(meta.version, '2.0.0');
    });

    it('removes previous firmware file when storing a new version', async () => {
      const { ota } = createOtaManager();
      await ota.init();

      // Store v1.0.0
      const result1 = ota.storeFirmware(createFakeFirmware(), '1.0.0');
      assert.ok(result1.ok, 'v1.0.0 store should succeed');
      const v1Path = join(TEST_FW_DIR, 'heartbeatz-1.0.0.bin');
      assert.ok(existsSync(v1Path), 'v1.0.0 binary should exist');

      // Verify state has the v1.0.0 metadata
      const currentFw = ota.getCurrentFirmware();
      assert.equal(currentFw.version, '1.0.0', 'Current firmware should be v1.0.0');

      // Store v1.1.0 — should remove v1.0.0
      const result2 = ota.storeFirmware(createFakeFirmware(), '1.1.0');
      assert.ok(result2.ok, 'v1.1.0 store should succeed');
      assert.ok(!existsSync(v1Path), 'v1.0.0 binary should be deleted');

      const v2Path = join(TEST_FW_DIR, 'heartbeatz-1.1.0.bin');
      assert.ok(existsSync(v2Path), 'v1.1.0 binary should exist');
    });

    it('persists firmware metadata in state', async () => {
      const { ota, store } = createOtaManager();
      await ota.init();

      ota.storeFirmware(createFakeFirmware(), '3.0.0');

      const state = store.getState();
      assert.equal(state.firmware.version, '3.0.0');
    });
  });

  // ── getCurrentFirmware / getFirmwareBinary ──

  describe('getCurrentFirmware()', () => {
    it('returns null when no firmware is stored', async () => {
      const { ota } = createOtaManager();
      await ota.init();
      assert.equal(ota.getCurrentFirmware(), null);
    });

    it('returns metadata after storing firmware', async () => {
      const { ota } = createOtaManager();
      await ota.init();
      ota.storeFirmware(createFakeFirmware(), '1.0.0');

      const fw = ota.getCurrentFirmware();
      assert.equal(fw.version, '1.0.0');
    });
  });

  describe('getFirmwareBinary()', () => {
    it('returns null when no firmware is stored', async () => {
      const { ota } = createOtaManager();
      await ota.init();
      assert.equal(ota.getFirmwareBinary(), null);
    });

    it('returns the binary data after storing', async () => {
      const { ota } = createOtaManager();
      await ota.init();
      const original = createFakeFirmware(80 * 1024);
      ota.storeFirmware(original, '1.0.0');

      const retrieved = ota.getFirmwareBinary();
      assert.ok(Buffer.isBuffer(retrieved));
      assert.equal(retrieved.length, original.length);
      assert.ok(original.equals(retrieved), 'Binary content should match');
    });
  });

  // ── deleteFirmware ──

  describe('deleteFirmware()', () => {
    it('removes firmware file and clears metadata', async () => {
      const { ota, store } = createOtaManager();
      await ota.init();
      ota.storeFirmware(createFakeFirmware(), '1.0.0');

      ota.deleteFirmware();

      assert.equal(ota.getCurrentFirmware(), null);
      assert.equal(ota.getFirmwareBinary(), null);
      assert.equal(store.getState().firmware, undefined);
    });

    it('emits firmware:deleted event', async () => {
      const { ota } = createOtaManager();
      await ota.init();
      ota.storeFirmware(createFakeFirmware(), '1.0.0');

      const eventPromise = waitForEvent(ota, 'firmware:deleted', 1000);
      ota.deleteFirmware();
      await eventPromise; // Should resolve without timeout
    });
  });

  // ── Version Checking ──

  describe('checkForUpdate()', () => {
    it('returns needsUpdate=false when no firmware is stored', async () => {
      const { ota } = createOtaManager();
      await ota.init();

      const result = ota.checkForUpdate('1.0.0');
      assert.equal(result.needsUpdate, false);
    });

    it('returns needsUpdate=false when versions match', async () => {
      const { ota } = createOtaManager();
      await ota.init();
      ota.storeFirmware(createFakeFirmware(), '2.0.0');

      const result = ota.checkForUpdate('2.0.0');
      assert.equal(result.needsUpdate, false);
    });

    it('returns needsUpdate=true when versions differ', async () => {
      const { ota } = createOtaManager();
      await ota.init();
      ota.storeFirmware(createFakeFirmware(), '2.0.0');

      const result = ota.checkForUpdate('1.0.0');
      assert.equal(result.needsUpdate, true);
      assert.equal(result.firmware.version, '2.0.0');
      assert.ok(result.firmware.size > 0);
      assert.ok(result.firmware.checksum);
    });
  });

  // ── Update Tracking ──

  describe('update tracking', () => {
    it('tracks OTA update start, progress, and completion', async () => {
      const { ota } = createOtaManager();
      await ota.init();

      ota.trackUpdateStart('node-1', 100000);
      let status = ota.getUpdateStatus();
      assert.equal(status.length, 1);
      assert.equal(status[0].nodeId, 'node-1');
      assert.equal(status[0].status, 'downloading');
      assert.equal(status[0].progress, 0);

      ota.trackProgress('node-1', 50000);
      status = ota.getUpdateStatus();
      assert.equal(status[0].progress, 50);

      ota.trackUpdateEnd('node-1', 'complete');
      status = ota.getUpdateStatus();
      assert.equal(status[0].status, 'complete');
    });

    it('emits ota:started and ota:complete events', async () => {
      const { ota } = createOtaManager();
      await ota.init();

      const startPromise = waitForEvent(ota, 'ota:started', 1000);
      ota.trackUpdateStart('node-2', 80000);
      const startData = await startPromise;
      assert.equal(startData.nodeId, 'node-2');

      const completePromise = waitForEvent(ota, 'ota:complete', 1000);
      ota.trackUpdateEnd('node-2', 'rebooting');
      const completeData = await completePromise;
      assert.equal(completeData.status, 'rebooting');
    });
  });
});
