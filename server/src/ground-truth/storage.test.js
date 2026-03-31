// ==============================================================================
// Tests: Ground Truth Storage Module
// ==============================================================================

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDatabase, closeDatabase, _resetDbSingleton } from '../db/index.js';
import {
  createSession,
  getSession,
  listSessions,
  endSession,
  addLabel,
  getLabels,
  getRecentLabels,
  getLabelDistribution,
  deleteLabel,
} from './storage.js';

const mockLogger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
  child: () => mockLogger,
};

describe('Ground Truth Storage', () => {
  beforeEach(() => {
    _resetDbSingleton();
    initDatabase({ logger: mockLogger, inMemory: true });
  });

  afterEach(() => {
    closeDatabase();
    _resetDbSingleton();
  });

  // -----------------------------------------------------------------------
  // Sessions
  // -----------------------------------------------------------------------

  describe('Sessions', () => {
    it('should create a session with defaults', () => {
      const session = createSession();
      assert.ok(session.id, 'Should have an ID');
      assert.ok(session.name.startsWith('session-'), 'Should have auto-generated name');
      assert.equal(session.annotator, 'anonymous');
      assert.equal(session.status, 'active');
      assert.equal(session.label_count, 0);
    });

    it('should create a session with custom params', () => {
      const session = createSession({
        name: 'Test Session',
        annotator: 'Alice',
        nodeId: 'node-1',
        notes: 'Testing',
      });
      assert.equal(session.name, 'Test Session');
      assert.equal(session.annotator, 'Alice');
      assert.equal(session.node_id, 'node-1');
      assert.equal(session.notes, 'Testing');
    });

    it('should get session by ID', () => {
      const created = createSession({ name: 'Find Me' });
      const found = getSession(created.id);
      assert.equal(found.name, 'Find Me');
    });

    it('should return null for unknown session', () => {
      const found = getSession('nonexistent');
      assert.equal(found, null);
    });

    it('should list sessions', () => {
      createSession({ name: 'S1' });
      createSession({ name: 'S2' });
      const list = listSessions();
      assert.equal(list.length, 2);
    });

    it('should filter sessions by status', () => {
      const s1 = createSession({ name: 'Active' });
      const s2 = createSession({ name: 'To End' });
      endSession(s2.id);

      const active = listSessions({ status: 'active' });
      assert.equal(active.length, 1);
      assert.equal(active[0].name, 'Active');

      const ended = listSessions({ status: 'ended' });
      assert.equal(ended.length, 1);
      assert.equal(ended[0].name, 'To End');
    });

    it('should end a session', () => {
      const session = createSession();
      const ended = endSession(session.id);
      assert.equal(ended.status, 'ended');
      assert.ok(ended.ended_at);
    });
  });

  // -----------------------------------------------------------------------
  // Labels
  // -----------------------------------------------------------------------

  describe('Labels', () => {
    let sessionId;

    beforeEach(() => {
      const session = createSession({ name: 'Label Test' });
      sessionId = session.id;
    });

    it('should add a label', () => {
      const label = addLabel({ sessionId, trueCount: 1 });
      assert.ok(label.id);
      assert.equal(label.true_count, 1);
      assert.equal(label.session_id, sessionId);
    });

    it('should reject label for non-existent session', () => {
      assert.throws(() => addLabel({ sessionId: 'fake', trueCount: 0 }), /not found/);
    });

    it('should reject label for ended session', () => {
      endSession(sessionId);
      assert.throws(() => addLabel({ sessionId, trueCount: 0 }), /not active/);
    });

    it('should reject invalid true_count', () => {
      assert.throws(() => addLabel({ sessionId, trueCount: 5 }), /Invalid true_count/);
      assert.throws(() => addLabel({ sessionId, trueCount: -1 }), /Invalid true_count/);
    });

    it('should accept all valid true_count values (0-3)', () => {
      for (let i = 0; i <= 3; i++) {
        const label = addLabel({ sessionId, trueCount: i });
        assert.equal(label.true_count, i);
      }
    });

    it('should get labels for a session', () => {
      addLabel({ sessionId, trueCount: 0 });
      addLabel({ sessionId, trueCount: 1 });
      addLabel({ sessionId, trueCount: 2 });

      const labels = getLabels(sessionId);
      assert.equal(labels.length, 3);
    });

    it('should paginate labels', () => {
      for (let i = 0; i < 10; i++) {
        addLabel({ sessionId, trueCount: i % 4 });
      }

      const page1 = getLabels(sessionId, { limit: 3, offset: 0 });
      assert.equal(page1.length, 3);

      const page2 = getLabels(sessionId, { limit: 3, offset: 3 });
      assert.equal(page2.length, 3);
    });

    it('should get recent labels across sessions', () => {
      const s2 = createSession({ name: 'Other Session' });
      addLabel({ sessionId, trueCount: 0 });
      addLabel({ sessionId: s2.id, trueCount: 1 });

      const recent = getRecentLabels({ limit: 10 });
      assert.equal(recent.length, 2);
      assert.ok(recent[0].session_name, 'Should include session name');
    });

    it('should compute label distribution', () => {
      addLabel({ sessionId, trueCount: 0 });
      addLabel({ sessionId, trueCount: 0 });
      addLabel({ sessionId, trueCount: 1 });
      addLabel({ sessionId, trueCount: 2 });
      addLabel({ sessionId, trueCount: 3 });
      addLabel({ sessionId, trueCount: 3 });

      const dist = getLabelDistribution(sessionId);
      assert.equal(dist.count_0, 2);
      assert.equal(dist.count_1, 1);
      assert.equal(dist.count_2, 1);
      assert.equal(dist.count_3, 2);
      assert.equal(dist.total, 6);
    });

    it('should delete a label', () => {
      const label = addLabel({ sessionId, trueCount: 1 });
      const deleted = deleteLabel(label.id);
      assert.ok(deleted);

      const labels = getLabels(sessionId);
      assert.equal(labels.length, 0);
    });

    it('should return false when deleting nonexistent label', () => {
      const deleted = deleteLabel(99999);
      assert.equal(deleted, false);
    });

    it('should include label count in session', () => {
      addLabel({ sessionId, trueCount: 0 });
      addLabel({ sessionId, trueCount: 1 });

      const session = getSession(sessionId);
      assert.equal(session.label_count, 2);
    });
  });
});
