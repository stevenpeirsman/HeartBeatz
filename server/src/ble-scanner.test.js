// ==============================================================================
// BLE Scanner Tests — BLE-01
// ==============================================================================
// Tests for iBeacon/Eddystone-UID parsing, advertising report decoding,
// sighting construction, and BleScanner class behavior.
//
// Uses synthetic HCI frames — no real Bluetooth hardware needed.
// ==============================================================================

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  hexToBytes,
  formatMac,
  parseAdStructures,
  parseIBeacon,
  parseEddystoneUid,
  parseAdvertisingReport,
  buildSighting,
  BleScanner,
} from './ble-scanner.js';

// ---------------------------------------------------------------------------
// Helper: build raw HCI LE Advertising Report bytes
// ---------------------------------------------------------------------------

/**
 * Build a synthetic HCI LE Advertising Report frame.
 *
 * @param {Object} opts
 * @param {number[]} opts.mac       - 6-byte MAC (big-endian / human order)
 * @param {number}   opts.rssi      - RSSI in dBm (signed)
 * @param {number[]} opts.adData    - Raw AD structures bytes
 * @param {number}   [opts.eventType=0x00] - ADV_IND
 * @param {number}   [opts.addrType=0x01]  - Random
 * @returns {number[]} Complete HCI event bytes
 */
function buildAdvReport({ mac, rssi, adData, eventType = 0x00, addrType = 0x01 }) {
  // MAC in little-endian for HCI
  const macLE = [...mac].reverse();
  const paramLen = 1 + 1 + 1 + 1 + 6 + 1 + adData.length + 1; // subevent + nreports + event_type + addr_type + mac + adlen + ad + rssi

  const rssiByte = rssi < 0 ? rssi + 256 : rssi;

  return [
    0x04,                      // HCI event packet
    0x3e,                      // LE Meta Event
    paramLen,                  // Parameter length
    0x02,                      // LE Advertising Report subevent
    0x01,                      // Number of reports
    eventType,                 // Event type
    addrType,                  // Address type
    ...macLE,                  // MAC (little-endian)
    adData.length,             // AD data length
    ...adData,                 // AD data
    rssiByte,                  // RSSI
  ];
}

/**
 * Build iBeacon AD structure bytes.
 *
 * @param {Object} opts
 * @param {string} opts.uuid  - 32 hex chars (no dashes)
 * @param {number} opts.major - 0-65535
 * @param {number} opts.minor - 0-65535
 * @param {number} [opts.txPower=-59] - TX power in dBm
 * @returns {number[]} Complete AD structure bytes [length, type, data...]
 */
function buildIBeaconAd({ uuid, major, minor, txPower = -59 }) {
  const uuidBytes = [];
  for (let i = 0; i < uuid.length; i += 2) {
    uuidBytes.push(parseInt(uuid.substring(i, i + 2), 16));
  }

  const txByte = txPower < 0 ? txPower + 256 : txPower;

  // Flags AD structure (common preamble)
  const flags = [0x02, 0x01, 0x06]; // len=2, type=Flags, data=0x06

  // iBeacon manufacturer data
  const mfgData = [
    0x4c, 0x00,       // Apple company ID (little-endian)
    0x02, 0x15,       // iBeacon type
    ...uuidBytes,     // 16-byte UUID
    (major >> 8) & 0xff, major & 0xff,  // Major (big-endian)
    (minor >> 8) & 0xff, minor & 0xff,  // Minor (big-endian)
    txByte,           // TX power
  ];

  // AD structure: [length, type=0xFF, data...]
  const mfgAd = [mfgData.length + 1, 0xff, ...mfgData];

  return [...flags, ...mfgAd];
}

/**
 * Build Eddystone-UID AD structure bytes.
 *
 * @param {Object} opts
 * @param {string} opts.namespace - 20 hex chars
 * @param {string} opts.instance  - 12 hex chars
 * @param {number} [opts.txPower=-20]
 * @returns {number[]}
 */
