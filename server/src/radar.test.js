// ==============================================================================
// Radar Service Tests
// ==============================================================================
// Tests the LD2410S mmWave radar frame parser, covering both basic mode (0x01)
// and engineering mode (0x02) with per-gate energy data, light sensor, and
// output pin parsing.
//
// Since the actual serial port isn't available in CI, we test frame parsing by
// feeding raw binary data directly to the internal _onData() method.
//
// Frame format:
//   Header: F4 F3 F2 F1
//   Length: 2 bytes LE (payload length)
//   Payload: varies by mode (see buildBasicPayload / buildEngineeringPayload)
//   Tail:   F8 F7 F6 F5

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  RadarService,
  FRAME_TYPE_BASIC,
  FRAME_TYPE_ENGINEERING,
  MAX_GATES,
  buildFrame,
  buildBasicPayload,
  buildEngineeringPayload,
  gateToDistance,
  findPeakGate,
  totalGateEnergy,
} from './radar.js';
import { createMockLogger, createTestConfig, waitForEvent } from './test-helpers.js';

// ---------------------------------------------------------------------------
// Helper: build a complete frame from options
// ---------------------------------------------------------------------------

/**
 * Build a complete basic mode frame for testing.
 * @param {Object} [opts] - See buildBasicPayload for options
 * @returns {Buffer}
 */
function basicFrame(opts = {}) {
  return buildFrame(buildBasicPayload(opts));
}

/**
 * Build a complete engineering mode frame for testing.
 * @param {Object} [opts] - See buildEngineeringPayload for options
 * @returns {Buffer}
 */
