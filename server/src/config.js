// ==============================================================================
// HeartBeatz Configuration
// ==============================================================================
// Loads environment variables and provides typed config with defaults.
// All config is read-only after boot — restart to apply changes.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(__dirname, '..', '..', 'state.json');

/**
 * Build configuration object from environment variables with sensible defaults.
 * @returns {Object} Frozen configuration object
 */
export function loadConfig() {
  return Object.freeze({
    // --- Server ---
    port: int(process.env.HEARTBEATZ_PORT, 8080),
    nodeEnv: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',

    // --- Network ---
    heartbeatzIp: process.env.HEARTBEATZ_IP || '192.168.1.10',
    gatewayIp: process.env.GATEWAY_IP || '192.168.1.1',
    subnet: process.env.NODE_SUBNET || '192.168.1.0/24',

    // --- Sensing Server (upstream RuView) ---
    sensing: Object.freeze({
      httpPort: int(process.env.SENSING_HTTP_PORT, 3000),
      wsPort: int(process.env.SENSING_WS_PORT, 3001),
      udpPort: int(process.env.SENSING_UDP_PORT, 5005),
      tickMs: int(process.env.SENSING_TICK_MS, 100),
      source: process.env.CSI_SOURCE || 'auto',
      baseUrl: `http://localhost:${int(process.env.SENSING_HTTP_PORT, 3000)}`,
      wsUrl: `ws://localhost:${int(process.env.SENSING_WS_PORT, 3001)}`,
    }),

    // --- Node Discovery ---
    discovery: Object.freeze({
      intervalMs: int(process.env.DISCOVERY_INTERVAL_MS, 5000),
      timeoutMs: int(process.env.NODE_TIMEOUT_MS, 15000),
    }),

    // --- BLE Beacon Tracking ---
    ble: Object.freeze({
      enabled: bool(process.env.BLE_ENABLED, false),
      hciDevice: process.env.BLE_HCI_DEVICE || 'hci0',
      uuidFilter: process.env.BLE_UUID_FILTER || '',
      rssiThreshold: int(process.env.BLE_RSSI_THRESHOLD, -70),
      scanIntervalMs: int(process.env.BLE_SCAN_INTERVAL_MS, 1000),
    }),

    // --- LD2410S Radar ---
    radar: Object.freeze({
      enabled: bool(process.env.RADAR_ENABLED, false),
      serialPort: process.env.RADAR_SERIAL_PORT || '',
      baudRate: int(process.env.RADAR_BAUD_RATE, 256000),
    }),

    // --- Display ---
    display: Object.freeze({
      width: int(process.env.DISPLAY_WIDTH, 1024),
      height: int(process.env.DISPLAY_HEIGHT, 600),
    }),

    // --- Demo Mode ---
    demo: Object.freeze({
      mode: 'false',  // FORCED off - update systemd service later
      scenario: process.env.DEMO_SCENARIO || 'patient-monitoring',
    }),
  });
}

// ---------------------------------------------------------------------------
// Persistent state (survives reboots — calibration, node names, etc.)
// ---------------------------------------------------------------------------

/**
 * Load persistent state from disk. Returns empty defaults if file missing.
 */
export function loadState() {
  if (!existsSync(STATE_PATH)) {
    return { nodes: {}, calibration: null, firstRunComplete: false };
  }
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
  } catch {
    return { nodes: {}, calibration: null, firstRunComplete: false };
  }
}

/**
 * Save persistent state to disk (atomic-ish write).
 * @param {Object} state
 */
export function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function int(val, fallback) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(val, fallback) {
  if (val === undefined || val === '') return fallback;
  return val === 'true' || val === '1';
}