function buildEddystoneUidAd({ namespace, instance, txPower = -20 }) {
  const nsBytes = [];
  for (let i = 0; i < namespace.length; i += 2) {
    nsBytes.push(parseInt(namespace.substring(i, i + 2), 16));
  }
  const instBytes = [];
  for (let i = 0; i < instance.length; i += 2) {
    instBytes.push(parseInt(instance.substring(i, i + 2), 16));
  }

  const txByte = txPower < 0 ? txPower + 256 : txPower;

  // Flags
  const flags = [0x02, 0x01, 0x06];

  // Complete 16-bit service UUID (Eddystone 0xFEAA)
  const svcUuid = [0x03, 0x03, 0xaa, 0xfe];

  // Service data
  const svcData = [
    0xaa, 0xfe,       // Eddystone service UUID (little-endian)
    0x00,             // UID frame type
    txByte,           // TX power
    ...nsBytes,       // 10-byte namespace
    ...instBytes,     // 6-byte instance
    0x00, 0x00,       // Reserved
  ];
  const svcDataAd = [svcData.length + 1, 0x16, ...svcData];

  return [...flags, ...svcUuid, ...svcDataAd];
}

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe('hexToBytes', () => {
  it('should parse space-separated hex', () => {
    const bytes = hexToBytes('04 3E 0A');
    assert.deepStrictEqual(bytes, [0x04, 0x3e, 0x0a]);
  });

  it('should parse continuous hex string', () => {
    const bytes = hexToBytes('FF00AB');
    assert.deepStrictEqual(bytes, [0xff, 0x00, 0xab]);
  });

  it('should handle empty string', () => {
    assert.deepStrictEqual(hexToBytes(''), []);
  });

  it('should handle mixed spacing', () => {
    const bytes = hexToBytes('04  3E   0A');
    assert.deepStrictEqual(bytes, [0x04, 0x3e, 0x0a]);
  });
});

describe('formatMac', () => {
  it('should format 6 LE bytes as uppercase colon-separated MAC', () => {
    // Little-endian bytes for MAC AA:BB:CC:DD:EE:FF
    const bytes = [0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa];
    assert.equal(formatMac(bytes, 0), 'AA:BB:CC:DD:EE:FF');
  });

  it('should handle offset', () => {
    const bytes = [0x00, 0x00, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01];
    assert.equal(formatMac(bytes, 2), '01:02:03:04:05:06');
  });
});

describe('parseAdStructures', () => {
  it('should parse multiple AD structures', () => {
    // Two AD structures: Flags (len=2, type=0x01, data=0x06) + TX Power (len=2, type=0x0A, data=0xF4)
    const bytes = [0x02, 0x01, 0x06, 0x02, 0x0a, 0xf4];
    const ads = parseAdStructures(bytes, 0, bytes.length);
    assert.equal(ads.length, 2);
    assert.equal(ads[0].type, 0x01);
    assert.deepStrictEqual(ads[0].data, [0x06]);
    assert.equal(ads[1].type, 0x0a);
    assert.deepStrictEqual(ads[1].data, [0xf4]);
  });

  it('should handle empty AD data', () => {
    const ads = parseAdStructures([], 0, 0);
    assert.equal(ads.length, 0);
  });

  it('should stop at zero-length AD entry', () => {
    const bytes = [0x02, 0x01, 0x06, 0x00]; // Zero marks end
    const ads = parseAdStructures(bytes, 0, bytes.length);
    assert.equal(ads.length, 1);
  });
});

describe('parseIBeacon', () => {
  it('should parse valid iBeacon manufacturer data', () => {
    const uuid = 'e2c56db5dffb48d2b060d0f5a71096e0';
    const data = [
      0x4c, 0x00,       // Apple company ID
      0x02, 0x15,       // iBeacon type
      // UUID: e2c56db5dffb48d2b060d0f5a71096e0
      0xe2, 0xc5, 0x6d, 0xb5, 0xdf, 0xfb, 0x48, 0xd2,
      0xb0, 0x60, 0xd0, 0xf5, 0xa7, 0x10, 0x96, 0xe0,
      0x00, 0x01,       // Major = 1
      0x00, 0x02,       // Minor = 2
      0xc5,             // TX power = -59 (0xC5 = 197, 197-256 = -59)
    ];

    const result = parseIBeacon(data);
    assert.notEqual(result, null);
    assert.equal(result.uuid, uuid);
    assert.equal(result.major, 1);
    assert.equal(result.minor, 2);
    assert.equal(result.txPower, -59);
  });

  it('should return null for non-Apple company ID', () => {
    const data = new Array(25).fill(0);
    data[0] = 0x00; data[1] = 0x01; // Wrong company ID
    assert.equal(parseIBeacon(data), null);
  });

  it('should return null for wrong beacon type', () => {
    const data = new Array(25).fill(0);
    data[0] = 0x4c; data[1] = 0x00; // Apple
    data[2] = 0x01; data[3] = 0x15; // Wrong type
    assert.equal(parseIBeacon(data), null);
  });

  it('should return null for data too short', () => {
    assert.equal(parseIBeacon([0x4c, 0x00, 0x02, 0x15]), null);
  });

  it('should parse major/minor in big-endian', () => {
    const data = [
      0x4c, 0x00, 0x02, 0x15,
      ...new Array(16).fill(0xab), // UUID
      0x01, 0x00,       // Major = 256
      0x00, 0xff,       // Minor = 255
      0x00,             // TX power = 0
    ];
    const result = parseIBeacon(data);
    assert.equal(result.major, 256);
    assert.equal(result.minor, 255);
    assert.equal(result.txPower, 0);
  });
});

