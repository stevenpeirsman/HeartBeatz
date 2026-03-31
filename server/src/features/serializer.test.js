// ==============================================================================
// Tests for features/serializer.js — Feature Vector Serializer (ACC-01-T7)
// ==============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvePath,
  formatValue,
  serializeToJSON,
  deserializeFromJSON,
  csvHeader,
  serializeToCSVRow,
  serializeToCSV,
  parseCSVRow,
  getColumnCount,
  getColumnNames,
  CSV_COLUMNS,
  PRECISION_STANDARD,
  PRECISION_HIGH,
} from './serializer.js';
import { NUM_BANDS } from '../shared/constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a sample feature vector with all fields populated. */
function makeSampleFeatureVector() {
  return {
    timestamp: 1711900800000,
    nodeMAC: 'AA:BB:CC:DD:EE:FF',
    bandMeans: [10.1234, 11.2345, 12.3456, 13.4567, 14.5678, 15.6789, 16.7890, 17.8901],
    bandVariances: [1.1, 2.2, 3.3, 4.4, 5.5, 6.6, 7.7, 8.8],
    overallMean: 13.5,
    overallVariance: 5.5,
    interBandVariance: 2.3,
    phaseSlope: 0.001234,
    phaseIntercept: -0.005678,
    phaseResidualStd: 0.123456,
    dopplerPeak: 1.25,
    dopplerEnergy: 42.5,
    motionClass: 'WALKING',
    motionLevel: 0.75,
    bandStats: Array.from({ length: NUM_BANDS }, (_, b) => ({
      skewness: 0.1 * b,
      kurtosis: 0.2 * b,
      iqr: 1.0 + b * 0.5,
      entropy: 0.5 + b * 0.05,
    })),
    eigenvalueSpread: 15.3,
    meanCorrelation: 0.65,
    maxCorrelation: 0.92,
    adjacentCorrelation: 0.78,
    csiQuality: 0.95,
  };
}

// ---------------------------------------------------------------------------
// resolvePath()
// ---------------------------------------------------------------------------

describe('serializer: resolvePath()', () => {
  it('resolves simple property', () => {
    assert.equal(resolvePath({ x: 42 }, 'x'), 42);
  });

  it('resolves nested path', () => {
    assert.equal(resolvePath({ a: { b: { c: 99 } } }, 'a.b.c'), 99);
  });

  it('resolves array index', () => {
    assert.equal(resolvePath({ arr: [10, 20, 30] }, 'arr.1'), 20);
  });

  it('returns undefined for missing path', () => {
    assert.equal(resolvePath({ x: 1 }, 'y'), undefined);
  });

  it('returns undefined for null input', () => {
    assert.equal(resolvePath(null, 'x'), undefined);
  });
});

// ---------------------------------------------------------------------------
// formatValue()
// ---------------------------------------------------------------------------

describe('serializer: formatValue()', () => {
  it('returns empty string for undefined', () => {
    assert.equal(formatValue(undefined, 4), '');
  });

  it('returns empty string for null', () => {
    assert.equal(formatValue(null, 4), '');
  });

  it('returns string for precision -1', () => {
    assert.equal(formatValue('hello', -1), 'hello');
  });

  it('rounds to zero precision', () => {
    assert.equal(formatValue(42.7, 0), '43');
  });

  it('formats to specified precision', () => {
    assert.equal(formatValue(3.14159, 4), '3.1416');
  });

  it('returns empty for NaN', () => {
    assert.equal(formatValue(NaN, 4), '');
  });
});

// ---------------------------------------------------------------------------
// JSON serialization
// ---------------------------------------------------------------------------

describe('serializer: serializeToJSON()', () => {
  it('returns {} for null input', () => {
    assert.equal(serializeToJSON(null), '{}');
  });

  it('serializes a full feature vector', () => {
    const fv = makeSampleFeatureVector();
    const json = serializeToJSON(fv);
    const parsed = JSON.parse(json);

    assert.equal(parsed.timestamp, 1711900800000);
    assert.equal(parsed.node_mac, 'AA:BB:CC:DD:EE:FF');
    assert.ok(typeof parsed.band_0_mean === 'number');
    assert.ok(typeof parsed.overall_mean === 'number');
    assert.ok(typeof parsed.quality_score === 'number');
  });

  it('rounds values to reduce bandwidth', () => {
    const fv = makeSampleFeatureVector();
    const json = serializeToJSON(fv);
    const parsed = JSON.parse(json);

    // Standard precision = 4 decimal places
    const band0Mean = parsed.band_0_mean;
    const decimalPlaces = band0Mean.toString().split('.')[1]?.length || 0;
    assert.ok(decimalPlaces <= PRECISION_STANDARD,
      `Expected <= ${PRECISION_STANDARD} decimal places, got ${decimalPlaces}`);
  });

  it('omits null/undefined values', () => {
    const fv = { timestamp: 123, nodeMAC: 'test' };
    const json = serializeToJSON(fv);
    const parsed = JSON.parse(json);

    assert.equal(parsed.timestamp, 123);
    assert.equal(parsed.node_mac, 'test');
    // Missing fields should not appear
    assert.equal(parsed.band_0_mean, undefined);
  });
});

