// ==============================================================================
// Feature Vector Serializer (ACC-01-T7)
// ==============================================================================
// Serializes unified feature vectors for two primary consumers:
//
//   1. JSON (for SSE streaming) — Compact JSON format optimized for real-time
//      browser consumption. Sent as SSE data events at 5Hz per node.
//
//   2. CSV (for ML training export) — Flat tabular format with header row,
//      one row per frame. Used to build labeled datasets for classifier training.
//
// Design decisions:
//   - Numeric precision: 4 decimal places for amplitudes/phases, 6 for small values
//   - Array flattening: Band arrays are prefixed (e.g., band_0_mean, band_1_mean)
//   - Timestamps: ISO 8601 in CSV, epoch ms in JSON (for SSE performance)
//   - Column ordering: metadata → amplitude → phase → doppler → stats → correlation → quality
//
// All functions are pure — no I/O, no state.
// ==============================================================================

import { NUM_BANDS } from '../shared/constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Decimal precision for amplitude/phase values in CSV/JSON. */
export const PRECISION_STANDARD = 4;

/** Decimal precision for small values (eigenvalues, entropy, etc.). */
export const PRECISION_HIGH = 6;

/**
 * CSV column definitions in canonical order.
 * Each entry has: { name, source (dot-path into FeatureVector), precision }.
 * @type {ReadonlyArray<{name: string, source: string, precision: number}>}
 */
export const CSV_COLUMNS = Object.freeze(buildColumnDefinitions());

// ---------------------------------------------------------------------------
// Column Definitions Builder
// ---------------------------------------------------------------------------

/**
 * Build the canonical column definitions for CSV export.
 * Defines the exact layout of the feature vector in tabular form.
 *
 * @returns {Array<{name: string, source: string, precision: number}>}
 */
function buildColumnDefinitions() {
  const cols = [];

  // Metadata
  cols.push({ name: 'timestamp', source: 'timestamp', precision: 0 });
  cols.push({ name: 'node_mac', source: 'nodeMAC', precision: -1 }); // -1 = string

  // Amplitude band features
  for (let b = 0; b < NUM_BANDS; b++) {
    cols.push({ name: `band_${b}_mean`, source: `bandMeans.${b}`, precision: PRECISION_STANDARD });
    cols.push({ name: `band_${b}_variance`, source: `bandVariances.${b}`, precision: PRECISION_STANDARD });
  }
  cols.push({ name: 'overall_mean', source: 'overallMean', precision: PRECISION_STANDARD });
  cols.push({ name: 'overall_variance', source: 'overallVariance', precision: PRECISION_STANDARD });
  cols.push({ name: 'inter_band_variance', source: 'interBandVariance', precision: PRECISION_STANDARD });

  // Phase features
  cols.push({ name: 'phase_slope', source: 'phaseSlope', precision: PRECISION_HIGH });
  cols.push({ name: 'phase_intercept', source: 'phaseIntercept', precision: PRECISION_HIGH });
  cols.push({ name: 'phase_residual_std', source: 'phaseResidualStd', precision: PRECISION_HIGH });

  // Doppler features
  cols.push({ name: 'doppler_peak_hz', source: 'dopplerPeak', precision: PRECISION_STANDARD });
  cols.push({ name: 'doppler_energy', source: 'dopplerEnergy', precision: PRECISION_STANDARD });
  cols.push({ name: 'motion_class', source: 'motionClass', precision: -1 }); // string
  cols.push({ name: 'motion_level', source: 'motionLevel', precision: PRECISION_STANDARD });

  // Statistical features (per band)
  for (let b = 0; b < NUM_BANDS; b++) {
    cols.push({ name: `band_${b}_skewness`, source: `bandStats.${b}.skewness`, precision: PRECISION_STANDARD });
    cols.push({ name: `band_${b}_kurtosis`, source: `bandStats.${b}.kurtosis`, precision: PRECISION_STANDARD });
    cols.push({ name: `band_${b}_iqr`, source: `bandStats.${b}.iqr`, precision: PRECISION_STANDARD });
    cols.push({ name: `band_${b}_entropy`, source: `bandStats.${b}.entropy`, precision: PRECISION_HIGH });
  }

  // Correlation features
  cols.push({ name: 'eigenvalue_spread', source: 'eigenvalueSpread', precision: PRECISION_STANDARD });
  cols.push({ name: 'mean_correlation', source: 'meanCorrelation', precision: PRECISION_STANDARD });
  cols.push({ name: 'max_correlation', source: 'maxCorrelation', precision: PRECISION_STANDARD });
  cols.push({ name: 'adjacent_correlation', source: 'adjacentCorrelation', precision: PRECISION_STANDARD });

  // Quality score
  cols.push({ name: 'quality_score', source: 'csiQuality', precision: PRECISION_STANDARD });

  return cols;
}

