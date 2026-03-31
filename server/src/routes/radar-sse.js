// ==============================================================================
// Radar SSE Stream & REST API (SENSOR-02)
// ==============================================================================
// Integrates LD2410S radar readings into the unified sensor event model and
// exposes them via Server-Sent Events (SSE) alongside a REST snapshot endpoint.
//
// Endpoints:
//   GET /api/v1/radar           — Latest radar reading per source (REST)
//   GET /api/v1/radar/stream    — SSE stream of radar events in real-time
//   GET /api/v1/radar/stats     — Radar frame parsing statistics
//
// The module bridges RadarService (which emits 'reading' events with raw
// LD2410S data) to the project's unified sensor event model:
//   { type: 'radar-reading', source: 'radar', timestamp, data: RadarReading }
//
// SSE clients receive events as they arrive (~10Hz from LD2410S hardware).
// An optional ?mode=engineering filter limits the stream to engineering frames.
//
// Architecture decision (ADR 2026-03-31): All live data streams use SSE,
// not WebSocket. This aligns with features/stream and ground-truth transports.
//
// Reference: HLK-LD2410S Datasheet v1.04, Section 4 (Data Reporting)
// ==============================================================================

import { Router } from 'express';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** SSE keep-alive comment interval in milliseconds (30 seconds). */
export const SSE_KEEPALIVE_MS = 30_000;

/** Maximum idle time before closing an SSE connection (5 minutes). */
export const SSE_MAX_IDLE_MS = 5 * 60 * 1000;

/** Unified sensor event type string for radar readings. */
export const RADAR_EVENT_TYPE = 'radar-reading';

/** Unified sensor source identifier. */
export const RADAR_SOURCE = 'radar';

// ---------------------------------------------------------------------------
// Unified Sensor Event Adapter
// ---------------------------------------------------------------------------

/**
 * Transform a raw RadarReading or EngineeringReading from RadarService
 * into the project's unified sensor event model.
 *
 * Unified event shape (per ADR 2026-03-31):
 *   { type: string, source: string, timestamp: number, data: Object }
 *
 * @param {import('../radar.js').RadarReading | import('../radar.js').EngineeringReading} reading
 *   Raw radar reading as emitted by RadarService 'reading' event
 * @returns {{ type: string, source: string, timestamp: number, data: Object }}
 *   Unified sensor event ready for SSE broadcast or fusion pipeline
 */
export function toUnifiedEvent(reading) {
  return {
    type: RADAR_EVENT_TYPE,
    source: RADAR_SOURCE,
    timestamp: reading.timestamp || Date.now(),
    data: { ...reading },
  };
}

// ---------------------------------------------------------------------------
// In-Memory Radar Store
// ---------------------------------------------------------------------------

/**
 * Holds the latest radar reading and maintains a list of SSE clients.
 * Designed as a thin bridge between the RadarService EventEmitter and
 * the Express SSE endpoint.
 *
 * Thread-safe for single-threaded Node.js — no locking needed.
 */
export class RadarStore {
  /**
   * @param {Object} [options]
   * @param {Object} [options.logger] - Pino logger (optional, null-safe)
   */
  constructor({ logger } = {}) {
    /** @type {Object|null} Latest radar reading (unified event) */
    this._latest = null;

    /** @type {Object|null} Latest engineering-mode reading (unified event) */
    this._latestEngineering = null;

    /** @type {Set<Function>} Active SSE client push functions */
    this._clients = new Set();

    /** @type {number} Total events received since construction */
    this._eventCount = 0;

    /** @type {Object|null} */
    this._log = logger?.child?.({ module: 'radar-sse' }) || logger || null;
  }

