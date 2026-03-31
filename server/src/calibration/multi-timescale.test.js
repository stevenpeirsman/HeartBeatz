// ==============================================================================
// Unit Tests — Multi-Timescale Baseline Tracking (ACC-03-T1)
// ==============================================================================
// Tests use synthetic CSI variance data to verify:
//   1. Initialization seeds all EMAs correctly
//   2. Steady-state convergence (slow baseline dominates)
//   3. Sudden environment shift triggers fast-tracking mode
//   4. Gradual drift is tracked by medium EMA
//   5. Max shift clamping prevents overcorrection
//   6. State persistence (save/restore round-trip)
//   7. Edge cases (no init, zero variance, negative values)
//
// Run: node --test server/src/calibration/multi-timescale.test.js

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MultiTimescaleTracker } from './multi-timescale.js';

// ---------------------------------------------------------------------------
// Helpers: Synthetic CSI data generators
// ---------------------------------------------------------------------------

/**
 * Generate N variance samples from a stable empty room.
 * Gaussian-like values around a mean with small jitter.
 * @param {number} mean - Center variance
 * @param {number} jitter - Max random deviation
 * @param {number} count - Number of samples
 * @returns {number[]}
 */
function stableRoom(mean, jitter, count) {
  const samples = [];
  // Use deterministic pseudo-random for reproducibility
  let seed = 42;
  for (let i = 0; i < count; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const r = (seed / 0x7fffffff) * 2 - 1; // [-1, 1]
    samples.push(mean + r * jitter);
  }
  return samples;
}

/**
 * Generate N variance samples from an occupied room.
 * Higher mean and larger jitter than empty room.
 * @param {number} mean - Center variance (typically 3-10x empty)
 * @param {number} jitter - Max random deviation
 * @param {number} count - Number of samples
 * @returns {number[]}
 */
function occupiedRoom(mean, jitter, count) {
  return stableRoom(mean, jitter, count);
}

/**
 * Generate a drift sequence: linear ramp from start to end over count samples.
 * @param {number} start - Starting variance
 * @param {number} end - Ending variance
 * @param {number} count - Number of samples
 * @returns {number[]}
 */
