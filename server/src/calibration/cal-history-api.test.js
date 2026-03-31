// ==============================================================================
// Calibration History API Tests — ACC-03-T6
// ==============================================================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCalibrationRouter } from './cal-history-api.js';
import { RecalibrationLogger, TriggerType } from './recal-logger.js';

// ---------------------------------------------------------------------------
// Test HTTP helper (lightweight, no supertest dependency)
// ---------------------------------------------------------------------------

/**
 * Make a request to the Express app and return the parsed response.
 * Uses Node's native http module.
 *
 * @param {express.Application} app
 * @param {string} path
 * @returns {Promise<{ status: number, body: Object }>}
 */
async function request(app, path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}${path}`;

      fetch(url)
        .then(async (res) => {
          const body = await res.json();
          server.close();
          resolve({ status: res.status, body });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

describe('Calibration History API', () => {
  /** @type {express.Application} */
  let app;
  /** @type {RecalibrationLogger} */
  let recalLogger;

  beforeEach(() => {
    const mockPino = {
      child: () => ({
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      }),
    };

    recalLogger = new RecalibrationLogger(mockPino, { maxEvents: 100 });

    app = express();
    const router = createCalibrationRouter({ logger: mockPino, recalLogger });
    app.use('/api/v1/calibration', router);
  });

  // Seed some test events
  function seedEvents() {
    recalLogger.logRecalibration({
      nodeId: 'node-01', triggerType: TriggerType.SCHEDULED,
      oldBaseline: 1.0, newBaseline: 1.05, activeScale: 'slow',
      divergence: 1.1, fastEma: 1.05, mediumEma: 1.02, slowEma: 1.0,
    });
    recalLogger.logRecalibration({
      nodeId: 'node-02', triggerType: TriggerType.CUSUM_SHIFT,
      oldBaseline: 1.0, newBaseline: 1.5, activeScale: 'fast',
      divergence: 3.0, fastEma: 1.5, mediumEma: 1.2, slowEma: 1.0,
    });
    recalLogger.logRecalibration({
      nodeId: 'node-01', triggerType: TriggerType.EMPTY_ROOM,
      oldBaseline: 1.05, newBaseline: 0.98, activeScale: 'slow',
      divergence: 1.0, fastEma: 0.98, mediumEma: 1.0, slowEma: 1.02,
      roomState: 'empty', roomConfidence: 0.95,
    });
  }

  // --- GET /history ---

  it('should return all events when no filters', async () => {
    seedEvents();
    const { status, body } = await request(app, '/api/v1/calibration/history');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.events.length, 3);
    assert.ok(body.data.summary);
    assert.equal(body.data.summary.totalEvents, 3);
  });

  it('should filter by nodeId', async () => {
    seedEvents();
    const { status, body } = await request(app, '/api/v1/calibration/history?nodeId=node-01');
    assert.equal(status, 200);
    assert.equal(body.data.events.length, 2);
    assert.ok(body.data.events.every(e => e.nodeId === 'node-01'));
  });

  it('should filter by triggerType', async () => {
    seedEvents();
    const { status, body } = await request(app, '/api/v1/calibration/history?triggerType=cusum_shift');
    assert.equal(status, 200);
    assert.equal(body.data.events.length, 1);
    assert.equal(body.data.events[0].triggerType, 'cusum_shift');
  });

  it('should filter by both nodeId and triggerType', async () => {
    seedEvents();
    const { status, body } = await request(app, '/api/v1/calibration/history?nodeId=node-01&triggerType=scheduled');
    assert.equal(status, 200);
    assert.equal(body.data.events.length, 1);
  });

  it('should respect limit parameter', async () => {
    seedEvents();
    const { status, body } = await request(app, '/api/v1/calibration/history?limit=2');
    assert.equal(status, 200);
    assert.equal(body.data.events.length, 2);
  });

  it('should return 400 for invalid triggerType', async () => {
    const { status, body } = await request(app, '/api/v1/calibration/history?triggerType=invalid');
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.ok(body.error.includes('Invalid triggerType'));
  });

  it('should return empty events when no data', async () => {
    const { status, body } = await request(app, '/api/v1/calibration/history');
    assert.equal(status, 200);
    assert.equal(body.data.events.length, 0);
  });

  // --- GET /summary ---

  it('should return summary statistics', async () => {
    seedEvents();
    const { status, body } = await request(app, '/api/v1/calibration/summary');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.summary.totalEvents, 3);
    assert.ok(body.data.summary.triggerCounts);
    assert.ok(body.data.summary.avgShiftMagnitude > 0);
  });

  it('should return empty summary when no events', async () => {
    const { status, body } = await request(app, '/api/v1/calibration/summary');
    assert.equal(status, 200);
    assert.equal(body.data.summary.totalEvents, 0);
  });
});