  /**
   * Ingest a raw reading from RadarService and broadcast to SSE clients.
   *
   * @param {import('../radar.js').RadarReading | import('../radar.js').EngineeringReading} reading
   *   Raw reading from RadarService 'reading' event
   */
  push(reading) {
    const event = toUnifiedEvent(reading);
    this._latest = event;
    this._eventCount++;

    if (reading.mode === 'engineering') {
      this._latestEngineering = event;
    }

    // Broadcast to all connected SSE clients
    for (const sendFn of this._clients) {
      try {
        sendFn(event);
      } catch (err) {
        this._log?.debug?.({ err: err.message }, 'SSE client send failed — will be cleaned up');
      }
    }
  }

  /**
   * Get the latest radar event (any mode).
   * @returns {{ type: string, source: string, timestamp: number, data: Object }|null}
   */
  get latest() {
    return this._latest;
  }

  /**
   * Get the latest engineering-mode radar event.
   * @returns {{ type: string, source: string, timestamp: number, data: Object }|null}
   */
  get latestEngineering() {
    return this._latestEngineering;
  }

  /**
   * Total number of radar events received.
   * @returns {number}
   */
  get eventCount() {
    return this._eventCount;
  }

  /**
   * Number of active SSE clients.
   * @returns {number}
   */
  get clientCount() {
    return this._clients.size;
  }

  /**
   * Register an SSE client push function.
   * @param {Function} sendFn - Function that accepts a unified event object
   */
  addClient(sendFn) {
    this._clients.add(sendFn);
    this._log?.debug?.({ clients: this._clients.size }, 'SSE client connected');
  }

  /**
   * Remove an SSE client push function (e.g., on disconnect).
   * @param {Function} sendFn - Previously registered push function
   */
  removeClient(sendFn) {
    this._clients.delete(sendFn);
    this._log?.debug?.({ clients: this._clients.size }, 'SSE client disconnected');
  }

  /**
   * Reset the store (useful for testing).
   */
  reset() {
    this._latest = null;
    this._latestEngineering = null;
    this._eventCount = 0;
    this._clients.clear();
  }
}

// ---------------------------------------------------------------------------
// Express Router Factory
// ---------------------------------------------------------------------------

/**
 * Create the radar SSE + REST router.
 *
 * Wire-up: In index.js or api-v1.js, call `connectRadar(radarService, radarStore)`
 * after constructing the RadarService to bridge events into the store.
 *
 * @param {Object} options
 * @param {Object} options.logger - Pino logger instance
 * @param {RadarStore} [options.radarStore] - RadarStore instance (created if not provided)
 * @returns {{ router: import('express').Router, radarStore: RadarStore }}
 */