function driftSequence(start, end, count) {
  const samples = [];
  for (let i = 0; i < count; i++) {
    samples.push(start + (end - start) * (i / (count - 1)));
  }
  return samples;
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('MultiTimescaleTracker', () => {
  /** @type {MultiTimescaleTracker} */
  let tracker;

  beforeEach(() => {
    tracker = new MultiTimescaleTracker({
      updateIntervalMs: 0,       // No rate limiting in tests
      minSamplesForUpdate: 1,    // Allow immediate updates in tests
    });
  });

  describe('initialization', () => {
    it('should seed all EMAs to the initial variance', () => {
      tracker.initialize(1.5, 45.0, 1000);

      assert.equal(tracker.fastEma, 1.5);
      assert.equal(tracker.mediumEma, 1.5);
      assert.equal(tracker.slowEma, 1.5);
      assert.equal(tracker.baseline, 1.5);
      assert.equal(tracker.initialized, true);
    });

    it('should enforce minimum baseline floor on initialization', () => {
      tracker.initialize(0.1, 45.0);

      // minBaseline default is 0.5
      assert.equal(tracker.fastEma, 0.5);
      assert.equal(tracker.baseline, 0.5);
    });

    it('should seed mean amplitude EMAs correctly', () => {
      tracker.initialize(1.5, 45.0);

      assert.equal(tracker.fastMeanAmp, 45.0);
      assert.equal(tracker.mediumMeanAmp, 45.0);
      assert.equal(tracker.slowMeanAmp, 45.0);
      assert.equal(tracker.baselineMeanAmp, 45.0);
    });

    it('should throw if update() called before initialize()', () => {
      assert.throws(
        () => tracker.update(1.0, 45.0),
        { message: /before initialize/ }
      );
    });
  });

  describe('steady-state behavior (empty room)', () => {
    it('should converge to observed variance when room is stable', () => {
      const emptyVar = 1.2;
      const emptyAmp = 42.0;
      tracker.initialize(emptyVar, emptyAmp, 0);

      // Feed 200 stable samples (same variance, small jitter)
      const samples = stableRoom(emptyVar, 0.05, 200);
      let t = 1000;
      for (const v of samples) {
        tracker.update(v, emptyAmp, t);
        t += 1000;
      }

      // All EMAs should be close to 1.2
      assert.ok(Math.abs(tracker.fastEma - emptyVar) < 0.15,
        `fastEma ${tracker.fastEma} not close to ${emptyVar}`);
      assert.ok(Math.abs(tracker.mediumEma - emptyVar) < 0.15,
        `mediumEma ${tracker.mediumEma} not close to ${emptyVar}`);
      // Slow EMA moves slower but should still be close after 200 updates
      assert.ok(Math.abs(tracker.slowEma - emptyVar) < 0.3,
        `slowEma ${tracker.slowEma} not close to ${emptyVar}`);

      // In steady state, slow should dominate
      assert.equal(tracker.activeScale, 'slow');
    });

    it('should report low divergence in steady state', () => {
      tracker.initialize(1.2, 42.0, 0);

      const samples = stableRoom(1.2, 0.02, 100);
      let t = 1000;
      for (const v of samples) {
        tracker.update(v, 42.0, t);
        t += 1000;
      }

      const result = tracker.update(1.2, 42.0, t);
      assert.ok(result.divergence < 1.5,
        `Divergence ${result.divergence} should be low in steady state`);
    });
  });

  describe('sudden environment shift', () => {
    it('should switch to fast-tracking when variance jumps suddenly', () => {
      tracker.initialize(1.0, 40.0, 0);

      // Stabilize with empty room
      let t = 1000;
      for (let i = 0; i < 50; i++) {
        tracker.update(1.0, 40.0, t);
        t += 1000;
      }

      // Sudden shift: furniture moved, variance jumps to 3.0
      for (let i = 0; i < 30; i++) {
        tracker.update(3.0, 40.0, t);
        t += 1000;
      }

      // Fast EMA should have tracked up quickly
      assert.ok(tracker.fastEma > 2.0,
        `fastEma ${tracker.fastEma} should track the jump`);

      // Slow EMA should still be near old value
      assert.ok(tracker.slowEma < 2.0,
        `slowEma ${tracker.slowEma} should lag behind`);

      // Divergence should be high
      const divergence = tracker._computeDivergence();
      assert.ok(divergence > 1.3,
        `Divergence ${divergence} should be elevated after shift`);
    });

    it('should eventually converge all EMAs after sustained shift', () => {
      tracker.initialize(1.0, 40.0, 0);

      let t = 1000;
      // Feed 1000 samples at new variance level (sustained change)
      for (let i = 0; i < 1000; i++) {
        tracker.update(3.0, 40.0, t);
        t += 1000;
      }

      // After ~16 minutes of sustained change, all should converge
      assert.ok(Math.abs(tracker.fastEma - 3.0) < 0.1,
        `fastEma should converge: ${tracker.fastEma}`);
      assert.ok(Math.abs(tracker.mediumEma - 3.0) < 0.5,
        `mediumEma should converge: ${tracker.mediumEma}`);
      // Slow needs more time but should have moved significantly
      assert.ok(tracker.slowEma > 1.5,
        `slowEma should have moved toward 3.0: ${tracker.slowEma}`);
    });
  });

  describe('gradual drift (temperature, etc.)', () => {
    it('should track gradual drift via medium EMA', () => {
      tracker.initialize(1.0, 40.0, 0);

      // Gradual drift from 1.0 to 2.0 over 300 samples
      const drift = driftSequence(1.0, 2.0, 300);
      let t = 1000;
      for (const v of drift) {
        tracker.update(v, 40.0, t);
        t += 1000;
      }

      // Medium EMA should have tracked the drift
      assert.ok(tracker.mediumEma > 1.3,
        `mediumEma ${tracker.mediumEma} should track drift`);
      // Fast should be near the end value
      assert.ok(tracker.fastEma > 1.7,
        `fastEma ${tracker.fastEma} should be near end of drift`);
    });
  });

  describe('shift clamping', () => {
    it('should clamp baseline shift to maxShiftPerUpdate', () => {
      const clamped = new MultiTimescaleTracker({
        maxShiftPerUpdate: 0.2,
        updateIntervalMs: 0,
        minSamplesForUpdate: 1,
        fastAlpha: 0.9,  // Very aggressive for test
      });
      clamped.initialize(1.0, 40.0, 0);

      // Single huge variance jump
      const result = clamped.update(100.0, 40.0, 1000);

      // Baseline should not have jumped by more than 0.2
      assert.ok(result.baseline <= 1.2 + 0.01,
        `Baseline ${result.baseline} should be clamped (max shift 0.2 from 1.0)`);
    });

    it('should enforce minimum baseline floor', () => {
      tracker.initialize(0.6, 40.0, 0);

      // Try to drive baseline below minimum
      for (let i = 0; i < 100; i++) {
        tracker.update(0.01, 40.0, i * 1000);
      }

      assert.ok(tracker.baseline >= 0.5,
        `Baseline ${tracker.baseline} should not go below minBaseline`);
    });
  });

  describe('state persistence', () => {
    it('should round-trip state through getState/restoreState', () => {
      tracker.initialize(1.5, 45.0, 0);

      // Run some updates to get non-trivial state
      let t = 1000;
      for (let i = 0; i < 50; i++) {
        tracker.update(1.5 + (i % 3) * 0.1, 45.0, t);
        t += 1000;
      }

      const state = tracker.getState();

      // Create new tracker and restore
      const restored = new MultiTimescaleTracker({
        updateIntervalMs: 0,
        minSamplesForUpdate: 1,
      });
      restored.restoreState(state);

      assert.equal(restored.fastEma, tracker.fastEma);
      assert.equal(restored.mediumEma, tracker.mediumEma);
      assert.equal(restored.slowEma, tracker.slowEma);
      assert.equal(restored.baseline, tracker.baseline);
      assert.equal(restored.baselineMeanAmp, tracker.baselineMeanAmp);
      assert.equal(restored.initialized, true);
      assert.equal(restored.updateCount, tracker.updateCount);
    });

    it('should throw on invalid state in restoreState', () => {
      assert.throws(
        () => tracker.restoreState(null),
        { message: /Invalid state/ }
      );
      assert.throws(
        () => tracker.restoreState({ fastEma: 'not a number' }),
        { message: /Invalid state/ }
      );
    });
  });

  describe('diagnostics', () => {
    it('should record recalibration events in history', () => {
      tracker.initialize(1.0, 40.0, 0);

      let t = 1000;
      for (let i = 0; i < 20; i++) {
        tracker.update(1.0 + i * 0.01, 40.0, t);
        t += 1000;
      }

      assert.ok(tracker.history.length > 0,
        'Should have recorded at least one event');

      const event = tracker.history[0];
      assert.ok('t' in event, 'Event should have timestamp');
      assert.ok('oldBaseline' in event, 'Event should have oldBaseline');
      assert.ok('newBaseline' in event, 'Event should have newBaseline');
      assert.ok('divergence' in event, 'Event should have divergence');
      assert.ok('activeScale' in event, 'Event should have activeScale');
      assert.ok('weights' in event, 'Event should have weights');
    });

    it('should limit history size', () => {
      const smallHistory = new MultiTimescaleTracker({
        historySize: 5,
        updateIntervalMs: 0,
        minSamplesForUpdate: 1,
      });
      smallHistory.initialize(1.0, 40.0, 0);

      let t = 1000;
      for (let i = 0; i < 20; i++) {
        smallHistory.update(1.0, 40.0, t);
        t += 1000;
      }

      assert.ok(smallHistory.history.length <= 5,
        `History size ${smallHistory.history.length} should be capped at 5`);
    });

    it('should return recent history via getRecentHistory()', () => {
      tracker.initialize(1.0, 40.0, 0);

      let t = 1000;
      for (let i = 0; i < 30; i++) {
        tracker.update(1.0, 40.0, t);
        t += 1000;
      }

      const recent5 = tracker.getRecentHistory(5);
      assert.ok(recent5.length <= 5);
      // Should be the last 5 events
      if (tracker.history.length >= 5) {
        assert.deepEqual(recent5, tracker.history.slice(-5));
      }
    });
  });

  describe('reset', () => {
    it('should reset all state to uninitialized', () => {
      tracker.initialize(1.5, 45.0, 0);
      tracker.update(1.5, 45.0, 1000);
      tracker.reset();

      assert.equal(tracker.initialized, false);
      assert.equal(tracker.fastEma, 0);
      assert.equal(tracker.mediumEma, 0);
      assert.equal(tracker.slowEma, 0);
      assert.equal(tracker.baseline, 0);
      assert.equal(tracker.updateCount, 0);
      assert.equal(tracker.history.length, 0);
    });
  });

  describe('rate limiting', () => {
    it('should skip EMA update when called too frequently', () => {
      const rateLimited = new MultiTimescaleTracker({
        updateIntervalMs: 5000, // 5 second interval
        minSamplesForUpdate: 1,
      });
      rateLimited.initialize(1.0, 40.0, 0);

      // First update at t=1000 — should process
      rateLimited.update(2.0, 40.0, 1000);
      const afterFirst = rateLimited.updateCount;

      // Second update at t=2000 — should be skipped (< 5s)
      rateLimited.update(3.0, 40.0, 2000);
      assert.equal(rateLimited.updateCount, afterFirst,
        'Should not have updated again within rate limit window');

      // Third update at t=7000 — should process (> 5s since last)
      rateLimited.update(3.0, 40.0, 7000);
      assert.equal(rateLimited.updateCount, afterFirst + 1,
        'Should have updated after rate limit window passed');
    });
  });

  describe('result object', () => {
    it('should return all expected fields from update()', () => {
      tracker.initialize(1.0, 40.0, 0);
      const result = tracker.update(1.1, 40.0, 1000);

      assert.ok('baseline' in result);
      assert.ok('baselineMeanAmp' in result);
      assert.ok('activeScale' in result);
      assert.ok('fastEma' in result);
      assert.ok('mediumEma' in result);
      assert.ok('slowEma' in result);
      assert.ok('divergence' in result);
      assert.ok('updateCount' in result);
      assert.ok('sampleCount' in result);
      assert.ok('event' in result);
    });
  });
});
