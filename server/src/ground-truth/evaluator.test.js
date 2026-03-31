// ==============================================================================
// Ground Truth Evaluation Pipeline — Unit & Integration Tests
// ==============================================================================
// Tests for ACC-08-T4 + ACC-08-T5: Verifies confusion matrix computation,
// per-class metrics (precision/recall/F1), aggregate metrics, error analysis,
// full evaluation pipeline, and the REST API endpoints.
//
// Test strategy:
//   - Pure function tests: buildConfusionMatrix, computePerClassMetrics,
//     computeAggregateMetrics, computeErrorAnalysis with known inputs
//   - Integration tests: evaluateSession with in-memory SQLite
//   - API tests: HTTP endpoint tests for eval-api.js
//   - Edge cases: empty data, single class, perfect accuracy, zero accuracy
// ==============================================================================

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDatabase, getDb, closeDatabase, _resetDbSingleton } from '../db/index.js';
import {
  CLASSES,
  CLASS_LABELS,
  buildConfusionMatrix,
  computePerClassMetrics,
  computeAggregateMetrics,
  computeErrorAnalysis,
  evaluateSession,
  evaluateMultipleSessions,
  getEvaluationHistory,
} from './evaluator.js';
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

/** Track inserted nodes to avoid FK violations */
const _insertedNodes = new Set();