// ---------------------------------------------------------------------------
// Pure Functions — Value Extraction
// ---------------------------------------------------------------------------

/**
 * Resolve a dot-path (e.g., 'bandMeans.0') to a value in an object.
 *
 * @param {Object} obj - Source object
 * @param {string} path - Dot-separated path
 * @returns {*} Resolved value, or undefined if path doesn't exist
 */
export function resolvePath(obj, path) {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Format a numeric value to the specified precision.
 * Returns the string directly for non-numeric or string-precision values.
 *
 * @param {*} value - Value to format
 * @param {number} precision - Decimal places (-1 for string pass-through)
 * @returns {string} Formatted value
 */
export function formatValue(value, precision) {
  if (value === undefined || value === null) return '';
  if (precision === -1) return String(value); // String field
  if (typeof value !== 'number' || isNaN(value)) return '';
  if (precision === 0) return Math.round(value).toString();
  return value.toFixed(precision);
}

// ---------------------------------------------------------------------------
// Pure Functions — JSON Serialization (for SSE)
// ---------------------------------------------------------------------------

/**
 * Serialize a feature vector to a compact JSON string for SSE streaming.
 *
 * Strips undefined/null fields and rounds numeric values to reduce bandwidth.
 * Optimized for browser consumption: uses epoch ms timestamps, flat structure.
 *
 * @param {Object} featureVector - Feature vector object
 * @returns {string} JSON string
 */
export function serializeToJSON(featureVector) {
  if (!featureVector) return '{}';

  const compact = {};

  for (const col of CSV_COLUMNS) {
    const value = resolvePath(featureVector, col.source);
    if (value === undefined || value === null) continue;

    if (col.precision === -1) {
      compact[col.name] = value;
    } else if (typeof value === 'number' && !isNaN(value)) {
      // Round to precision for bandwidth savings
      const factor = Math.pow(10, col.precision);
      compact[col.name] = Math.round(value * factor) / factor;
    }
  }

  return JSON.stringify(compact);
}

/**
 * Parse a JSON-serialized feature vector back into an object.
 *
 * @param {string} json - JSON string from serializeToJSON
 * @returns {Object} Parsed feature vector (flat key-value pairs)
 */
export function deserializeFromJSON(json) {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Pure Functions — CSV Serialization (for ML training)
// ---------------------------------------------------------------------------

/**
 * Generate the CSV header row.
 *
 * @returns {string} Comma-separated column names
 */
export function csvHeader() {
  return CSV_COLUMNS.map(c => c.name).join(',');
}

/**
 * Serialize a single feature vector to a CSV data row.
 *
 * @param {Object} featureVector - Feature vector object
 * @returns {string} Comma-separated values matching csvHeader() column order
 */
export function serializeToCSVRow(featureVector) {
  if (!featureVector) return CSV_COLUMNS.map(() => '').join(',');

  const values = CSV_COLUMNS.map(col => {
    const value = resolvePath(featureVector, col.source);
    return formatValue(value, col.precision);
  });

  return values.join(',');
}

/**
 * Serialize multiple feature vectors to a complete CSV string (header + rows).
 *
 * @param {Object[]} featureVectors - Array of feature vectors
 * @returns {string} Complete CSV content with header and data rows
 */
export function serializeToCSV(featureVectors) {
  if (!featureVectors || featureVectors.length === 0) {
    return csvHeader();
  }

  const lines = [csvHeader()];
  for (const fv of featureVectors) {
    lines.push(serializeToCSVRow(fv));
  }
  return lines.join('\n');
}

/**
 * Parse a CSV row back into a key-value object using the column definitions.
 *
 * @param {string} row - Comma-separated value string
 * @returns {Object} Parsed key-value pairs
 */
export function parseCSVRow(row) {
  const values = row.split(',');
  const result = {};

  for (let i = 0; i < CSV_COLUMNS.length && i < values.length; i++) {
    const col = CSV_COLUMNS[i];
    const raw = values[i].trim();

    if (raw === '') continue;

    if (col.precision === -1) {
      result[col.name] = raw;
    } else {
      const num = parseFloat(raw);
      if (!isNaN(num)) {
        result[col.name] = num;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Feature Vector Column Count
// ---------------------------------------------------------------------------

/**
 * Get the total number of columns in the serialized feature vector.
 *
 * @returns {number} Column count
 */
export function getColumnCount() {
  return CSV_COLUMNS.length;
}

/**
 * Get column names as an array.
 *
 * @returns {string[]} Column names in order
 */
export function getColumnNames() {
  return CSV_COLUMNS.map(c => c.name);
}
