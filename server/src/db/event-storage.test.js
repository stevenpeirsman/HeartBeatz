// ==============================================================================
// Tests: Detection Event Storage (DB-03)
// ==============================================================================

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  storeEvent,
  storeBatch,
  getEventsByNode,
  getEventSummary,
  getEventsInRange,
  countEvents,
  pruneOldEvents,
  DEFAULT_RETENTION_DAYS,
  MAX_BATCH_SIZE,
  VALID_ALGORITHMS,
} from './event-storage.js';
import { initDatabase, getDb, _resetDbSingleton } from './index.js';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/** Ensure a node exists in the nodes table (foreign key requirement) */
function ensureNode(nodeId) {
  const db = getDb();
  const mac = `AA:BB:CC:DD:EE:${nodeId.slice(-2).padStart(2, '0')}`;
  db.prepare(`
    INSERT OR IGNORE INTO nodes (id, mac, name, type, status)
    VALUES (?, ?, ?, 'esp32-s3', 'online')
  `).run(nodeId, mac, `Test ${nodeId}`);
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Event Storage (DB-03)', () => {
  beforeEach(() => {
    _resetDbSingleton();
    initDatabase({ inMemory: true });
    ensureNode('node-1');
    ensureNode('node-2');
    ensureNode('node-3');
  });

  after(() => {
    _resetDbSingleton();
  });

  // ---- storeEvent() ----

  describe('storeEvent()', () => {
    it('should store a basic event and return id + timestamp', () => {
      const result = storeEvent({
        node_id: 'node-1',
        predicted_count: 2,
        confidence: 0.87,
      });

      assert.ok(result.id > 0, 'should return a positive id');
      assert.ok(result.timestamp, 'should return a timestamp');
    });

    it('should store event with all optional fields', () => {
      const ts = '2026-03-31T10:00:00.000Z';
      const result = storeEvent({
        node_id: 'node-1',
        predicted_count: 1,
        confidence: 0.95,
        algorithm: 'ml',
        features_hash: 'abc123def456',
        session_id: 'test-session-1',
        timestamp: ts,
      });

      assert.ok(result.id > 0);
      assert.equal(result.timestamp, ts);

      // Verify persisted correctly
      const db = getDb();
      const row = db.prepare('SELECT * FROM events WHERE id = ?').get(result.id);
      assert.equal(row.node_id, 'node-1');
      assert.equal(row.predicted_count, 1);
      assert.equal(row.confidence, 0.95);
      assert.equal(row.algorithm, 'ml');
      assert.equal(row.features_hash, 'abc123def456');
      assert.equal(row.session_id, 'test-session-1');
    });

    it('should default algorithm to "threshold"', () => {
      const { id } = storeEvent({ node_id: 'node-1', predicted_count: 0 });
      const row = getDb().prepare('SELECT algorithm FROM events WHERE id = ?').get(id);
      assert.equal(row.algorithm, 'threshold');
    });

    it('should round predicted_count to nearest integer', () => {
      const { id } = storeEvent({ node_id: 'node-1', predicted_count: 1.7 });
      const row = getDb().prepare('SELECT predicted_count FROM events WHERE id = ?').get(id);
      assert.equal(row.predicted_count, 2);
    });

    it('should auto-generate timestamp when not provided', () => {
      const before = new Date().toISOString();
      const { timestamp } = storeEvent({ node_id: 'node-1', predicted_count: 0 });
      const after = new Date().toISOString();
      assert.ok(timestamp >= before && timestamp <= after, 'timestamp should be between before/after');
    });

    // -- Validation errors --

    it('should reject missing node_id', () => {
      assert.throws(
        () => storeEvent({ predicted_count: 1 }),
        /node_id.*required/
      );
    });

    it('should reject negative predicted_count', () => {
      assert.throws(
        () => storeEvent({ node_id: 'node-1', predicted_count: -1 }),
        /predicted_count.*non-negative/
      );
    });

    it('should reject NaN predicted_count', () => {
      assert.throws(
        () => storeEvent({ node_id: 'node-1', predicted_count: NaN }),
        /predicted_count/
      );
    });

    it('should reject confidence > 1', () => {
      assert.throws(
        () => storeEvent({ node_id: 'node-1', predicted_count: 1, confidence: 1.5 }),
        /confidence.*between 0 and 1/
      );
    });

    it('should reject invalid algorithm', () => {
      assert.throws(
        () => storeEvent({ node_id: 'node-1', predicted_count: 1, algorithm: 'magic' }),
        /algorithm.*must be one of/
      );
    });

    it('should reject null event', () => {
      assert.throws(() => storeEvent(null), /non-null object/);
    });
  });

  // ---- storeBatch() ----

  describe('storeBatch()', () => {
    it('should insert multiple events atomically', () => {
      const events = [
        { node_id: 'node-1', predicted_count: 0, confidence: 0.9 },
        { node_id: 'node-2', predicted_count: 1, confidence: 0.85 },
        { node_id: 'node-1', predicted_count: 2, confidence: 0.7 },
      ];

      const result = storeBatch(events);

      assert.equal(result.inserted, 3);
      assert.equal(result.ids.length, 3);
      assert.ok(result.ids.every(id => id > 0));
    });

    it('should rollback on validation failure in any event', () => {
      const countBefore = countEvents();
      assert.throws(
        () => storeBatch([
          { node_id: 'node-1', predicted_count: 1 },
          { node_id: 'node-1', predicted_count: -1 }, // invalid
        ]),
        /Event at index 1/
      );
      // Validation happens before transaction, so count shouldn't change
      assert.equal(countEvents(), countBefore);
    });

    it('should reject empty array', () => {
      assert.throws(() => storeBatch([]), /non-empty array/);
    });

    it('should reject oversized batch', () => {
      const bigBatch = Array.from({ length: MAX_BATCH_SIZE + 1 }, () => ({
        node_id: 'node-1',
        predicted_count: 0,
      }));
      assert.throws(() => storeBatch(bigBatch), /exceeds maximum/);
    });

    it('should handle batch of size 1', () => {
      const result = storeBatch([{ node_id: 'node-1', predicted_count: 3 }]);
      assert.equal(result.inserted, 1);
    });
  });

  // ---- getEventsByNode() ----

  describe('getEventsByNode()', () => {
    it('should return events for a specific node in desc order', () => {
      storeEvent({ node_id: 'node-1', predicted_count: 0, timestamp: '2026-03-31T10:00:00Z' });
      storeEvent({ node_id: 'node-1', predicted_count: 1, timestamp: '2026-03-31T10:00:01Z' });
      storeEvent({ node_id: 'node-2', predicted_count: 2, timestamp: '2026-03-31T10:00:02Z' });

      const events = getEventsByNode('node-1');
      assert.equal(events.length, 2);
      assert.equal(events[0].predicted_count, 1, 'most recent first');
      assert.equal(events[1].predicted_count, 0);
    });

    it('should respect limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        storeEvent({ node_id: 'node-1', predicted_count: i });
      }
      const events = getEventsByNode('node-1', { limit: 3 });
      assert.equal(events.length, 3);
    });

    it('should filter by since parameter', () => {
      storeEvent({ node_id: 'node-1', predicted_count: 0, timestamp: '2026-03-30T10:00:00Z' });
      storeEvent({ node_id: 'node-1', predicted_count: 1, timestamp: '2026-03-31T10:00:00Z' });

      const events = getEventsByNode('node-1', { since: '2026-03-31T00:00:00Z' });
      assert.equal(events.length, 1);
      assert.equal(events[0].predicted_count, 1);
    });

    it('should filter by algorithm', () => {
      storeEvent({ node_id: 'node-1', predicted_count: 0, algorithm: 'threshold' });
      storeEvent({ node_id: 'node-1', predicted_count: 1, algorithm: 'ml' });

      const events = getEventsByNode('node-1', { algorithm: 'ml' });
      assert.equal(events.length, 1);
      assert.equal(events[0].algorithm, 'ml');
    });

    it('should reject missing nodeId', () => {
      assert.throws(() => getEventsByNode(''), /nodeId.*required/);
    });
  });

  // ---- getEventSummary() ----

  describe('getEventSummary()', () => {
    it('should return per-node summary', () => {
      storeEvent({ node_id: 'node-1', predicted_count: 0, timestamp: '2026-03-31T10:00:00Z' });
      storeEvent({ node_id: 'node-1', predicted_count: 1, timestamp: '2026-03-31T10:00:01Z' });
      storeEvent({ node_id: 'node-2', predicted_count: 2, timestamp: '2026-03-31T10:00:02Z' });

      const summary = getEventSummary();
      assert.equal(summary.length, 2);

      const node1 = summary.find(s => s.node_id === 'node-1');
      assert.equal(node1.event_count, 2);
      assert.equal(node1.latest_event, '2026-03-31T10:00:01Z');
      assert.equal(node1.earliest_event, '2026-03-31T10:00:00Z');
    });

    it('should return empty array when no events', () => {
      const summary = getEventSummary();
      assert.equal(summary.length, 0);
    });
  });

  // ---- getEventsInRange() ----

  describe('getEventsInRange()', () => {
    it('should return events within the time range', () => {
      storeEvent({ node_id: 'node-1', predicted_count: 0, timestamp: '2026-03-31T09:00:00Z' });
      storeEvent({ node_id: 'node-1', predicted_count: 1, timestamp: '2026-03-31T10:00:00Z' });
      storeEvent({ node_id: 'node-1', predicted_count: 2, timestamp: '2026-03-31T11:00:00Z' });
      storeEvent({ node_id: 'node-1', predicted_count: 3, timestamp: '2026-03-31T12:00:00Z' });

      const events = getEventsInRange('2026-03-31T10:00:00Z', '2026-03-31T11:00:00Z');
      assert.equal(events.length, 2);
      assert.equal(events[0].predicted_count, 1, 'ASC order');
      assert.equal(events[1].predicted_count, 2);
    });

    it('should filter by nodeId within range', () => {
      storeEvent({ node_id: 'node-1', predicted_count: 1, timestamp: '2026-03-31T10:00:00Z' });
      storeEvent({ node_id: 'node-2', predicted_count: 2, timestamp: '2026-03-31T10:00:01Z' });

      const events = getEventsInRange('2026-03-31T09:00:00Z', '2026-03-31T11:00:00Z', { nodeId: 'node-2' });
      assert.equal(events.length, 1);
      assert.equal(events[0].node_id, 'node-2');
    });

    it('should reject missing time range', () => {
      assert.throws(() => getEventsInRange(null, '2026-03-31T11:00:00Z'), /required/);
    });
  });

  // ---- countEvents() ----

  describe('countEvents()', () => {
    it('should count all events', () => {
      storeEvent({ node_id: 'node-1', predicted_count: 0 });
      storeEvent({ node_id: 'node-2', predicted_count: 1 });
      assert.equal(countEvents(), 2);
    });

    it('should count with node filter', () => {
      storeEvent({ node_id: 'node-1', predicted_count: 0 });
      storeEvent({ node_id: 'node-2', predicted_count: 1 });
      assert.equal(countEvents({ nodeId: 'node-1' }), 1);
    });

    it('should count with since filter', () => {
      storeEvent({ node_id: 'node-1', predicted_count: 0, timestamp: '2026-03-30T10:00:00Z' });
      storeEvent({ node_id: 'node-1', predicted_count: 1, timestamp: '2026-03-31T10:00:00Z' });
      assert.equal(countEvents({ since: '2026-03-31T00:00:00Z' }), 1);
    });

    it('should return 0 when no events', () => {
      assert.equal(countEvents(), 0);
    });
  });

  // ---- pruneOldEvents() ----

  describe('pruneOldEvents()', () => {
    it('should delete events older than retention period', () => {
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      const recentDate = new Date().toISOString();

      storeEvent({ node_id: 'node-1', predicted_count: 0, timestamp: oldDate });
      storeEvent({ node_id: 'node-1', predicted_count: 1, timestamp: recentDate });

      assert.equal(countEvents(), 2);

      const { deleted, cutoff } = pruneOldEvents({ retentionDays: 30 });
      assert.equal(deleted, 1, 'should delete 1 old event');
      assert.ok(cutoff, 'should return cutoff timestamp');
      assert.equal(countEvents(), 1, 'should have 1 event remaining');
    });

    it('should respect custom retention period', () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      storeEvent({ node_id: 'node-1', predicted_count: 0, timestamp: twoDaysAgo });

      const { deleted } = pruneOldEvents({ retentionDays: 1 });
      assert.equal(deleted, 1);
    });

    it('should return 0 deleted when no old events', () => {
      storeEvent({ node_id: 'node-1', predicted_count: 0 }); // fresh event
      const { deleted } = pruneOldEvents({ retentionDays: 30 });
      assert.equal(deleted, 0);
    });

    it('should reject invalid retentionDays', () => {
      assert.throws(() => pruneOldEvents({ retentionDays: 0 }), /positive number/);
      assert.throws(() => pruneOldEvents({ retentionDays: -5 }), /positive number/);
    });
  });

  // ---- Constants ----

  describe('Constants', () => {
    it('should have sensible defaults', () => {
      assert.equal(DEFAULT_RETENTION_DAYS, 30);
      assert.equal(MAX_BATCH_SIZE, 500);
      assert.ok(VALID_ALGORITHMS.includes('threshold'));
      assert.ok(VALID_ALGORITHMS.includes('ml'));
    });
  });
});