describe('parseEddystoneUid', () => {
  it('should parse valid Eddystone-UID service data', () => {
    const data = [
      0xaa, 0xfe,       // Eddystone service UUID
      0x00,             // UID frame type
      0xec,             // TX power = -20 (0xEC = 236, 236-256 = -20)
      // Namespace (10 bytes)
      0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a,
      // Instance (6 bytes)
      0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
    ];

    const result = parseEddystoneUid(data);
    assert.notEqual(result, null);
    assert.equal(result.namespace, '0102030405060708090a');
    assert.equal(result.instance, 'aabbccddeeff');
    assert.equal(result.txPower, -20);
  });

  it('should return null for wrong service UUID', () => {
    const data = new Array(20).fill(0);
    data[0] = 0x00; data[1] = 0x00; // Wrong service UUID
    assert.equal(parseEddystoneUid(data), null);
  });

  it('should return null for non-UID frame type', () => {
    const data = new Array(20).fill(0);
    data[0] = 0xaa; data[1] = 0xfe;
    data[2] = 0x10; // URL frame type, not UID
    assert.equal(parseEddystoneUid(data), null);
  });

  it('should return null for data too short', () => {
    assert.equal(parseEddystoneUid([0xaa, 0xfe, 0x00]), null);
  });
});

describe('parseAdvertisingReport', () => {
  it('should parse a complete iBeacon advertising report', () => {
    const mac = [0xA1, 0xB2, 0xC3, 0xD4, 0xE5, 0xF6];
    const adData = buildIBeaconAd({
      uuid: 'e2c56db5dffb48d2b060d0f5a71096e0',
      major: 100,
      minor: 200,
      txPower: -59,
    });
    const bytes = buildAdvReport({ mac, rssi: -65, adData });

    const report = parseAdvertisingReport(bytes);
    assert.notEqual(report, null);
    assert.equal(report.mac, 'A1:B2:C3:D4:E5:F6');
    assert.equal(report.rssi, -65);
    assert.ok(report.adStructures.length >= 1);
  });

  it('should extract correct RSSI from signed byte', () => {
    const mac = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66];
    const adData = [0x02, 0x01, 0x06]; // Simple flags AD
    const bytes = buildAdvReport({ mac, rssi: -90, adData });
    const report = parseAdvertisingReport(bytes);
    assert.equal(report.rssi, -90);
  });

  it('should return null for non-HCI event', () => {
    assert.equal(parseAdvertisingReport([0x05, 0x3e, 0x00, 0x02]), null);
  });

  it('should return null for non-LE-Meta event', () => {
    assert.equal(parseAdvertisingReport([0x04, 0x0e, 0x00, 0x02]), null);
  });

  it('should return null for non-advertising subevent', () => {
    assert.equal(parseAdvertisingReport([0x04, 0x3e, 0x00, 0x01]), null);
  });

  it('should return null for data too short', () => {
    assert.equal(parseAdvertisingReport([0x04, 0x3e]), null);
  });
});

