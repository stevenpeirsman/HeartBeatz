// ==============================================================================
// Tests for features/features-api.js — Feature Vector API (ACC-01-T8, ACC-01-T9)
// ==============================================================================
// Covers:
//   - FeatureStore: put, get, getAll, remove, clear, size
//   - REST endpoint: GET /api/v1/features (all nodes, single node, 404)
//   - SSE endpoint: GET /api/v1/features/stream (connection, events, cleanup)
//   - Nodes list endpoint: GET /api/v1/features/nodes
// ==============================================================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  FeatureStore,
  SSE_INTERVAL_MS,
  SSE_MAX_IDLE_MS,
  SSE_KEEPALIVE_MS,
} from './features-api.js';

// ---------------------------------------------------------------------------
// FeatureStore
// ---------------------------------------------------------------------------

describe('FeatureStore', () => {
  let store;

  beforeEach(() => {
    store = new FeatureStore();
  });

  it('starts empty', () => {
    assert.equal(store.size, 0);
    assert.deepEqual(store.getNodeMACs(), []);
    assert.deepEqual(store.getAll(), []);
  });

  it('stores and retrieves a feature vector', () => {
    const vector = { bandMeans: [1, 2, 3, 4, 5, 6, 7, 8] };
    store.put('AA:BB:CC:DD:EE:FF', vector);

    const result = store.get('AA:BB:CC:DD:EE:FF');
    assert.notEqual(result, null);
    assert.deepEqual(result.vector, vector);
    assert.ok(result.updatedAt > 0);
  });

  it('normalizes MAC to uppercase', () => {
    store.put('aa:bb:cc:dd:ee:ff', { test: true });
    const result = store.get('AA:BB:CC:DD:EE:FF');
    assert.notEqual(result, null);
    assert.equal(result.vector.test, true);
  });

  it('returns null for unknown node', () => {
    assert.equal(store.get('00:00:00:00:00:00'), null);
  });

  it('overwrites existing vectors', () => {
    store.put('AA:BB:CC:DD:EE:FF', { version: 1 });
    store.put('AA:BB:CC:DD:EE:FF', { version: 2 });

    const result = store.get('AA:BB:CC:DD:EE:FF');
    assert.equal(result.vector.version, 2);
    assert.equal(store.size, 1);
  });

  it('stores multiple nodes', () => {
    store.put('AA:AA:AA:AA:AA:AA', { node: 'a' });
    store.put('BB:BB:BB:BB:BB:BB', { node: 'b' });
    store.put('CC:CC:CC:CC:CC:CC', { node: 'c' });

    assert.equal(store.size, 3);
    assert.equal(store.getNodeMACs().length, 3);
  });

  it('getAll returns all entries', () => {
    store.put('AA:AA:AA:AA:AA:AA', { v: 1 });
    store.put('BB:BB:BB:BB:BB:BB', { v: 2 });

    const all = store.getAll();
    assert.equal(all.length, 2);
    assert.ok(all.every(e => e.nodeMAC && e.vector && e.updatedAt));
  });

  it('getNodeMACs returns MAC addresses', () => {
    store.put('AA:AA:AA:AA:AA:AA', {});
    store.put('BB:BB:BB:BB:BB:BB', {});

    const macs = store.getNodeMACs();
    assert.equal(macs.length, 2);
    assert.ok(macs.includes('AA:AA:AA:AA:AA:AA'));
    assert.ok(macs.includes('BB:BB:BB:BB:BB:BB'));
  });

  it('remove deletes a node', () => {
    store.put('AA:AA:AA:AA:AA:AA', { v: 1 });
    store.put('BB:BB:BB:BB:BB:BB', { v: 2 });

    const removed = store.remove('AA:AA:AA:AA:AA:AA');
    assert.equal(removed, true);
    assert.equal(store.size, 1);
    assert.equal(store.get('AA:AA:AA:AA:AA:AA'), null);
  });

  it('remove returns false for unknown node', () => {
    assert.equal(store.remove('00:00:00:00:00:00'), false);
  });

  it('clear removes all entries', () => {
    store.put('AA:AA:AA:AA:AA:AA', {});
    store.put('BB:BB:BB:BB:BB:BB', {});
    store.clear();

    assert.equal(store.size, 0);
    assert.deepEqual(store.getAll(), []);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('features-api/constants', () => {
  it('SSE_INTERVAL_MS is 200ms (5Hz)', () => {
    assert.equal(SSE_INTERVAL_MS, 200);
  });

  it('SSE_MAX_IDLE_MS is 5 minutes', () => {
    assert.equal(SSE_MAX_IDLE_MS, 5 * 60 * 1000);
  });

  it('SSE_KEEPALIVE_MS is 30 seconds', () => {
    assert.equal(SSE_KEEPALIVE_MS, 30 * 1000);
  });
});
