// ==============================================================================
// OTA Firmware Update Manager
// ==============================================================================
// Manages firmware binary storage, version tracking, and OTA delivery to ESP32
// sensor nodes. Works with the ESP32 ota_check_task that polls for updates.
//
// Design:
//   - Firmware binaries are stored on disk in data/firmware/
//   - Metadata (version, upload time, size, checksum) is tracked in state.json
//   - Nodes poll GET /api/firmware/latest with their current version
//   - If a newer version exists, the server streams the binary back
//   - If the node is already up-to-date, the server returns 304
//   - The UI can upload new firmware and monitor update progress
//
// Limitations (demo box scope):
//   - Single firmware binary for all nodes (same ESP32-S3 hardware)
//   - No TLS (local network only) — production would use esp_https_ota
//   - No automatic rollback detection (ESP-IDF handles this at boot)
//
// Usage:
//   const ota = new OtaManager(config, loadState, saveState, logger);
//   await ota.init();

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Directory where firmware binaries are stored (relative to project root). */
const FIRMWARE_DIR = join(__dirname, '..', '..', 'data', 'firmware');

/** Maximum firmware binary size (1.75MB — matches ESP32 OTA partition size). */
const MAX_FIRMWARE_SIZE = 1.75 * 1024 * 1024;

/** Minimum firmware binary size (sanity check — ESP-IDF images are at least ~100KB). */
const MIN_FIRMWARE_SIZE = 50 * 1024;


export class OtaManager extends EventEmitter {
  /**
   * @param {Object}   config    - App config
   * @param {Function} loadState - Load persistent state from disk
   * @param {Function} saveState - Save persistent state to disk
   * @param {Object}   logger    - Pino logger instance
   */
  constructor(config, loadState, saveState, logger) {
    super();
    this.config = config;
    this.loadState = loadState;
    this.saveState = saveState;
    this.log = logger.child({ module: 'ota' });

    // Track which nodes are currently updating (for UI progress display)
    // Map<nodeId, { startedAt, bytesDelivered, totalBytes, status }>
    this._activeUpdates = new Map();
  }

  // =========================================================================
  // Initialization
  // =========================================================================

  /**
   * Ensure the firmware storage directory exists.
   * Called once at server startup.
   */
  async init() {
    if (!existsSync(FIRMWARE_DIR)) {
      mkdirSync(FIRMWARE_DIR, { recursive: true });
      this.log.info({ dir: FIRMWARE_DIR }, 'Created firmware storage directory');
    }

    // Validate that persisted firmware metadata still matches the file on disk
    const meta = this._getFirmwareMeta();
    if (meta && meta.filename) {
      const fwPath = join(FIRMWARE_DIR, meta.filename);
      if (!existsSync(fwPath)) {
        this.log.warn({ filename: meta.filename }, 'Firmware file missing — clearing metadata');
        this._clearFirmwareMeta();
      }
    }

    this.log.info('OTA manager initialized');
  }

  // =========================================================================
  // Firmware Binary Management
  // =========================================================================

  /**
   * Store a new firmware binary and update metadata.
   * Validates the binary and computes a SHA-256 checksum.
   *
   * @param {Buffer} buffer   - Raw firmware binary (.bin file)
   * @param {string} version  - Semantic version string (e.g. "1.1.0")
   * @param {string} [notes]  - Optional release notes
   * @returns {{ ok: boolean, error?: string, firmware?: Object }}
   */
  storeFirmware(buffer, version, notes = '') {
    // --- Validation ---

    if (!Buffer.isBuffer(buffer)) {
      return { ok: false, error: 'Invalid firmware data — expected a binary buffer' };
    }

    if (buffer.length < MIN_FIRMWARE_SIZE) {
      return { ok: false, error: `Firmware too small (${buffer.length} bytes). Minimum is ${MIN_FIRMWARE_SIZE} bytes.` };
    }

    if (buffer.length > MAX_FIRMWARE_SIZE) {
      return { ok: false, error: `Firmware too large (${buffer.length} bytes). Maximum is ${MAX_FIRMWARE_SIZE} bytes (1.75MB OTA partition).` };
    }

    if (!version || typeof version !== 'string') {
      return { ok: false, error: 'Version string is required (e.g. "1.1.0")' };
    }

    // Validate ESP-IDF binary magic: ESP-IDF app images start with 0xE9
    if (buffer[0] !== 0xE9) {
      this.log.warn({ firstByte: buffer[0].toString(16) }, 'Firmware does not start with ESP-IDF magic byte 0xE9');
      // Don't reject — the user may be uploading a different format
    }

    // --- Store the binary ---

    const checksum = createHash('sha256').update(buffer).digest('hex');
    const filename = `heartbeatz-${version}.bin`;
    const fwPath = join(FIRMWARE_DIR, filename);

    // Remove previous firmware file (only keep one version on disk)
    const prevMeta = this._getFirmwareMeta();
    if (prevMeta && prevMeta.filename && prevMeta.filename !== filename) {
      const prevPath = join(FIRMWARE_DIR, prevMeta.filename);
      try {
        if (existsSync(prevPath)) unlinkSync(prevPath);
      } catch (err) {
        this.log.warn({ err: err.message }, 'Failed to remove previous firmware');
      }
    }

    writeFileSync(fwPath, buffer);

    // --- Update metadata in state.json ---

    const meta = {
      version,
      filename,
      size: buffer.length,
      checksum,
      notes: notes || '',
      uploadedAt: Date.now(),
    };

    this._setFirmwareMeta(meta);

    this.log.info(
      { version, size: buffer.length, checksum: checksum.slice(0, 12) },
      'Firmware stored successfully'
    );

    this.emit('firmware:uploaded', meta);
    return { ok: true, firmware: meta };
  }