describe('buildSighting', () => {
  it('should build iBeacon sighting from report', () => {
    const mac = [0xA1, 0xB2, 0xC3, 0xD4, 0xE5, 0xF6];
    const adData = buildIBeaconAd({
      uuid: 'e2c56db5dffb48d2b060d0f5a71096e0',
      major: 100,
      minor: 200,
    });
    const bytes = buildAdvReport({ mac, rssi: -60, adData });
    const report = parseAdvertisingReport(bytes);
    const sighting = buildSighting(report, 1000);

    assert.equal(sighting.type, 'ibeacon');
    assert.equal(sighting.uuid, 'e2c56db5dffb48d2b060d0f5a71096e0');
    assert.equal(sighting.major, 100);
    assert.equal(sighting.minor, 200);
    assert.equal(sighting.mac, 'A1:B2:C3:D4:E5:F6');
    assert.equal(sighting.rssi, -60);
    assert.equal(sighting.timestamp, 1000);
    assert.equal(sighting.role, 'unknown');
  });

  it('should build Eddystone-UID sighting from report', () => {
    const mac = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66];
    const adData = buildEddystoneUidAd({
      namespace: '0102030405060708090a',
      instance: 'aabbccddeeff',
      txPower: -20,
    });
    const bytes = buildAdvReport({ mac, rssi: -55, adData });
    const report = parseAdvertisingReport(bytes);
    const sighting = buildSighting(report, 2000);

    assert.equal(sighting.type, 'eddystone-uid');
    assert.equal(sighting.namespace, '0102030405060708090a');
    assert.equal(sighting.instance, 'aabbccddeeff');
    assert.equal(sighting.mac, '11:22:33:44:55:66');
    assert.equal(sighting.rssi, -55);
    assert.equal(sighting.txPower, -20);
  });

  it('should mark unknown type for non-beacon advertisements', () => {
    const mac = [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF];
    const adData = [0x02, 0x01, 0x06]; // Just flags, no beacon payload
    const bytes = buildAdvReport({ mac, rssi: -70, adData });
    const report = parseAdvertisingReport(bytes);
    const sighting = buildSighting(report);

    assert.equal(sighting.type, 'unknown');
    assert.equal(sighting.uuid, undefined);
    assert.equal(sighting.namespace, undefined);
  });
});

// ---------------------------------------------------------------------------
// BleScanner class tests (unit-level, no real BLE hardware)
// ---------------------------------------------------------------------------

