// ==============================================================================
// BLE Beacon Scanner — BLE-01
// ==============================================================================
// Scans for iBeacon / Eddystone-UID BLE advertisements from patient wristbands
// (ABN05 nRF52810) and staff badges. Uses Linux's hcitool + hcidump via
// subprocess since noble/bluetooth-hci-socket requires native compilation
// that's fragile on embedded Linux.
//
// Parsing approach:
//   hcidump --raw outputs hex lines of HCI events. We accumulate multi-line
//   frames (new frames start with ">"), then parse the concatenated hex for:
//     - HCI LE Meta Event (0x3E) → LE Advertising Report (subevent 0x02)
//     - Extract: MAC address, RSSI, advertisement data (AD structures)
//     - Parse AD types: 0xFF (manufacturer specific) for iBeacon,
//       0x16 (service data) for Eddystone-UID
//
// Each detected beacon emits a unified sensor event:
//   { type: 'ble-sighting', source: 'ble', timestamp, data: BeaconSighting }
//
// References:
//   - Bluetooth Core Spec 5.4, Vol 4, Part E, §7.7.65.2 (LE Advertising Report)
//   - Apple iBeacon: Manufacturer specific data with company ID 0x004C,
//     beacon type 0x0215, 16-byte UUID + 2-byte major + 2-byte minor + TX power
//   - Eddystone-UID: Google, frame type 0x00 in Eddystone service (0xFEAA),
//     10-byte namespace + 6-byte instance
// ==============================================================================

import { EventEmitter } from 'events';
import { spawn } from 'child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Apple's Bluetooth company identifier (little-endian in raw HCI). */
const APPLE_COMPANY_ID = 0x004c; // 76 decimal

/** iBeacon type indicator within Apple manufacturer data. */
const IBEACON_TYPE = 0x0215;

/** Eddystone service UUID (16-bit, little-endian: 0xAAFE). */
const EDDYSTONE_SERVICE_UUID = 0xfeaa;

/** Eddystone-UID frame type byte. */
const EDDYSTONE_UID_FRAME_TYPE = 0x00;

/** HCI event code for LE Meta Event. */
const HCI_LE_META_EVENT = 0x3e;

/** LE Advertising Report subevent code. */
const LE_ADVERTISING_REPORT_SUBEVENT = 0x02;

/** Default stale beacon timeout in milliseconds (30 seconds). */
const DEFAULT_STALE_TIMEOUT_MS = 30_000;

/** Maximum hex buffer size before forced flush (prevents unbounded memory). */
const MAX_HEX_BUFFER_LENGTH = 4096; // characters

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} BeaconSighting
 * @property {string}  mac        - BLE MAC address (uppercase, colon-separated)
 * @property {number}  rssi       - Signal strength in dBm (signed)
 * @property {string}  type       - 'ibeacon' | 'eddystone-uid' | 'unknown'
 * @property {string}  [uuid]     - iBeacon proximity UUID (lowercase, no dashes)
 * @property {number}  [major]    - iBeacon major value (0-65535)
 * @property {number}  [minor]    - iBeacon minor value (0-65535)
 * @property {number}  [txPower]  - Measured TX power at 1m (dBm, signed)
 * @property {string}  [namespace] - Eddystone-UID namespace (10 bytes, hex)
 * @property {string}  [instance]  - Eddystone-UID instance (6 bytes, hex)
 * @property {string}  [name]     - Resolved friendly name (from registry)
 * @property {string}  role       - 'patient' | 'staff' | 'equipment' | 'unknown'
 * @property {number}  timestamp  - Unix timestamp in ms (Date.now())
 */

/**
 * @typedef {Object} AdStructure
 * @property {number}   type - AD type byte
 * @property {number[]} data - AD data bytes (excluding length and type)
 */

// ---------------------------------------------------------------------------
// Pure parsing functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Parse a hex string into an array of integer byte values.
 *
 * @param {string} hex - Hex string, optionally space-separated (e.g. "04 3E 26 02")
 * @returns {number[]} Array of byte values (0-255)
 */
export function hexToBytes(hex) {
  const clean = hex.replace(/\s+/g, '');
  const bytes = [];
  for (let i = 0; i + 1 < clean.length; i += 2) {
    bytes.push(parseInt(clean.substring(i, i + 2), 16));
  }
  return bytes;
}

/**
 * Format 6 bytes as a colon-separated uppercase MAC address.
 *
 * @param {number[]} bytes - Array of 6 byte values
 * @param {number} offset  - Starting index in the array
 * @returns {string} MAC address like "AA:BB:CC:DD:EE:FF"
 */
