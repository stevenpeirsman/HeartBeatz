// ==============================================================================
// Error Handler Middleware Tests
// ==============================================================================
// Tests the Express error handling middleware: request IDs, 404 handling,
// error classification, async route wrapping, and structured error responses.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'http';
import {
  requestIdMiddleware,
  notFoundHandler,
  errorHandler,
  asyncHandler,
} from './error-handler.js';
import { createMockLogger } from '../test-helpers.js';

// ---------------------------------------------------------------------------
// Test Server Factory
// ---------------------------------------------------------------------------

/**
 * Create a test Express app with the error middleware and custom routes.
 * Returns { api, close } where api(path) returns { status, data, headers }.
 */
function createTestApp(routeSetup) {
  const logger = createMockLogger();
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);

  // Let the test define custom routes
  routeSetup(app);

  // 404 handler
  app.use(notFoundHandler);

  // Error handler (must be last)
  app.use(errorHandler(logger));

  const server = createServer(app);

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}`;

      const api = async (path, opts = {}) => {
        const res = await fetch(`${baseUrl}${path}`, {
          headers: { 'Content-Type': 'application/json', ...opts.headers },
          ...opts,
        });
        const data = await res.json().catch(() => null);
        const headers = Object.fromEntries(res.headers.entries());
        return { status: res.status, data, headers };
      };

      resolve({
        api,
        logger,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

describe('Error Handler Middleware', () => {
  let ctx;

  afterEach(async () => {
    if (ctx) await ctx.close();
  });

  // ── Request ID ──

  describe('requestIdMiddleware', () => {
    it('should add X-Request-Id header to responses', async () => {
      ctx = await createTestApp((app) => {
        app.get('/test', (_req, res) => res.json({ ok: true }));
      });

      const { headers } = await ctx.api('/test');
      assert.ok(headers['x-request-id'], 'Should have X-Request-Id header');
      assert.ok(headers['x-request-id'].startsWith('hb-'), 'ID should start with "hb-"');
    });

    it('should use client-provided X-Request-Id if present', async () => {
      ctx = await createTestApp((app) => {
        app.get('/test', (req, res) => res.json({ id: req.id }));
      });

      const { data } = await ctx.api('/test', {
        headers: { 'X-Request-Id': 'custom-id-123' },
      });
      assert.equal(data.id, 'custom-id-123');
    });
  });

  // ── 404 Handler ──

  describe('notFoundHandler', () => {
    it('should return 404 for unknown routes', async () => {
      ctx = await createTestApp(() => {
        // No routes defined — everything is 404
      });

      const { status, data } = await ctx.api('/api/nonexistent');
      assert.equal(status, 404);
      assert.equal(data.code, 'NOT_FOUND');
      assert.ok(data.requestId, 'Should include requestId');
      assert.ok(data.path, 'Should include the requested path');
    });
  });

  // ── Error Handler ──

  describe('errorHandler', () => {
    it('should catch synchronous errors in route handlers', async () => {
      ctx = await createTestApp((app) => {
        app.get('/throw', () => {
          throw new Error('Test sync error');
        });
      });

      const { status, data } = await ctx.api('/throw');
      assert.equal(status, 500);
      assert.equal(data.code, 'INTERNAL_ERROR');
      assert.ok(data.requestId);
    });

    it('should return 400 for ValidationError', async () => {
      ctx = await createTestApp((app) => {
        app.get('/validate', () => {
          const err = new Error('Invalid input');
          err.name = 'ValidationError';
          throw err;
        });
      });

      const { status, data } = await ctx.api('/validate');
      assert.equal(status, 400);
      assert.equal(data.code, 'VALIDATION_ERROR');
    });

    it('should return 502 for ECONNREFUSED errors', async () => {
      ctx = await createTestApp((app) => {
        app.get('/upstream', () => {
          const err = new Error('Connection refused');
          err.code = 'ECONNREFUSED';
          throw err;
        });
      });

      const { status, data } = await ctx.api('/upstream');
      assert.equal(status, 502);
      assert.equal(data.code, 'UPSTREAM_UNAVAILABLE');
    });

    it('should use custom status from error object', async () => {
      ctx = await createTestApp((app) => {
        app.get('/custom', () => {
          const err = new Error('Rate limited');
          err.status = 429;
          err.code = 'RATE_LIMITED';
          throw err;
        });
      });

      const { status, data } = await ctx.api('/custom');
      assert.equal(status, 429);
      assert.equal(data.code, 'RATE_LIMITED');
    });
  });

  // ── Async Handler Wrapper ──

  describe('asyncHandler', () => {
    it('should catch rejected promises in async route handlers', async () => {
      ctx = await createTestApp((app) => {
        app.get('/async-throw', asyncHandler(async () => {
          throw new Error('Async failure');
        }));
      });

      const { status, data } = await ctx.api('/async-throw');
      assert.equal(status, 500);
      assert.equal(data.code, 'INTERNAL_ERROR');
      assert.ok(data.requestId);
    });

    it('should let successful async handlers respond normally', async () => {
      ctx = await createTestApp((app) => {
        app.get('/async-ok', asyncHandler(async (_req, res) => {
          await new Promise((r) => setTimeout(r, 10));
          res.json({ ok: true });
        }));
      });

      const { status, data } = await ctx.api('/async-ok');
      assert.equal(status, 200);
      assert.equal(data.ok, true);
    });

    it('should handle AbortError as timeout (504)', async () => {
      ctx = await createTestApp((app) => {
        app.get('/timeout', asyncHandler(async () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          throw err;
        }));
      });

      const { status, data } = await ctx.api('/timeout');
      assert.equal(status, 504);
      assert.equal(data.code, 'UPSTREAM_TIMEOUT');
    });
  });
});