describe('BleScanner', () => {
  /** @type {BleScanner} */
  let scanner;
  let mockState;
  let logMessages;

  beforeEach(() => {
    mockState = { beacons: {} };
    logMessages = [];

    const mockLogger = {
      child: () => ({
        info: (...args) => logMessages.push({ level: 'info', args }),
        warn: (...args) => logMessages.push({ level: 'warn', args }),
        debug: (...args) => logMessages.push({ level: 'debug', args }),
        error: (...args) => logMessages.push({ level: 'error', args }),
      }),
    };

    const config = {
      ble: {
        enabled: true,
        hciDevice: 'hci0',
        uuidFilter: '',
        rssiThreshold: -90,
        scanIntervalMs: 1000,
      },
    };

    scanner = new BleScanner(
      config,
      () => ({ ...mockState }),
      (state) => { mockState = state; },
      mockLogger
    );
  });

  it('should initialize with empty beacon map', () => {
    assert.equal(scanner.beacons.size, 0);
    assert.equal(scanner.isAvailable, false);
  });

  it('should filter by UUID when configured', () => {
    scanner.config = {
      ...scanner.config,
      ble: { ...scanner.config.ble, uuidFilter: 'e2c56db5' },
    };

    const events = [];
    scanner.on('beacon:sighting', (s) => events.push(s));

    // Feed an iBeacon with matching UUID
    const mac1 = [0xA1, 0xB2, 0xC3, 0xD4, 0xE5, 0xF6];
    const ad1 = buildIBeaconAd({ uuid: 'e2c56db5dffb48d2b060d0f5a71096e0', major: 1, minor: 1 });
    const bytes1 = buildAdvReport({ mac: mac1, rssi: -60, adData: ad1 });
    const report1 = parseAdvertisingReport(bytes1);
    const sighting1 = buildSighting(report1);
    scanner._handleSighting(sighting1);

    // Feed an iBeacon with non-matching UUID
    const mac2 = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66];
    const ad2 = buildIBeaconAd({ uuid: 'aaaabbbbccccddddeeeeffffgggg0000', major: 2, minor: 2 });
    const bytes2 = buildAdvReport({ mac: mac2, rssi: -60, adData: ad2 });
    const report2 = parseAdvertisingReport(bytes2);
    // This will be null since the UUID hex is invalid, test the filter logic directly
    const sighting2 = {
      mac: '11:22:33:44:55:66',
      rssi: -60,
      type: 'ibeacon',
      uuid: 'aaaabbbbccccddddeeeeffffgggg0000',
      role: 'unknown',
      timestamp: Date.now(),
    };
    scanner._handleSighting(sighting2);

    assert.equal(events.length, 1);
    assert.equal(events[0].mac, 'A1:B2:C3:D4:E5:F6');
  });

  it('should filter by RSSI threshold', () => {
    const events = [];
    scanner.on('beacon:sighting', (s) => events.push(s));

    // Sighting above threshold (-60 > -90)
    scanner._handleSighting({
      mac: 'AA:BB:CC:DD:EE:01', rssi: -60, type: 'ibeacon', role: 'unknown', timestamp: Date.now(),
    });

    // Sighting below threshold (-95 < -90)
    scanner._handleSighting({
      mac: 'AA:BB:CC:DD:EE:02', rssi: -95, type: 'ibeacon', role: 'unknown', timestamp: Date.now(),
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].mac, 'AA:BB:CC:DD:EE:01');
  });

  it('should emit beacon:discovered only on first sighting', () => {
    const discovered = [];
    const sightings = [];
    scanner.on('beacon:discovered', (s) => discovered.push(s));
    scanner.on('beacon:sighting', (s) => sightings.push(s));

    const sighting = {
      mac: 'AA:BB:CC:DD:EE:FF', rssi: -60, type: 'unknown', role: 'unknown', timestamp: Date.now(),
    };

    scanner._handleSighting(sighting);
    scanner._handleSighting({ ...sighting, timestamp: Date.now() + 100 });

    assert.equal(discovered.length, 1);
    assert.equal(sightings.length, 2);
  });

  it('should emit sensor:event with unified event model', () => {
    const events = [];
    scanner.on('sensor:event', (e) => events.push(e));

    scanner._handleSighting({
      mac: 'AA:BB:CC:DD:EE:FF', rssi: -60, type: 'ibeacon', role: 'unknown', timestamp: 12345,
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'ble-sighting');
    assert.equal(events[0].source, 'ble');
    assert.equal(events[0].timestamp, 12345);
    assert.equal(events[0].data.mac, 'AA:BB:CC:DD:EE:FF');
  });

  it('should resolve beacon identity from persisted state', () => {
    mockState = { beacons: { 'AA:BB:CC:DD:EE:FF': { name: 'Patient 1', role: 'patient' } } };

    const events = [];
    scanner.on('beacon:sighting', (s) => events.push(s));

    scanner._handleSighting({
      mac: 'AA:BB:CC:DD:EE:FF', rssi: -60, type: 'ibeacon', role: 'unknown', timestamp: Date.now(),
    });

    assert.equal(events[0].name, 'Patient 1');
    assert.equal(events[0].role, 'patient');
  });

  it('should persist identity via setBeaconIdentity', () => {
    scanner.setBeaconIdentity('AA:BB:CC:DD:EE:FF', 'Nurse Alice', 'staff');
    assert.equal(mockState.beacons['AA:BB:CC:DD:EE:FF'].name, 'Nurse Alice');
    assert.equal(mockState.beacons['AA:BB:CC:DD:EE:FF'].role, 'staff');
  });

  it('should prune stale beacons', () => {
    const lost = [];
    scanner.on('beacon:lost', (s) => lost.push(s));

    const now = Date.now();
    scanner.beacons.set('OLD', { mac: 'OLD', timestamp: now - 60_000 }); // 60s ago — stale
    scanner.beacons.set('NEW', { mac: 'NEW', timestamp: now - 1_000 });  // 1s ago — fresh

    scanner._pruneStale();

    assert.equal(scanner.beacons.size, 1);
    assert.ok(scanner.beacons.has('NEW'));
    assert.equal(lost.length, 1);
    assert.equal(lost[0].mac, 'OLD');
  });

  it('should track statistics per beacon type', () => {
    scanner._handleSighting({
      mac: 'AA:BB:CC:DD:EE:01', rssi: -60, type: 'ibeacon', role: 'unknown', timestamp: Date.now(),
    });
    scanner._handleSighting({
      mac: 'AA:BB:CC:DD:EE:02', rssi: -60, type: 'eddystone-uid', role: 'unknown', timestamp: Date.now(),
    });
    scanner._handleSighting({
      mac: 'AA:BB:CC:DD:EE:03', rssi: -60, type: 'unknown', role: 'unknown', timestamp: Date.now(),
    });

    assert.equal(scanner.stats.ibeaconCount, 1);
    assert.equal(scanner.stats.eddystoneCount, 1);
    assert.equal(scanner.stats.unknownCount, 1);
  });

  it('should reset statistics', () => {
    scanner.stats.ibeaconCount = 10;
    scanner.stats.parseErrors = 5;
    scanner.resetStats();
    assert.equal(scanner.stats.ibeaconCount, 0);
    assert.equal(scanner.stats.parseErrors, 0);
  });

  it('should return beacons by role', () => {
    scanner.beacons.set('P1', { mac: 'P1', role: 'patient', timestamp: Date.now() });
    scanner.beacons.set('S1', { mac: 'S1', role: 'staff', timestamp: Date.now() });
    scanner.beacons.set('P2', { mac: 'P2', role: 'patient', timestamp: Date.now() });

    const patients = scanner.getByRole('patient');
    assert.equal(patients.length, 2);

    const staff = scanner.getByRole('staff');
    assert.equal(staff.length, 1);
  });
});

