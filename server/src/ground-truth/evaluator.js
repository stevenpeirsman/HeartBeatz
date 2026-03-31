// ==============================================================================
// Ground Truth Evaluation Pipeline
// ==============================================================================
// ACC-08-T4: Computes confusion matrix, precision/recall/F1, and per-class
// breakdown from aligned ground truth labels vs. system predictions.
//
// This module is the core accuracy measurement tool for HeartBeatz. Without it,
// we cannot objectively validate any improvement to the person counting system.
//
// Pipeline flow:
//   1. Fetch aligned {true_count, predicted_count} pairs via alignment.js
//   2. Build NxN confusion matrix (N = number of classes: 0, 1, 2, 3+)
//   3. Compute per-class precision, recall, F1 (one-vs-rest)
//   4. Compute macro-averaged and weighted-averaged metrics
//   5. Compute overall accuracy
//   6. Persist evaluation results to the evaluations table
//
// Classes:
//   0 = empty room
//   1 = one person
//   2 = two people
//   3 = three or more people
//
// Reference:
//   Confusion matrix: rows = true class, columns = predicted class
//   Precision(c) = TP(c) / (TP(c) + FP(c))
//   Recall(c)    = TP(c) / (TP(c) + FN(c))
//   F1(c)        = 2 * P(c) * R(c) / (P(c) + R(c))
// ==============================================================================

import { getDb } from '../db/index.js';
import { getEvaluationPairs } from './alignment.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Person count classes: 0 (empty), 1, 2, 3+ */
export const CLASSES = [0, 1, 2, 3];

/** Human-readable class labels for reporting */
export const CLASS_LABELS = {
  0: 'empty',
  1: '1 person',
  2: '2 people',
  3: '3+ people',
};

// ---------------------------------------------------------------------------
// Confusion Matrix
// ---------------------------------------------------------------------------

/**
 * Build an NxN confusion matrix from aligned pairs.
 *
 * Matrix layout: matrix[trueClass][predictedClass] = count
 * Row index = true class, column index = predicted class.
 *
 * @param {Array<{ true_count: number, predicted_count: number }>} pairs
 *   Array of aligned evaluation pairs from getEvaluationPairs()
 * @returns {{ matrix: number[][], classes: number[], total: number }}
 *   - matrix: 4x4 array where matrix[i][j] = count of (true=i, pred=j)
 *   - classes: [0, 1, 2, 3]
 *   - total: total number of samples
 */
export function buildConfusionMatrix(pairs) {
  const n = CLASSES.length;
  const matrix = Array.from({ length: n }, () => Array(n).fill(0));
  let total = 0;

  for (const { true_count, predicted_count } of pairs) {
    // Round to nearest integer then clamp to valid class range [0, 3].
    // Rounding handles fractional predictions (e.g. ensemble averages).
    // Clamping maps any count ≥ 3 to class 3 ("3+ people").
    const trueIdx = Math.min(Math.max(Math.round(true_count), 0), 3);
    const predIdx = Math.min(Math.max(Math.round(predicted_count), 0), 3);
    matrix[trueIdx][predIdx]++;
    total++;
  }

  return { matrix, classes: [...CLASSES], total };
}

// ---------------------------------------------------------------------------
// Per-Class Metrics
// ---------------------------------------------------------------------------

/**
 * Compute per-class precision, recall, and F1 from a confusion matrix.
 *
 * Uses one-vs-rest decomposition: for each class c, compute:
 *   TP = matrix[c][c]
 *   FP = sum of column c (excluding diagonal) = Σ matrix[i][c] for i≠c
 *   FN = sum of row c (excluding diagonal)    = Σ matrix[c][j] for j≠c
 *
 * @param {number[][]} matrix - 4x4 confusion matrix (row=true, col=predicted)
 * @returns {Array<{ class_id: number, label: string, tp: number, fp: number,
 *   fn: number, support: number, precision: number, recall: number, f1: number }>}
 */