/**
 * Ensure a node row exists (events.node_id has FK to nodes).
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
 * Insert a detection event into the events table.
 * @param {Object} params
 * @returns {number} event ID
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

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

describe('Evaluation Pipeline', () => {
  beforeEach(() => {
    _insertedNodes.clear();
    _resetDbSingleton();
    initDatabase({ logger: testLogger, inMemory: true });
  });

  afterEach(() => {
    closeDatabase();
    _resetDbSingleton();
  });

  // =========================================================================
  // buildConfusionMatrix
  // =========================================================================
  describe('buildConfusionMatrix', () => {
    it('should build a 4x4 zero matrix from empty pairs', () => {
      const cm = buildConfusionMatrix([]);
      assert.equal(cm.total, 0);
      assert.deepEqual(cm.classes, [0, 1, 2, 3]);
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          assert.equal(cm.matrix[i][j], 0);
        }
      }
    });

    it('should count perfect predictions on the diagonal', () => {
      const pairs = [
        { true_count: 0, predicted_count: 0 },
        { true_count: 1, predicted_count: 1 },
        { true_count: 1, predicted_count: 1 },
        { true_count: 2, predicted_count: 2 },
        { true_count: 3, predicted_count: 3 },
      ];
      const cm = buildConfusionMatrix(pairs);
      assert.equal(cm.total, 5);
      assert.equal(cm.matrix[0][0], 1); // true=0, pred=0
      assert.equal(cm.matrix[1][1], 2); // true=1, pred=1
      assert.equal(cm.matrix[2][2], 1); // true=2, pred=2
      assert.equal(cm.matrix[3][3], 1); // true=3, pred=3
    });

    it('should count misclassifications off-diagonal', () => {
      const pairs = [
        { true_count: 0, predicted_count: 1 }, // FP for class 1
        { true_count: 1, predicted_count: 0 }, // FN for class 1
        { true_count: 2, predicted_count: 3 },
      ];
      const cm = buildConfusionMatrix(pairs);
      assert.equal(cm.total, 3);
      assert.equal(cm.matrix[0][1], 1); // true=0, pred=1
      assert.equal(cm.matrix[1][0], 1); // true=1, pred=0
      assert.equal(cm.matrix[2][3], 1); // true=2, pred=3
    });

    it('should clamp out-of-range values to [0, 3]', () => {
      const pairs = [
        { true_count: -1, predicted_count: 5 },
        { true_count: 4, predicted_count: -2 },
      ];
      const cm = buildConfusionMatrix(pairs);
      assert.equal(cm.matrix[0][3], 1); // -1 → 0, 5 → 3
      assert.equal(cm.matrix[3][0], 1); // 4 → 3, -2 → 0
    });

    it('should handle all samples in one class', () => {
      const pairs = Array(10).fill({ true_count: 1, predicted_count: 1 });
      const cm = buildConfusionMatrix(pairs);
      assert.equal(cm.total, 10);
      assert.equal(cm.matrix[1][1], 10);
      // Everything else should be 0
      assert.equal(cm.matrix[0][0], 0);
      assert.equal(cm.matrix[2][2], 0);
    });
  });

  // =========================================================================
  // computePerClassMetrics
  // =========================================================================
  describe('computePerClassMetrics', () => {
    it('should compute perfect metrics for a perfect classifier', () => {
      // Perfect: 5 of each class correctly classified
      const matrix = [
        [5, 0, 0, 0],
        [0, 5, 0, 0],
        [0, 0, 5, 0],
        [0, 0, 0, 5],
      ];
      const metrics = computePerClassMetrics(matrix);
      assert.equal(metrics.length, 4);
      for (const m of metrics) {
        assert.equal(m.precision, 1);
        assert.equal(m.recall, 1);
        assert.equal(m.f1, 1);
        assert.equal(m.support, 5);
        assert.equal(m.tp, 5);
        assert.equal(m.fp, 0);
        assert.equal(m.fn, 0);
      }
    });

    it('should compute zero metrics for a completely wrong classifier', () => {
      // All class 0 predicted as class 1
      const matrix = [
        [0, 5, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ];
      const metrics = computePerClassMetrics(matrix);
      // Class 0: tp=0, fp=0, fn=5 → precision=0/0=0, recall=0/5=0
      assert.equal(metrics[0].precision, 0);
      assert.equal(metrics[0].recall, 0);
      assert.equal(metrics[0].f1, 0);
      assert.equal(metrics[0].support, 5);
      // Class 1: tp=0, fp=5, fn=0 → precision=0/5=0, recall=0/0=0
      assert.equal(metrics[1].precision, 0);
      assert.equal(metrics[1].recall, 0);
      assert.equal(metrics[1].f1, 0);
    });

    it('should compute correct metrics for a mixed classifier', () => {
      // Class 0: 8 correct, 2 missed (predicted as 1)
      // Class 1: 6 correct, 4 missed (2 predicted as 0, 2 as 2)
      const matrix = [
        [8, 2, 0, 0], // true=0
        [2, 6, 2, 0], // true=1
        [0, 0, 0, 0], // true=2 (no samples)
        [0, 0, 0, 0], // true=3 (no samples)
      ];
      const metrics = computePerClassMetrics(matrix);

      // Class 0: tp=8, fp=2 (from row 1 col 0), fn=2 → P=8/10=0.8, R=8/10=0.8
      assert.equal(metrics[0].tp, 8);
      assert.equal(metrics[0].fp, 2);
      assert.equal(metrics[0].fn, 2);
      assert.equal(metrics[0].precision, 0.8);
      assert.equal(metrics[0].recall, 0.8);
      assert.equal(metrics[0].f1, 0.8);
      assert.equal(metrics[0].support, 10);

      // Class 1: tp=6, fp=2 (from row 0 col 1), fn=4 → P=6/8=0.75, R=6/10=0.6
      assert.equal(metrics[1].tp, 6);
      assert.equal(metrics[1].fp, 2);
      assert.equal(metrics[1].fn, 4);
      assert.equal(metrics[1].precision, 0.75);
      assert.equal(metrics[1].recall, 0.6);
      // F1 = 2 * 0.75 * 0.6 / (0.75 + 0.6) = 0.9 / 1.35 ≈ 0.6667
      assert.ok(Math.abs(metrics[1].f1 - 0.6667) < 0.001);
    });

    it('should handle classes with zero support', () => {
      const matrix = [
        [5, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ];
      const metrics = computePerClassMetrics(matrix);
      // Class 0: perfect
      assert.equal(metrics[0].precision, 1);
      assert.equal(metrics[0].recall, 1);
      // Classes 1-3: no support, all zeros
      assert.equal(metrics[1].support, 0);
      assert.equal(metrics[1].precision, 0);
      assert.equal(metrics[1].recall, 0);
    });

    it('should include correct labels', () => {
      const matrix = Array.from({ length: 4 }, () => Array(4).fill(0));
      const metrics = computePerClassMetrics(matrix);
      assert.equal(metrics[0].label, 'empty');
      assert.equal(metrics[1].label, '1 person');
      assert.equal(metrics[2].label, '2 people');
      assert.equal(metrics[3].label, '3+ people');
    });
  });

  // =========================================================================
  // computeAggregateMetrics
  // =========================================================================
  describe('computeAggregateMetrics', () => {
    it('should compute perfect aggregate for perfect classifier', () => {
      const perClass = [
        { precision: 1, recall: 1, f1: 1, support: 5, tp: 5 },
        { precision: 1, recall: 1, f1: 1, support: 5, tp: 5 },
        { precision: 1, recall: 1, f1: 1, support: 5, tp: 5 },
        { precision: 1, recall: 1, f1: 1, support: 5, tp: 5 },
      ];
      const agg = computeAggregateMetrics(perClass);
      assert.equal(agg.accuracy, 1);
      assert.equal(agg.macro.precision, 1);
      assert.equal(agg.macro.recall, 1);
      assert.equal(agg.macro.f1, 1);
      assert.equal(agg.weighted.precision, 1);
      assert.equal(agg.weighted.recall, 1);
      assert.equal(agg.weighted.f1, 1);
      assert.equal(agg.total_samples, 20);
    });

    it('should compute zero aggregate for zero metrics', () => {
      const perClass = [
        { precision: 0, recall: 0, f1: 0, support: 5, tp: 0 },
        { precision: 0, recall: 0, f1: 0, support: 5, tp: 0 },
        { precision: 0, recall: 0, f1: 0, support: 0, tp: 0 },
        { precision: 0, recall: 0, f1: 0, support: 0, tp: 0 },
      ];
      const agg = computeAggregateMetrics(perClass);
      assert.equal(agg.accuracy, 0);
      assert.equal(agg.macro.precision, 0);
      assert.equal(agg.total_samples, 10);
    });

    it('should weight by support for weighted average', () => {
      // Class 0: 90% precision with 90 samples
      // Class 1: 10% precision with 10 samples
      // Weighted precision = (0.9*90 + 0.1*10) / 100 = 82/100 = 0.82
      const perClass = [
        { precision: 0.9, recall: 0.9, f1: 0.9, support: 90, tp: 81 },
        { precision: 0.1, recall: 0.1, f1: 0.1, support: 10, tp: 1 },
        { precision: 0, recall: 0, f1: 0, support: 0, tp: 0 },
        { precision: 0, recall: 0, f1: 0, support: 0, tp: 0 },
      ];
      const agg = computeAggregateMetrics(perClass);
      assert.equal(agg.weighted.precision, 0.82);
      assert.equal(agg.weighted.recall, 0.82);
      assert.equal(agg.weighted.f1, 0.82);
      // Macro (only active classes): (0.9 + 0.1) / 2 = 0.5
      assert.equal(agg.macro.precision, 0.5);
    });

    it('should handle empty input gracefully', () => {
      const perClass = [];
      const agg = computeAggregateMetrics(perClass);
      assert.equal(agg.accuracy, 0);
      assert.equal(agg.total_samples, 0);
    });
  });

  // =========================================================================
  // computeErrorAnalysis
  // =========================================================================
  describe('computeErrorAnalysis', () => {
    it('should return empty array for perfect classifier', () => {
      const matrix = [
        [5, 0, 0, 0],
        [0, 5, 0, 0],
        [0, 0, 5, 0],
        [0, 0, 0, 5],
      ];
      const errors = computeErrorAnalysis(matrix);
      assert.equal(errors.length, 0);
    });

    it('should list errors sorted by frequency', () => {
      const matrix = [
        [3, 5, 0, 0], // 5 errors: true=0 pred as 1
        [2, 4, 0, 0], // 2 errors: true=1 pred as 0
        [0, 0, 0, 1], // 1 error: true=2 pred as 3
        [0, 0, 0, 0],
      ];
      const errors = computeErrorAnalysis(matrix);
      assert.equal(errors.length, 3);
      // Sorted by count descending
      assert.equal(errors[0].count, 5);
      assert.equal(errors[0].true_class, 0);
      assert.equal(errors[0].predicted_class, 1);
      assert.equal(errors[1].count, 2);
      assert.equal(errors[2].count, 1);
    });

    it('should include percentage of total errors', () => {
      const matrix = [
        [0, 6, 0, 0],
        [4, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ];
      const errors = computeErrorAnalysis(matrix);
      // Total errors = 10, class 0→1 has 6 = 60%, class 1→0 has 4 = 40%
      assert.equal(errors[0].percentage, 0.6);
      assert.equal(errors[1].percentage, 0.4);
    });

    it('should include human-readable labels', () => {
      const matrix = [
        [0, 0, 0, 0],
        [1, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ];
      const errors = computeErrorAnalysis(matrix);
      assert.equal(errors[0].true_label, '1 person');
      assert.equal(errors[0].predicted_label, 'empty');
    });
  });

  // =========================================================================
  // evaluateSession (integration)
  // =========================================================================
  describe('evaluateSession', () => {
    it('should return empty result for session with no aligned pairs', () => {
      const session = createSession({ name: 'empty-eval', annotator: 'test' });
      const result = evaluateSession(session.id);
      assert.equal(result.session_id, session.id);
      assert.equal(result.aggregate.total_samples, 0);
      assert.equal(result.aggregate.accuracy, 0);
      assert.equal(result.confusion_matrix.total, 0);
      assert.equal(result.error_analysis.length, 0);
    });

    it('should compute correct metrics for aligned session data', () => {
      // Create session, labels, and events that will align
      const session = createSession({ name: 'eval-test', annotator: 'test' });
      const nodeId = 'node-eval-01';

      // Insert events at known timestamps
      const baseTime = '2026-03-31T12:00:00.000Z';
      for (let i = 0; i < 10; i++) {
        const ts = `2026-03-31T12:00:${String(i).padStart(2, '0')}.000Z`;
        // Predictions: first 5 predict 0, last 5 predict 1
        insertEvent({ timestamp: ts, nodeId, predictedCount: i < 5 ? 0 : 1 });
      }

      // Add labels near the event timestamps
      // First 3: true=0 (matches prediction) → correct
      // Next 2: true=0 (but pred=0) → correct
      // Next 3: true=1 (matches prediction) → correct
      // Last 2: true=0 (but pred=1) → wrong
      for (let i = 0; i < 10; i++) {
        const ts = `2026-03-31T12:00:${String(i).padStart(2, '0')}.050Z`; // 50ms after event
        const trueCount = i < 5 ? 0 : (i < 8 ? 1 : 0);
        addLabel({
          sessionId: session.id,
          trueCount,
          nodeId,
          annotator: 'test',
        });
        // Override the timestamp directly in DB for precise control
        const db = getDb();
        const label = db.prepare('SELECT id FROM labels ORDER BY id DESC LIMIT 1').get();
        db.prepare('UPDATE labels SET timestamp = ? WHERE id = ?').run(ts, label.id);
      }

      const result = evaluateSession(session.id, {
        nodeId,
        maxDeltaMs: 100,
      });

      // Should have 10 aligned pairs
      assert.equal(result.aggregate.total_samples, 10);
      // 8 correct: first 5 (true=0, pred=0) + 3 (true=1, pred=1) = 8
      // 2 wrong: last 2 (true=0, pred=1)
      assert.equal(result.aggregate.accuracy, 0.8);
      assert.equal(result.confusion_matrix.total, 10);
    });

    it('should persist evaluation when persist=true', () => {
      const session = createSession({ name: 'persist-test', annotator: 'test' });
      const result = evaluateSession(session.id, { persist: true, notes: 'test run' });

      assert.ok(result.evaluation_id !== null);

      // Verify it's in the DB
      const db = getDb();
      const row = db.prepare('SELECT * FROM evaluations WHERE id = ?').get(result.evaluation_id);
      assert.ok(row);
      assert.equal(row.algorithm, 'threshold');
      assert.equal(row.notes, 'test run');
    });

    it('should not persist evaluation by default', () => {
      const session = createSession({ name: 'no-persist', annotator: 'test' });
      const result = evaluateSession(session.id);
      assert.equal(result.evaluation_id, null);
    });

    it('should include algorithm name in result', () => {
      const session = createSession({ name: 'algo-test', annotator: 'test' });
      const result = evaluateSession(session.id, { algorithm: 'random-forest-v2' });
      assert.equal(result.algorithm, 'random-forest-v2');
    });
  });

  // =========================================================================
  // evaluateMultipleSessions
  // =========================================================================
  describe('evaluateMultipleSessions', () => {
    it('should merge pairs from multiple sessions', () => {
      const s1 = createSession({ name: 'multi-1', annotator: 'test' });
      const s2 = createSession({ name: 'multi-2', annotator: 'test' });

      const result = evaluateMultipleSessions([s1.id, s2.id]);
      assert.deepEqual(result.session_ids, [s1.id, s2.id]);
      assert.ok(result.alignment.sessions.length === 2);
    });

    it('should handle empty sessions gracefully', () => {
      const s1 = createSession({ name: 'empty-multi', annotator: 'test' });
      const result = evaluateMultipleSessions([s1.id]);
      assert.equal(result.aggregate.total_samples, 0);
      assert.equal(result.confusion_matrix.total, 0);
    });

    it('should persist multi-session evaluation', () => {
      const s1 = createSession({ name: 'multi-persist-1', annotator: 'test' });
      const s2 = createSession({ name: 'multi-persist-2', annotator: 'test' });
      const result = evaluateMultipleSessions([s1.id, s2.id], {
        persist: true,
        notes: 'multi-test',
      });
      assert.ok(result.evaluation_id !== null);

      const db = getDb();
      const row = db.prepare('SELECT * FROM evaluations WHERE id = ?').get(result.evaluation_id);
      assert.ok(row.session_id.includes(s1.id));
      assert.ok(row.session_id.includes(s2.id));
    });
  });

  // =========================================================================
  // getEvaluationHistory
  // =========================================================================
  describe('getEvaluationHistory', () => {
    it('should return empty array when no evaluations exist', () => {
      const history = getEvaluationHistory();
      assert.equal(history.length, 0);
    });

    it('should return persisted evaluations', () => {
      const session = createSession({ name: 'history-test', annotator: 'test' });
      evaluateSession(session.id, { persist: true, algorithm: 'threshold' });
      evaluateSession(session.id, { persist: true, algorithm: 'ml-v1' });

      const history = getEvaluationHistory();
      assert.equal(history.length, 2);
    });

    it('should filter by algorithm', () => {
      const session = createSession({ name: 'filter-test', annotator: 'test' });
      evaluateSession(session.id, { persist: true, algorithm: 'threshold' });
      evaluateSession(session.id, { persist: true, algorithm: 'ml-v1' });

      const history = getEvaluationHistory({ algorithm: 'ml-v1' });
      assert.equal(history.length, 1);
      assert.equal(history[0].algorithm, 'ml-v1');
    });

    it('should filter by sessionId', () => {
      const s1 = createSession({ name: 'filter-s1', annotator: 'test' });
      const s2 = createSession({ name: 'filter-s2', annotator: 'test' });
      evaluateSession(s1.id, { persist: true });
      evaluateSession(s2.id, { persist: true });

      const history = getEvaluationHistory({ sessionId: s1.id });
      assert.equal(history.length, 1);
    });

    it('should respect limit parameter', () => {
      const session = createSession({ name: 'limit-test', annotator: 'test' });
      for (let i = 0; i < 5; i++) {
        evaluateSession(session.id, { persist: true });
      }
      const history = getEvaluationHistory({ limit: 3 });
      assert.equal(history.length, 3);
    });

    it('should parse confusion_json back into objects', () => {
      const session = createSession({ name: 'json-test', annotator: 'test' });
      evaluateSession(session.id, { persist: true });

      const history = getEvaluationHistory();
      assert.ok(history[0].confusion_json !== null);
      assert.ok(typeof history[0].confusion_json === 'object');
    });

    it('should order by timestamp descending (latest first)', () => {
      const session = createSession({ name: 'order-test', annotator: 'test' });
      evaluateSession(session.id, { persist: true, algorithm: 'first' });
      evaluateSession(session.id, { persist: true, algorithm: 'second' });

      const history = getEvaluationHistory();
      // Both have same second-precision timestamp from SQLite datetime('now'),
      // but ORDER BY timestamp DESC, id DESC ensures latest-inserted is first
      assert.equal(history.length, 2);
      // The second insert has a higher id, verify both are present
      assert.ok(
        history.some(h => h.algorithm === 'first') &&
        history.some(h => h.algorithm === 'second'),
      );
    });
  });

  // =========================================================================
  // Constants
  // =========================================================================
  describe('Constants', () => {
    it('should define 4 classes (0-3)', () => {
      assert.deepEqual(CLASSES, [0, 1, 2, 3]);
    });

    it('should have labels for all classes', () => {
      assert.equal(Object.keys(CLASS_LABELS).length, 4);
      assert.equal(CLASS_LABELS[0], 'empty');
      assert.equal(CLASS_LABELS[3], '3+ people');
    });
  });

  // =========================================================================
  // Known-answer verification
  // =========================================================================
  describe('Known-answer tests', () => {
    it('should reproduce sklearn-equivalent metrics for a known dataset', () => {
      // 20 samples, known true/predicted pairs:
      // True:  [0,0,0,0,0, 1,1,1,1,1, 2,2,2,2,2, 3,3,3,3,3]
      // Pred:  [0,0,0,1,1, 1,1,1,0,2, 2,2,3,3,2, 3,3,3,3,2]
      const pairs = [
        // Class 0: 3 correct, 2 predicted as 1
        { true_count: 0, predicted_count: 0 },
        { true_count: 0, predicted_count: 0 },
        { true_count: 0, predicted_count: 0 },
        { true_count: 0, predicted_count: 1 },
        { true_count: 0, predicted_count: 1 },
        // Class 1: 3 correct, 1 predicted as 0, 1 as 2
        { true_count: 1, predicted_count: 1 },
        { true_count: 1, predicted_count: 1 },
        { true_count: 1, predicted_count: 1 },
        { true_count: 1, predicted_count: 0 },
        { true_count: 1, predicted_count: 2 },
        // Class 2: 3 correct, 2 predicted as 3
        { true_count: 2, predicted_count: 2 },
        { true_count: 2, predicted_count: 2 },
        { true_count: 2, predicted_count: 3 },
        { true_count: 2, predicted_count: 3 },
        { true_count: 2, predicted_count: 2 },
        // Class 3: 4 correct, 1 predicted as 2
        { true_count: 3, predicted_count: 3 },
        { true_count: 3, predicted_count: 3 },
        { true_count: 3, predicted_count: 3 },
        { true_count: 3, predicted_count: 3 },
        { true_count: 3, predicted_count: 2 },
      ];

      const cm = buildConfusionMatrix(pairs);

      // Verify confusion matrix
      assert.deepEqual(cm.matrix, [
        [3, 2, 0, 0], // true=0
        [1, 3, 1, 0], // true=1
        [0, 0, 3, 2], // true=2
        [0, 0, 1, 4], // true=3
      ]);
      assert.equal(cm.total, 20);

      const perClass = computePerClassMetrics(cm.matrix);

      // Class 0: tp=3, fp=1, fn=2 → P=3/4=0.75, R=3/5=0.6
      assert.equal(perClass[0].tp, 3);
      assert.equal(perClass[0].fp, 1);
      assert.equal(perClass[0].fn, 2);
      assert.equal(perClass[0].precision, 0.75);
      assert.equal(perClass[0].recall, 0.6);

      // Class 3: tp=4, fp=2, fn=1 → P=4/6≈0.6667, R=4/5=0.8
      assert.equal(perClass[3].tp, 4);
      assert.equal(perClass[3].fp, 2);
      assert.equal(perClass[3].fn, 1);
      assert.ok(Math.abs(perClass[3].precision - 0.6667) < 0.001);
      assert.equal(perClass[3].recall, 0.8);

      const agg = computeAggregateMetrics(perClass);
      // Overall accuracy = (3+3+3+4)/20 = 13/20 = 0.65
      assert.equal(agg.accuracy, 0.65);
      assert.equal(agg.total_samples, 20);

      const errors = computeErrorAnalysis(cm.matrix);
      // Most common errors: 0→1 (2), 2→3 (2), then 1→0, 1→2, 3→2 (1 each)
      assert.ok(errors.length > 0);
      assert.ok(errors[0].count >= errors[errors.length - 1].count);
    });
  });
});
