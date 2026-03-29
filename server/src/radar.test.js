// ==============================================================================
// Radar Service Tests
// ==============================================================================
// Tests the LD2410S mmWave radar frame parser. Since the actual serial port
// isn't available in CI, we test the frame parsing logic by feeding raw
// binary data directly to the internal _onData() method.
//
// Frame format:
//   Header: F4 F3 F2 F1
//   Length: 2 bytes LE (payload length)
//   Payload: type(1) + state(1) + movingDist(2) + movingEnergy(1) +
//            stationaryDist(2) + stationaryEnergy(1) + [detectionDist(2)]
//   Tail:   F8 F7 F6 F5

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RadarService } from './radar.js';
import { createMockLogger, createTestConfig, waitForEvent } from './test-helpers.js';

/**
 * Build a valid LD2410S binary frame for testing.
 *
 * @param {Object} opts
 * @param {number} [opts.type=0x02]       - Frame type (0x01=basic, 0x02=engineering)
 * @param {number} [opts.state=1]         - 0=none, 1=moving, 2=stationary, 3=both
 * @param {number} [opts.movingDist=150]  - Moving target distance (cm)
 * @param {number} [opts.movingEnergy=60] - Moving target energy (0-100)
 * @param {number} [opts.stationaryDist=200] - Stationary target distance (cm)
 * @param {number} [opts.stationaryEnergy=40] - Stationary target energy (0-100)
 * @param {number} [opts.detectionDist=200]  - Overall detection distance (cm)
 * @returns {Buffer}
 */
function buildRadarFrame(opts = {}) {
  const type = opts.type ?? 0x02;
  const state = opts.state ?? 1;
  const movingDist = opts.movingDist ?? 150;
  const movingEnergy = opts.movingEnergy ?? 60;
  const stationaryDist = opts.stationaryDist ?? 200;
  const stationaryEnergy = opts.stationaryEnergy ?? 40;
  const detectionDist = opts.detectionDist ?? 200;

  // Build payload: type + state + movingDist(LE16) + movingEnergy +
  //                stationaryDist(LE16) + stationaryEnergy + detectionDist(LE16)
  const payload = Buffer.alloc(10);
  payload[0] = type;
  payload[1] = state;
  payload.writeUInt16LE(movingDist, 2);
  payload[4] = movingEnergy;
  payload.writeUInt16LE(stationaryDist, 5);
  payload[7] = stationaryEnergy;
  payload.writeUInt16LE(detectionDist, 8);

  // Build full frame
  const header = Buffer.from([0xf4, 0xf3, 0xf2, 0xf1]);
  const length = Buffer.alloc(2);
  length.writeUInt16LE(payload.length);
  const tail = Buffer.from([0xf8, 0xf7, 0xf6, 0xf5]);

  return Buffer.concat([header, length, payload, tail]);
}

