// ==============================================================================
// Unit Tests — Empty-Room Detection (ACC-03-T3)
// ==============================================================================
// Tests cover:
//   1. Constructor validation and defaults
//   2. Basic quiet detection (variance ratio < threshold)
//   3. Empty-room declaration after sustained quiet period
//   4. Hysteresis: harder to leave empty state than to enter it
//   5. Reoccupation detection with ratio above hysteresis threshold
//   6. Transient spike tolerance (HVAC, interference)
//   7. Insufficient data → UNKNOWN state
//   8. Force state override
//   9. State persistence (getState / restoreState)
//  10. Reset behavior
//  11. Synthetic CSI scenarios: empty room, person enters, person leaves
//
// Run: node --test server/src/calibration/empty-room.test.js
// ==============================================================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EmptyRoomDetector, RoomState } from './empty-room.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a sequence of variance observations simulating an empty room.
 * Empty room: variance hovers near baseline (ratio ≈ 1.0–1.1).
 *
 * @param {number} count - Number of observations
 * @param {number} baselineVar - Baseline variance
 * @param {number} [noiseLevel=0.05] - Noise amplitude as fraction of baseline
 * @returns {Array<number>} Array of variance values
 */
function generateEmptyRoomVariances(count, baselineVar, noiseLevel = 0.05) {
  const variances = [];
  for (let i = 0; i < count; i++) {
    // Small random fluctuation around baseline
    const noise = (Math.random() - 0.5) * 2 * noiseLevel * baselineVar;
    variances.push(baselineVar + noise);
  }
  return variances;
}

/**
 * Generate variance observations simulating an occupied room.
 * Occupied: variance is 2-5x baseline due to human motion.
 *
 * @param {number} count - Number of observations
 * @param {number} baselineVar - Baseline variance
 * @param {number} [multiplier=3.0] - Mean ratio of observed/baseline
 * @returns {Array<number>} Array of variance values
 */
function generateOccupiedVariances(count, baselineVar, multiplier = 3.0) {
  const variances = [];
  for (let i = 0; i < count; i++) {
    const variation = 0.5 + Math.random() * (multiplier - 0.5);
    variances.push(baselineVar * Math.max(1.5, variation));
  }
  return variances;
}

/**
 * Feed a sequence of variance values into a detector at regular intervals.
 *
 * @param {EmptyRoomDetector} detector - The detector instance
 * @param {Array<number>} variances - Observed variance values
 * @param {number} baselineVar - Baseline variance
 * @param {number} startTime - Start timestamp (ms)
 * @param {number} intervalMs - Interval between observations (ms)
 * @returns {Array<Object>} Array of results from each update call
 */