describe('serializer: deserializeFromJSON()', () => {
  it('round-trips a feature vector', () => {
    const fv = makeSampleFeatureVector();
    const json = serializeToJSON(fv);
    const parsed = deserializeFromJSON(json);
    assert.equal(parsed.node_mac, 'AA:BB:CC:DD:EE:FF');
    assert.ok(typeof parsed.band_0_mean === 'number');
  });

  it('returns empty object for invalid JSON', () => {
    const result = deserializeFromJSON('not json');
    assert.deepEqual(result, {});
  });
});

// ---------------------------------------------------------------------------
// CSV serialization
// ---------------------------------------------------------------------------

describe('serializer: csvHeader()', () => {
  it('returns comma-separated column names', () => {
    const header = csvHeader();
    const cols = header.split(',');
    assert.ok(cols.length > 10, `Expected many columns, got ${cols.length}`);
    assert.equal(cols[0], 'timestamp');
    assert.equal(cols[1], 'node_mac');
  });

  it('matches CSV_COLUMNS length', () => {
    const cols = csvHeader().split(',');
    assert.equal(cols.length, CSV_COLUMNS.length);
  });
});

describe('serializer: serializeToCSVRow()', () => {
  it('returns empty values for null input', () => {
    const row = serializeToCSVRow(null);
    const values = row.split(',');
    assert.equal(values.length, CSV_COLUMNS.length);
    assert.ok(values.every(v => v === ''));
  });

  it('serializes a full feature vector', () => {
    const fv = makeSampleFeatureVector();
    const row = serializeToCSVRow(fv);
    const values = row.split(',');
    assert.equal(values.length, CSV_COLUMNS.length);
    assert.equal(values[0], '1711900800000'); // timestamp
    assert.equal(values[1], 'AA:BB:CC:DD:EE:FF'); // node_mac
    assert.ok(values[2] !== ''); // band_0_mean should have a value
  });
});

describe('serializer: serializeToCSV()', () => {
  it('returns header only for empty input', () => {
    const csv = serializeToCSV([]);
    assert.equal(csv, csvHeader());
  });

  it('returns header only for null input', () => {
    const csv = serializeToCSV(null);
    assert.equal(csv, csvHeader());
  });

  it('serializes multiple feature vectors', () => {
    const vectors = [makeSampleFeatureVector(), makeSampleFeatureVector()];
    vectors[1].timestamp = 1711900800100;
    const csv = serializeToCSV(vectors);
    const lines = csv.split('\n');
    assert.equal(lines.length, 3); // header + 2 data rows
    assert.equal(lines[0], csvHeader());
  });
});

describe('serializer: parseCSVRow()', () => {
  it('round-trips a feature vector through CSV', () => {
    const fv = makeSampleFeatureVector();
    const row = serializeToCSVRow(fv);
    const parsed = parseCSVRow(row);

    assert.equal(parsed.timestamp, 1711900800000);
    assert.equal(parsed.node_mac, 'AA:BB:CC:DD:EE:FF');
    assert.ok(typeof parsed.band_0_mean === 'number');
    assert.ok(Math.abs(parsed.band_0_mean - 10.1234) < 0.001);
  });

  it('handles empty values', () => {
    const row = CSV_COLUMNS.map(() => '').join(',');
    const parsed = parseCSVRow(row);
    assert.deepEqual(parsed, {});
  });
});

// ---------------------------------------------------------------------------
// Column utilities
// ---------------------------------------------------------------------------

describe('serializer: column utilities', () => {
  it('getColumnCount returns positive number', () => {
    assert.ok(getColumnCount() > 0);
    assert.equal(getColumnCount(), CSV_COLUMNS.length);
  });

  it('getColumnNames returns array of strings', () => {
    const names = getColumnNames();
    assert.ok(Array.isArray(names));
    assert.ok(names.length > 0);
    assert.ok(names.every(n => typeof n === 'string'));
  });

  it('column names are unique', () => {
    const names = getColumnNames();
    const unique = new Set(names);
    assert.equal(names.length, unique.size, 'Column names must be unique');
  });

  it('includes expected metadata columns', () => {
    const names = getColumnNames();
    assert.ok(names.includes('timestamp'));
    assert.ok(names.includes('node_mac'));
  });

  it('includes band columns for all 8 bands', () => {
    const names = getColumnNames();
    for (let b = 0; b < NUM_BANDS; b++) {
      assert.ok(names.includes(`band_${b}_mean`), `Missing band_${b}_mean`);
      assert.ok(names.includes(`band_${b}_variance`), `Missing band_${b}_variance`);
    }
  });

  it('includes quality score column', () => {
    const names = getColumnNames();
    assert.ok(names.includes('quality_score'));
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('serializer: exported constants', () => {
  it('PRECISION_STANDARD is positive', () => {
    assert.ok(PRECISION_STANDARD > 0);
  });

  it('PRECISION_HIGH is greater than PRECISION_STANDARD', () => {
    assert.ok(PRECISION_HIGH > PRECISION_STANDARD);
  });

  it('CSV_COLUMNS is frozen', () => {
    assert.ok(Object.isFrozen(CSV_COLUMNS));
  });
});
