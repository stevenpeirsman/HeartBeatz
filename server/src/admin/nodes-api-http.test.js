// ==============================================================================
// Tests: Node Admin HTTP API Integration Tests (ADMIN-03)
// ==============================================================================
// Tests the /api/v1/nodes endpoints via the Express router using
// http.createServer to validate the full request/response cycle.
//
// Verifies: CRUD operations, validation, error handling, duplicate detection,
// and consistency of the {ok, data/error} response format.
// ==============================================================================

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { initDatabase, getDb, closeDatabase, _resetDbSingleton } from '../db/index.js';
import { createNodesRouter } from './nodes-api.js';

const mockLogger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
  child: () => mockLogger,
};

/**
 * Helper: create a test Express app with the nodes router mounted.
 * @returns {express.Application} Express app for testing
 */
function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/nodes', createNodesRouter({ logger: mockLogger }));
  return app;
}

/**
 * Helper: make an HTTP request to the test server.
 * @param {http.Server} server - Test server
 * @param {string} method - HTTP method
 * @param {string} path - Request path
 * @param {Object} [body] - JSON body
 * @returns {Promise<{status: number, body: Object}>}
 */
function request(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const options = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('Node Admin HTTP API', () => {
  let app, server;

  beforeEach(async () => {
    _resetDbSingleton();
    initDatabase({ logger: mockLogger, inMemory: true });
    app = createTestApp();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    _resetDbSingleton();
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/nodes — List nodes
  // -------------------------------------------------------------------------

  it('GET /api/v1/nodes should return empty list initially', async () => {
    const res = await request(server, 'GET', '/api/v1/nodes');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(Array.isArray(res.body.data));
    assert.equal(res.body.data.length, 0);
  });

  it('GET /api/v1/nodes should list registered nodes', async () => {
    // Seed two nodes directly in DB
    const db = getDb();
    db.prepare("INSERT INTO nodes (id, mac, name) VALUES ('n1', 'aa:bb:cc:dd:ee:01', 'Alpha')").run();
    db.prepare("INSERT INTO nodes (id, mac, name) VALUES ('n2', 'aa:bb:cc:dd:ee:02', 'Beta')").run();

    const res = await request(server, 'GET', '/api/v1/nodes');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 2);
    // Ordered by name ASC
    assert.equal(res.body.data[0].name, 'Alpha');
    assert.equal(res.body.data[1].name, 'Beta');
  });

  it('GET /api/v1/nodes?status=online should filter by status', async () => {
    const db = getDb();
    db.prepare("INSERT INTO nodes (id, mac, name, status) VALUES ('n1', 'aa:bb:cc:dd:ee:01', 'Online', 'online')").run();
    db.prepare("INSERT INTO nodes (id, mac, name, status) VALUES ('n2', 'aa:bb:cc:dd:ee:02', 'Offline', 'offline')").run();

    const res = await request(server, 'GET', '/api/v1/nodes?status=online');
    assert.equal(res.body.data.length, 1);
    assert.equal(res.body.data[0].name, 'Online');
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/nodes/:id — Get single node
  // -------------------------------------------------------------------------

  it('GET /api/v1/nodes/:id should return a specific node', async () => {
    const db = getDb();
    db.prepare("INSERT INTO nodes (id, mac, name) VALUES ('n1', 'aa:bb:cc:dd:ee:01', 'Alpha')").run();

    const res = await request(server, 'GET', '/api/v1/nodes/n1');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.name, 'Alpha');
    assert.equal(res.body.data.mac, 'aa:bb:cc:dd:ee:01');
  });

  it('GET /api/v1/nodes/:id should 404 for non-existent node', async () => {
    const res = await request(server, 'GET', '/api/v1/nodes/nonexistent');
    assert.equal(res.status, 404);
    assert.equal(res.body.ok, false);
    assert.ok(res.body.error.includes('not found'));
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/nodes — Create node
  // -------------------------------------------------------------------------

  it('POST /api/v1/nodes should create a new node', async () => {
    const res = await request(server, 'POST', '/api/v1/nodes', {
      mac: 'aa:bb:cc:dd:ee:01',
      name: 'Test Node',
      ip: '192.168.1.50',
      type: 'esp32-s3',
      firmware_ver: '1.0.0',
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.name, 'Test Node');
    assert.equal(res.body.data.mac, 'aa:bb:cc:dd:ee:01');
    assert.equal(res.body.data.ip, '192.168.1.50');
    assert.ok(res.body.data.id); // UUID generated
  });

  it('POST /api/v1/nodes should normalize MAC to lowercase', async () => {
    const res = await request(server, 'POST', '/api/v1/nodes', {
      mac: 'AA:BB:CC:DD:EE:01',
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.data.mac, 'aa:bb:cc:dd:ee:01');
  });

  it('POST /api/v1/nodes should reject missing MAC', async () => {
    const res = await request(server, 'POST', '/api/v1/nodes', {
      name: 'No MAC Node',
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.ok(res.body.error.includes('mac'));
  });

  it('POST /api/v1/nodes should reject invalid MAC format', async () => {
    const res = await request(server, 'POST', '/api/v1/nodes', {
      mac: 'not-a-mac',
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.ok(res.body.error.includes('Invalid MAC'));
  });

  it('POST /api/v1/nodes should reject duplicate MAC with 409', async () => {
    await request(server, 'POST', '/api/v1/nodes', { mac: 'aa:bb:cc:dd:ee:01' });
    const res = await request(server, 'POST', '/api/v1/nodes', { mac: 'aa:bb:cc:dd:ee:01' });

    assert.equal(res.status, 409);
    assert.equal(res.body.ok, false);
    assert.ok(res.body.error.includes('already registered'));
  });

  it('POST /api/v1/nodes should assign default name and type', async () => {
    const res = await request(server, 'POST', '/api/v1/nodes', { mac: 'aa:bb:cc:dd:ee:01' });

    assert.equal(res.status, 201);
    assert.equal(res.body.data.name, 'Unnamed Node');
    assert.equal(res.body.data.type, 'esp32-s3');
    assert.equal(res.body.data.status, 'offline');
  });

  it('POST /api/v1/nodes should store position coordinates', async () => {
    const res = await request(server, 'POST', '/api/v1/nodes', {
      mac: 'aa:bb:cc:dd:ee:01',
      position_x: 0.25,
      position_y: 0.75,
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.data.position_x, 0.25);
    assert.equal(res.body.data.position_y, 0.75);
  });

  // -------------------------------------------------------------------------
  // PUT /api/v1/nodes/:id — Update node
  // -------------------------------------------------------------------------

  it('PUT /api/v1/nodes/:id should update node name', async () => {
    const createRes = await request(server, 'POST', '/api/v1/nodes', {
      mac: 'aa:bb:cc:dd:ee:01',
      name: 'Old Name',
    });
    const id = createRes.body.data.id;

    const res = await request(server, 'PUT', `/api/v1/nodes/${id}`, {
      name: 'New Name',
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.name, 'New Name');
  });

  it('PUT /api/v1/nodes/:id should update multiple fields', async () => {
    const createRes = await request(server, 'POST', '/api/v1/nodes', {
      mac: 'aa:bb:cc:dd:ee:01',
    });
    const id = createRes.body.data.id;

    const res = await request(server, 'PUT', `/api/v1/nodes/${id}`, {
      name: 'Updated',
      status: 'online',
      firmware_ver: '2.0.0',
      ip: '10.0.0.5',
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.name, 'Updated');
    assert.equal(res.body.data.status, 'online');
    assert.equal(res.body.data.firmware_ver, '2.0.0');
    assert.equal(res.body.data.ip, '10.0.0.5');
  });

  it('PUT /api/v1/nodes/:id should 404 for non-existent node', async () => {
    const res = await request(server, 'PUT', '/api/v1/nodes/nonexistent', {
      name: 'Ghost',
    });

    assert.equal(res.status, 404);
    assert.equal(res.body.ok, false);
  });

  it('PUT /api/v1/nodes/:id should 400 with no valid fields', async () => {
    const createRes = await request(server, 'POST', '/api/v1/nodes', {
      mac: 'aa:bb:cc:dd:ee:01',
    });
    const id = createRes.body.data.id;

    const res = await request(server, 'PUT', `/api/v1/nodes/${id}`, {
      invalid_field: 'test',
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.ok(res.body.error.includes('No valid fields'));
  });

  // -------------------------------------------------------------------------
  // DELETE /api/v1/nodes/:id — Delete node
  // -------------------------------------------------------------------------

  it('DELETE /api/v1/nodes/:id should delete an existing node', async () => {
    const createRes = await request(server, 'POST', '/api/v1/nodes', {
      mac: 'aa:bb:cc:dd:ee:01',
    });
    const id = createRes.body.data.id;

    const res = await request(server, 'DELETE', `/api/v1/nodes/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    // Verify it's gone
    const getRes = await request(server, 'GET', `/api/v1/nodes/${id}`);
    assert.equal(getRes.status, 404);
  });

  it('DELETE /api/v1/nodes/:id should 404 for non-existent node', async () => {
    const res = await request(server, 'DELETE', '/api/v1/nodes/nonexistent');
    assert.equal(res.status, 404);
    assert.equal(res.body.ok, false);
  });

  // -------------------------------------------------------------------------
  // Full lifecycle test
  // -------------------------------------------------------------------------

  it('should support full CRUD lifecycle', async () => {
    // Create
    const createRes = await request(server, 'POST', '/api/v1/nodes', {
      mac: 'ff:ee:dd:cc:bb:aa',
      name: 'Lifecycle Node',
      type: 'esp32-s3',
    });
    assert.equal(createRes.status, 201);
    const id = createRes.body.data.id;

    // Read
    const getRes = await request(server, 'GET', `/api/v1/nodes/${id}`);
    assert.equal(getRes.body.data.name, 'Lifecycle Node');

    // Update
    const updateRes = await request(server, 'PUT', `/api/v1/nodes/${id}`, {
      name: 'Renamed Node',
      status: 'online',
    });
    assert.equal(updateRes.body.data.name, 'Renamed Node');
    assert.equal(updateRes.body.data.status, 'online');

    // List (should include updated node)
    const listRes = await request(server, 'GET', '/api/v1/nodes');
    assert.equal(listRes.body.data.length, 1);
    assert.equal(listRes.body.data[0].name, 'Renamed Node');

    // Delete
    const deleteRes = await request(server, 'DELETE', `/api/v1/nodes/${id}`);
    assert.equal(deleteRes.status, 200);

    // Verify deleted
    const finalList = await request(server, 'GET', '/api/v1/nodes');
    assert.equal(finalList.body.data.length, 0);
  });
});