export function createRadarRouter({ logger, radarStore }) {
  const router = Router();
  const log = logger.child({ module: 'radar-sse' });
  const store = radarStore || new RadarStore({ logger });

  // -------------------------------------------------------------------------
  // GET /api/v1/radar — Latest radar reading snapshot
  // -------------------------------------------------------------------------

  /**
   * Returns the most recent radar reading in the unified sensor event format.
   * Optional query parameter: ?mode=engineering to get the latest engineering frame.
   *
   * Response: { ok: true, data: { event, available } }
   *   - event: unified radar event or null if no readings yet
   *   - available: boolean indicating if radar hardware is sending data
   */
  router.get('/', (_req, res) => {
    const mode = _req.query.mode;

    if (mode && mode !== 'basic' && mode !== 'engineering') {
      return res.status(400).json({
        ok: false,
        error: `Invalid mode "${mode}". Must be "basic" or "engineering".`,
      });
    }

    const event = mode === 'engineering'
      ? store.latestEngineering
      : store.latest;

    res.json({
      ok: true,
      data: {
        event,
        available: event !== null,
        eventCount: store.eventCount,
        sseClients: store.clientCount,
      },
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/radar/stream — SSE stream of radar events
  // -------------------------------------------------------------------------

  /**
   * Server-Sent Events stream of radar readings in real-time.
   * Events arrive at ~10Hz (LD2410S hardware rate).
   *
   * Optional query parameter: ?mode=engineering to filter to engineering frames only.
   *
   * Each SSE event is a JSON-serialized unified sensor event:
   *   data: {"type":"radar-reading","source":"radar","timestamp":...,"data":{...}}
   */
  router.get('/stream', (req, res) => {
    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    });

    // Send initial comment to establish connection
    res.write(':ok\n\n');

    const modeFilter = req.query.mode || null;
    let lastActivity = Date.now();

    /**
     * Push function registered with RadarStore.
     * Serializes the event and writes it to the SSE stream.
     *
     * @param {{ type: string, source: string, timestamp: number, data: Object }} event
     */
    const sendEvent = (event) => {
      // Apply mode filter if specified
      if (modeFilter === 'engineering' && event.data?.mode !== 'engineering') {
        return;
      }
      if (modeFilter === 'basic' && event.data?.mode !== 'basic') {
        return;
      }

      try {
        const payload = JSON.stringify(event);
        res.write(`data: ${payload}\n\n`);
        lastActivity = Date.now();
      } catch {
        // Client likely disconnected — cleanup will happen via 'close' event
      }
    };

    store.addClient(sendEvent);

    // Keep-alive: send SSE comment periodically to detect dead connections
    const keepAlive = setInterval(() => {
      try {
        res.write(':keepalive\n\n');
      } catch {
        // Connection dead — cleanup below
      }
    }, SSE_KEEPALIVE_MS);

    // Idle timeout: close connections that haven't received data
    const idleCheck = setInterval(() => {
      if (Date.now() - lastActivity > SSE_MAX_IDLE_MS) {
        log.debug('SSE client idle timeout — closing');
        cleanup();
        res.end();
      }
    }, SSE_MAX_IDLE_MS / 2);

    /**
     * Clean up all timers and deregister from the store.
     */
    const cleanup = () => {
      clearInterval(keepAlive);
      clearInterval(idleCheck);
      store.removeClient(sendEvent);
    };

    // Client disconnect
    req.on('close', cleanup);
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/radar/stats — Radar diagnostics
  // -------------------------------------------------------------------------

  /**
   * Returns radar store statistics: event count, client count.
   * For hardware-level stats (frames parsed, dropped, etc.), use the
   * RadarService.stats getter directly (exposed via /api/radar/status).
   */
  router.get('/stats', (_req, res) => {
    res.json({
      ok: true,
      data: {
        eventCount: store.eventCount,
        sseClients: store.clientCount,
        hasLatest: store.latest !== null,
        hasEngineering: store.latestEngineering !== null,
        latestTimestamp: store.latest?.timestamp || null,
      },
    });
  });

  return { router, radarStore: store };
}

// ---------------------------------------------------------------------------
// RadarService → RadarStore Bridge
// ---------------------------------------------------------------------------

/**
 * Connect a RadarService EventEmitter to a RadarStore.
 * This is the glue that bridges the hardware-facing module (radar.js)
 * to the SSE transport layer.
 *
 * Call this once during server bootstrap, after both are constructed.
 *
 * @param {import('../radar.js').RadarService} radarService - The radar hardware interface
 * @param {RadarStore} radarStore - The SSE store to push events into
 * @param {Object} [logger] - Optional pino logger
 * @returns {Function} Cleanup function that removes the event listener
 */
export function connectRadarToStore(radarService, radarStore, logger) {
  const log = logger?.child?.({ module: 'radar-bridge' }) || logger || null;

  /**
   * Handler for RadarService 'reading' events.
   * Transforms and pushes into the RadarStore for SSE distribution.
   *
   * @param {import('../radar.js').RadarReading | import('../radar.js').EngineeringReading} reading
   */
  const onReading = (reading) => {
    radarStore.push(reading);
  };

  radarService.on('reading', onReading);
  log?.info?.('Radar → SSE bridge connected');

  // Return cleanup function for graceful shutdown
  return () => {
    radarService.removeListener('reading', onReading);
    log?.info?.('Radar → SSE bridge disconnected');
  };
}

export default { createRadarRouter, RadarStore, connectRadarToStore, toUnifiedEvent };
