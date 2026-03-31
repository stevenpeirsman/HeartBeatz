// ==============================================================================
// Unit Tests — CUSUM Environment Change Detection (ACC-03-T2)
// ==============================================================================
// Tests cover:
//   1. Initialization and input validation
//   2. Steady-state behavior (no false alarms on stable signal)
//   3. Step-change detection (sudden environment shift)
//   4. Gradual drift detection
//   5. Per-channel voting (reject single-channel glitches)
//   6. Cooldown behavior
//   7. Warmup behavior
//   8. FIR headstart effect
//   9. Bidirectional detection (upward and downward shifts)
//  10. Baseline update and re-detection
//  11. State persistence (save/restore)
//  12. Direction classification
//
// Run: node --test server/src/calibration/cusum.test.js
// ==============================================================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CusumDetector } from './cusum.js';

// ---------------------------------------------------------------------------
// Helpers: Generate synthetic CSI amplitude data
// ---------------------------------------------------------------------------

/**
 * Generate a stable CSI frame (empty room, Gaussian noise around baselines).
 * @param {Float64Array|number[]} baselines - Per-channel baseline values
 * @param {number} noiseStd - Standard deviation of Gaussian noise
 * @param {number} [seed] - Simple deterministic seed for reproducibility
 * @returns {Float64Array} Synthetic amplitude frame
 */
function stableFrame(baselines, noiseStd = 0.5, seed = null) {
  const n = baselines.length;
  const frame = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // Box-Muller approximation (simplified, not perfect randomness but fine for tests)
    const u1 = seed !== null ? pseudoRandom(seed + i) : Math.random();
    const u2 = seed !== null ? pseudoRandom(seed + i + n) : Math.random();
    const z = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2);
    frame[i] = baselines[i] + z * noiseStd;
  }
  return frame;
}

/**
 * Generate a shifted CSI frame (environment changed, all channels shifted).
 * @param {Float64Array|number[]} baselines - Per-channel baseline values
 * @param {number} shiftAmount - Mean shift applied to all channels
 * @param {number} noiseStd - Standard deviation of Gaussian noise
 * @param {number} [seed] - Deterministic seed
 * @returns {Float64Array} Synthetic shifted frame
 */
function shiftedFrame(baselines, shiftAmount, noiseStd = 0.5, seed = null) {
  const frame = stableFrame(baselines, noiseStd, seed);
  for (let i = 0; i < frame.length; i++) {
    frame[i] += shiftAmount;
  }
  return frame;
}

/**
 * Generate a partially shifted frame (only some channels affected).
 * Simulates narrow-band interference or single-subcarrier glitch.
 * @param {Float64Array|number[]} baselines - Per-channel baseline values
 * @param {number} shiftAmount - Shift for affected channels
 * @param {number} affectedRatio - Fraction of channels to shift [0, 1]
 * @param {number} noiseStd - Noise std dev
 * @param {number} [seed] - Deterministic seed
 * @returns {Float64Array} Synthetic partially shifted frame
 */
function partialShiftFrame(baselines, shiftAmount, affectedRatio, noiseStd = 0.5, seed = null) {
  const frame = stableFrame(baselines, noiseStd, seed);
  const n = baselines.length;
  const affectedCount = Math.floor(n * affectedRatio);
  for (let i = 0; i < affectedCount; i++) {
    frame[i] += shiftAmount;
  }
  return frame;
}

/**
 * Simple pseudo-random number generator (LCG) for deterministic tests.
 * @param {number} seed - Integer seed
 * @returns {number} Pseudo-random value in (0, 1)
 */
function pseudoRandom(seed) {
  // Linear congruential generator
  const a = 1664525;
  const c = 1013904223;
  const m = 2 ** 32;
  const next = ((a * Math.abs(Math.floor(seed)) + c) % m) >>> 0;
  return next / m;
}

/**
 * Create standard baselines for testing.
 * @param {number} n - Number of channels
 * @param {number} value - Baseline amplitude value
 * @returns {Float64Array}
 */