export function computePerClassMetrics(matrix) {
  const n = CLASSES.length;
  const results = [];

  for (let c = 0; c < n; c++) {
    const tp = matrix[c][c];

    // FP: other true classes predicted as c (column c, excluding diagonal)
    let fp = 0;
    for (let i = 0; i < n; i++) {
      if (i !== c) fp += matrix[i][c];
    }

    // FN: class c predicted as something else (row c, excluding diagonal)
    let fn = 0;
    for (let j = 0; j < n; j++) {
      if (j !== c) fn += matrix[c][j];
    }

    // Support: total true instances of this class (sum of row c)
    const support = tp + fn;

    // Precision, recall, F1 with zero-division protection
    const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
    const recall = (tp + fn) > 0 ? tp / (tp + fn) : 0;
    const f1 = (precision + recall) > 0
      ? (2 * precision * recall) / (precision + recall)
      : 0;

    results.push({
      class_id: CLASSES[c],
      label: CLASS_LABELS[CLASSES[c]],
      tp,
      fp,
      fn,
      support,
      precision: _round(precision, 4),
      recall: _round(recall, 4),
      f1: _round(f1, 4),
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Aggregated Metrics
// ---------------------------------------------------------------------------

/**
 * Compute macro-averaged and weighted-averaged precision, recall, F1.
 *
 * Macro average: unweighted mean across classes (treats each class equally).
 * Weighted average: weighted by class support (treats each sample equally).
 *
 * @param {Array<{ precision: number, recall: number, f1: number, support: number }>} perClass
 *   Per-class metrics from computePerClassMetrics()
 * @returns {{
 *   macro: { precision: number, recall: number, f1: number },
 *   weighted: { precision: number, recall: number, f1: number },
 *   accuracy: number,
 *   total_samples: number
 * }}
 */
export function computeAggregateMetrics(perClass) {
  const activeClasses = perClass.filter(c => c.support > 0);
  const totalSupport = perClass.reduce((sum, c) => sum + c.support, 0);
  const totalTp = perClass.reduce((sum, c) => sum + c.tp, 0);

  // Macro average (only classes with support > 0)
  const numActive = activeClasses.length || 1; // prevent divide-by-zero
  const macro = {
    precision: _round(activeClasses.reduce((s, c) => s + c.precision, 0) / numActive, 4),
    recall: _round(activeClasses.reduce((s, c) => s + c.recall, 0) / numActive, 4),
    f1: _round(activeClasses.reduce((s, c) => s + c.f1, 0) / numActive, 4),
  };

  // Weighted average
  const weighted = totalSupport > 0 ? {
    precision: _round(perClass.reduce((s, c) => s + c.precision * c.support, 0) / totalSupport, 4),
    recall: _round(perClass.reduce((s, c) => s + c.recall * c.support, 0) / totalSupport, 4),
    f1: _round(perClass.reduce((s, c) => s + c.f1 * c.support, 0) / totalSupport, 4),
  } : { precision: 0, recall: 0, f1: 0 };

  // Overall accuracy = correct / total
  const accuracy = totalSupport > 0 ? _round(totalTp / totalSupport, 4) : 0;

  return { macro, weighted, accuracy, total_samples: totalSupport };
}

// ---------------------------------------------------------------------------
// Error Analysis
// ---------------------------------------------------------------------------

/**
 * Compute error analysis: identify the most common misclassifications.
 *
 * Returns a sorted list of (true → predicted) error pairs, ordered by
 * frequency. Useful for understanding where the system fails most.
 *
 * @param {number[][]} matrix - 4x4 confusion matrix
 * @returns {Array<{ true_class: number, true_label: string,
 *   predicted_class: number, predicted_label: string, count: number,
 *   percentage: number }>}
 */
export function computeErrorAnalysis(matrix) {
  const errors = [];
  let totalErrors = 0;

  for (let i = 0; i < CLASSES.length; i++) {
    for (let j = 0; j < CLASSES.length; j++) {
      if (i !== j && matrix[i][j] > 0) {
        totalErrors += matrix[i][j];
        errors.push({
          true_class: CLASSES[i],
          true_label: CLASS_LABELS[CLASSES[i]],
          predicted_class: CLASSES[j],
          predicted_label: CLASS_LABELS[CLASSES[j]],
          count: matrix[i][j],
        });
      }
    }
  }

  // Add percentage and sort by count descending
  return errors
    .map(e => ({
      ...e,
      percentage: totalErrors > 0 ? _round(e.count / totalErrors, 4) : 0,
    }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Full Evaluation Pipeline
// ---------------------------------------------------------------------------

/**
 * Run the complete evaluation pipeline for a labeling session.
 *
 * This is the primary entry point. It:
 *   1. Fetches aligned pairs from the alignment module
 *   2. Builds the confusion matrix
 *   3. Computes per-class and aggregate metrics
 *   4. Computes error analysis
 *   5. Optionally persists results to the evaluations table
 *
 * @param {string} sessionId - Labeling session UUID
 * @param {Object} [options]
 * @param {string} [options.nodeId] - Restrict to a specific node
 * @param {number} [options.maxDeltaMs=100] - Max alignment delta
 * @param {string} [options.confidenceFilter] - Min confidence level
 * @param {string} [options.algorithm='threshold'] - Algorithm name for tracking
 * @param {boolean} [options.persist=false] - Save results to evaluations table
 * @param {string} [options.notes] - Optional notes for the evaluation record
 * @returns {{
 *   session_id: string,
 *   algorithm: string,
 *   timestamp: string,
 *   alignment: Object,
 *   confusion_matrix: { matrix: number[][], classes: number[], total: number },
 *   per_class: Array<Object>,
 *   aggregate: Object,
 *   error_analysis: Array<Object>,
 *   evaluation_id?: number
 * }}
 */
export function evaluateSession(sessionId, {
  nodeId,
  maxDeltaMs,
  confidenceFilter,
  algorithm = 'threshold',
  persist = false,
  notes,
} = {}) {
  // Input validation
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('sessionId is required and must be a non-empty string');
  }

  // Step 1: Get aligned pairs
  const { pairs, stats: alignmentStats } = getEvaluationPairs(sessionId, {
    nodeId,
    maxDeltaMs,
    confidenceFilter,
  });

  if (pairs.length === 0) {
    const emptyMatrix = buildConfusionMatrix([]).matrix;
    const emptyPerClass = computePerClassMetrics(emptyMatrix);
    const result = {
      session_id: sessionId,
      algorithm,
      timestamp: new Date().toISOString(),
      alignment: alignmentStats,
      confusion_matrix: { matrix: emptyMatrix, classes: [...CLASSES], total: 0 },
      per_class: emptyPerClass,
      aggregate: computeAggregateMetrics(emptyPerClass),
      error_analysis: [],
      evaluation_id: null,
    };

    if (persist) {
      result.evaluation_id = _persistEvaluation(result, notes);
    }

    return result;
  }

  // Step 2: Build confusion matrix
  const cm = buildConfusionMatrix(pairs);

  // Step 3: Per-class metrics
  const perClass = computePerClassMetrics(cm.matrix);

  // Step 4: Aggregate metrics
  const aggregate = computeAggregateMetrics(perClass);

  // Step 5: Error analysis
  const errorAnalysis = computeErrorAnalysis(cm.matrix);

  // Build result
  const result = {
    session_id: sessionId,
    algorithm,
    timestamp: new Date().toISOString(),
    alignment: alignmentStats,
    confusion_matrix: cm,
    per_class: perClass,
    aggregate,
    error_analysis: errorAnalysis,
    evaluation_id: null,
  };

  // Step 6: Persist if requested
  if (persist) {
    result.evaluation_id = _persistEvaluation(result, notes);
  }

  return result;
}

/**
 * Run evaluation across multiple sessions (e.g., for aggregate accuracy).
 *
 * Merges all aligned pairs from the specified sessions, then runs the
 * evaluation pipeline on the combined dataset. Useful for computing
 * overall system accuracy across different labeling sessions.
 *
 * @param {string[]} sessionIds - Array of session UUIDs
 * @param {Object} [options] - Same options as evaluateSession
 * @returns {Object} Same shape as evaluateSession result, with additional
 *   session_ids field
 */
export function evaluateMultipleSessions(sessionIds, {
  nodeId,
  maxDeltaMs,
  confidenceFilter,
  algorithm = 'threshold',
  persist = false,
  notes,
} = {}) {
  // Input validation
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    throw new Error('sessionIds must be a non-empty array of session ID strings');
  }
  for (const sid of sessionIds) {
    if (!sid || typeof sid !== 'string') {
      throw new Error(`Each sessionId must be a non-empty string, got: ${sid}`);
    }
  }

  const allPairs = [];
  const sessionAlignmentStats = [];

  for (const sid of sessionIds) {
    const { pairs, stats } = getEvaluationPairs(sid, {
      nodeId,
      maxDeltaMs,
      confidenceFilter,
    });
    allPairs.push(...pairs);
    sessionAlignmentStats.push({ session_id: sid, ...stats });
  }

  if (allPairs.length === 0) {
    const emptyMatrix = buildConfusionMatrix([]).matrix;
    const emptyPerClass = computePerClassMetrics(emptyMatrix);
    const result = {
      session_ids: sessionIds,
      algorithm,
      timestamp: new Date().toISOString(),
      alignment: { sessions: sessionAlignmentStats, total_pairs: 0 },
      confusion_matrix: { matrix: emptyMatrix, classes: [...CLASSES], total: 0 },
      per_class: emptyPerClass,
      aggregate: computeAggregateMetrics(emptyPerClass),
      error_analysis: [],
      evaluation_id: null,
    };

    if (persist) {
      result.evaluation_id = _persistEvaluation(result, notes);
    }

    return result;
  }

  const cm = buildConfusionMatrix(allPairs);
  const perClass = computePerClassMetrics(cm.matrix);
  const aggregate = computeAggregateMetrics(perClass);
  const errorAnalysis = computeErrorAnalysis(cm.matrix);

  const result = {
    session_ids: sessionIds,
    algorithm,
    timestamp: new Date().toISOString(),
    alignment: {
      sessions: sessionAlignmentStats,
      total_pairs: allPairs.length,
    },
    confusion_matrix: cm,
    per_class: perClass,
    aggregate,
    error_analysis: errorAnalysis,
    evaluation_id: null,
  };

  if (persist) {
    result.evaluation_id = _persistEvaluation(result, notes);
  }

  return result;
}

/**
 * Get historical evaluation results from the database.
 *
 * @param {Object} [options]
 * @param {string} [options.sessionId] - Filter by session
 * @param {string} [options.algorithm] - Filter by algorithm
 * @param {number} [options.limit=20] - Max results
 * @returns {Array<Object>} Evaluation records with parsed confusion_json
 */
export function getEvaluationHistory({ sessionId, algorithm, limit = 20 } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM evaluations WHERE 1=1';
  const params = [];

  if (sessionId) {
    sql += ' AND session_id = ?';
    params.push(sessionId);
  }
  if (algorithm) {
    sql += ' AND algorithm = ?';
    params.push(algorithm);
  }

  sql += ' ORDER BY timestamp DESC, id DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params);

  // Parse confusion_json back into objects
  return rows.map(row => ({
    ...row,
    confusion_json: row.confusion_json ? JSON.parse(row.confusion_json) : null,
  }));
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Persist evaluation results to the evaluations table.
 *
 * @param {Object} result - Full evaluation result object
 * @param {string} [notes] - Optional notes
 * @returns {number} Inserted evaluation ID
 * @private
 */
function _persistEvaluation(result, notes) {
  const db = getDb();

  const confusionData = {
    matrix: result.confusion_matrix.matrix,
    per_class: result.per_class,
    error_analysis: result.error_analysis,
  };

  const stmt = db.prepare(`
    INSERT INTO evaluations
      (session_id, algorithm, total_samples, accuracy, precision_avg, recall_avg, f1_avg, confusion_json, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const info = stmt.run(
    result.session_id || (result.session_ids ? JSON.stringify(result.session_ids) : null),
    result.algorithm,
    result.aggregate.total_samples,
    result.aggregate.accuracy,
    result.aggregate.macro.precision,
    result.aggregate.macro.recall,
    result.aggregate.macro.f1,
    JSON.stringify(confusionData),
    notes || null,
  );

  return Number(info.lastInsertRowid);
}

/**
 * Round a number to a specified number of decimal places.
 *
 * @param {number} value
 * @param {number} decimals
 * @returns {number}
 * @private
 */
function _round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export default {
  CLASSES,
  CLASS_LABELS,
  buildConfusionMatrix,
  computePerClassMetrics,
  computeAggregateMetrics,
  computeErrorAnalysis,
  evaluateSession,
  evaluateMultipleSessions,
  getEvaluationHistory,
};