function engineeringFrame(opts = {}) {
  return buildFrame(buildEngineeringPayload(opts));
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

  // =========================================================================
  // Initial State
  // =========================================================================

  describe('initial state', () => {
    it('should not be available before starting', () => {
      assert.equal(radar.isAvailable, false);
    });

    it('should have null lastReading before any data', () => {
      assert.equal(radar.lastReading, null);
    });

    it('should have null lastEngineering before any data', () => {
      assert.equal(radar.lastEngineering, null);
    });

    it('should have zero stats initially', () => {
      const stats = radar.stats;
      assert.equal(stats.framesReceived, 0);
      assert.equal(stats.framesDropped, 0);
      assert.equal(stats.basicFrames, 0);
      assert.equal(stats.engineeringFrames, 0);
      assert.equal(stats.bytesReceived, 0);
      assert.equal(stats.bufferOverflows, 0);
    });
  });

  // =========================================================================
  // Basic Mode Frame Parsing (type 0x01)
  // =========================================================================

  describe('basic mode parsing', () => {
    it('should parse a valid basic mode frame', async () => {
      const frame = basicFrame({
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

      assert.equal(reading.mode, 'basic');
      assert.equal(reading.state, 'moving');
      assert.equal(reading.movingDist, 150);
      assert.equal(reading.movingEnergy, 60);
      assert.equal(reading.stationaryDist, 0);
      assert.equal(reading.stationaryEnergy, 0);
      assert.equal(reading.detectionDist, 150);
      assert.equal(typeof reading.timestamp, 'number');
    });

    it('should correctly map all state codes', async () => {
      const expectedStates = ['none', 'moving', 'stationary', 'both'];

      for (let stateCode = 0; stateCode <= 3; stateCode++) {
        const frame = basicFrame({ state: stateCode });
        const promise = waitForEvent(radar, 'reading');
        radar._onData(frame);
        const reading = await promise;
        assert.equal(reading.state, expectedStates[stateCode],
          `State code ${stateCode} should map to "${expectedStates[stateCode]}"`);
      }
    });

    it('should default unknown state codes to "none"', async () => {
      const frame = basicFrame({ state: 255 });
      const promise = waitForEvent(radar, 'reading');
      radar._onData(frame);
      const reading = await promise;
      assert.equal(reading.state, 'none');
    });

    it('should store the reading as lastReading', () => {
      const frame = basicFrame({ state: 3, movingDist: 100, stationaryDist: 80 });
      radar._onData(frame);

      const reading = radar.lastReading;
      assert.notEqual(reading, null);
      assert.equal(reading.state, 'both');
      assert.equal(reading.movingDist, 100);
      assert.equal(reading.stationaryDist, 80);
    });

    it('should NOT update lastEngineering for basic frames', () => {
      const frame = basicFrame({ state: 1 });
      radar._onData(frame);
      assert.equal(radar.lastEngineering, null);
    });

    it('should increment basicFrames stat', () => {
      radar._onData(basicFrame());
      radar._onData(basicFrame());
      assert.equal(radar.stats.basicFrames, 2);
      assert.equal(radar.stats.engineeringFrames, 0);
      assert.equal(radar.stats.framesReceived, 2);
    });
  });

  // =========================================================================
  // Engineering Mode Frame Parsing (type 0x02)
  // =========================================================================

  describe('engineering mode parsing', () => {
    it('should parse a minimal engineering mode frame', async () => {
      const frame = engineeringFrame({
        state: 1,
        movingDist: 225,
        movingEnergy: 75,
        stationaryDist: 300,
        stationaryEnergy: 50,
        detectionDist: 300,
        maxMovingGate: 8,
        maxStationaryGate: 8,
        movingGateEnergy: [10, 20, 30, 40, 75, 50, 30, 10, 5],
        stationaryGateEnergy: [5, 10, 15, 20, 50, 40, 25, 10, 5],
      });

      const promise = waitForEvent(radar, 'engineering');
      radar._onData(frame);
      const reading = await promise;

      assert.equal(reading.mode, 'engineering');
      assert.equal(reading.state, 'moving');
      assert.equal(reading.movingDist, 225);
      assert.equal(reading.movingEnergy, 75);
      assert.equal(reading.stationaryDist, 300);
      assert.equal(reading.stationaryEnergy, 50);
      assert.equal(reading.detectionDist, 300);
      assert.equal(reading.maxMovingGate, 8);
      assert.equal(reading.maxStationaryGate, 8);
      assert.deepEqual(reading.movingGateEnergy, [10, 20, 30, 40, 75, 50, 30, 10, 5]);
      assert.deepEqual(reading.stationaryGateEnergy, [5, 10, 15, 20, 50, 40, 25, 10, 5]);
      assert.equal(reading.lightSensor, null); // not included
      assert.equal(reading.outputPin, null);   // not included
      assert.equal(typeof reading.timestamp, 'number');
    });

    it('should emit both "reading" and "engineering" events', async () => {
      const frame = engineeringFrame({ state: 2, maxMovingGate: 2, maxStationaryGate: 2 });

      const readings = [];
      const engineerings = [];
      radar.on('reading', (r) => readings.push(r));
      radar.on('engineering', (r) => engineerings.push(r));

      radar._onData(frame);

      assert.equal(readings.length, 1);
      assert.equal(engineerings.length, 1);
      assert.equal(readings[0], engineerings[0]); // same object
    });

    it('should update both lastReading and lastEngineering', () => {
      const frame = engineeringFrame({ state: 3, maxMovingGate: 4, maxStationaryGate: 4 });
      radar._onData(frame);

      assert.notEqual(radar.lastReading, null);
      assert.notEqual(radar.lastEngineering, null);
      assert.equal(radar.lastReading.mode, 'engineering');
    });

    it('should parse frames with fewer gates', async () => {
      // Only 3 gates (0, 1, 2) — smaller radar configuration
      const frame = engineeringFrame({
        state: 1,
        maxMovingGate: 2,
        maxStationaryGate: 2,
        movingGateEnergy: [80, 40, 10],
        stationaryGateEnergy: [5, 15, 25],
      });

      const promise = waitForEvent(radar, 'engineering');
      radar._onData(frame);
      const reading = await promise;

      assert.equal(reading.maxMovingGate, 2);
      assert.equal(reading.maxStationaryGate, 2);
      assert.deepEqual(reading.movingGateEnergy, [80, 40, 10]);
      assert.deepEqual(reading.stationaryGateEnergy, [5, 15, 25]);
    });

    it('should parse asymmetric moving/stationary gate counts', async () => {
      const frame = engineeringFrame({
        state: 3,
        maxMovingGate: 8,
        maxStationaryGate: 4,
        movingGateEnergy: [0, 10, 20, 30, 40, 50, 60, 70, 80],
        stationaryGateEnergy: [5, 10, 15, 20, 25],
      });

      const promise = waitForEvent(radar, 'engineering');
      radar._onData(frame);
      const reading = await promise;

      assert.equal(reading.movingGateEnergy.length, 9);
      assert.equal(reading.stationaryGateEnergy.length, 5);
      assert.equal(reading.movingGateEnergy[8], 80);
      assert.equal(reading.stationaryGateEnergy[4], 25);
    });

    it('should parse light sensor value when present', async () => {
      const frame = engineeringFrame({
        state: 0,
        maxMovingGate: 2,
        maxStationaryGate: 2,
        lightSensor: 128,
      });

      const promise = waitForEvent(radar, 'engineering');
      radar._onData(frame);
      const reading = await promise;

      assert.equal(reading.lightSensor, 128);
      assert.equal(reading.outputPin, null); // only light, no pin
    });

    it('should parse both light sensor and output pin when present', async () => {
      const frame = engineeringFrame({
        state: 1,
        maxMovingGate: 4,
        maxStationaryGate: 4,
        lightSensor: 200,
        outputPin: 1,
      });

      const promise = waitForEvent(radar, 'engineering');
      radar._onData(frame);
      const reading = await promise;

      assert.equal(reading.lightSensor, 200);
      assert.equal(reading.outputPin, 1);
    });

    it('should handle output pin state 0 (no detection)', async () => {
      const frame = engineeringFrame({
        state: 0,
        maxMovingGate: 2,
        maxStationaryGate: 2,
        lightSensor: 50,
        outputPin: 0,
      });

      const promise = waitForEvent(radar, 'engineering');
      radar._onData(frame);
      const reading = await promise;

      assert.equal(reading.outputPin, 0);
    });

    it('should parse zero-energy gates correctly', async () => {
      const frame = engineeringFrame({
        state: 0,
        maxMovingGate: 8,
        maxStationaryGate: 8,
        movingGateEnergy: [0, 0, 0, 0, 0, 0, 0, 0, 0],
        stationaryGateEnergy: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      });

      const promise = waitForEvent(radar, 'engineering');
      radar._onData(frame);
      const reading = await promise;

      assert.equal(reading.state, 'none');
      assert.ok(reading.movingGateEnergy.every(e => e === 0));
      assert.ok(reading.stationaryGateEnergy.every(e => e === 0));
    });

    it('should parse max energy values (100) per gate', async () => {
      const maxEnergy = new Array(9).fill(100);
      const frame = engineeringFrame({
        state: 3,
        maxMovingGate: 8,
        maxStationaryGate: 8,
        movingGateEnergy: maxEnergy,
        stationaryGateEnergy: maxEnergy,
      });

      const promise = waitForEvent(radar, 'engineering');
      radar._onData(frame);
      const reading = await promise;

      assert.ok(reading.movingGateEnergy.every(e => e === 100));
      assert.ok(reading.stationaryGateEnergy.every(e => e === 100));
    });

    it('should increment engineeringFrames stat', () => {
      radar._onData(engineeringFrame({ maxMovingGate: 2, maxStationaryGate: 2 }));
      radar._onData(engineeringFrame({ maxMovingGate: 2, maxStationaryGate: 2 }));
      assert.equal(radar.stats.engineeringFrames, 2);
      assert.equal(radar.stats.basicFrames, 0);
      assert.equal(radar.stats.framesReceived, 2);
    });
  });

  // =========================================================================
  // Frame Robustness (both modes)
  // =========================================================================

  describe('frame robustness', () => {
    it('should handle consecutive frames in a single chunk', () => {
      const frame1 = basicFrame({ state: 1, movingDist: 100 });
      const frame2 = engineeringFrame({
        state: 2,
        stationaryDist: 200,
        maxMovingGate: 2,
        maxStationaryGate: 2,
      });

      const readings = [];
      radar.on('reading', (r) => readings.push(r));
      radar._onData(Buffer.concat([frame1, frame2]));

      assert.equal(readings.length, 2);
      assert.equal(readings[0].mode, 'basic');
      assert.equal(readings[0].state, 'moving');
      assert.equal(readings[1].mode, 'engineering');
      assert.equal(readings[1].state, 'stationary');
    });

    it('should handle frames split across multiple chunks', async () => {
      const frame = engineeringFrame({
        state: 1,
        movingDist: 250,
        maxMovingGate: 4,
        maxStationaryGate: 4,
        movingGateEnergy: [10, 20, 30, 40, 50],
      });

      // Split at an arbitrary byte
      const mid = Math.floor(frame.length / 2);
      const chunk1 = frame.subarray(0, mid);
      const chunk2 = frame.subarray(mid);

      const promise = waitForEvent(radar, 'reading');
      radar._onData(chunk1);
      radar._onData(chunk2);
      const reading = await promise;

      assert.equal(reading.mode, 'engineering');
      assert.equal(reading.movingDist, 250);
      assert.deepEqual(reading.movingGateEnergy, [10, 20, 30, 40, 50]);
    });

    it('should skip garbage data before a valid frame', async () => {
      const garbage = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
      const frame = basicFrame({ state: 0, detectionDist: 0 });

      const promise = waitForEvent(radar, 'reading');
      radar._onData(Buffer.concat([garbage, frame]));
      const reading = await promise;

      assert.equal(reading.state, 'none');
    });

    it('should handle garbage between valid frames', () => {
      const garbage = Buffer.from([0xaa, 0xbb, 0xcc]);
      const frame1 = basicFrame({ state: 1 });
      const frame2 = basicFrame({ state: 2 });

      const readings = [];
      radar.on('reading', (r) => readings.push(r));
      radar._onData(Buffer.concat([frame1, garbage, frame2]));

      // At least the first frame should parse; second depends on garbage alignment
      assert.ok(readings.length >= 1);
      assert.equal(readings[0].state, 'moving');
    });

    it('should ignore frames with invalid type bytes', () => {
      // Build a frame with type 0x05 (invalid)
      const payload = Buffer.alloc(10);
      payload[0] = 0x05;
      const frame = buildFrame(payload);

      const readings = [];
      radar.on('reading', (r) => readings.push(r));
      radar._onData(frame);

      assert.equal(readings.length, 0, 'Should not emit reading for invalid type');
    });

    it('should drop frames with too-short payload', () => {
      // Basic frame with only 5 bytes of payload (minimum is 10)
      const shortPayload = Buffer.from([FRAME_TYPE_BASIC, 0x01, 0x00, 0x00, 0x00]);
      const frame = buildFrame(shortPayload);

      const readings = [];
      radar.on('reading', (r) => readings.push(r));
      radar._onData(frame);

      assert.equal(readings.length, 0);
      assert.equal(radar.stats.framesDropped, 1);
    });

    it('should drop engineering frame with invalid gate count (>= MAX_GATES)', () => {
      // Manually craft a payload with gate count of 9 (MAX_GATES)
      const payload = Buffer.alloc(14);
      payload[0] = FRAME_TYPE_ENGINEERING;
      payload[1] = 0; // state
      payload[10] = 9; // maxMovingGate = 9 (invalid, max is 8)
      payload[11] = 8; // maxStationaryGate = 8 (valid)
      const frame = buildFrame(payload);

      const readings = [];
      radar.on('reading', (r) => readings.push(r));
      radar._onData(frame);

      assert.equal(readings.length, 0);
      assert.equal(radar.stats.framesDropped, 1);
    });

    it('should drop engineering frame with truncated gate data', () => {
      // Claim 9 gates but only provide 3 bytes of data
      const payload = Buffer.alloc(15);
      payload[0] = FRAME_TYPE_ENGINEERING;
      payload[1] = 0;
      payload[10] = 8; // expects 9 moving gate bytes
      payload[11] = 8; // expects 9 stationary gate bytes
      // Only 3 bytes after offset 12, far short of 18 needed
      const frame = buildFrame(payload);

      const readings = [];
      radar.on('reading', (r) => readings.push(r));
      radar._onData(frame);

      assert.equal(readings.length, 0);
      assert.equal(radar.stats.framesDropped, 1);
    });

    it('should drop frames with bogus length field (> 128)', () => {
      // Craft a buffer with valid header but absurd length, padded to 10+ bytes
      // so _onData enters the processing loop
      const buf = Buffer.alloc(16, 0x00);
      buf[0] = 0xf4; buf[1] = 0xf3; buf[2] = 0xf2; buf[3] = 0xf1; // header
      buf.writeUInt16LE(1024, 4); // length = 1024 (> 128 sanity limit)

      radar._onData(buf);
      assert.equal(radar.stats.framesDropped, 1);
    });

    it('should prevent buffer from growing unbounded', () => {
      for (let i = 0; i < 20; i++) {
        radar._onData(Buffer.alloc(100, 0xff));
      }
      assert.ok(radar._buffer.length <= 1024,
        `Buffer should not exceed 1024 bytes, got ${radar._buffer.length}`);
    });

    it('should track bytesReceived stat', () => {
      const frame = basicFrame({ state: 1 });
      radar._onData(frame);
      assert.equal(radar.stats.bytesReceived, frame.length);
    });
  });

  // =========================================================================
  // Mixed Mode Sequences
  // =========================================================================

  describe('mixed basic and engineering frames', () => {
    it('should alternate between basic and engineering frames', () => {
      const bFrame = basicFrame({ state: 1, movingDist: 100 });
      const eFrame = engineeringFrame({
        state: 2,
        stationaryDist: 200,
        maxMovingGate: 2,
        maxStationaryGate: 2,
        stationaryGateEnergy: [10, 30, 50],
      });

      const readings = [];
      const engineerings = [];
      radar.on('reading', (r) => readings.push(r));
      radar.on('engineering', (r) => engineerings.push(r));

      radar._onData(Buffer.concat([bFrame, eFrame, bFrame]));

      assert.equal(readings.length, 3);
      assert.equal(engineerings.length, 1);
      assert.equal(readings[0].mode, 'basic');
      assert.equal(readings[1].mode, 'engineering');
      assert.equal(readings[2].mode, 'basic');
    });

    it('should keep lastEngineering even after subsequent basic frames', () => {
      const eFrame = engineeringFrame({
        state: 3,
        maxMovingGate: 2,
        maxStationaryGate: 2,
        movingGateEnergy: [99, 50, 10],
      });
      radar._onData(eFrame);

      const engReading = radar.lastEngineering;
      assert.notEqual(engReading, null);
      assert.deepEqual(engReading.movingGateEnergy, [99, 50, 10]);

      // Now send a basic frame — lastEngineering should NOT be cleared
      radar._onData(basicFrame({ state: 0 }));
      assert.equal(radar.lastReading.mode, 'basic');
      assert.equal(radar.lastEngineering, engReading); // still the engineering one
    });
  });

  // =========================================================================
  // Stats & Reset
  // =========================================================================

  describe('statistics', () => {
    it('should accurately track frame counts by mode', () => {
      radar._onData(basicFrame({ state: 0 }));
      radar._onData(basicFrame({ state: 1 }));
      radar._onData(engineeringFrame({ maxMovingGate: 2, maxStationaryGate: 2 }));

      const stats = radar.stats;
      assert.equal(stats.framesReceived, 3);
      assert.equal(stats.basicFrames, 2);
      assert.equal(stats.engineeringFrames, 1);
    });

    it('should return a copy of stats (not a reference)', () => {
      radar._onData(basicFrame());
      const stats1 = radar.stats;
      radar._onData(basicFrame());
      const stats2 = radar.stats;

      assert.notEqual(stats1, stats2);
      assert.equal(stats1.framesReceived, 1);
      assert.equal(stats2.framesReceived, 2);
    });

    it('should reset all stats on resetStats()', () => {
      radar._onData(basicFrame());
      radar._onData(engineeringFrame({ maxMovingGate: 2, maxStationaryGate: 2 }));
      radar.resetStats();

      const stats = radar.stats;
      assert.equal(stats.framesReceived, 0);
      assert.equal(stats.framesDropped, 0);
      assert.equal(stats.basicFrames, 0);
      assert.equal(stats.engineeringFrames, 0);
      assert.equal(stats.bytesReceived, 0);
      assert.equal(stats.bufferOverflows, 0);
    });

    it('should track framesDropped when tail mismatches', () => {
      // Craft a frame with correct header and length but wrong tail bytes
      const payload = Buffer.alloc(10);
      payload[0] = FRAME_TYPE_BASIC;
      payload[1] = 1;
      const header = Buffer.from([0xf4, 0xf3, 0xf2, 0xf1]);
      const length = Buffer.alloc(2);
      length.writeUInt16LE(10);
      const badTail = Buffer.from([0x00, 0x00, 0x00, 0x00]); // not F8 F7 F6 F5
      const badFrame = Buffer.concat([header, length, payload, badTail]);

      radar._onData(badFrame);
      assert.equal(radar.stats.framesDropped, 1);
      assert.equal(radar.stats.framesReceived, 0);
    });
  });

  // =========================================================================
  // Pure Helper Functions
  // =========================================================================

  describe('gateToDistance()', () => {
    it('should return 0-75cm for gate 0', () => {
      const range = gateToDistance(0);
      assert.equal(range.minCm, 0);
      assert.equal(range.maxCm, 75);
    });

    it('should return 75-150cm for gate 1', () => {
      const range = gateToDistance(1);
      assert.equal(range.minCm, 75);
      assert.equal(range.maxCm, 150);
    });

    it('should return 600-675cm for gate 8', () => {
      const range = gateToDistance(8);
      assert.equal(range.minCm, 600);
      assert.equal(range.maxCm, 675);
    });
  });

  describe('findPeakGate()', () => {
    it('should find the gate with highest energy', () => {
      const result = findPeakGate([10, 20, 80, 40, 5]);
      assert.deepEqual(result, { gate: 2, energy: 80 });
    });

    it('should return the first gate on ties', () => {
      const result = findPeakGate([50, 50, 50]);
      assert.deepEqual(result, { gate: 0, energy: 50 });
    });

    it('should handle single-element arrays', () => {
      const result = findPeakGate([42]);
      assert.deepEqual(result, { gate: 0, energy: 42 });
    });

    it('should return null for empty arrays', () => {
      assert.equal(findPeakGate([]), null);
    });

    it('should return null for null input', () => {
      assert.equal(findPeakGate(null), null);
    });

    it('should handle all-zero energies', () => {
      const result = findPeakGate([0, 0, 0, 0, 0]);
      assert.deepEqual(result, { gate: 0, energy: 0 });
    });
  });

  describe('totalGateEnergy()', () => {
    it('should sum all gate energies', () => {
      assert.equal(totalGateEnergy([10, 20, 30, 40]), 100);
    });

    it('should return 0 for all-zero energies', () => {
      assert.equal(totalGateEnergy([0, 0, 0]), 0);
    });

    it('should return 0 for empty array', () => {
      assert.equal(totalGateEnergy([]), 0);
    });

    it('should return 0 for null input', () => {
      assert.equal(totalGateEnergy(null), 0);
    });

    it('should handle max energy scenario', () => {
      assert.equal(totalGateEnergy(new Array(9).fill(100)), 900);
    });
  });

  // =========================================================================
  // Frame Builder Utilities
  // =========================================================================

  describe('buildFrame / buildBasicPayload / buildEngineeringPayload', () => {
    it('buildFrame should produce valid header-length-payload-tail structure', () => {
      const payload = Buffer.from([0x01, 0x02, 0x03]);
      const frame = buildFrame(payload);

      // Header
      assert.ok(frame.subarray(0, 4).equals(Buffer.from([0xf4, 0xf3, 0xf2, 0xf1])));
      // Length
      assert.equal(frame.readUInt16LE(4), 3);
      // Payload
      assert.ok(frame.subarray(6, 9).equals(payload));
      // Tail
      assert.ok(frame.subarray(9, 13).equals(Buffer.from([0xf8, 0xf7, 0xf6, 0xf5])));
    });

    it('buildBasicPayload should produce 10-byte payload with type 0x01', () => {
      const p = buildBasicPayload({ state: 2, movingDist: 300 });
      assert.equal(p.length, 10);
      assert.equal(p[0], FRAME_TYPE_BASIC);
      assert.equal(p[1], 2);
      assert.equal(p.readUInt16LE(2), 300);
    });

    it('buildEngineeringPayload should have correct size for 9+9 gates', () => {
      const p = buildEngineeringPayload({ maxMovingGate: 8, maxStationaryGate: 8 });
      // 12 base + 9 moving + 9 stationary = 30 bytes
      assert.equal(p.length, 30);
      assert.equal(p[0], FRAME_TYPE_ENGINEERING);
    });

    it('buildEngineeringPayload should include light sensor and output pin', () => {
      const p = buildEngineeringPayload({
        maxMovingGate: 2,
        maxStationaryGate: 2,
        lightSensor: 150,
        outputPin: 1,
      });
      // 12 base + 3 moving + 3 stationary + 1 light + 1 pin = 20
      assert.equal(p.length, 20);
      assert.equal(p[p.length - 2], 150); // light sensor
      assert.equal(p[p.length - 1], 1);   // output pin
    });
  });
});
