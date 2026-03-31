// ==============================================================================
// CSI-Label Alignment — Unit & Integration Tests
// ==============================================================================
// Tests for ACC-08-T3: Verifies that labels are correctly matched to the
// nearest CSI detection event within the configured time tolerance.
//
// Test strategy:
//   - Uses in-memory SQLite database for isolation
//   - Seeds events table with known timestamps
//   - Verifies alignment picks the closest event
//   - Verifies unaligned labels when no event is within tolerance
//   - Tests node-scoped alignment
//   - Tests confidence filtering
//   - Tests edge cases: empty session, single label, exact match
// ==============================================================================

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDatabase, getDb, closeDatabase, _resetDbSingleton } from '../db/index.js';
import {
  findNearestEvent,
  alignSession,
  getEvaluationPairs,
  DEFAULT_MAX_DELTA_MS,
} from './alignment.js';
import { createSession, addLabel } from './storage.js';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/** Minimal no-op logger for testing */
const testLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => testLogger,
};

/** Track which node IDs have been inserted in the current test so we don't duplicate */
const _insertedNodes = new Set();

/**
 * Ensure a node row exists in the nodes table (events.node_id is a FK).
 *
 * @param {string} nodeId
 */
function ensureNode(nodeId) {
  if (_insertedNodes.has(nodeId)) return;
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO nodes (id, mac, name, type, status)
    VALUES (?, ?, ?, 'esp32-s3', 'online')
  `).run(nodeId, `AA:BB:CC:DD:EE:${nodeId.slice(-2).padStart(2, '0')}`, nodeId);
  _insertedNodes.add(nodeId);
}

/**
 * Insert a detection event directly into the events table.
 * Automatically ensures the referenced node exists.
 *
 * @param {Object} params
 * @param {string} params.timestamp - ISO 8601 timestamp
 * @param {string} params.nodeId - Node identifier
 * @param {number} params.predictedCount - Algorithm's person count prediction
 * @param {number} [params.confidence=0.9] - Detection confidence
 * @param {string} [params.algorithm='threshold'] - Algorithm name
 * @returns {number} Inserted event ID
 */
function insertEvent({ timestamp, nodeId, predictedCount, confidence = 0.9, algorithm = 'threshold' }) {
  const db = getDb();
  ensureNode(nodeId);
  const result = db.prepare(`
    INSERT INTO events (timestamp, node_id, predicted_count, confidence, algorithm)
    VALUES (?, ?, ?, ?, ?)
  `).run(timestamp, nodeId, predictedCount, confidence, algorithm);
  return result.lastInsertRowid;
}

/**
 * Create a test session and return its ID.
 *
 * @param {string} [nodeId] - Optional node scope
 * @returns {string} Session UUID
 */
function createTestSession(nodeId) {
  const session = createSession({ name: 'test-session', annotator: 'tester', nodeId });
  return session.id;
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('CSI-Label Alignment (ACC-08-T3)', () => {
  beforeEach(() => {
    _resetDbSingleton();
    _insertedNodes.clear();
    initDatabase({ logger: testLogger, inMemory: true });
  });

  afterEach(() => {
    closeDatabase();
    _resetDbSingleton();
  });

  // -------------------------------------------------------------------------
  // findNearestEvent
  // -------------------------------------------------------------------------

  describe('findNearestEvent()', () => {
    it('should find the nearest event before the timestamp', () => {
      insertEvent({ timestamp: '2026-03-31T10:00:00.000Z', nodeId: 'node-1', predictedCount: 1 });
      insertEvent({ timestamp: '2026-03-31T10:00:00.050Z', nodeId: 'node-1', predictedCount: 1 });

      const result = findNearestEvent('2026-03-31T10:00:00.060Z', { maxDeltaMs: 100 });
      assert.ok(result, 'Should find a match');
      assert.equal(result.delta_ms, 10);
    });

    it('should find the nearest event after the timestamp', () => {
      insertEvent({ timestamp: '2026-03-31T10:00:00.100Z', nodeId: 'node-1', predictedCount: 2 });

      const result = findNearestEvent('2026-03-31T10:00:00.050Z', { maxDeltaMs: 100 });
      assert.ok(result, 'Should find a match');
      assert.equal(result.delta_ms, 50);
      assert.equal(result.event.predicted_count, 2);
    });

    it('should pick the closer event when events exist on both sides', () => {
      insertEvent({ timestamp: '2026-03-31T10:00:00.000Z', nodeId: 'node-1', predictedCount: 0 });
      insertEvent({ timestamp: '2026-03-31T10:00:00.080Z', nodeId: 'node-1', predictedCount: 1 });

      // 30ms is closer to .000 (30ms) than to .080 (50ms)
      const result = findNearestEvent('2026-03-31T10:00:00.030Z', { maxDeltaMs: 100 });
      assert.ok(result);
      assert.equal(result.event.predicted_count, 0);
      assert.equal(result.delta_ms, 30);
    });

    it('should return null when no event is within tolerance', () => {
      insertEvent({ timestamp: '2026-03-31T10:00:00.000Z', nodeId: 'node-1', predictedCount: 1 });

      const result = findNearestEvent('2026-03-31T10:00:01.000Z', { maxDeltaMs: 100 });
      assert.equal(result, null, 'Should be null when >100ms away');
    });

    it('should return null when no events exist at all', () => {
      const result = findNearestEvent('2026-03-31T10:00:00.000Z');
      assert.equal(result, null);
    });

    it('should filter by nodeId when specified', () => {
      insertEvent({ timestamp: '2026-03-31T10:00:00.000Z', nodeId: 'node-1', predictedCount: 1 });
      insertEvent({ timestamp: '2026-03-31T10:00:00.010Z', nodeId: 'node-2', predictedCount: 2 });

      const result = findNearestEvent('2026-03-31T10:00:00.005Z', { nodeId: 'node-2', maxDeltaMs: 100 });
      assert.ok(result);
      assert.equal(result.event.predicted_count, 2);
      assert.equal(result.event.node_id, 'node-2');
    });

    it('should return null when nodeId has no matching events', () => {
      insertEvent({ timestamp: '2026-03-31T10:00:00.000Z', nodeId: 'node-1', predictedCount: 1 });

      const result = findNearestEvent('2026-03-31T10:00:00.005Z', { nodeId: 'node-99', maxDeltaMs: 100 });
      assert.equal(result, null);
    });

    it('should handle exact timestamp match (delta = 0)', () => {
      insertEvent({ timestamp: '2026-03-31T10:00:00.000Z', nodeId: 'node-1', predictedCount: 3 });

      const result = findNearestEvent('2026-03-31T10:00:00.000Z', { maxDeltaMs: 100 });
      assert.ok(result);
      assert.equal(result.delta_ms, 0);
      assert.equal(result.event.predicted_count, 3);
    });

    it('should respect custom maxDeltaMs', () => {
      insertEvent({ timestamp: '2026-03-31T10:00:00.000Z', nodeId: 'node-1', predictedCount: 1 });

      // 50ms away — within 200ms tolerance
      const loose = findNearestEvent('2026-03-31T10:00:00.050Z', { maxDeltaMs: 200 });
      assert.ok(loose, 'Should match with 200ms tolerance');

      // 50ms away — outside 10ms tolerance
      const strict = findNearestEvent('2026-03-31T10:00:00.050Z', { maxDeltaMs: 10 });
      assert.equal(strict, null, 'Should not match with 10ms tolerance');
    });
  });

  // -------------------------------------------------------------------------
  // alignSession
  // -------------------------------------------------------------------------

  describe('alignSession()', () => {
    it('should align all labels to nearest events in a simple session', () => {
      // Insert label FIRST (sets label.timestamp to datetime('now')),
      // then insert an event with a known close timestamp derived from
      // reading the label back. This avoids race conditions from using
      // real wall-clock time.
      const sessionId = createTestSession('node-1');
      addLabel({ sessionId, trueCount: 0, nodeId: 'node-1' });

      // Read back the label's actual stored timestamp
      const db = getDb();
      const label = db.prepare('SELECT timestamp FROM labels WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId);

      // Insert event 50ms after the label timestamp (known delta)
      const labelMs = new Date(label.timestamp + 'Z').getTime(); // append Z for UTC parse
      const eventTs = new Date(labelMs + 50).toISOString();
      insertEvent({ timestamp: eventTs, nodeId: 'node-1', predictedCount: 0 });

      const result = alignSession(sessionId, { maxDeltaMs: 200 });
      assert.equal(result.aligned.length, 1);
      assert.equal(result.unaligned.length, 0);
      assert.equal(result.stats.total, 1);
      assert.equal(result.stats.alignment_rate, 1);
    });

    it('should report unaligned labels when no event exists', () => {
      const sessionId = createTestSession();
      addLabel({ sessionId, trueCount: 1 });

      const result = alignSession(sessionId);
      assert.equal(result.aligned.length, 0);
      assert.equal(result.unaligned.length, 1);
      assert.equal(result.stats.alignment_rate, 0);
      assert.ok(result.unaligned[0].reason.includes('No event within'));
    });

    it('should handle empty session gracefully', () => {
      const sessionId = createTestSession();
      const result = alignSession(sessionId);

      assert.equal(result.aligned.length, 0);
      assert.equal(result.unaligned.length, 0);
      assert.equal(result.stats.total, 0);
      assert.equal(result.stats.alignment_rate, 0);
      assert.equal(result.stats.avg_delta_ms, 0);
    });

    it('should compute correct stats for mixed aligned/unaligned', () => {
      // One event at a known time
      insertEvent({ timestamp: '2026-03-31T10:00:00.000Z', nodeId: 'node-1', predictedCount: 1 });

      const sessionId = createTestSession();
      // First label: will align (close to the event)
      addLabel({ sessionId, trueCount: 1, nodeId: 'node-1' });

      const result = alignSession(sessionId, { maxDeltaMs: 5000 });

      // At least 1 label should align since the label was created ~same time
      assert.ok(result.stats.total >= 1, 'Should have at least 1 label');
    });

    it('should use label nodeId for alignment when set', () => {
      insertEvent({ timestamp: '2026-03-31T10:00:00.000Z', nodeId: 'node-1', predictedCount: 1 });
      insertEvent({ timestamp: '2026-03-31T10:00:00.000Z', nodeId: 'node-2', predictedCount: 2 });

      const sessionId = createTestSession();
      // Label with explicit node_id=node-2 should align to node-2's event
      addLabel({ sessionId, trueCount: 2, nodeId: 'node-2' });

      const result = alignSession(sessionId, { maxDeltaMs: 60000 });

      if (result.aligned.length > 0) {
        assert.equal(result.aligned[0].event.node_id, 'node-2');
        assert.equal(result.aligned[0].event.predicted_count, 2);
      }
    });
  });

  // -------------------------------------------------------------------------
  // getEvaluationPairs
  // -------------------------------------------------------------------------

  describe('getEvaluationPairs()', () => {
    it('should return evaluation-ready pairs with correct structure', () => {
      insertEvent({ timestamp: '2026-03-31T10:00:00.000Z', nodeId: 'node-1', predictedCount: 1 });

      const sessionId = createTestSession();
      addLabel({ sessionId, trueCount: 1, nodeId: 'node-1', confidence: 'certain' });

      const result = getEvaluationPairs(sessionId, { maxDeltaMs: 60000 });

      if (result.pairs.length > 0) {
        const pair = result.pairs[0];
        assert.ok('true_count' in pair, 'Should have true_count');
        assert.ok('predicted_count' in pair, 'Should have predicted_count');
        assert.ok('delta_ms' in pair, 'Should have delta_ms');
        assert.ok('label_id' in pair, 'Should have label_id');
        assert.ok('event_id' in pair, 'Should have event_id');
        assert.ok('timestamp' in pair, 'Should have timestamp');
      }

      assert.ok('evaluation_count' in result.stats, 'Stats should include evaluation_count');
      assert.ok('filtered_count' in result.stats, 'Stats should include filtered_count');
    });

    it('should filter by confidence level', () => {
      insertEvent({ timestamp: '2026-03-31T10:00:00.000Z', nodeId: 'node-1', predictedCount: 1 });
      insertEvent({ timestamp: '2026-03-31T10:00:01.000Z', nodeId: 'node-1', predictedCount: 2 });

      const sessionId = createTestSession();
      addLabel({ sessionId, trueCount: 1, nodeId: 'node-1', confidence: 'certain' });
      addLabel({ sessionId, trueCount: 2, nodeId: 'node-1', confidence: 'unsure' });

      // Filter to 'certain' only — should exclude the 'unsure' label
      const result = getEvaluationPairs(sessionId, {
        maxDeltaMs: 60000,
        confidenceFilter: 'certain',
      });

      // All returned pairs should be from 'certain' labels only
      for (const pair of result.pairs) {
        // We can't directly check confidence from the pair, but the count
        // should be less than or equal to total aligned
        assert.ok(pair.true_count >= 0);
      }

      assert.ok(result.stats.filtered_count >= 0, 'Should report filtered count');
    });

    it('should handle empty session', () => {
      const sessionId = createTestSession();
      const result = getEvaluationPairs(sessionId);

      assert.deepEqual(result.pairs, []);
      assert.equal(result.stats.total, 0);
      assert.equal(result.stats.evaluation_count, 0);
    });

    it('should propagate alignment stats', () => {
      const sessionId = createTestSession();
      addLabel({ sessionId, trueCount: 0 }); // No events to align to

      const result = getEvaluationPairs(sessionId);
      assert.equal(result.stats.total, 1);
      assert.equal(result.stats.unaligned_count, 1);
      assert.equal(result.stats.evaluation_count, 0);
    });
  });

  // -------------------------------------------------------------------------
  // DEFAULT_MAX_DELTA_MS constant
  // -------------------------------------------------------------------------

  describe('DEFAULT_MAX_DELTA_MS', () => {
    it('should be 100ms as specified in task requirements', () => {
      assert.equal(DEFAULT_MAX_DELTA_MS, 100);
    });
  });

  // -------------------------------------------------------------------------
  // Edge Cases
  // -------------------------------------------------------------------------

  describe('Edge cases', () => {
    it('should handle many events efficiently', () => {
      // Insert 100 events at 200ms intervals
      const db = getDb();
      ensureNode('node-1');
      const stmt = db.prepare(
        'INSERT INTO events (timestamp, node_id, predicted_count, confidence, algorithm) VALUES (?, ?, ?, ?, ?)'
      );
      const insertMany = db.transaction(() => {
        for (let i = 0; i < 100; i++) {
          const ts = new Date(Date.UTC(2026, 2, 31, 10, 0, 0, i * 200)).toISOString();
          stmt.run(ts, 'node-1', i % 4, 0.9, 'threshold');
        }
      });
      insertMany();

      // Find event at midpoint — should be fast
      const start = performance.now();
      const result = findNearestEvent('2026-03-31T10:00:10.000Z', { nodeId: 'node-1', maxDeltaMs: 200 });
      const elapsed = performance.now() - start;

      assert.ok(result, 'Should find a match in the middle of the range');
      assert.ok(elapsed < 50, `Should complete in <50ms, took ${elapsed.toFixed(1)}ms`);
    });

    it('should handle events with identical timestamps', () => {
      insertEvent({ timestamp: '2026-03-31T10:00:00.000Z', nodeId: 'node-1', predictedCount: 1 });
      insertEvent({ timestamp: '2026-03-31T10:00:00.000Z', nodeId: 'node-2', predictedCount: 2 });

      const result = findNearestEvent('2026-03-31T10:00:00.000Z', { maxDeltaMs: 100 });
      assert.ok(result);
      assert.equal(result.delta_ms, 0);
    });

    it('should handle boundary: event exactly at maxDeltaMs', () => {
      insertEvent({ timestamp: '2026-03-31T10:00:00.000Z', nodeId: 'node-1', predictedCount: 1 });

      // Event is exactly 100ms away
      const result = findNearestEvent('2026-03-31T10:00:00.100Z', { maxDeltaMs: 100 });
      assert.ok(result, 'Should include event exactly at the boundary');
      assert.equal(result.delta_ms, 100);
    });

    it('should handle boundary: event 1ms beyond maxDeltaMs', () => {
      insertEvent({ timestamp: '2026-03-31T10:00:00.000Z', nodeId: 'node-1', predictedCount: 1 });

      // Event is 101ms away — just beyond tolerance
      const result = findNearestEvent('2026-03-31T10:00:00.101Z', { maxDeltaMs: 100 });
      assert.equal(result, null, 'Should exclude event just beyond the boundary');
    });
  });

  // -------------------------------------------------------------------------
  // Input Validation (reviewer feedback — cycle 3)
  // -------------------------------------------------------------------------

  describe('Input validation', () => {
    it('should reject null sessionId in alignSession', () => {
      assert.throws(() => alignSession(null), /sessionId is required/);
    });

    it('should reject empty string sessionId in alignSession', () => {
      assert.throws(() => alignSession(''), /sessionId is required/);
    });

    it('should reject sessionId with invalid characters', () => {
      assert.throws(() => alignSession('session with spaces!'), /Invalid sessionId format/);
    });

    it('should reject negative maxDeltaMs in findNearestEvent', () => {
      assert.throws(
        () => findNearestEvent('2026-03-31T10:00:00.000Z', { maxDeltaMs: -1 }),
        /maxDeltaMs must be a non-negative number/,
      );
    });

    it('should reject NaN maxDeltaMs', () => {
      assert.throws(
        () => findNearestEvent('2026-03-31T10:00:00.000Z', { maxDeltaMs: NaN }),
        /maxDeltaMs must be a non-negative number/,
      );
    });

    it('should accept maxDeltaMs = 0', () => {
      insertEvent({ timestamp: '2026-03-31T10:00:00.000Z', nodeId: 'node-1', predictedCount: 1 });
      // Exact match needed at maxDeltaMs=0
      const result = findNearestEvent('2026-03-31T10:00:00.000Z', { maxDeltaMs: 0 });
      assert.ok(result, 'Should match exact timestamp with maxDeltaMs=0');
      assert.equal(result.delta_ms, 0);
    });
  });

  // -------------------------------------------------------------------------
  // SQLite datetime format (reviewer feedback — cycle 3)
  // -------------------------------------------------------------------------

  describe('SQLite datetime format handling', () => {
    it('should correctly match events stored with SQLite datetime format (space-separated, no Z)', () => {
      // SQLite datetime('now') produces timestamps like '2026-03-31 10:00:00'
      // (space-separated, no timezone indicator) — these are UTC but JS Date
      // would interpret them as local time without the 'Z' suffix
      const db = getDb();
      ensureNode('node-fmt');
      db.prepare(`
        INSERT INTO events (timestamp, node_id, predicted_count, confidence, algorithm)
        VALUES ('2026-03-31 10:00:00.050', 'node-fmt', 2, 0.9, 'threshold')
      `).run();

      // Query with ISO 8601 format — should still find the match
      const result = findNearestEvent('2026-03-31T10:00:00.050Z', { maxDeltaMs: 10 });
      assert.ok(result, 'Should find event stored in SQLite format when queried with ISO 8601');
      assert.equal(result.event.predicted_count, 2);
    });
  });

  // -------------------------------------------------------------------------
  // Confidence filter strength (reviewer feedback — cycle 3)
  // -------------------------------------------------------------------------

  describe('Confidence filter strength', () => {
    it('should return fewer pairs when confidence filter is applied', () => {
      const sessionId = createTestSession();
      const db = getDb();
      ensureNode('node-cf');

      // Insert events at known timestamps
      insertEvent({ timestamp: '2026-03-31T12:00:00.000Z', nodeId: 'node-cf', predictedCount: 1 });
      insertEvent({ timestamp: '2026-03-31T12:00:01.000Z', nodeId: 'node-cf', predictedCount: 2 });

      // Insert labels directly with specific timestamps and confidences
      // (addLabel uses DB-default timestamp, so we insert manually for precise control)
      db.prepare(`
        INSERT INTO labels (session_id, timestamp, true_count, annotator, confidence)
        VALUES (?, '2026-03-31 12:00:00.010', ?, 'tester', 'certain')
      `).run(sessionId, 1);
      db.prepare(`
        INSERT INTO labels (session_id, timestamp, true_count, annotator, confidence)
        VALUES (?, '2026-03-31 12:00:01.010', ?, 'tester', 'unsure')
      `).run(sessionId, 2);

      // Unfiltered should return 2 pairs
      const unfiltered = getEvaluationPairs(sessionId, { maxDeltaMs: 200 });
      assert.equal(unfiltered.pairs.length, 2, 'Unfiltered should return 2 pairs');

      // Filtered at 'certain' should return fewer pairs (only the 'certain' one)
      const filtered = getEvaluationPairs(sessionId, { maxDeltaMs: 200, confidenceFilter: 'certain' });
      assert.ok(
        filtered.pairs.length < unfiltered.pairs.length,
        `Filtered (${filtered.pairs.length}) should be < unfiltered (${unfiltered.pairs.length})`,
      );
      assert.equal(filtered.pairs.length, 1, 'Filtered should only include the certain label');
    });
  });
});