describe('RadarService', () => {
  let radar;
  let config;
  let logger;

  beforeEach(() => {
    config = createTestConfig({ radar: { enabled: false } });
    logger = createMockLogger();
    radar = new RadarService(config, logger);
  });

  // -------------------------------------------------------------------------
  // Basic State
  // -------------------------------------------------------------------------

  describe('initial state', () => {
    it('should not be available before starting', () => {
      assert.equal(radar.isAvailable, false);
    });

    it('should have null lastReading before any data', () => {
      assert.equal(radar.lastReading, null);
    });
  });

  // -------------------------------------------------------------------------
  // Frame Parsing via _onData()
  // -------------------------------------------------------------------------

  describe('frame parsing', () => {
    it('should parse a valid engineering mode frame', async () => {
      const frame = buildRadarFrame({
        type: 0x02,
        state: 1, // moving
        movingDist: 150,
        movingEnergy: 60,
        stationaryDist: 0,
        stationaryEnergy: 0,
        detectionDist: 150,
      });

      const promise = waitForEvent(radar, 'reading');
      radar._onData(frame);
      const reading = await promise;

      assert.equal(reading.state, 'moving');
      assert.equal(reading.movingDist, 150);
      assert.equal(reading.movingEnergy, 60);
      assert.equal(reading.stationaryDist, 0);
      assert.equal(reading.stationaryEnergy, 0);
      assert.equal(reading.detectionDist, 150);
      assert.equal(typeof reading.timestamp, 'number');
    });

    it('should parse a basic mode frame (type 0x01)', async () => {
      const frame = buildRadarFrame({ type: 0x01, state: 2 });

      const promise = waitForEvent(radar, 'reading');
      radar._onData(frame);
      const reading = await promise;

      assert.equal(reading.state, 'stationary');
    });

    it('should correctly map all state codes', async () => {
      const expectedStates = ['none', 'moving', 'stationary', 'both'];

      for (let stateCode = 0; stateCode <= 3; stateCode++) {
        const frame = buildRadarFrame({ state: stateCode });
        const promise = waitForEvent(radar, 'reading');
        radar._onData(frame);
        const reading = await promise;
        assert.equal(reading.state, expectedStates[stateCode],
          `State code ${stateCode} should map to "${expectedStates[stateCode]}"`);
      }
    });

    it('should store the reading as lastReading', () => {
      const frame = buildRadarFrame({ state: 3, movingDist: 100, stationaryDist: 80 });
      radar._onData(frame);

      const reading = radar.lastReading;
      assert.notEqual(reading, null);
      assert.equal(reading.state, 'both');
      assert.equal(reading.movingDist, 100);
      assert.equal(reading.stationaryDist, 80);
    });

    it('should handle consecutive frames', async () => {
      const frame1 = buildRadarFrame({ state: 1, movingDist: 100 });
      const frame2 = buildRadarFrame({ state: 2, stationaryDist: 200 });

      // Feed both frames as a single chunk (simulating buffered serial data)
      const combined = Buffer.concat([frame1, frame2]);

      const readings = [];
      radar.on('reading', (r) => readings.push(r));
      radar._onData(combined);

      assert.equal(readings.length, 2);
      assert.equal(readings[0].state, 'moving');
      assert.equal(readings[1].state, 'stationary');
    });

    it('should handle frames split across multiple chunks', async () => {
      const frame = buildRadarFrame({ state: 1, movingDist: 250 });

      // Split the frame into two chunks at arbitrary points
      const mid = Math.floor(frame.length / 2);
      const chunk1 = frame.subarray(0, mid);
      const chunk2 = frame.subarray(mid);

      const promise = waitForEvent(radar, 'reading');
      radar._onData(chunk1);  // Partial frame — should buffer
      radar._onData(chunk2);  // Complete frame — should parse
      const reading = await promise;

      assert.equal(reading.state, 'moving');
      assert.equal(reading.movingDist, 250);
    });

    it('should skip garbage data before a valid frame', async () => {
      const garbage = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
      const frame = buildRadarFrame({ state: 0, detectionDist: 0 });

      const promise = waitForEvent(radar, 'reading');
      radar._onData(Buffer.concat([garbage, frame]));
      const reading = await promise;

      assert.equal(reading.state, 'none');
    });

    it('should ignore frames with invalid type bytes', () => {
      const frame = buildRadarFrame({ type: 0x05 }); // Invalid type
      const readings = [];
      radar.on('reading', (r) => readings.push(r));
      radar._onData(frame);

      assert.equal(readings.length, 0, 'Should not emit reading for invalid type');
    });

    it('should prevent buffer from growing unbounded', () => {
      // Feed lots of garbage data
      for (let i = 0; i < 20; i++) {
        radar._onData(Buffer.alloc(100, 0xff));
      }

      // Internal buffer should be capped (< 1024 bytes after trimming)
      assert.ok(radar._buffer.length <= 1024,
        `Buffer should not exceed 1024 bytes, got ${radar._buffer.length}`);
    });
  });
});
