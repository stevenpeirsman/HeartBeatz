// ==============================================================================
// Express Error Handling Middleware
// ==============================================================================
// Catches unhandled errors in Express route handlers and returns structured
// JSON error responses. Also handles 404s for unknown API routes.
//
// Error response format:
//   { error: string, code?: string, detail?: string, requestId?: string }
//
// This middleware should be mounted AFTER all routes. The 404 handler should
// be mounted BEFORE the error handler.
//
// Usage:
//   app.use('/api', apiRouter);
//   app.use('/api', notFoundHandler);
//   app.use(errorHandler(logger));

/**
 * Simple request ID generator.
 * Produces short IDs like "hb-a1b2c3" for log correlation.
 * @returns {string}
 */
function generateRequestId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = 'hb-';
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

/**
 * Middleware: attach a unique request ID to every request.
 * The ID is added to req.id and to the response header X-Request-Id.
 * Downstream handlers and the error handler use it for log correlation.
 */
export function requestIdMiddleware(req, res, next) {
  req.id = req.headers['x-request-id'] || generateRequestId();
  res.setHeader('X-Request-Id', req.id);
  next();
}

/**
 * Middleware: catch-all for unmatched API routes (404).
 * Mount this AFTER all real API routes but BEFORE the error handler.
 */
export function notFoundHandler(req, res) {
  res.status(404).json({
    error: 'Not found',
    code: 'NOT_FOUND',
    path: req.originalUrl,
    requestId: req.id,
  });
}

/**
 * Middleware: global error handler.
 * Catches any error thrown or passed to next(err) in route handlers.
 *
 * Classifies errors into categories:
 *   - ValidationError  → 400
 *   - TimeoutError     → 504
 *   - UpstreamError    → 502
 *   - Everything else  → 500
 *
 * @param {Object} logger - Pino logger instance
 * @returns {Function} Express error-handling middleware (4-arg signature)
 */
export function errorHandler(logger) {
  const log = logger.child({ module: 'error-handler' });

  // Express identifies error middleware by the 4-argument signature
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    // --- Classify the error ---
    let statusCode = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred';

    if (err.name === 'ValidationError' || err.status === 400) {
      statusCode = 400;
      code = 'VALIDATION_ERROR';
      message = err.message || 'Invalid request';
    } else if (err.code === 'ABORT_ERR' || err.name === 'AbortError' || err.type === 'request-timeout') {
      statusCode = 504;
      code = 'UPSTREAM_TIMEOUT';
      message = 'Upstream service timed out';
    } else if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
      statusCode = 502;
      code = 'UPSTREAM_UNAVAILABLE';
      message = 'Upstream service unavailable';
    } else if (err.status) {
      statusCode = err.status;
      code = err.code || 'ERROR';
      message = err.message || message;
    }

    // --- Log the error ---
    const logPayload = {
      requestId: req.id,
      method: req.method,
      path: req.path,
      statusCode,
      code,
      err: err.message,
    };

    if (statusCode >= 500) {
      // Server errors get full stack traces
      log.error({ ...logPayload, stack: err.stack }, `[${req.id}] ${err.message}`);
    } else {
      // Client errors are less severe
      log.warn(logPayload, `[${req.id}] ${err.message}`);
    }

    // --- Send structured response ---
    // Don't leak internal details in production
    const isProduction = process.env.NODE_ENV === 'production';
    const response = {
      error: message,
      code,
      requestId: req.id,
    };

    if (!isProduction && err.stack) {
      response.detail = err.message;
      response.stack = err.stack.split('\n').slice(0, 5);
    }

    // Avoid double-sending if headers already sent
    if (res.headersSent) {
      log.warn({ requestId: req.id }, 'Headers already sent — cannot send error response');
      return;
    }

    res.status(statusCode).json(response);
  };
}

/**
 * Wrap an async route handler to automatically catch promise rejections.
 * Without this, unhandled rejections in async handlers crash Express.
 *
 * Usage:
 *   router.get('/something', asyncHandler(async (req, res) => { ... }));
 *
 * @param {Function} fn - Async route handler
 * @returns {Function} Wrapped handler that forwards errors to next()
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