  /**
   * Get metadata about the currently stored firmware.
   * @returns {Object|null} Firmware metadata or null if none stored
   */
  getCurrentFirmware() {
    return this._getFirmwareMeta();
  }

  /**
   * Read the firmware binary from disk.
   * @returns {Buffer|null} Firmware binary or null if not available
   */
  getFirmwareBinary() {
    const meta = this._getFirmwareMeta();
    if (!meta || !meta.filename) return null;

    const fwPath = join(FIRMWARE_DIR, meta.filename);
    if (!existsSync(fwPath)) return null;

    return readFileSync(fwPath);
  }

  /**
   * Delete the stored firmware and clear metadata.
   * @returns {{ ok: boolean }}
   */
  deleteFirmware() {
    const meta = this._getFirmwareMeta();
    if (meta && meta.filename) {
      const fwPath = join(FIRMWARE_DIR, meta.filename);
      try {
        if (existsSync(fwPath)) unlinkSync(fwPath);
      } catch (err) {
        this.log.warn({ err: err.message }, 'Failed to delete firmware file');
      }
    }
    this._clearFirmwareMeta();
    this.log.info('Firmware deleted');
    this.emit('firmware:deleted');
    return { ok: true };
  }

  // =========================================================================
  // OTA Delivery (called by API route when ESP32 requests firmware)
  // =========================================================================

  /**
   * Check if a node needs an update based on its reported version.
   *
   * @param {string} nodeVersion - The node's current firmware version
   * @returns {{ needsUpdate: boolean, firmware?: Object }}
   */
  checkForUpdate(nodeVersion) {
    const meta = this._getFirmwareMeta();
    if (!meta) {
      return { needsUpdate: false };
    }

    // Simple string comparison — if the versions differ, there's an update.
    // In a production system, you'd use semver comparison.
    if (nodeVersion === meta.version) {
      return { needsUpdate: false };
    }

    return {
      needsUpdate: true,
      firmware: {
        version: meta.version,
        size: meta.size,
        checksum: meta.checksum,
      },
    };
  }

  /**
   * Record that a node has started downloading firmware.
   * Used for UI progress tracking.
   *
   * @param {string} nodeId    - The node identifier
   * @param {number} totalBytes - Total firmware size
   */
  trackUpdateStart(nodeId, totalBytes) {
    this._activeUpdates.set(nodeId, {
      startedAt: Date.now(),
      bytesDelivered: 0,
      totalBytes,
      status: 'downloading',
    });
    this.emit('ota:started', { nodeId, totalBytes });
    this.log.info({ nodeId, totalBytes }, 'OTA download started');
  }

  /**
   * Update the bytes delivered counter for a node's OTA download.
   * @param {string} nodeId
   * @param {number} bytesDelivered
   */
  trackProgress(nodeId, bytesDelivered) {
    const update = this._activeUpdates.get(nodeId);
    if (update) {
      update.bytesDelivered = bytesDelivered;
      this.emit('ota:progress', { nodeId, bytesDelivered, totalBytes: update.totalBytes });
    }
  }

  /**
   * Record that a node's OTA update completed (or failed).
   * @param {string} nodeId
   * @param {'complete'|'failed'|'rebooting'} status
   */
  trackUpdateEnd(nodeId, status) {
    const update = this._activeUpdates.get(nodeId);
    if (update) {
      update.status = status;
      update.completedAt = Date.now();
      const duration = update.completedAt - update.startedAt;
      this.log.info({ nodeId, status, durationMs: duration }, 'OTA update finished');
    }
    // Keep the record for a bit (UI can display completion), then clean up
    setTimeout(() => this._activeUpdates.delete(nodeId), 60_000);
    this.emit('ota:complete', { nodeId, status });
  }

  /**
   * Get all active/recent OTA update statuses (for UI display).
   * @returns {Array<Object>}
   */
  getUpdateStatus() {
    const result = [];
    for (const [nodeId, update] of this._activeUpdates) {
      result.push({
        nodeId,
        ...update,
        progress: update.totalBytes > 0
          ? Math.round((update.bytesDelivered / update.totalBytes) * 100)
          : 0,
      });
    }
    return result;
  }

  // =========================================================================
  // Private: State Persistence Helpers
  // =========================================================================

  /**
   * Get firmware metadata from persistent state.
   * @returns {Object|null}
   */
  _getFirmwareMeta() {
    const state = this.loadState();
    return state.firmware || null;
  }

  /**
   * Save firmware metadata to persistent state.
   * @param {Object} meta
   */
  _setFirmwareMeta(meta) {
    const state = this.loadState();
    state.firmware = meta;
    this.saveState(state);
  }

  /**
   * Clear firmware metadata from persistent state.
   */
  _clearFirmwareMeta() {
    const state = this.loadState();
    delete state.firmware;
    this.saveState(state);
  }
}
