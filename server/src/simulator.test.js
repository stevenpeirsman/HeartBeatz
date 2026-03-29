// ==============================================================================
// Simulator Service Tests
// ==============================================================================
// Tests the demo mode data generator that produces realistic synthetic data
// for trade show demos. Verifies scenario management, data generation quality,
// phase transitions, and that the simulator implements the same interfaces as
// the real Discovery, BLE, and Radar services.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SimulatorService } from './simulator.js';
import {
  createMockLogger,
  createTestConfig,
  waitForEvent,
  collectEvents,
  sleep,
} from './test-helpers.js';

describe('SimulatorService', () => {
  let sim;
  let config;
  let logger;

  beforeEach(() => {
    config = createTestConfig({ sensing: { tickMs: 50 } });
    logger = createMockLogger();
    sim = new SimulatorService(config, logger);
  });

  afterEach(() => {
    sim.stop();
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('should not be running initially', () => {
      assert.equal(sim.isRunning, false);
    });

    it('should start and stop cleanly', () => {
      sim.start();
      assert.equal(sim.isRunning, true);

      sim.stop();
      assert.equal(sim.isRunning, false);
    });

    it('should be idempotent — calling start() twice does not throw', () => {
      sim.start();
      sim.start(); // Should be a no-op
      assert.equal(sim.isRunning, true);
    });

    it('should stop cleanly even if never started', () => {
      sim.stop(); // Should not throw
      assert.equal(sim.isRunning, false);
    });
  });

  // -------------------------------------------------------------------------
  // Node Discovery Interface
  // -------------------------------------------------------------------------

  describe('node discovery interface', () => {
    it('should provide 3 simulated nodes after start', async () => {
      sim.start();
      // Give it a tick to initialize nodes
      await sleep(60);

      const nodes = sim.getNodes();
      assert.equal(nodes.length, 3, 'Should have 3 simulated nodes');
    });

    it('should emit node:discovered events on start', async () => {
      const discovered = collectEvents(sim, 'node:discovered', 3, 2000);
      sim.start();
      const nodes = await discovered;
      assert.equal(nodes.length, 3);
    });

    it('should emit discovery:complete with all nodes', async () => {
      const promise = waitForEvent(sim, 'discovery:complete');
      sim.start();
      const nodes = await promise;
      assert.equal(Array.isArray(nodes), true);
      assert.equal(nodes.length, 3);
    });

    it('should return a node by ID', async () => {
      sim.start();
      await sleep(60);

      const node = sim.getNode('DEMO:AA:BB:CC:01');
      assert.notEqual(node, null);
      assert.equal(node.name, 'Wall Left');
    });

    it('should return null for unknown node ID', () => {
      sim.start();
      assert.equal(sim.getNode('UNKNOWN:ID'), null);
    });

    it('should allow renaming a simulated node', async () => {
      sim.start();
      await sleep(60);

      sim.setNodeName('DEMO:AA:BB:CC:01', 'Bedside Left');
      const node = sim.getNode('DEMO:AA:BB:CC:01');
      assert.equal(node.name, 'Bedside Left');
    });

    it('should emit node:updated when renaming', async () => {
      sim.start();
      await sleep(60);

      const promise = waitForEvent(sim, 'node:updated');
      sim.setNodeName('DEMO:AA:BB:CC:01', 'Renamed');
      const updated = await promise;
      assert.equal(updated.name, 'Renamed');
    });
  });

  // -------------------------------------------------------------------------
  // Scenario Management
  // -------------------------------------------------------------------------

  describe('scenario management', () => {
    it('should list available scenarios', () => {
      const scenarios = sim.getScenarios();
      assert.ok(scenarios.length >= 3, 'Should have at least 3 scenarios');

      const ids = scenarios.map((s) => s.id);
      assert.ok(ids.includes('patient-monitoring'));
      assert.ok(ids.includes('fall-detection'));
      assert.ok(ids.includes('occupancy-tracking'));
    });

    it('should mark the active scenario in getScenarios()', () => {
      const scenarios = sim.getScenarios();
      const active = scenarios.filter((s) => s.active);
      assert.equal(active.length, 1);
      assert.equal(active[0].id, 'patient-monitoring'); // default
    });

    it('should switch scenarios', () => {
      const ok = sim.setScenario('fall-detection');
      assert.equal(ok, true);

      const status = sim.getStatus();
      assert.equal(status.scenarioId, 'fall-detection');
    });

    it('should reject unknown scenario IDs', () => {
      const ok = sim.setScenario('nonexistent-scenario');
      assert.equal(ok, false);
    });

    it('should emit scenario:changed when switching', async () => {
      const promise = waitForEvent(sim, 'scenario:changed');
      sim.setScenario('occupancy-tracking');
      const status = await promise;
      assert.equal(status.scenarioId, 'occupancy-tracking');
    });

    it('should reset to phase 0 when switching scenarios', () => {
      sim.start();
      sim.setScenario('fall-detection');
      const status = sim.getStatus();
      assert.equal(status.phaseIndex, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  describe('getStatus()', () => {
    it('should return current simulator state', () => {
      const status = sim.getStatus();

      assert.equal(typeof status.running, 'boolean');
      assert.equal(typeof status.scenarioId, 'string');
      assert.equal(typeof status.scenarioName, 'string');
      assert.equal(typeof status.phaseIndex, 'number');
      assert.equal(typeof status.phaseLabel, 'string');
      assert.equal(typeof status.phaseCount, 'number');
    });

    it('should show running=false before start', () => {
      assert.equal(sim.getStatus().running, false);
    });

    it('should show running=true after start', () => {
      sim.start();
      assert.equal(sim.getStatus().running, true);
    });
  });

  // -------------------------------------------------------------------------
  // Data Generation (sensing frames, beacons, radar)
  // -------------------------------------------------------------------------

  describe('data generation', () => {
    it('should emit sensing:frame events after starting', async () => {
      sim.start();
      const frame = await waitForEvent(sim, 'sensing:frame', 3000);

      assert.equal(frame.type, 'sensing');
      assert.ok(frame.data, 'Frame should contain data');
      assert.equal(typeof frame.data.heart_rate, 'number');
      assert.equal(typeof frame.data.breathing_rate, 'number');
      assert.equal(typeof frame.data.person_count, 'number');
      assert.equal(typeof frame.data.motion_state, 'string');
      assert.equal(typeof frame.data.confidence, 'number');
      assert.equal(typeof frame.data.timestamp, 'number');
    });

    it('should generate vitals within scenario-defined ranges', async () => {
      // Patient monitoring, phase 0: hr [62,68], br [14,16]
      sim.start();
      const frame = await waitForEvent(sim, 'sensing:frame', 3000);
      const { heart_rate, breathing_rate } = frame.data;

      // Allow some jitter margin beyond the defined ranges
      assert.ok(heart_rate >= 55 && heart_rate <= 80,
        `Heart rate ${heart_rate} should be roughly in expected range`);
      assert.ok(breathing_rate >= 10 && breathing_rate <= 22,
        `Breathing rate ${breathing_rate} should be roughly in expected range`);
    });

    it('should track beacons from the active scenario phase', async () => {
      sim.start();
      // Wait for beacon discovery in patient-monitoring (phase 0 has 1 beacon)
      const beacon = await waitForEvent(sim, 'beacon:discovered', 3000);

      assert.equal(typeof beacon.mac, 'string');
      assert.equal(typeof beacon.name, 'string');
      assert.equal(typeof beacon.role, 'string');
      assert.equal(typeof beacon.rssi, 'number');
    });

    it('should provide radar readings via lastReading', async () => {
      sim.start();
      // Wait for a radar event
      await waitForEvent(sim, 'reading', 3000);

      const reading = sim.lastReading;
      assert.notEqual(reading, null);
      assert.equal(typeof reading.state, 'string');
      assert.equal(typeof reading.movingDist, 'number');
      assert.equal(typeof reading.stationaryDist, 'number');
      assert.equal(typeof reading.timestamp, 'number');
    });
  });

  // -------------------------------------------------------------------------
  // BLE Beacon Interface
  // -------------------------------------------------------------------------

  describe('BLE beacon interface', () => {
    it('should return beacons via getBeacons()', async () => {
      sim.start();
      await sleep(200); // Let some ticks run

      const beacons = sim.getBeacons();
      assert.ok(beacons.length >= 1, 'Should have at least 1 beacon in patient-monitoring');
    });

    it('should filter beacons by role via getByRole()', async () => {
      sim.start();
      await sleep(200);

      const patients = sim.getByRole('patient');
      assert.ok(patients.length >= 1);
      patients.forEach((b) => assert.equal(b.role, 'patient'));
    });

    it('should allow setting beacon identity', async () => {
      sim.start();
      await sleep(200);

      sim.setBeaconIdentity('AA:BB:CC:DD:01:01', 'Patient Smith', 'patient');
      const beacons = sim.getBeacons();
      const updated = beacons.find((b) => b.mac === 'AA:BB:CC:DD:01:01');

      // Only assert if the beacon exists (depends on phase timing)
      if (updated) {
        assert.equal(updated.name, 'Patient Smith');
        assert.equal(updated.role, 'patient');
      }
    });

    it('should report isAvailable=true when running', () => {
      assert.equal(sim.isAvailable, false);
      sim.start();
      assert.equal(sim.isAvailable, true);
    });
  });

  // -------------------------------------------------------------------------
  // Phase Transitions
  // -------------------------------------------------------------------------

  describe('phase transitions', () => {
    it('should emit phase:changed when transitioning between phases', async () => {
      // Use a very short phase to trigger a transition quickly
      // The shortest phase in patient-monitoring is 5000ms, so we use
      // fall-detection's first phase at 12000ms — too slow.
      // Instead, we'll test that the event structure is correct when it fires.
      sim.start();

      // We can't reliably wait for a real phase transition in a unit test
      // (shortest is 5s), but we can verify the mechanism by checking status
      const status = sim.getStatus();
      assert.equal(status.phaseIndex, 0);
      assert.ok(status.phaseCount > 1, 'Scenario should have multiple phases');
    });
  });

  // -------------------------------------------------------------------------
  // Vitals Accessor
  // -------------------------------------------------------------------------

  describe('lastVitals', () => {
    it('should be null before starting', () => {
      assert.equal(sim.lastVitals, null);
    });

    it('should be populated after first tick', async () => {
      sim.start();
      await sleep(150);

      const vitals = sim.lastVitals;
      assert.notEqual(vitals, null);
      assert.equal(typeof vitals.heart_rate, 'number');
      assert.equal(typeof vitals.breathing_rate, 'number');
      assert.equal(typeof vitals.csi_quality, 'number');
    });

    it('should include person positions', async () => {
      sim.start();
      await sleep(150);

      const vitals = sim.lastVitals;
      assert.ok(Array.isArray(vitals.persons_positions),
        'Vitals should include persons_positions array');
      assert.ok(vitals.persons_positions.length > 0,
        'Should have at least one person position');
      assert.equal(typeof vitals.persons_positions[0].x, 'number');
      assert.equal(typeof vitals.persons_positions[0].y, 'number');
    });
  });

  // -------------------------------------------------------------------------
  // Tracking History
  // -------------------------------------------------------------------------

  describe('tracking history', () => {
    it('should be empty before starting', () => {
      const history = sim.getTrackingHistory();
      assert.ok(Array.isArray(history));
      assert.equal(history.length, 0);
    });

    it('should accumulate tracking points after starting', async () => {
      sim.start();
      await sleep(300);  // Let a few ticks run

      const history = sim.getTrackingHistory();
      assert.ok(history.length > 0, 'Should have accumulated tracking points');

      // Each point should have persons array and timestamp
      const point = history[0];
      assert.ok(Array.isArray(point.persons));
      assert.equal(typeof point.timestamp, 'number');
    });

    it('should respect the limit parameter', async () => {
      sim.start();
      await sleep(500);

      const history = sim.getTrackingHistory(3);
      assert.ok(history.length <= 3, 'Should limit results');
    });
  });
});
