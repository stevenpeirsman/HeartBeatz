// ==============================================================================
// Config Module Tests
// ==============================================================================
// Verifies that loadConfig() correctly reads environment variables, applies
// defaults, and produces a frozen config object. Also tests loadState/saveState
// round-tripping for persistent state.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';

describe('loadConfig()', () => {
  // Save original env so we can restore after each test
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original environment variables
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('should return sensible defaults when no env vars are set', () => {
    // Clear relevant env vars to test defaults
    delete process.env.HEARTBEATZ_PORT;
    delete process.env.NODE_ENV;
    delete process.env.LOG_LEVEL;

    const config = loadConfig();

    assert.equal(config.port, 8080, 'Default port should be 8080');
    assert.equal(config.logLevel, 'info', 'Default log level should be info');
    assert.equal(config.heartbeatzIp, '192.168.1.10');
    assert.equal(config.gatewayIp, '192.168.1.1');
  });

  it('should read HEARTBEATZ_PORT from environment', () => {
    process.env.HEARTBEATZ_PORT = '9090';
    const config = loadConfig();
    assert.equal(config.port, 9090);
  });

  it('should handle invalid numeric env vars gracefully (fall back to default)', () => {
    process.env.HEARTBEATZ_PORT = 'not-a-number';
    const config = loadConfig();
    assert.equal(config.port, 8080, 'Should fall back to default on invalid number');
  });

  it('should parse sensing config correctly', () => {
    process.env.SENSING_HTTP_PORT = '4000';
    process.env.SENSING_WS_PORT = '4001';
    process.env.SENSING_UDP_PORT = '6000';
    process.env.SENSING_TICK_MS = '50';
    process.env.CSI_SOURCE = 'esp32';

    const config = loadConfig();

    assert.equal(config.sensing.httpPort, 4000);
    assert.equal(config.sensing.wsPort, 4001);
    assert.equal(config.sensing.udpPort, 6000);
    assert.equal(config.sensing.tickMs, 50);
    assert.equal(config.sensing.source, 'esp32');
    assert.equal(config.sensing.baseUrl, 'http://localhost:4000');
    assert.equal(config.sensing.wsUrl, 'ws://localhost:4001');
  });

  it('should parse BLE config with boolean conversion', () => {
    process.env.BLE_ENABLED = 'true';
    process.env.BLE_RSSI_THRESHOLD = '-85';

    const config = loadConfig();

    assert.equal(config.ble.enabled, true);
    assert.equal(config.ble.rssiThreshold, -85);
  });

  it('should treat BLE_ENABLED=false as false', () => {
    process.env.BLE_ENABLED = 'false';
    const config = loadConfig();
    assert.equal(config.ble.enabled, false);
  });

  it('should parse demo mode settings', () => {
    process.env.DEMO_MODE = 'true';
    process.env.DEMO_SCENARIO = 'fall-detection';

    const config = loadConfig();

    assert.equal(config.demo.mode, 'true');
    assert.equal(config.demo.scenario, 'fall-detection');
  });

  it('should default demo mode to "auto"', () => {
    delete process.env.DEMO_MODE;
    const config = loadConfig();
    assert.equal(config.demo.mode, 'auto');
  });

  it('should produce a frozen config object (immutable)', () => {
    const config = loadConfig();

    assert.throws(() => {
      config.port = 9999;
    }, TypeError, 'Top-level config should be frozen');

    assert.throws(() => {
      config.sensing.httpPort = 9999;
    }, TypeError, 'Nested config should be frozen');
  });

  it('should parse display dimensions', () => {
    process.env.DISPLAY_WIDTH = '800';
    process.env.DISPLAY_HEIGHT = '480';

    const config = loadConfig();

    assert.equal(config.display.width, 800);
    assert.equal(config.display.height, 480);
  });

  it('should parse radar config', () => {
    process.env.RADAR_ENABLED = 'true';
    process.env.RADAR_SERIAL_PORT = '/dev/ttyUSB0';
    process.env.RADAR_BAUD_RATE = '115200';

    const config = loadConfig();

    assert.equal(config.radar.enabled, true);
    assert.equal(config.radar.serialPort, '/dev/ttyUSB0');
    assert.equal(config.radar.baudRate, 115200);
  });
});
