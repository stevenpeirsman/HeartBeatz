// ==============================================================================
// Recalibration Event Logger Tests — ACC-03-T5
// ==============================================================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RecalibrationLogger, TriggerType } from './recal-logger.js';

describe('TriggerType', () => {
  it('should have all expected trigger types', () => {
    assert.equal(TriggerType.SCHEDULED, 'scheduled');
    assert.equal(TriggerType.CUSUM_SHIFT, 'cusum_shift');
    assert.equal(TriggerType.EMPTY_ROOM, 'empty_room');
    assert.equal(TriggerType.MANUAL, 'manual');
    assert.equal(TriggerType.STARTUP, 'startup');
  });

  it('should be frozen', () => {
    assert.throws(() => { TriggerType.NEW_TYPE = 'new'; });
  });
});

describe('RecalibrationLogger', () => {
  /** @type {RecalibrationLogger} */
  let logger;
  let logMessages;

  beforeEach(() => {
    logMessages = [];
    const mockPino = {
      child: () => ({
        info: (data, msg) => logMessages.push({ level: 'info', data, msg }),
        warn: (data, msg) => logMessages.push({ level: 'warn', data, msg }),
        debug: (data, msg) => logMessages.push({ level: 'debug', data, msg }),
        error: (data, msg) => logMessages.push({ level: 'error', data, msg }),
      }),
    };
    logger = new RecalibrationLogger(mockPino, { maxEvents: 10 });
  });

  // --- Basic logging ---

  it('should log a recalibration event and return it', () => {
    const event = logger.logRecalibration({
      nodeId: 'node-01',
      triggerType: TriggerType.SCHEDULED,
      oldBaseline: 1.0,
      newBaseline: 1.05,
      activeScale: 'slow',
      divergence: 1.1,
      fastEma: 1.05,
      mediumEma: 1.03,
      slowEma: 1.0,
    });

    assert.equal(event.nodeId, 'node-01');
    assert.equal(event.triggerType, 'scheduled');
    assert.equal(event.oldBaseline, 1.0);
    assert.equal(event.newBaseline, 1.05);
    assert.equal(event.shiftAbsolute, 0.05);
    assert.ok(event.shiftMagnitude > 0.04 && event.shiftMagnitude < 0.06);
    assert.ok(event.id.includes('-1'));
    assert.ok(event.timestamp);
  });

  it('should compute relative shift magnitude correctly', () => {
    // 100% increase: 1.0 → 2.0
    const event = logger.logRecalibration({
      nodeId: 'node-01',
      triggerType: TriggerType.CUSUM_SHIFT,
      oldBaseline: 1.0,
      newBaseline: 2.0,
      activeScale: 'fast',
      divergence: 3.0,
      fastEma: 2.0,
      mediumEma: 1.5,
      slowEma: 1.0,
    });

    assert.equal(event.shiftMagnitude, 1.0);
    assert.equal(event.shiftAbsolute, 1.0);
  });

  it('should handle zero baseline safely', () => {
    const event = logger.logRecalibration({
      nodeId: 'node-01',
      triggerType: TriggerType.STARTUP,
      oldBaseline: 0,
      newBaseline: 1.5,
      activeScale: 'slow',
      divergence: 1.0,
      fastEma: 1.5,
      mediumEma: 1.5,
      slowEma: 1.5,
    });

    // Should use 0.001 as minimum, so shift = 1.5/0.001 = 1500
    assert.ok(event.shiftMagnitude > 0);
    assert.ok(Number.isFinite(event.shiftMagnitude));
  });

  // --- Log levels based on shift magnitude ---

  it('should log at debug level for small shifts (<10%)', () => {
    logger.logRecalibration({
      nodeId: 'node-01',
      triggerType: TriggerType.SCHEDULED,
      oldBaseline: 1.0,
      newBaseline: 1.05, // 5% shift
      activeScale: 'slow',
      divergence: 1.0,
      fastEma: 1.05,
      mediumEma: 1.02,
      slowEma: 1.0,
    });

    assert.equal(logMessages.length, 1);
    assert.equal(logMessages[0].level, 'debug');
  });

  it('should log at info level for moderate shifts (10-50%)', () => {
    logger.logRecalibration({
      nodeId: 'node-01',
      triggerType: TriggerType.CUSUM_SHIFT,
      oldBaseline: 1.0,
      newBaseline: 1.25, // 25% shift
      activeScale: 'fast',
      divergence: 2.0,
      fastEma: 1.3,
      mediumEma: 1.1,
      slowEma: 1.0,
    });

    assert.equal(logMessages[0].level, 'info');
  });

  it('should log at warn level for large shifts (>50%)', () => {
    logger.logRecalibration({
      nodeId: 'node-01',
      triggerType: TriggerType.CUSUM_SHIFT,
      oldBaseline: 1.0,
      newBaseline: 2.0, // 100% shift
      activeScale: 'fast',
      divergence: 4.0,
      fastEma: 2.5,
      mediumEma: 1.5,
      slowEma: 1.0,
    });

    assert.equal(logMessages[0].level, 'warn');
  });

  // --- Ring buffer ---

  it('should enforce maxEvents ring buffer limit', () => {
    for (let i = 0; i < 15; i++) {
      logger.logRecalibration({
        nodeId: 'node-01',
        triggerType: TriggerType.SCHEDULED,
        oldBaseline: 1.0,
        newBaseline: 1.0 + i * 0.01,
        activeScale: 'slow',
        divergence: 1.0,
        fastEma: 1.0,
        mediumEma: 1.0,
        slowEma: 1.0,
      });
    }

    assert.equal(logger.eventCount, 10);
    // Oldest events should have been evicted
    const history = logger.getHistory();
    assert.equal(history.length, 10);
  });

  it('should return only N most recent events', () => {
    for (let i = 0; i < 5; i++) {
      logger.logRecalibration({
        nodeId: `node-0${i}`,
        triggerType: TriggerType.SCHEDULED,
        oldBaseline: 1.0,
        newBaseline: 1.01,
        activeScale: 'slow',
        divergence: 1.0,
        fastEma: 1.0,
        mediumEma: 1.0,
        slowEma: 1.0,
      });
    }

    const recent = logger.getHistory(3);
    assert.equal(recent.length, 3);
    assert.equal(recent[2].nodeId, 'node-04');
  });

  // --- Filtering ---

  it('should filter by node ID', () => {
    logger.logRecalibration({
      nodeId: 'node-01', triggerType: TriggerType.SCHEDULED,
      oldBaseline: 1.0, newBaseline: 1.01, activeScale: 'slow',
      divergence: 1.0, fastEma: 1.0, mediumEma: 1.0, slowEma: 1.0,
    });
    logger.logRecalibration({
      nodeId: 'node-02', triggerType: TriggerType.SCHEDULED,
      oldBaseline: 1.0, newBaseline: 1.01, activeScale: 'slow',
      divergence: 1.0, fastEma: 1.0, mediumEma: 1.0, slowEma: 1.0,
    });
    logger.logRecalibration({
      nodeId: 'node-01', triggerType: TriggerType.CUSUM_SHIFT,
      oldBaseline: 1.0, newBaseline: 1.5, activeScale: 'fast',
      divergence: 2.0, fastEma: 1.5, mediumEma: 1.2, slowEma: 1.0,
    });

    const node01Events = logger.getHistoryByNode('node-01');
    assert.equal(node01Events.length, 2);
  });

  it('should filter by trigger type', () => {
    logger.logRecalibration({
      nodeId: 'node-01', triggerType: TriggerType.SCHEDULED,
      oldBaseline: 1.0, newBaseline: 1.01, activeScale: 'slow',
      divergence: 1.0, fastEma: 1.0, mediumEma: 1.0, slowEma: 1.0,
    });
    logger.logRecalibration({
      nodeId: 'node-01', triggerType: TriggerType.CUSUM_SHIFT,
      oldBaseline: 1.0, newBaseline: 1.5, activeScale: 'fast',
      divergence: 2.0, fastEma: 1.5, mediumEma: 1.2, slowEma: 1.0,
    });

    const cusumEvents = logger.getHistoryByTrigger(TriggerType.CUSUM_SHIFT);
    assert.equal(cusumEvents.length, 1);
    assert.equal(cusumEvents[0].triggerType, 'cusum_shift');
  });

  // --- Summary ---

  it('should compute summary statistics', () => {
    logger.logRecalibration({
      nodeId: 'node-01', triggerType: TriggerType.SCHEDULED,
      oldBaseline: 1.0, newBaseline: 1.1, activeScale: 'slow',
      divergence: 1.0, fastEma: 1.1, mediumEma: 1.0, slowEma: 1.0,
    });
    logger.logRecalibration({
      nodeId: 'node-01', triggerType: TriggerType.CUSUM_SHIFT,
      oldBaseline: 1.0, newBaseline: 1.3, activeScale: 'fast',
      divergence: 2.0, fastEma: 1.3, mediumEma: 1.1, slowEma: 1.0,
    });
    logger.logRecalibration({
      nodeId: 'node-02', triggerType: TriggerType.SCHEDULED,
      oldBaseline: 1.0, newBaseline: 1.05, activeScale: 'slow',
      divergence: 1.0, fastEma: 1.05, mediumEma: 1.0, slowEma: 1.0,
    });

    const summary = logger.getSummary();
    assert.equal(summary.totalEvents, 3);
    assert.equal(summary.triggerCounts.scheduled, 2);
    assert.equal(summary.triggerCounts.cusum_shift, 1);
    assert.ok(summary.avgShiftMagnitude > 0);
    assert.ok(summary.maxShiftMagnitude > 0.2);
    assert.ok(summary.lastEventTimestamp);
  });

  it('should return empty summary when no events', () => {
    const summary = logger.getSummary();
    assert.equal(summary.totalEvents, 0);
    assert.equal(summary.avgShiftMagnitude, 0);
    assert.equal(summary.lastEventTimestamp, null);
  });

  // --- Optional fields ---

  it('should include room state when provided', () => {
    const event = logger.logRecalibration({
      nodeId: 'node-01',
      triggerType: TriggerType.EMPTY_ROOM,
      oldBaseline: 1.0,
      newBaseline: 0.95,
      activeScale: 'slow',
      divergence: 1.0,
      fastEma: 0.95,
      mediumEma: 0.98,
      slowEma: 1.0,
      roomState: 'empty',
      roomConfidence: 0.95,
    });

    assert.equal(event.roomState, 'empty');
    assert.equal(event.roomConfidence, 0.95);
  });

  // --- Clear ---

  it('should clear all events', () => {
    logger.logRecalibration({
      nodeId: 'node-01', triggerType: TriggerType.SCHEDULED,
      oldBaseline: 1.0, newBaseline: 1.01, activeScale: 'slow',
      divergence: 1.0, fastEma: 1.0, mediumEma: 1.0, slowEma: 1.0,
    });

    logger.clear();
    assert.equal(logger.eventCount, 0);
    assert.equal(logger.getHistory().length, 0);
  });

  // --- Sequence numbering ---

  it('should assign unique sequential IDs', () => {
    const e1 = logger.logRecalibration({
      nodeId: 'node-01', triggerType: TriggerType.SCHEDULED,
      oldBaseline: 1.0, newBaseline: 1.01, activeScale: 'slow',
      divergence: 1.0, fastEma: 1.0, mediumEma: 1.0, slowEma: 1.0,
    });
    const e2 = logger.logRecalibration({
      nodeId: 'node-01', triggerType: TriggerType.SCHEDULED,
      oldBaseline: 1.0, newBaseline: 1.02, activeScale: 'slow',
      divergence: 1.0, fastEma: 1.0, mediumEma: 1.0, slowEma: 1.0,
    });

    assert.notEqual(e1.id, e2.id);
    assert.ok(e1.id.endsWith('-1'));
    assert.ok(e2.id.endsWith('-2'));
  });
});
