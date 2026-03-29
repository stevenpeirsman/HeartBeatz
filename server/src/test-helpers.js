// ==============================================================================
// Test Helpers & Mocks
// ==============================================================================
// Shared utilities for HeartBeatz server tests. Provides mock factories for
// the pino logger, config, state persistence, and HTTP request/response objects.
//
// Usage:
//   import { createMockLogger, createTestConfig, ... } from './test-helpers.js';

/**
 * Create a silent mock logger that captures log calls for assertion.
 * Mimics the pino logger interface used throughout the server.
 *
 * @returns {Object} Mock logger with .calls array for inspection
 */
export function createMockLogger() {
  const calls = [];

  const handler = (level) => (...args) => {
    calls.push({ level, args });
  };

  const logger = {
    info: handler('info'),
    warn: handler('warn'),
    error: handler('error'),
    debug: handler('debug'),
    fatal: handler('fatal'),
    trace: handler('trace'),
    calls,

    /** Create a child logger (same pattern as pino) */
    child: (_bindings) => createMockLogger(),
  };

  return logger;
}

/**
 * Create a test config object with sensible defaults.
 * Override any section by passing partial config.
 *
 * @param {Object} [overrides] - Partial config to merge
 * @returns {Object} Frozen config matching loadConfig() shape
 */
export function createTestConfig(overrides = {}) {
  return Object.freeze({
    port: 8080,
    nodeEnv: 'test',
    logLevel: 'silent',
    heartbeatzIp: '192.168.1.10',
    gatewayIp: '192.168.1.1',
    subnet: '192.168.1.0/24',
    sensing: Object.freeze({
      httpPort: 3000,
      wsPort: 3001,
      udpPort: 5005,
      tickMs: 100,
      source: 'auto',
      baseUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3001',
      ...(overrides.sensing || {}),
    }),
    discovery: Object.freeze({
      intervalMs: 5000,
      timeoutMs: 15000,
      ...(overrides.discovery || {}),
    }),
    ble: Object.freeze({
      enabled: false,
      hciDevice: 'hci0',
      uuidFilter: '',
      rssiThreshold: -70,
      scanIntervalMs: 1000,
      ...(overrides.ble || {}),
    }),
    radar: Object.freeze({
      enabled: false,
      serialPort: '',
      baudRate: 256000,
      ...(overrides.radar || {}),
    }),
    display: Object.freeze({
      width: 1024,
      height: 600,
      ...(overrides.display || {}),
    }),
    demo: Object.freeze({
      mode: 'true',
      scenario: 'patient-monitoring',
      ...(overrides.demo || {}),
    }),
    ...overrides,
  });
}

/**
 * Create a mock state store (in-memory replacement for file-based state).
 * Returns loadState/saveState functions that work like the real ones.
 *
 * @param {Object} [initialState] - Starting state
 * @returns {{ loadState: Function, saveState: Function, getState: Function }}
 */
export function createMockStateStore(initialState = null) {
  let state = initialState || { nodes: {}, calibration: null, firstRunComplete: false };

  return {
    loadState: () => structuredClone(state),
    saveState: (newState) => { state = structuredClone(newState); },
    /** Direct access for assertions — returns current state without cloning */
    getState: () => state,
  };
}

/**
 * Create a mock Express request object.
 *
 * @param {Object} [opts]
 * @param {string} [opts.method='GET']
 * @param {string} [opts.path='/']
 * @param {Object} [opts.params={}]
 * @param {Object} [opts.body={}]
 * @param {Object} [opts.query={}]
 * @returns {Object} Mock request
 */
export function createMockReq(opts = {}) {
  return {
    method: opts.method || 'GET',
    path: opts.path || '/',
    params: opts.params || {},
    body: opts.body || {},
    query: opts.query || {},
    headers: opts.headers || {},
  };
}

/**
 * Create a mock Express response object with chainable methods.
 * Captures status code and sent data for assertions.
 *
 * @returns {Object} Mock response with .statusCode, .body, .headers
 */
export function createMockRes() {
  const res = {
    statusCode: 200,
    body: null,
    _headers: {},
    _sent: false,

    status(code) {
      res.statusCode = code;
      return res;
    },
    json(data) {
      res.body = data;
      res._sent = true;
      return res;
    },
    send(data) {
      res.body = data;
      res._sent = true;
      return res;
    },
    sendStatus(code) {
      res.statusCode = code;
      res._sent = true;
      return res;
    },
    header(name, value) {
      res._headers[name.toLowerCase()] = value;
      return res;
    },
    sendFile(path) {
      res.body = { _file: path };
      res._sent = true;
      return res;
    },
  };
  return res;
}

/**
 * Wait for a specific event from an EventEmitter.
 * Resolves with the emitted data, rejects after timeout.
 *
 * @param {import('events').EventEmitter} emitter
 * @param {string} event
 * @param {number} [timeoutMs=2000]
 * @returns {Promise<*>}
 */
export function waitForEvent(emitter, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for event: ${event}`));
    }, timeoutMs);

    emitter.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args.length === 1 ? args[0] : args);
    });
  });
}

/**
 * Collect N events from an emitter, then resolve with the array.
 *
 * @param {import('events').EventEmitter} emitter
 * @param {string} event
 * @param {number} count
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<Array>}
 */
export function collectEvents(emitter, event, count, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const collected = [];
    const timer = setTimeout(() => {
      reject(new Error(`Timeout: collected ${collected.length}/${count} "${event}" events`));
    }, timeoutMs);

    const handler = (data) => {
      collected.push(data);
      if (collected.length >= count) {
        clearTimeout(timer);
        emitter.removeListener(event, handler);
        resolve(collected);
      }
    };

    emitter.on(event, handler);
  });
}

/**
 * Small sleep utility for async tests.
 * @param {number} ms
 */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
