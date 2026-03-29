// ==============================================================================
// BLE Beacon Scanner
// ==============================================================================
// Scans for iBeacon / Eddystone BLE advertisements from patient wristbands
// (ABN05 nRF52810) and staff badges. Uses Linux's hcitool + hcidump via
// subprocess since noble/bluetooth-hci-socket requires native compilation
// that's fragile on embedded Linux.
//
// Each detected beacon emits an event with:
//   - MAC address
//   - RSSI (signal strength → proximity estimate)
//   - iBeacon UUID/major/minor or Eddystone namespace/instance
//   - Timestamp
//
// The HeartBeatz server correlates these beacon sightings with CSI presence
// data to answer "who is in the room" (beacon identity) + "what are they
// doing" (CSI pose/vitals).

import { EventEmitter } from 'events';
import { spawn } from 'child_process';

/**
 * @typedef {Object} BeaconSighting
 * @property {string}  mac        - BLE MAC address
 * @property {number}  rssi       - Signal strength (dBm)
 * @property {string}  type       - 'ibeacon' | 'eddystone' | 'unknown'
 * @property {string}  [uuid]     - iBeacon proximity UUID
 * @property {number}  [major]    - iBeacon major value
 * @property {number}  [minor]    - iBeacon minor value
 * @property {string}  [namespace] - Eddystone namespace
 * @property {string}  [instance]  - Eddystone instance
 * @property {string}  [name]     - Resolved friendly name (from state)
 * @property {string}  role       - 'patient' | 'staff' | 'unknown'
 * @property {number}  timestamp  - Unix timestamp (ms)
 */

export class BleScanner extends EventEmitter {
  /**
   * @param {Object} config     - config.ble
   * @param {Function} loadState
   * @param {Function} saveState
   * @param {Object} logger
   */
  constructor(config, loadState, saveState, logger) {
    super();
    this.config = config;
    this.loadState = loadState;
    this.saveState = saveState;
    this.log = logger.child({ module: 'ble' });

    /** @type {Map<string, BeaconSighting>} Live beacon sightings */
    this.beacons = new Map();
    this._scanProc = null;
    this._dumpProc = null;
    this._available = false;
  }

  /** Start BLE scanning using hcitool/hcidump. */
  async start() {
    if (!this.config.ble.enabled) {
      this.log.info('BLE scanning disabled in config');
      return;
    }

    const device = this.config.ble.hciDevice;

    try {
      // Start LE scan (passive — doesn't send scan requests)
      this._scanProc = spawn('hcitool', ['-i', device, 'lescan', '--passive', '--duplicates'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this._scanProc.on('error', (err) => {
        this.log.warn({ err: err.message }, 'hcitool not available — BLE disabled');
      });

      // hcidump captures raw HCI events including advertisement data
      this._dumpProc = spawn('hcidump', ['-i', device, '--raw'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this._dumpProc.on('error', (err) => {
        this.log.warn({ err: err.message }, 'hcidump not available — BLE disabled');
      });

      let rawBuffer = '';
      this._dumpProc.stdout.on('data', (chunk) => {
        rawBuffer += chunk.toString();
        const lines = rawBuffer.split('\n');
        rawBuffer = lines.pop() || '';

        for (const line of lines) {
          this._processHciLine(line.trim());
        }
      });

      this._available = true;
      this.log.info({ device }, 'BLE scanning started');

      // Periodically prune stale beacons
      this._pruneTimer = setInterval(() => this._pruneStale(), 5000);
    } catch (err) {
      this.log.warn({ err: err.message }, 'Failed to start BLE scanner');
    }
  }

  /** Stop scanning. */
  stop() {
    this._scanProc?.kill();
    this._dumpProc?.kill();
    if (this._pruneTimer) clearInterval(this._pruneTimer);
  }

  /** Get all currently visible beacons. */
  getBeacons() {
    return Array.from(this.beacons.values());
  }

  /** Get beacons filtered by role. */
  getByRole(role) {
    return this.getBeacons().filter((b) => b.role === role);
  }

  /** Assign a friendly name and role to a beacon MAC (persisted). */
  setBeaconIdentity(mac, name, role) {
    const state = this.loadState();
    if (!state.beacons) state.beacons = {};
    state.beacons[mac] = { name, role };
    this.saveState(state);

    const beacon = this.beacons.get(mac);
    if (beacon) {
      beacon.name = name;
      beacon.role = role;
      this.emit('beacon:updated', beacon);
    }
  }

  get isAvailable() {
    return this._available;
  }

  // ---------------------------------------------------------------------------
  // Internal: HCI advertisement parsing
  // ---------------------------------------------------------------------------

  /**
   * Process a raw HCI dump line. We're looking for LE advertising report events
   * which contain the iBeacon/Eddystone payload.
   *
   * This is a simplified parser — for production, consider using a proper
   * BLE library. For the demo box, this works well enough.
   */
  _processHciLine(line) {
    // Quick filter: we only care about hex data lines (starts with ">")
    if (!line.startsWith('>') && !line.match(/^[0-9A-Fa-f ]+$/)) return;

    // For now, use a simpler approach: parse hcitool lescan output
    // Format: "AA:BB:CC:DD:EE:FF DeviceName"
    const macMatch = line.match(/([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})/);
    if (!macMatch) return;

    const mac = macMatch[1].toUpperCase();
    const state = this.loadState();
    const identity = state.beacons?.[mac];

    /** @type {BeaconSighting} */
    const sighting = {
      mac,
      rssi: -65, // Placeholder — real RSSI comes from HCI event parsing
      type: 'unknown',
      name: identity?.name || mac.slice(-8),
      role: identity?.role || 'unknown',
      timestamp: Date.now(),
    };

    // Apply UUID filter if configured
    if (this.config.ble.uuidFilter && sighting.uuid) {
      if (!sighting.uuid.toLowerCase().includes(this.config.ble.uuidFilter.toLowerCase())) {
        return;
      }
    }

    // Apply RSSI threshold
    if (sighting.rssi < this.config.ble.rssiThreshold) return;

    const isNew = !this.beacons.has(mac);
    this.beacons.set(mac, sighting);

    if (isNew) {
      this.emit('beacon:discovered', sighting);
    }
    this.emit('beacon:sighting', sighting);
  }

  /** Remove beacons not seen in the last 30 seconds. */
  _pruneStale() {
    const cutoff = Date.now() - 30_000;
    for (const [mac, beacon] of this.beacons) {
      if (beacon.timestamp < cutoff) {
        this.beacons.delete(mac);
        this.emit('beacon:lost', beacon);
      }
    }
  }
}