// ---------------------------------------------------------------------------
// hcidump line processing integration tests
// ---------------------------------------------------------------------------

describe('BleScanner._processHciLine (hcidump parsing)', () => {
  let scanner;

  beforeEach(() => {
    const mockLogger = {
      child: () => ({
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      }),
    };

    scanner = new BleScanner(
      { ble: { enabled: true, hciDevice: 'hci0', uuidFilter: '', rssiThreshold: -100, scanIntervalMs: 1000 } },
      () => ({ beacons: {} }),
      () => {},
      mockLogger
    );
  });

  it('should accumulate multi-line hex frames and parse on next frame start', () => {
    const events = [];
    scanner.on('beacon:sighting', (s) => events.push(s));

    const mac = [0xA1, 0xB2, 0xC3, 0xD4, 0xE5, 0xF6];
    const adData = buildIBeaconAd({
      uuid: 'e2c56db5dffb48d2b060d0f5a71096e0',
      major: 1,
      minor: 2,
    });
    const bytes = buildAdvReport({ mac, rssi: -65, adData });

    // Convert bytes to hex lines like hcidump would output
    const hexStr = bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
    const line1 = '> ' + hexStr.substring(0, 30);
    const line2 = '  ' + hexStr.substring(30);

    // Feed lines
    scanner._processHciLine(line1);
    scanner._processHciLine(line2);

    // Flush by starting a new frame
    scanner._processHciLine('> 04 3E 02 02');

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'ibeacon');
    assert.equal(events[0].mac, 'A1:B2:C3:D4:E5:F6');
  });

  it('should ignore non-hex lines', () => {
    scanner._processHciLine('some random text');
    scanner._processHciLine('');
    scanner._processHciLine('   ');
    assert.equal(scanner._hexAccumulator, '');
  });

  it('should handle hex accumulator overflow gracefully', () => {
    // Start a frame
    scanner._processHciLine('> 04 3E');
    // Feed many continuation lines to exceed buffer limit (4096 chars)
    // Each line adds ~300 chars, so after ~14 lines it overflows
    for (let i = 0; i < 20; i++) {
      scanner._processHciLine('  ' + 'AA '.repeat(100));
    }
    // The overflow should have been detected and parseErrors incremented
    assert.ok(scanner.stats.parseErrors >= 1, 'Expected at least one parse error from overflow');
  });
});

describe('BleScanner hcidump end-to-end with Eddystone', () => {
  let scanner;

  beforeEach(() => {
    const mockLogger = {
      child: () => ({
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      }),
    };

    scanner = new BleScanner(
      { ble: { enabled: true, hciDevice: 'hci0', uuidFilter: '', rssiThreshold: -100, scanIntervalMs: 1000 } },
      () => ({ beacons: {} }),
      () => {},
      mockLogger
    );
  });

  it('should parse Eddystone-UID frame from hcidump lines', () => {
    const events = [];
    scanner.on('beacon:sighting', (s) => events.push(s));

    const mac = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66];
    const adData = buildEddystoneUidAd({
      namespace: '0102030405060708090a',
      instance: 'aabbccddeeff',
    });
    const bytes = buildAdvReport({ mac, rssi: -50, adData });

    const hexStr = bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');

    // Single line frame
    scanner._processHciLine('> ' + hexStr);
    // Flush
    scanner._processHciLine('> 04');

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'eddystone-uid');
    assert.equal(events[0].namespace, '0102030405060708090a');
    assert.equal(events[0].instance, 'aabbccddeeff');
    assert.equal(events[0].rssi, -50);
  });
});