function makeBaselines(n = 8, value = 10.0) {
  return new Float64Array(n).fill(value);
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('CusumDetector', () => {
  /** @type {CusumDetector} */
  let detector;
  const N = 8;  // Use 8 channels for fast tests

  beforeEach(() => {
    detector = new CusumDetector({
      numChannels: N,
      warmupSamples: 10,
      cooldownMs: 1000,
      channelVoteRatio: 0.25,  // 2 of 8 channels must alarm
      decisionThreshold: 5.0,
      slackParameter: 0.5,
      enableFir: false,  // Disable FIR for predictable tests unless testing FIR
      historySize: 20,
    });
  });

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  describe('initialization', () => {
    it('should require initialize() before update()', () => {
      assert.throws(
        () => detector.update(makeBaselines(N)),
        /called before initialize/
      );
    });

    it('should accept valid baselines', () => {
      const baselines = makeBaselines(N);
      detector.initialize(baselines);
      assert.equal(detector.initialized, true);
      assert.equal(detector.sampleCount, 0);
    });

    it('should reject baselines with wrong length', () => {
      assert.throws(
        () => detector.initialize(makeBaselines(3)),
        /expected 8 baselines, got 3/
      );
    });

    it('should accept optional initial std devs', () => {
      const baselines = makeBaselines(N);
      const stds = new Float64Array(N).fill(1.0);
      detector.initialize(baselines, stds);
      const stats = detector.getChannelStats();
      assert.equal(stats.runningStd[0], 1.0);
    });

    it('should floor std devs at baselineStdFloor', () => {
      const baselines = makeBaselines(N);
      const stds = new Float64Array(N).fill(0.001);  // Below floor
      detector.initialize(baselines, stds);
      const stats = detector.getChannelStats();
      assert.equal(stats.runningStd[0], detector.config.baselineStdFloor);
    });
  });

  // -------------------------------------------------------------------------
  // Steady-state: no false alarms
  // -------------------------------------------------------------------------

  describe('steady-state (no change)', () => {
    it('should not trigger on stable signal after warmup', () => {
      const baselines = makeBaselines(N, 10.0);
      detector.initialize(baselines);

      let changes = 0;
      // Run 200 frames of stable signal
      for (let t = 0; t < 200; t++) {
        const frame = stableFrame(baselines, 0.3, t * 100);
        const result = detector.update(frame, 1000 + t * 50);
        if (result.changeDetected) changes++;
      }

      assert.equal(changes, 0, 'Should have zero false alarms on stable signal');
    });

    it('should report warmup state correctly', () => {
      const baselines = makeBaselines(N, 10.0);
      detector.initialize(baselines);

      const result = detector.update(stableFrame(baselines, 0.3, 1), 1000);
      assert.equal(result.inWarmup, true);
      assert.equal(result.sampleCount, 1);
    });

    it('should exit warmup after configured samples', () => {
      const baselines = makeBaselines(N, 10.0);
      detector.initialize(baselines);

      for (let t = 0; t < 10; t++) {
        detector.update(stableFrame(baselines, 0.3, t), 1000 + t * 50);
      }

      const result = detector.update(stableFrame(baselines, 0.3, 99), 1500);
      assert.equal(result.inWarmup, false);
    });
  });

  // -------------------------------------------------------------------------
  // Step change detection
  // -------------------------------------------------------------------------

  describe('step change detection', () => {
    it('should detect a large upward shift across all channels', () => {
      const baselines = makeBaselines(N, 10.0);
      const stds = new Float64Array(N).fill(0.5);
      // Pass explicit timestamp so cooldown calculates correctly
      detector.initialize(baselines, stds, 0);

      // Warmup with stable frames
      for (let t = 0; t < 15; t++) {
        detector.update(stableFrame(baselines, 0.3, t), 1000 + t * 50);
      }

      // Apply a 5-sigma shift (should be detected quickly)
      let detected = false;
      for (let t = 0; t < 50; t++) {
        const frame = shiftedFrame(baselines, 3.0, 0.3, 100 + t);
        const result = detector.update(frame, 2000 + t * 50);
        if (result.changeDetected) {
          detected = true;
          break;
        }
      }

      assert.equal(detected, true, 'Should detect large step change');
    });

    it('should detect a large downward shift', () => {
      const baselines = makeBaselines(N, 10.0);
      const stds = new Float64Array(N).fill(0.5);
      detector.initialize(baselines, stds, 0);

      // Warmup
      for (let t = 0; t < 15; t++) {
        detector.update(stableFrame(baselines, 0.3, t), 1000 + t * 50);
      }

      // Negative shift
      let detected = false;
      for (let t = 0; t < 50; t++) {
        const frame = shiftedFrame(baselines, -3.0, 0.3, 200 + t);
        const result = detector.update(frame, 2000 + t * 50);
        if (result.changeDetected) {
          detected = true;
          break;
        }
      }

      assert.equal(detected, true, 'Should detect large downward step change');
    });

    it('should increment change count on detection', () => {
      const baselines = makeBaselines(N, 10.0);
      const stds = new Float64Array(N).fill(0.5);
      detector.initialize(baselines, stds, 0);

      // Warmup
      for (let t = 0; t < 15; t++) {
        detector.update(stableFrame(baselines, 0.3, t), 1000 + t * 50);
      }

      // Trigger a change
      for (let t = 0; t < 50; t++) {
        const result = detector.update(
          shiftedFrame(baselines, 5.0, 0.3, 300 + t),
          2000 + t * 50
        );
        if (result.changeDetected) break;
      }

      assert.equal(detector.changeCount, 1);
    });
  });

  // -------------------------------------------------------------------------
  // Channel voting: reject narrow-band glitches
  // -------------------------------------------------------------------------

  describe('channel voting', () => {
    it('should NOT trigger when only one channel is affected', () => {
      const baselines = makeBaselines(N, 10.0);
      const stds = new Float64Array(N).fill(0.5);
      detector.initialize(baselines, stds, 0);

      // Warmup with exact baseline (no noise) to establish clean state
      for (let t = 0; t < 15; t++) {
        detector.update(new Float64Array(baselines), 1000 + t * 50);
      }

      // Shift only channel 0 — other channels stay at exact baseline (no noise)
      // With 1/8 = 12.5% < 25% channelVoteRatio, should not trigger
      let changes = 0;
      for (let t = 0; t < 100; t++) {
        const frame = new Float64Array(baselines);
        frame[0] += 5.0;  // Only channel 0 is shifted
        const result = detector.update(frame, 2000 + t * 50);
        if (result.changeDetected) changes++;
      }

      assert.equal(changes, 0, 'Should reject single-channel glitches');
    });

    it('should trigger when enough channels are affected', () => {
      const baselines = makeBaselines(N, 10.0);
      const stds = new Float64Array(N).fill(0.5);
      detector.initialize(baselines, stds, 0);

      // Warmup
      for (let t = 0; t < 15; t++) {
        detector.update(stableFrame(baselines, 0.3, t), 1000 + t * 50);
      }

      // Shift 50% of channels (well above 25% threshold)
      let detected = false;
      for (let t = 0; t < 50; t++) {
        const frame = partialShiftFrame(baselines, 5.0, 0.5, 0.3, 500 + t);
        const result = detector.update(frame, 2000 + t * 50);
        if (result.changeDetected) {
          detected = true;
          break;
        }
      }

      assert.equal(detected, true, 'Should detect when half of channels shift');
    });
  });

  // -------------------------------------------------------------------------
  // Cooldown
  // -------------------------------------------------------------------------

  describe('cooldown', () => {
    it('should respect cooldown period after detection', () => {
      const baselines = makeBaselines(N, 10.0);
      const stds = new Float64Array(N).fill(0.5);
      detector.initialize(baselines, stds, 0);

      // Warmup
      for (let t = 0; t < 15; t++) {
        detector.update(stableFrame(baselines, 0.3, t), 1000 + t * 50);
      }

      // Trigger first detection
      let firstDetectTime = 0;
      for (let t = 0; t < 50; t++) {
        const ts = 2000 + t * 50;
        const result = detector.update(shiftedFrame(baselines, 5.0, 0.3, 600 + t), ts);
        if (result.changeDetected) {
          firstDetectTime = ts;
          break;
        }
      }
      assert.ok(firstDetectTime > 0, 'Should have detected first change');

      // Immediately try to detect another change — should be in cooldown
      const result = detector.update(
        shiftedFrame(baselines, 10.0, 0.3, 700),
        firstDetectTime + 500  // Within 1000ms cooldown
      );
      assert.equal(result.inCooldown, true);
      assert.equal(result.changeDetected, false);
    });
  });

  // -------------------------------------------------------------------------
  // FIR headstart
  // -------------------------------------------------------------------------

  describe('FIR headstart', () => {
    it('should detect changes faster with FIR enabled', () => {
      const baselines = makeBaselines(N, 10.0);
      const stds = new Float64Array(N).fill(0.5);

      // Detector with FIR
      const withFir = new CusumDetector({
        numChannels: N,
        warmupSamples: 5,
        cooldownMs: 0,
        channelVoteRatio: 0.25,
        decisionThreshold: 5.0,
        slackParameter: 0.5,
        enableFir: true,
        firHeadstart: 0.5,
      });

      // Detector without FIR
      const withoutFir = new CusumDetector({
        numChannels: N,
        warmupSamples: 5,
        cooldownMs: 0,
        channelVoteRatio: 0.25,
        decisionThreshold: 5.0,
        slackParameter: 0.5,
        enableFir: false,
      });

      withFir.initialize(baselines, stds);
      withoutFir.initialize(baselines, stds);

      // Warmup both
      for (let t = 0; t < 10; t++) {
        const frame = stableFrame(baselines, 0.3, t);
        withFir.update(frame, 1000 + t * 50);
        withoutFir.update(frame, 1000 + t * 50);
      }

      // Feed shifted frames and count samples to detection
      let firDetectAt = Infinity;
      let noFirDetectAt = Infinity;

      for (let t = 0; t < 100; t++) {
        const frame = shiftedFrame(baselines, 3.0, 0.3, 800 + t);
        const ts = 2000 + t * 50;

        const r1 = withFir.update(frame, ts);
        if (r1.changeDetected && firDetectAt === Infinity) firDetectAt = t;

        const r2 = withoutFir.update(frame, ts);
        if (r2.changeDetected && noFirDetectAt === Infinity) noFirDetectAt = t;

        if (firDetectAt < Infinity && noFirDetectAt < Infinity) break;
      }

      // FIR should detect at same time or sooner
      assert.ok(firDetectAt <= noFirDetectAt,
        `FIR should detect at same time or sooner: FIR@${firDetectAt} vs noFIR@${noFirDetectAt}`);
    });
  });

  // -------------------------------------------------------------------------
  // Baseline update
  // -------------------------------------------------------------------------

  describe('baseline update', () => {
    it('should accept new baselines and reset CUSUM', () => {
      const baselines = makeBaselines(N, 10.0);
      detector.initialize(baselines);

      // Process some frames to build up CUSUM
      for (let t = 0; t < 20; t++) {
        detector.update(shiftedFrame(baselines, 1.0, 0.3, t), 1000 + t * 50);
      }

      // Update baselines
      const newBaselines = makeBaselines(N, 12.0);
      detector.updateBaselines(newBaselines);

      // CUSUM should be reset (to 0 since FIR is disabled)
      const stats = detector.getChannelStats();
      for (let i = 0; i < N; i++) {
        assert.equal(stats.high[i], 0);
        assert.equal(stats.low[i], 0);
        assert.equal(stats.baselines[i], 12.0);
      }
    });

    it('should reject wrong-length baselines in updateBaselines', () => {
      detector.initialize(makeBaselines(N));
      assert.throws(
        () => detector.updateBaselines(makeBaselines(3)),
        /expected 8 baselines, got 3/
      );
    });
  });

  // -------------------------------------------------------------------------
  // State persistence
  // -------------------------------------------------------------------------

  describe('state persistence', () => {
    it('should save and restore state correctly', () => {
      const baselines = makeBaselines(N, 10.0);
      detector.initialize(baselines);

      // Run some frames
      for (let t = 0; t < 30; t++) {
        detector.update(stableFrame(baselines, 0.3, t), 1000 + t * 50);
      }

      // Save state
      const state = detector.getState();
      assert.equal(state.sampleCount, 30);
      assert.equal(state.baselines.length, N);

      // Create new detector and restore
      const restored = new CusumDetector({ numChannels: N, enableFir: false });
      restored.restoreState(state);

      assert.equal(restored.initialized, true);
      assert.equal(restored.sampleCount, 30);
      assert.deepEqual(Array.from(restored.baselines), Array.from(detector.baselines));
    });

    it('should reject invalid state in restoreState', () => {
      assert.throws(() => detector.restoreState(null), /Invalid state/);
      assert.throws(() => detector.restoreState({}), /Invalid state/);
    });
  });

  // -------------------------------------------------------------------------
  // Direction classification
  // -------------------------------------------------------------------------

  describe('direction classification', () => {
    it('should report "up" direction for upward shift', () => {
      const baselines = makeBaselines(N, 10.0);
      const stds = new Float64Array(N).fill(0.5);
      detector.initialize(baselines, stds, 0);

      // Warmup
      for (let t = 0; t < 15; t++) {
        detector.update(stableFrame(baselines, 0.3, t), 1000 + t * 50);
      }

      // Upward shift
      for (let t = 0; t < 50; t++) {
        const result = detector.update(
          shiftedFrame(baselines, 5.0, 0.3, 900 + t),
          2000 + t * 50
        );
        if (result.changeDetected) {
          const event = detector.getRecentHistory(1)[0];
          assert.equal(event.direction, 'up');
          return;
        }
      }
      assert.fail('Should have detected upward change');
    });

    it('should report "down" direction for downward shift', () => {
      const baselines = makeBaselines(N, 10.0);
      const stds = new Float64Array(N).fill(0.5);
      detector.initialize(baselines, stds, 0);

      // Warmup
      for (let t = 0; t < 15; t++) {
        detector.update(stableFrame(baselines, 0.3, t), 1000 + t * 50);
      }

      // Downward shift
      for (let t = 0; t < 50; t++) {
        const result = detector.update(
          shiftedFrame(baselines, -5.0, 0.3, 950 + t),
          2000 + t * 50
        );
        if (result.changeDetected) {
          const event = detector.getRecentHistory(1)[0];
          assert.equal(event.direction, 'down');
          return;
        }
      }
      assert.fail('Should have detected downward change');
    });
  });

  // -------------------------------------------------------------------------
  // Diagnostics history
  // -------------------------------------------------------------------------

  describe('diagnostics', () => {
    it('should record detection events in history', () => {
      const baselines = makeBaselines(N, 10.0);
      const stds = new Float64Array(N).fill(0.5);
      detector.initialize(baselines, stds, 0);

      // Warmup
      for (let t = 0; t < 15; t++) {
        detector.update(stableFrame(baselines, 0.3, t), 1000 + t * 50);
      }

      // Trigger detection
      for (let t = 0; t < 50; t++) {
        detector.update(shiftedFrame(baselines, 5.0, 0.3, 1000 + t), 2000 + t * 50);
      }

      const history = detector.getRecentHistory(10);
      assert.ok(history.length > 0, 'Should have at least one event');
      assert.ok(history[0].t > 0);
      assert.ok(history[0].alarmRatio > 0);
      assert.ok(history[0].changeIndex === 1);
    });

    it('should limit history to configured size', () => {
      const shortHistDetector = new CusumDetector({
        numChannels: N,
        warmupSamples: 5,
        cooldownMs: 0,  // No cooldown for rapid detections
        channelVoteRatio: 0.25,
        decisionThreshold: 2.0,  // Very sensitive
        slackParameter: 0.1,
        enableFir: false,
        historySize: 3,
      });

      const baselines = makeBaselines(N, 10.0);
      const stds = new Float64Array(N).fill(0.5);
      shortHistDetector.initialize(baselines, stds);

      // Warmup
      for (let t = 0; t < 10; t++) {
        shortHistDetector.update(stableFrame(baselines, 0.3, t), 1000 + t * 50);
      }

      // Trigger many detections by alternating big shifts
      for (let t = 0; t < 500; t++) {
        const shift = (t % 20 < 10) ? 10.0 : -10.0;
        shortHistDetector.update(shiftedFrame(baselines, shift, 0.3, 1100 + t), 2000 + t * 100);
      }

      const history = shortHistDetector.getRecentHistory(100);
      assert.ok(history.length <= 3, `History should be capped at 3, got ${history.length}`);
    });
  });

  // -------------------------------------------------------------------------
  // Reset
  // -------------------------------------------------------------------------

  describe('reset', () => {
    it('should return to uninitialized state', () => {
      detector.initialize(makeBaselines(N));
      detector.update(makeBaselines(N), 1000);
      detector.reset();

      assert.equal(detector.initialized, false);
      assert.equal(detector.sampleCount, 0);
      assert.equal(detector.changeCount, 0);
      assert.throws(() => detector.update(makeBaselines(N)));
    });
  });

  // -------------------------------------------------------------------------
  // Channel stats
  // -------------------------------------------------------------------------

  describe('getChannelStats', () => {
    it('should return copies of internal arrays', () => {
      detector.initialize(makeBaselines(N, 10.0));
      const stats = detector.getChannelStats();

      // Modify returned arrays — should not affect detector
      stats.baselines[0] = 999;
      const stats2 = detector.getChannelStats();
      assert.equal(stats2.baselines[0], 10.0);
    });
  });
});