export function formatMac(bytes, offset) {
  const parts = [];
  // BLE advertising report stores MAC in reverse (little-endian)
  for (let i = 5; i >= 0; i--) {
    parts.push(bytes[offset + i].toString(16).padStart(2, '0').toUpperCase());
  }
  return parts.join(':');
}

/**
 * Parse AD (Advertising Data) structures from the advertisement payload.
 *
 * AD structure format: [length] [type] [data...] where length includes
 * the type byte but not itself.
 *
 * @param {number[]} bytes  - Full byte array
 * @param {number}   offset - Start of AD data
 * @param {number}   length - Total AD data length in bytes
 * @returns {AdStructure[]} Parsed AD structures
 */
export function parseAdStructures(bytes, offset, length) {
  const structures = [];
  let pos = offset;
  const end = offset + length;

  while (pos < end) {
    const adLen = bytes[pos];
    if (adLen === 0 || pos + adLen >= end + 1) break; // End marker or overflow

    const adType = bytes[pos + 1];
    const data = bytes.slice(pos + 2, pos + 1 + adLen);
    structures.push({ type: adType, data });
    pos += 1 + adLen;
  }

  return structures;
}

/**
 * Extract iBeacon fields from an Apple manufacturer-specific AD structure.
 *
 * Expected format (after AD type 0xFF):
 *   [0x4C 0x00]         — Apple company ID (little-endian)
 *   [0x02 0x15]         — iBeacon type
 *   [16 bytes]          — Proximity UUID
 *   [2 bytes]           — Major (big-endian)
 *   [2 bytes]           — Minor (big-endian)
 *   [1 byte]            — Measured TX power (signed int8)
 *
 * @param {number[]} data - Manufacturer-specific data bytes (after AD type)
 * @returns {{ uuid: string, major: number, minor: number, txPower: number } | null}
 */
export function parseIBeacon(data) {
  // Minimum iBeacon payload: 2 (company) + 2 (type) + 16 (uuid) + 2 (major) + 2 (minor) + 1 (tx) = 25
  if (data.length < 25) return null;

  // Check Apple company ID (little-endian: 0x4C, 0x00)
  const companyId = data[0] | (data[1] << 8);
  if (companyId !== APPLE_COMPANY_ID) return null;

  // Check iBeacon type (0x02, 0x15)
  const beaconType = (data[2] << 8) | data[3];
  if (beaconType !== IBEACON_TYPE) return null;

  // Extract UUID (bytes 4-19)
  const uuid = data.slice(4, 20)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Extract major (bytes 20-21, big-endian)
  const major = (data[20] << 8) | data[21];

  // Extract minor (bytes 22-23, big-endian)
  const minor = (data[22] << 8) | data[23];

  // TX power at 1m (byte 24, signed int8)
  const txPower = data[24] > 127 ? data[24] - 256 : data[24];

  return { uuid, major, minor, txPower };
}

/**
 * Extract Eddystone-UID fields from a service data AD structure.
 *
 * Expected format (after AD type 0x16):
 *   [0xAA 0xFE]         — Eddystone service UUID (little-endian)
 *   [0x00]              — UID frame type
 *   [1 byte]            — TX power at 0m (signed int8)
 *   [10 bytes]          — Namespace ID
 *   [6 bytes]           — Instance ID
 *
 * @param {number[]} data - Service data bytes (after AD type)
 * @returns {{ namespace: string, instance: string, txPower: number } | null}
 */
export function parseEddystoneUid(data) {
  // Minimum: 2 (service UUID) + 1 (frame) + 1 (tx) + 10 (ns) + 6 (inst) = 20
  if (data.length < 20) return null;

  // Check Eddystone service UUID (little-endian: 0xAA, 0xFE)
  const serviceUuid = data[0] | (data[1] << 8);
  if (serviceUuid !== EDDYSTONE_SERVICE_UUID) return null;

  // Check UID frame type
  if (data[2] !== EDDYSTONE_UID_FRAME_TYPE) return null;

  // TX power at 0m (signed int8)
  const txPower = data[3] > 127 ? data[3] - 256 : data[3];

  // Namespace (bytes 4-13)
  const namespace = data.slice(4, 14)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Instance (bytes 14-19)
  const instance = data.slice(14, 20)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return { namespace, instance, txPower };
}