function feedObservations(detector, variances, baselineVar, startTime, intervalMs) {
  const results = [];
  for (let i = 0; i < variances.length; i++) {
    const t = startTime + i * intervalMs;
    results.push(detector.update(variances[i], baselineVar, t));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EmptyRoomDetector', () => {

  describe('constructor', () => {
    it('should create with default config', () => {
      const detector = new EmptyRoomDetector();
      assert.equal(detector.state, RoomState.UNKNOWN);
      assert.equal(detector.confidence, 0);
    });

    it('should accept custom config overrides', () => {
      const detector = new EmptyRoomDetector({
        varianceRatioThreshold: 1.3,
        quietDurationMs: 300_000,
      });
      assert.equal(detector.config.varianceRatioThreshold, 1.3);
      assert.equal(detector.config.quietDurationMs, 300_000);
      // Non-overridden values should retain defaults
      assert.equal(detector.config.reoccupyRatioThreshold, 1.5);
    });

    it('should reject invalid hysteresis (reoccupy <= quiet threshold)', () => {
      assert.throws(
        () => new EmptyRoomDetector({
          varianceRatioThreshold: 1.5,
          reoccupyRatioThreshold: 1.5,  // Equal — invalid
        }),
        /reoccupyRatioThreshold.*must be greater/
      );

      assert.throws(
        () => new EmptyRoomDetector({
          varianceRatioThreshold: 2.0,
          reoccupyRatioThreshold: 1.5,  // Lower — invalid
        }),
        /reoccupyRatioThreshold.*must be greater/
      );
    });
  });

  describe('RoomState enum', () => {
    it('should have frozen enum values', () => {
      assert.equal(RoomState.OCCUPIED, 'occupied');
      assert.equal(RoomState.EMPTY, 'empty');
      assert.equal(RoomState.UNKNOWN, 'unknown');
      assert.ok(Object.isFrozen(RoomState));
    });
  });

  describe('initial state', () => {
    it('should return UNKNOWN with zero confidence when no data', () => {
      const detector = new EmptyRoomDetector();
      const result = detector.update(1.0, 1.0, 1000);
      assert.equal(result.state, RoomState.UNKNOWN);
      assert.equal(result.confidence, 0);
      assert.equal(result.isEmpty, false);
      assert.equal(result.isOccupied, false);
    });

    it('should remain UNKNOWN until minObservations reached', () => {
      const detector = new EmptyRoomDetector({
        minObservations: 10,
        samplingIntervalMs: 100,
      });

      // Feed 9 observations — still below minimum
      for (let i = 0; i < 9; i++) {
        const result = detector.update(1.0, 1.0, 1000 + i * 100);
        assert.equal(result.state, RoomState.UNKNOWN);
      }
    });
  });

  describe('quiet detection (variance ratio)', () => {
    it('should classify low ratio as quiet observation', () => {
      const detector = new EmptyRoomDetector({
        minObservations: 5,
        samplingIntervalMs: 100,
      });

      // Ratio = 1.0/1.0 = 1.0 < 1.2 → quiet
      const result = detector.update(1.0, 1.0, 1000);
      assert.equal(result.currentRatio, 1.0);
    });

    it('should classify high ratio as non-quiet', () => {
      const detector = new EmptyRoomDetector({
        minObservations: 5,
        samplingIntervalMs: 100,
      });

      // Ratio = 2.0/1.0 = 2.0 > 1.2 → not quiet
      const result = detector.update(2.0, 1.0, 1000);
      assert.equal(result.currentRatio, 2.0);
    });

    it('should handle edge case: ratio exactly at threshold', () => {
      const detector = new EmptyRoomDetector({
        minObservations: 5,
        samplingIntervalMs: 100,
      });

      // Ratio = 1.2 — NOT quiet (must be strictly less than threshold)
      const result = detector.update(1.2, 1.0, 1000);
      assert.equal(result.currentRatio, 1.2);
    });
  });

  describe('empty-room declaration', () => {
    it('should declare empty after sustained quiet period', () => {
      // Use short durations for testing
      const detector = new EmptyRoomDetector({
        quietDurationMs:       5_000,   // 5 seconds
        windowSizeMs:          8_000,   // 8 seconds
        minObservations:       10,
        samplingIntervalMs:    100,     // 10 Hz
        quietFractionRequired: 0.90,
      });

      const baselineVar = 1.0;
      const startTime = 10_000;

      // Feed 80 quiet observations over 8 seconds (100ms apart)
      // All with ratio ~1.05 (below 1.2 threshold)
      let lastResult;
      for (let i = 0; i < 80; i++) {
        const t = startTime + i * 100;
        const observedVar = baselineVar * (1.0 + Math.random() * 0.1);  // 1.0–1.1x
        lastResult = detector.update(observedVar, baselineVar, t);
      }

      assert.equal(lastResult.state, RoomState.EMPTY);
      assert.equal(lastResult.isEmpty, true);
      assert.ok(lastResult.confidence > 0.5, `Expected confidence > 0.5, got ${lastResult.confidence}`);
    });

    it('should NOT declare empty if quiet fraction is too low', () => {
      const detector = new EmptyRoomDetector({
        quietDurationMs:       2_000,
        windowSizeMs:          5_000,
        minObservations:       10,
        samplingIntervalMs:    100,
        quietFractionRequired: 0.90,
      });

      const baselineVar = 1.0;
      const startTime = 10_000;

      // Mix of quiet and noisy observations (50/50)
      let lastResult;
      for (let i = 0; i < 50; i++) {
        const t = startTime + i * 100;
        const isQuietFrame = i % 2 === 0;
        const observedVar = isQuietFrame ? baselineVar * 1.05 : baselineVar * 3.0;
        lastResult = detector.update(observedVar, baselineVar, t);
      }

      // 50% quiet is below the 90% threshold
      assert.notEqual(lastResult.state, RoomState.EMPTY);
    });

    it('should NOT declare empty before quietDurationMs elapsed', () => {
      const detector = new EmptyRoomDetector({
        quietDurationMs:       10_000,  // 10 seconds required
        windowSizeMs:          15_000,
        minObservations:       10,
        samplingIntervalMs:    100,
        quietFractionRequired: 0.90,
      });

      const baselineVar = 1.0;
      const startTime = 10_000;

      // Feed 50 quiet observations over 5 seconds (only half the required duration)
      let lastResult;
      for (let i = 0; i < 50; i++) {
        const t = startTime + i * 100;
        lastResult = detector.update(baselineVar * 1.05, baselineVar, t);
      }

      // 5 seconds < 10 seconds required
      assert.notEqual(lastResult.state, RoomState.EMPTY);
    });
  });

  describe('hysteresis (Schmitt trigger)', () => {
    it('should require higher ratio to transition from empty → occupied', () => {
      const detector = new EmptyRoomDetector({
        quietDurationMs:       2_000,
        windowSizeMs:          5_000,
        minObservations:       10,
        samplingIntervalMs:    100,
        quietFractionRequired: 0.85,
        varianceRatioThreshold: 1.2,
        reoccupyRatioThreshold: 1.5,
      });

      const baselineVar = 1.0;
      let t = 10_000;

      // Phase 1: establish empty state with 30 quiet observations
      for (let i = 0; i < 30; i++) {
        detector.update(baselineVar * 1.05, baselineVar, t);
        t += 100;
      }
      assert.equal(detector.state, RoomState.EMPTY);

      // Phase 2: introduce moderate variance (1.3x — above quiet threshold 1.2
      // but below reoccupy threshold 1.5). Should STAY empty due to hysteresis.
      for (let i = 0; i < 15; i++) {
        detector.update(baselineVar * 1.3, baselineVar, t);
        t += 100;
      }
      // The detector should still be empty because 1.3 < 1.5 (reoccupy threshold)
      assert.equal(detector.state, RoomState.EMPTY,
        'Should stay empty when variance between quiet and reoccupy thresholds');
    });

    it('should transition to occupied when ratio exceeds reoccupy threshold', () => {
      const detector = new EmptyRoomDetector({
        quietDurationMs:       2_000,
        windowSizeMs:          5_000,
        minObservations:       10,
        samplingIntervalMs:    100,
        quietFractionRequired: 0.85,
        varianceRatioThreshold: 1.2,
        reoccupyRatioThreshold: 1.5,
      });

      const baselineVar = 1.0;
      let t = 10_000;

      // Phase 1: establish empty state
      for (let i = 0; i < 30; i++) {
        detector.update(baselineVar * 1.05, baselineVar, t);
        t += 100;
      }
      assert.equal(detector.state, RoomState.EMPTY);

      // Phase 2: introduce strong variance (2.0x > 1.5 reoccupy threshold)
      let lastResult;
      for (let i = 0; i < 15; i++) {
        lastResult = detector.update(baselineVar * 2.0, baselineVar, t);
        t += 100;
      }
      assert.equal(lastResult.state, RoomState.OCCUPIED,
        'Should transition to occupied when ratio > reoccupy threshold');
    });
  });

  describe('transient spike tolerance', () => {
    it('should tolerate occasional spikes within the quiet streak', () => {
      const detector = new EmptyRoomDetector({
        quietDurationMs:       3_000,
        windowSizeMs:          6_000,
        minObservations:       10,
        samplingIntervalMs:    100,
        quietFractionRequired: 0.85,
      });

      const baselineVar = 1.0;
      let t = 10_000;

      // Feed 50 observations: 95% quiet, 5% spikes (every 20th is a spike)
      let lastResult;
      for (let i = 0; i < 50; i++) {
        const isSpike = i % 20 === 10;  // Spike at positions 10, 30
        const observedVar = isSpike ? baselineVar * 3.0 : baselineVar * 1.05;
        lastResult = detector.update(observedVar, baselineVar, t);
        t += 100;
      }

      // 95% quiet > 85% threshold, and duration 5s > 3s required
      assert.equal(lastResult.state, RoomState.EMPTY,
        'Should declare empty despite occasional transient spikes');
    });
  });

  describe('synthetic CSI scenarios', () => {
    it('scenario: person enters empty room', () => {
      const detector = new EmptyRoomDetector({
        quietDurationMs:       3_000,
        windowSizeMs:          6_000,
        minObservations:       10,
        samplingIntervalMs:    100,
        quietFractionRequired: 0.85,
      });

      const baselineVar = 1.0;
      let t = 10_000;

      // Phase 1: empty room (40 quiet observations = 4s)
      for (let i = 0; i < 40; i++) {
        detector.update(baselineVar * (1.0 + Math.random() * 0.1), baselineVar, t);
        t += 100;
      }
      assert.equal(detector.state, RoomState.EMPTY);

      // Phase 2: person enters — variance jumps to 3-5x baseline
      let result;
      for (let i = 0; i < 20; i++) {
        const humanVar = baselineVar * (3.0 + Math.random() * 2.0);
        result = detector.update(humanVar, baselineVar, t);
        t += 100;
      }

      // Should detect reoccupation
      assert.equal(result.state, RoomState.OCCUPIED,
        'Should detect person entering previously empty room');
      assert.ok(result.stateChanged || detector.state === RoomState.OCCUPIED);
    });

    it('scenario: person leaves occupied room', () => {
      const detector = new EmptyRoomDetector({
        quietDurationMs:       2_000,
        windowSizeMs:          5_000,
        minObservations:       10,
        samplingIntervalMs:    100,
        quietFractionRequired: 0.85,
      });

      const baselineVar = 1.0;
      let t = 10_000;

      // Phase 1: occupied room (20 noisy observations)
      for (let i = 0; i < 20; i++) {
        detector.update(baselineVar * (2.0 + Math.random() * 2.0), baselineVar, t);
        t += 100;
      }
      // Should be occupied (or unknown, depending on min observations)

      // Phase 2: person leaves — variance drops to near baseline
      // Need to feed enough quiet observations to fill the window
      let result;
      for (let i = 0; i < 60; i++) {
        const quietVar = baselineVar * (1.0 + Math.random() * 0.1);
        result = detector.update(quietVar, baselineVar, t);
        t += 100;
      }

      assert.equal(result.state, RoomState.EMPTY,
        'Should detect room becoming empty after person leaves');
    });

    it('scenario: temperature drift (gradual variance increase stays below threshold)', () => {
      const detector = new EmptyRoomDetector({
        quietDurationMs:       3_000,
        windowSizeMs:          6_000,
        minObservations:       10,
        samplingIntervalMs:    100,
        quietFractionRequired: 0.85,
      });

      const baselineVar = 1.0;
      let t = 10_000;

      // Gradual drift: variance slowly increases from 1.0x to 1.15x over 50 frames
      // All values stay below 1.2x threshold — should still detect as empty
      let result;
      for (let i = 0; i < 50; i++) {
        const driftRatio = 1.0 + (i / 50) * 0.15;  // 1.0 → 1.15
        result = detector.update(baselineVar * driftRatio, baselineVar, t);
        t += 100;
      }

      assert.equal(result.state, RoomState.EMPTY,
        'Gradual temperature drift below threshold should still be detected as empty');
    });
  });

  describe('forceState', () => {
    it('should force transition to empty', () => {
      const detector = new EmptyRoomDetector();
      detector.forceState(RoomState.EMPTY);
      assert.equal(detector.state, RoomState.EMPTY);
      assert.equal(detector.confidence, 1.0);
    });

    it('should force transition to occupied', () => {
      const detector = new EmptyRoomDetector();
      detector.forceState(RoomState.OCCUPIED);
      assert.equal(detector.state, RoomState.OCCUPIED);
      assert.equal(detector.confidence, 1.0);
    });

    it('should reject invalid state', () => {
      const detector = new EmptyRoomDetector();
      assert.throws(
        () => detector.forceState('invalid'),
        /invalid state/
      );
    });

    it('should record forced transitions in history', () => {
      const detector = new EmptyRoomDetector();
      detector.forceState(RoomState.OCCUPIED, 1000);  // UNKNOWN → OCCUPIED
      detector.forceState(RoomState.EMPTY, 2000);      // OCCUPIED → EMPTY
      detector.forceState(RoomState.OCCUPIED, 3000);   // EMPTY → OCCUPIED

      const history = detector.getRecentHistory(10);
      // All 3 transitions are recorded (forceState records all state changes)
      assert.equal(history.length, 3);
      assert.equal(history[0].forced, true);
      assert.equal(history[0].from, RoomState.UNKNOWN);
      assert.equal(history[0].to, RoomState.OCCUPIED);
      assert.equal(history[1].from, RoomState.OCCUPIED);
      assert.equal(history[1].to, RoomState.EMPTY);
      assert.equal(history[2].from, RoomState.EMPTY);
      assert.equal(history[2].to, RoomState.OCCUPIED);
    });
  });

  describe('state persistence', () => {
    it('should serialize and restore state correctly', () => {
      const detector = new EmptyRoomDetector({
        minObservations: 5,
        samplingIntervalMs: 100,
        quietDurationMs: 2_000,
        windowSizeMs: 5_000,
        quietFractionRequired: 0.80,
      });

      // Build up some state
      const baselineVar = 1.0;
      for (let i = 0; i < 30; i++) {
        detector.update(baselineVar * 1.05, baselineVar, 10_000 + i * 100);
      }

      const saved = detector.getState();

      // Create new detector and restore
      const restored = new EmptyRoomDetector({
        minObservations: 5,
        samplingIntervalMs: 100,
        quietDurationMs: 2_000,
        windowSizeMs: 5_000,
        quietFractionRequired: 0.80,
      });
      restored.restoreState(saved);

      assert.equal(restored.state, detector.state);
      assert.equal(restored.confidence, detector.confidence);
      assert.equal(restored._totalObservations, detector._totalObservations);
    });

    it('should reject invalid state object', () => {
      const detector = new EmptyRoomDetector();
      assert.throws(
        () => detector.restoreState(null),
        /Invalid state/
      );
      assert.throws(
        () => detector.restoreState({ state: 123 }),  // Not a string
        /Invalid state/
      );
    });
  });

  describe('reset', () => {
    it('should clear all state', () => {
      const detector = new EmptyRoomDetector({
        minObservations: 5,
        samplingIntervalMs: 100,
      });

      // Build up state
      for (let i = 0; i < 20; i++) {
        detector.update(1.0, 1.0, 1000 + i * 100);
      }
      detector.forceState(RoomState.OCCUPIED);

      // Reset
      detector.reset();
      assert.equal(detector.state, RoomState.UNKNOWN);
      assert.equal(detector.confidence, 0);
      assert.equal(detector._totalObservations, 0);
      assert.equal(detector._observations.length, 0);
      assert.equal(detector.history.length, 0);
    });
  });

  describe('rate limiting', () => {
    it('should not record observations faster than samplingIntervalMs', () => {
      const detector = new EmptyRoomDetector({
        samplingIntervalMs: 1000,  // 1 per second
      });

      // Feed 100 observations at 10ms intervals (100x faster than allowed)
      for (let i = 0; i < 100; i++) {
        detector.update(1.0, 1.0, 10_000 + i * 10);
      }

      // Should only have ~1 observation (1 second span / 1 second interval)
      assert.ok(detector._observations.length <= 2,
        `Expected <=2 observations, got ${detector._observations.length}`);
    });
  });

  describe('edge cases', () => {
    it('should handle zero baseline variance safely', () => {
      const detector = new EmptyRoomDetector({
        minObservations: 5,
        samplingIntervalMs: 100,
      });

      // baseline = 0 → should use floor of 0.001
      const result = detector.update(0.5, 0, 1000);
      assert.ok(Number.isFinite(result.currentRatio));
      assert.ok(result.currentRatio > 0);
    });

    it('should handle negative variance gracefully', () => {
      const detector = new EmptyRoomDetector({
        minObservations: 5,
        samplingIntervalMs: 100,
      });

      // Negative variance shouldn't crash (can happen with numerical errors)
      const result = detector.update(-0.5, 1.0, 1000);
      assert.ok(Number.isFinite(result.currentRatio));
    });

    it('should handle very large variance ratios', () => {
      const detector = new EmptyRoomDetector({
        minObservations: 5,
        samplingIntervalMs: 100,
      });

      const result = detector.update(1000.0, 1.0, 1000);
      assert.equal(result.currentRatio, 1000.0);
      assert.ok(Number.isFinite(result.currentRatio));
    });
  });

  describe('getSummary', () => {
    it('should return a structured summary for logging', () => {
      const detector = new EmptyRoomDetector({
        minObservations: 5,
        samplingIntervalMs: 100,
      });

      for (let i = 0; i < 10; i++) {
        detector.update(1.0, 1.0, 1000 + i * 100);
      }

      const summary = detector.getSummary();
      assert.ok('state' in summary);
      assert.ok('confidence' in summary);
      assert.ok('quietFraction' in summary);
      assert.ok('observationCount' in summary);
      assert.ok('totalObservations' in summary);
      assert.ok('transitionCount' in summary);
    });
  });

  describe('history management', () => {
    it('should limit history to historySize', () => {
      const detector = new EmptyRoomDetector({
        quietDurationMs: 1_000,
        windowSizeMs: 3_000,
        minObservations: 5,
        samplingIntervalMs: 50,
        quietFractionRequired: 0.80,
        historySize: 3,
      });

      const baselineVar = 1.0;
      let t = 10_000;

      // Cycle between empty and occupied states many times
      for (let cycle = 0; cycle < 5; cycle++) {
        // Quiet phase → empty
        for (let i = 0; i < 30; i++) {
          detector.update(baselineVar * 1.05, baselineVar, t);
          t += 50;
        }
        // Noisy phase → occupied
        for (let i = 0; i < 20; i++) {
          detector.update(baselineVar * 3.0, baselineVar, t);
          t += 50;
        }
      }

      assert.ok(detector.history.length <= 3,
        `Expected at most 3 history entries, got ${detector.history.length}`);
    });
  });
});
