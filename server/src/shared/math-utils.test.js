// ==============================================================================
// Shared Math Utilities Tests — DEBT-01
// ==============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ema, clamp } from './math-utils.js';

describe('ema', () => {
  it('should compute EMA correctly with alpha=0.5', () => {
    // EMA = current*(1-alpha) + observed*alpha = 10*0.5 + 20*0.5 = 15
    assert.equal(ema(10, 20, 0.5), 15);
  });

  it('should return observed when alpha=1 (no smoothing)', () => {
    assert.equal(ema(10, 20, 1.0), 20);
  });

  it('should return current when alpha=0 (infinite smoothing)', () => {
    assert.equal(ema(10, 20, 0.0), 10);
  });

  it('should handle typical calibration alphas', () => {
    // alpha=0.1: 100*0.9 + 110*0.1 = 90 + 11 = 101
    const result = ema(100, 110, 0.1);
    assert.ok(Math.abs(result - 101) < 1e-10);
  });

  it('should converge toward observed value over many iterations', () => {
    let value = 0;
    const target = 100;
    for (let i = 0; i < 100; i++) {
      value = ema(value, target, 0.1);
    }
    assert.ok(Math.abs(value - target) < 0.01, `Expected ~100, got ${value}`);
  });
});

describe('clamp', () => {
  it('should clamp value below min', () => {
    assert.equal(clamp(-5, 0, 10), 0);
  });

  it('should clamp value above max', () => {
    assert.equal(clamp(15, 0, 10), 10);
  });

  it('should pass through value within range', () => {
    assert.equal(clamp(5, 0, 10), 5);
  });

  it('should handle equal min and max', () => {
    assert.equal(clamp(5, 3, 3), 3);
  });

  it('should handle negative ranges', () => {
    assert.equal(clamp(-5, -10, -1), -5);
    assert.equal(clamp(-15, -10, -1), -10);
  });
});