/**
 * Parse an HCI LE Advertising Report event from raw bytes.
 *
 * HCI event structure:
 *   [0x04]              — HCI event packet indicator
 *   [event_code]        — 0x3E for LE Meta Event
 *   [param_length]      — Total parameter length
 *   [subevent]          — 0x02 for LE Advertising Report
 *   [num_reports]       — Number of reports (usually 1)
 *   Per report:
 *     [event_type]      — 0x00=ADV_IND, 0x03=ADV_NONCONN_IND, etc.
 *     [address_type]    — 0x00=public, 0x01=random
 *     [6 bytes address] — BLE MAC (little-endian)
 *     [data_length]     — Length of AD data
 *     [AD data...]      — Advertising data structures
 *     [RSSI]            — Signed int8, last byte of the report
 *
 * @param {number[]} bytes - Complete HCI event bytes
 * @returns {{ mac: string, rssi: number, adStructures: AdStructure[] } | null}
 */
export function parseAdvertisingReport(bytes) {
  // Minimum: 04 3E xx 02 01 xx xx ADDR(6) xx RSSI = 14 bytes
  if (bytes.length < 14) return null;

  // Check HCI event packet indicator
  if (bytes[0] !== 0x04) return null;

  // Check LE Meta Event
  if (bytes[1] !== HCI_LE_META_EVENT) return null;

  // Check LE Advertising Report subevent
  if (bytes[3] !== LE_ADVERTISING_REPORT_SUBEVENT) return null;

  // const numReports = bytes[4]; // Usually 1
  // const eventType = bytes[5];
  // const addressType = bytes[6];

  // MAC address starts at byte 7, 6 bytes, little-endian
  const mac = formatMac(bytes, 7);

  // AD data length at byte 13
  const adDataLen = bytes[13];

  // Validate we have enough bytes for AD data + RSSI
  if (bytes.length < 14 + adDataLen + 1) return null;

  // Parse AD structures
  const adStructures = parseAdStructures(bytes, 14, adDataLen);

  // RSSI is the last byte (signed int8)
  const rssiIndex = 14 + adDataLen;
  const rssiByte = bytes[rssiIndex];
  const rssi = rssiByte > 127 ? rssiByte - 256 : rssiByte;

  return { mac, rssi, adStructures };
}

/**
 * Build a full BeaconSighting from a parsed advertising report.
 *
 * Inspects AD structures for iBeacon or Eddystone-UID payloads.
 * Falls back to 'unknown' type if neither is found.
 *
 * @param {{ mac: string, rssi: number, adStructures: AdStructure[] }} report - Parsed report
 * @param {number} [timestamp=Date.now()] - Sighting timestamp
 * @returns {BeaconSighting} Complete sighting object
 */
export function buildSighting(report, timestamp = Date.now()) {
  /** @type {BeaconSighting} */
  const sighting = {
    mac: report.mac,
    rssi: report.rssi,
    type: 'unknown',
    role: 'unknown',
    timestamp,
  };

  for (const ad of report.adStructures) {
    // AD type 0xFF = Manufacturer Specific Data → check for iBeacon
    if (ad.type === 0xff) {
      const ibeacon = parseIBeacon(ad.data);
      if (ibeacon) {
        sighting.type = 'ibeacon';
        sighting.uuid = ibeacon.uuid;
        sighting.major = ibeacon.major;
        sighting.minor = ibeacon.minor;
        sighting.txPower = ibeacon.txPower;
        break;
      }
    }

    // AD type 0x16 = Service Data → check for Eddystone-UID
    if (ad.type === 0x16) {
      const eddystone = parseEddystoneUid(ad.data);
      if (eddystone) {
        sighting.type = 'eddystone-uid';
        sighting.namespace = eddystone.namespace;
        sighting.instance = eddystone.instance;
        sighting.txPower = eddystone.txPower;
        break;
      }
    }
  }

  return sighting;
}

// ---------------------------------------------------------------------------
// BleScanner Class
// ---------------------------------------------------------------------------

export class BleScanner extends EventEmitter {
  /**
   * @param {Object}   config    - Full app config (must have config.ble)
   * @param {Function} loadState - Load persistent state from disk
   * @param {Function} saveState - Save persistent state to disk
   * @param {Object}   logger    - Pino logger instance
   */
  constructor(config, loadState, saveState, logger) {
    super();
    this.config = config;
    this.loadState = loadState;
    this.saveState = saveState;
    this.log = logger.child({ module: 'ble' });

    /** @type {Map<string, BeaconSighting>} Live beacon sightings keyed by MAC */
    this.beacons = new Map();

    /** @type {import('child_process').ChildProcess | null} */
    this._scanProc = null;
    /** @type {import('child_process').ChildProcess | null} */
    this._dumpProc = null;
    /** @type {boolean} */
    this._available = false;
    /** @type {NodeJS.Timeout | null} */
    this._pruneTimer = null;

    // --- hcidump raw frame accumulator ---
    // hcidump --raw outputs multi-line hex frames; a new frame starts with ">"
    /** @type {string} Accumulated hex for the current HCI frame */
    this._hexAccumulator = '';

    // --- Statistics ---
    /** @type {{ framesReceived: number, ibeaconCount: number, eddystoneCount: number, unknownCount: number, parseErrors: number }} */
    this.stats = {
      framesReceived: 0,
      ibeaconCount: 0,
      eddystoneCount: 0,
      unknownCount: 0,
      parseErrors: 0,
    };
  }

  /**
   * Start BLE scanning using hcitool + hcidump subprocesses.
   *
   * hcitool starts a passive LE scan (does not send scan requests, preserving
   * beacon battery life). hcidump captures raw HCI events which we parse for
   * advertising report data.
   */
  async start() {
    if (!this.config.ble.enabled) {
      this.log.info('BLE scanning disabled in config');
      return;
    }

    const device = this.config.ble.hciDevice;

    try {
      // Start passive LE scan with duplicates (needed to track RSSI changes)
      this._scanProc = spawn('hcitool', ['-i', device, 'lescan', '--passive', '--duplicates'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this._scanProc.on('error', (err) => {
        this.log.warn({ err: err.message, device }, 'hcitool not available — BLE disabled');
        this._available = false;
      });

      this._scanProc.on('exit', (code) => {
        if (code !== null && code !== 0) {
          this.log.warn({ code, device }, 'hcitool exited unexpectedly');
        }
      });

      // hcidump captures raw HCI events including advertisement payloads
      this._dumpProc = spawn('hcidump', ['-i', device, '--raw'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this._dumpProc.on('error', (err) => {
        this.log.warn({ err: err.message, device }, 'hcidump not available — BLE disabled');
        this._available = false;
      });

      this._dumpProc.on('exit', (code) => {
        if (code !== null && code !== 0) {
          this.log.warn({ code, device }, 'hcidump exited unexpectedly');
        }
      });

      // Process raw hex output line by line
      let lineBuffer = '';
      this._dumpProc.stdout.on('data', (chunk) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          this._processHciLine(line);
        }
      });

      this._available = true;
      this.log.info({ device }, 'BLE scanning started');

      // Periodically prune stale beacons (every 5 seconds)
      this._pruneTimer = setInterval(() => this._pruneStale(), 5000);
    } catch (err) {
      this.log.warn({ err: err.message, device }, 'Failed to start BLE scanner');
    }
  }

  /** Stop scanning and clean up subprocesses. */
  stop() {
    if (this._scanProc) {
      this._scanProc.kill('SIGTERM');
      this._scanProc = null;
    }
    if (this._dumpProc) {
      this._dumpProc.kill('SIGTERM');
      this._dumpProc = null;
    }
    if (this._pruneTimer) {
      clearInterval(this._pruneTimer);
      this._pruneTimer = null;
    }
    this._available = false;
    this.log.info('BLE scanning stopped');
  }

  /** Get all currently visible beacons as an array. */
  getBeacons() {
    return Array.from(this.beacons.values());
  }

  /**
   * Get beacons filtered by role.
   * @param {string} role - 'patient' | 'staff' | 'equipment' | 'unknown'
   * @returns {BeaconSighting[]}
   */
  getByRole(role) {
    return this.getBeacons().filter((b) => b.role === role);
  }

  /**
   * Assign a friendly name and role to a beacon MAC.
   * Persisted to disk so identity survives restarts.
   *
   * @param {string} mac  - BLE MAC address (uppercase)
   * @param {string} name - Human-readable name
   * @param {string} role - 'patient' | 'staff' | 'equipment'
   */
  setBeaconIdentity(mac, name, role) {
    const state = this.loadState();
    if (!state.beacons) state.beacons = {};
    state.beacons[mac] = { name, role };
    this.saveState(state);

    // Update in-memory sighting if beacon is currently visible
    const beacon = this.beacons.get(mac);
    if (beacon) {
      beacon.name = name;
      beacon.role = role;
      this.emit('beacon:updated', beacon);
    }

    this.log.info({ mac, name, role }, 'Beacon identity updated');
  }

  /** Whether the BLE scanner is operational. */
  get isAvailable() {
    return this._available;
  }

  /**
   * Reset statistics counters.
   */
  resetStats() {
    this.stats.framesReceived = 0;
    this.stats.ibeaconCount = 0;
    this.stats.eddystoneCount = 0;
    this.stats.unknownCount = 0;
    this.stats.parseErrors = 0;
  }

  // ---------------------------------------------------------------------------
  // Internal: hcidump raw output parsing
  // ---------------------------------------------------------------------------

  /**
   * Process a single line from hcidump --raw output.
   *
   * hcidump --raw outputs HCI events as multi-line hex dumps:
   *   > 04 3E 26 02 01 00 00 A1 B2 C3 D4 E5 F6 1A 02 01 06 ...
   *     4C 00 02 15 E2 C5 ...
   *     B6
   *
   * Lines starting with ">" mark the beginning of a new frame.
   * Continuation lines start with whitespace. We accumulate hex data
   * across lines and parse when a new frame starts (flushing the previous).
   *
   * @param {string} line - Raw line from hcidump stdout
   * @private
   */
  _processHciLine(line) {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    if (line.startsWith('>')) {
      // New frame starting — flush the accumulated previous frame
      if (this._hexAccumulator.length > 0) {
        this._parseAccumulatedFrame();
      }
      // Start accumulating (strip the ">" marker)
      this._hexAccumulator = trimmed.substring(1).trim();
    } else if (/^[0-9A-Fa-f\s]+$/.test(trimmed)) {
      // Continuation hex data line
      this._hexAccumulator += ' ' + trimmed;

      // Safety: prevent unbounded memory growth from corrupt data
      if (this._hexAccumulator.length > MAX_HEX_BUFFER_LENGTH) {
        this.log.debug('Hex accumulator overflow, flushing');
        this._hexAccumulator = '';
        this.stats.parseErrors++;
      }
    }
    // Other lines (e.g., comments, errors) are ignored
  }

  /**
   * Parse the accumulated hex frame into a beacon sighting.
   * @private
   */
  _parseAccumulatedFrame() {
    const hex = this._hexAccumulator;
    this._hexAccumulator = '';

    if (hex.length < 10) return; // Too short to be meaningful

    try {
      const bytes = hexToBytes(hex);
      this.stats.framesReceived++;

      const report = parseAdvertisingReport(bytes);
      if (!report) return;

      const sighting = buildSighting(report);
      this._handleSighting(sighting);
    } catch (err) {
      this.stats.parseErrors++;
      this.log.debug({ err: err.message, hexLen: hex.length }, 'Failed to parse HCI frame');
    }
  }

  /**
   * Process a parsed beacon sighting: apply filters, resolve identity,
   * update the beacon map, and emit events.
   *
   * @param {BeaconSighting} sighting - Parsed sighting
   * @private
   */
  _handleSighting(sighting) {
    // Apply UUID filter if configured (iBeacon only)
    if (this.config.ble.uuidFilter && sighting.uuid) {
      if (!sighting.uuid.toLowerCase().includes(this.config.ble.uuidFilter.toLowerCase())) {
        return;
      }
    }

    // Apply RSSI threshold filter
    if (sighting.rssi < this.config.ble.rssiThreshold) return;

    // Update type-specific stats
    if (sighting.type === 'ibeacon') {
      this.stats.ibeaconCount++;
    } else if (sighting.type === 'eddystone-uid') {
      this.stats.eddystoneCount++;
    } else {
      this.stats.unknownCount++;
    }

    // Resolve identity from persisted registry
    const state = this.loadState();
    const identity = state.beacons?.[sighting.mac];
    if (identity) {
      sighting.name = identity.name;
      sighting.role = identity.role;
    } else {
      sighting.name = sighting.name || sighting.mac.slice(-8);
    }

    const isNew = !this.beacons.has(sighting.mac);
    this.beacons.set(sighting.mac, sighting);

    // Emit unified sensor event model
    const sensorEvent = {
      type: 'ble-sighting',
      source: 'ble',
      timestamp: sighting.timestamp,
      data: sighting,
    };

    if (isNew) {
      this.log.info(
        { mac: sighting.mac, type: sighting.type, rssi: sighting.rssi, name: sighting.name },
        'New beacon discovered'
      );
      this.emit('beacon:discovered', sighting);
    }
    this.emit('beacon:sighting', sighting);
    this.emit('sensor:event', sensorEvent);
  }

  /**
   * Remove beacons not seen within the stale timeout.
   * @private
   */
  _pruneStale() {
    const cutoff = Date.now() - DEFAULT_STALE_TIMEOUT_MS;
    for (const [mac, beacon] of this.beacons) {
      if (beacon.timestamp < cutoff) {
        this.beacons.delete(mac);
        this.log.debug({ mac, lastSeen: beacon.timestamp }, 'Beacon pruned (stale)');
        this.emit('beacon:lost', beacon);
      }
    }
  }
}
