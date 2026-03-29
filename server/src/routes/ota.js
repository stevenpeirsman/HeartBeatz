// ==============================================================================
// OTA Firmware Update API Routes
// ==============================================================================
// REST endpoints for managing ESP32 firmware updates via the HeartBeatz server.
//
// Endpoints:
//   GET    /api/firmware           - Get current firmware metadata
//   POST   /api/firmware/upload    - Upload a new firmware binary (multipart)
//   DELETE /api/firmware           - Delete the stored firmware
//   GET    /api/firmware/latest    - ESP32 OTA check endpoint (returns binary or 304)
//   GET    /api/firmware/download  - Download firmware binary (for manual use)
//   GET    /api/firmware/status    - Active OTA update progress for all nodes
//   POST   /api/firmware/push/:id  - Trigger an OTA update notification to a specific node
//
// The /api/firmware/latest endpoint is called by the ESP32 ota_check_task.
// It uses the X-Firmware-Version header to determine if an update is needed.

import { Router } from 'express';
import { asyncHandler } from '../middleware/error-handler.js';

/**
 * Maximum upload size for firmware binaries (2MB — slightly above the 1.75MB
 * OTA partition to allow for some overhead).
 */
const MAX_UPLOAD_SIZE = 2 * 1024 * 1024;

/**
 * Create OTA API router with injected services.
 *
 * @param {Object} services
 * @param {import('../ota-manager.js').OtaManager} services.otaManager
 * @param {Object} services.discovery - DiscoveryService or SimulatorService
 * @param {Object} services.logger
 * @returns {Router}
 */
export function createOtaRouter(services) {
  const { otaManager, discovery, logger } = services;
  const log = logger.child({ module: 'ota-api' });
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /firmware — Current firmware metadata
  // -------------------------------------------------------------------------
  router.get('/', (_req, res) => {
    const firmware = otaManager.getCurrentFirmware();
    const nodes = discovery.getNodes();

    // Enrich with per-node firmware version info (if nodes report their version)
    const nodeVersions = nodes.map((n) => ({
      id: n.id,
      name: n.name,
      status: n.status,
      firmware: n.meta?.firmware || 'unknown',
      needsUpdate: firmware
        ? n.meta?.firmware !== firmware.version
        : false,
    }));

    res.json({
      firmware: firmware || null,
      nodes: nodeVersions,
      activeUpdates: otaManager.getUpdateStatus(),
    });
  });

  // -------------------------------------------------------------------------
  // POST /firmware/upload — Upload a new firmware binary
  // -------------------------------------------------------------------------
  // Expects:
  //   Content-Type: application/octet-stream (raw binary)
  //   X-Firmware-Version: "1.1.0" (required header)
  //   X-Firmware-Notes: "Bug fixes" (optional header)
  //
  // Or:
  //   Content-Type: multipart/form-data
  //   Fields: file (binary), version (string), notes (string)
  //
  // For simplicity on the kiosk UI, we support raw binary upload with
  // version in the header. The UI sends a FormData request.
  // -------------------------------------------------------------------------
  router.post('/upload', asyncHandler(async (req, res) => {
    // Determine upload method based on content type
    const contentType = req.headers['content-type'] || '';

    let buffer;
    let version;
    let notes;

    if (contentType.includes('application/octet-stream')) {
      // Raw binary upload — version comes from header
      version = req.headers['x-firmware-version'];
      notes = req.headers['x-firmware-notes'] || '';
      buffer = await collectBody(req, MAX_UPLOAD_SIZE);
    } else {
      // For multipart, we use a simple manual boundary parser.
      // In production, you'd use multer — for the demo box this is sufficient.
      const result = await parseMultipartFirmware(req, MAX_UPLOAD_SIZE);
      buffer = result.buffer;
      version = result.version;
      notes = result.notes;
    }

    if (!version) {
      return res.status(400).json({
        error: 'Firmware version is required',
        hint: 'Send X-Firmware-Version header or "version" form field',
      });
    }

    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ error: 'No firmware binary received' });
    }

    log.info({ version, size: buffer.length }, 'Firmware upload received');

    const result = otaManager.storeFirmware(buffer, version, notes);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    res.json({
      ok: true,
      firmware: result.firmware,
      message: `Firmware v${version} uploaded successfully (${formatBytes(buffer.length)})`,
    });
  }));

  // -------------------------------------------------------------------------
  // DELETE /firmware — Remove the stored firmware
  // -------------------------------------------------------------------------
  router.delete('/', (_req, res) => {
    otaManager.deleteFirmware();
    res.json({ ok: true, message: 'Firmware deleted' });
  });

  // -------------------------------------------------------------------------
  // GET /firmware/latest — ESP32 OTA endpoint
  // -------------------------------------------------------------------------
  // Called by the ESP32 ota_check_task periodically.
  //
  // Request headers:
  //   X-Firmware-Version: "1.0.0"  — the node's current firmware version
  //   X-Node-Id: "AA:BB:CC:DD:01"  — the node's identifier
  //
  // Response:
  //   200 + binary stream — new firmware available
  //   304 — node is already up-to-date
  //   404 — no firmware stored on server
  // -------------------------------------------------------------------------
  router.get('/latest', (req, res) => {
    const nodeVersion = req.headers['x-firmware-version'] || '';
    const nodeId = req.headers['x-node-id'] || 'unknown';

    const firmware = otaManager.getCurrentFirmware();
    if (!firmware) {
      return res.status(404).json({ error: 'No firmware available' });
    }

    // Check if the node needs an update
    const { needsUpdate } = otaManager.checkForUpdate(nodeVersion);
    if (!needsUpdate) {
      log.debug({ nodeId, nodeVersion }, 'Node firmware is up-to-date');
      return res.status(304).end();
    }

    // Stream the firmware binary to the node
    const binary = otaManager.getFirmwareBinary();
    if (!binary) {
      return res.status(500).json({ error: 'Firmware file missing from disk' });
    }

    log.info(
      { nodeId, nodeVersion, newVersion: firmware.version, size: binary.length },
      'Delivering firmware update to node'
    );

    // Track the update for UI progress display
    otaManager.trackUpdateStart(nodeId, binary.length);

    // Set headers that the ESP32 OTA client expects
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Length': binary.length,
      'X-Firmware-Version': firmware.version,
      'X-Firmware-Checksum': firmware.checksum,
    });

    // Send the binary
    res.send(binary);

    // Mark as complete (the ESP32 will reboot after flashing)
    otaManager.trackUpdateEnd(nodeId, 'rebooting');
  });

  // -------------------------------------------------------------------------
  // GET /firmware/download — Manual firmware download (for debugging)
  // -------------------------------------------------------------------------
  router.get('/download', (_req, res) => {
    const firmware = otaManager.getCurrentFirmware();
    if (!firmware) {
      return res.status(404).json({ error: 'No firmware available' });
    }

    const binary = otaManager.getFirmwareBinary();
    if (!binary) {
      return res.status(500).json({ error: 'Firmware file missing' });
    }

    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${firmware.filename}"`,
      'Content-Length': binary.length,
    });
    res.send(binary);
  });

  // -------------------------------------------------------------------------
  // GET /firmware/status — Active OTA update progress
  // -------------------------------------------------------------------------
  router.get('/status', (_req, res) => {
    res.json({
      activeUpdates: otaManager.getUpdateStatus(),
      firmware: otaManager.getCurrentFirmware(),
    });
  });

  // -------------------------------------------------------------------------
  // POST /firmware/push/:id — Trigger OTA notification to a specific node
  // -------------------------------------------------------------------------
  // In the real implementation, this would use a persistent connection or
  // MQTT to tell a specific node to check for updates immediately. For the
  // demo box, nodes poll every 5 minutes — this endpoint just tracks intent.
  router.post('/push/:id', (req, res) => {
    const nodeId = req.params.id;
    const node = discovery.getNode(nodeId);

    if (!node) {
      return res.status(404).json({ error: `Node ${nodeId} not found` });
    }

    const firmware = otaManager.getCurrentFirmware();
    if (!firmware) {
      return res.status(400).json({ error: 'No firmware uploaded' });
    }

    log.info({ nodeId, targetVersion: firmware.version }, 'OTA push requested');

    // For now, just emit an event — in a real system this would send a
    // UDP or WS message to the node telling it to check /api/firmware/latest
    otaManager.emit('ota:push', { nodeId, firmware });

    res.json({
      ok: true,
      message: `OTA update queued for ${node.name || nodeId}. Node will update on next check cycle.`,
      firmware: { version: firmware.version, size: firmware.size },
    });
  });

  return router;
}

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Collect the raw request body as a Buffer (for application/octet-stream).
 * Enforces a maximum size limit.
 *
 * @param {import('http').IncomingMessage} req
 * @param {number} maxSize - Maximum allowed body size in bytes
 * @returns {Promise<Buffer>}
 */
function collectBody(req, maxSize) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxSize) {
        reject(Object.assign(new Error('Firmware binary exceeds maximum size'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Simple multipart/form-data parser for firmware upload.
 * Extracts the firmware binary file and version/notes text fields.
 *
 * This is a minimal parser for the demo box — in production, use multer.
 *
 * @param {import('http').IncomingMessage} req
 * @param {number} maxSize
 * @returns {Promise<{ buffer: Buffer|null, version: string, notes: string }>}
 */
function parseMultipartFirmware(req, maxSize) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxSize) {
        reject(Object.assign(new Error('Upload exceeds maximum size'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(.+)/);

      if (!boundaryMatch) {
        // Not multipart — try to parse as raw binary with headers
        resolve({
          buffer: body,
          version: req.headers['x-firmware-version'] || '',
          notes: req.headers['x-firmware-notes'] || '',
        });
        return;
      }

      const boundary = boundaryMatch[1];
      const parts = splitMultipart(body, boundary);

      let buffer = null;
      let version = '';
      let notes = '';

      for (const part of parts) {
        const nameMatch = part.headers.match(/name="([^"]+)"/);
        if (!nameMatch) continue;
        const name = nameMatch[1];

        if (name === 'file' || name === 'firmware') {
          buffer = part.body;
        } else if (name === 'version') {
          version = part.body.toString('utf-8').trim();
        } else if (name === 'notes') {
          notes = part.body.toString('utf-8').trim();
        }
      }

      resolve({ buffer, version, notes });
    });

    req.on('error', reject);
  });
}

/**
 * Split a multipart body into individual parts.
 * @param {Buffer} body
 * @param {string} boundary
 * @returns {Array<{ headers: string, body: Buffer }>}
 */
function splitMultipart(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = 0;

  while (true) {
    const idx = body.indexOf(delimiter, start);
    if (idx === -1) break;

    if (start > 0) {
      // Extract the part between the previous delimiter and this one
      const partData = body.subarray(start, idx - 2); // -2 for CRLF before delimiter
      const headerEnd = partData.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        parts.push({
          headers: partData.subarray(0, headerEnd).toString('utf-8'),
          body: partData.subarray(headerEnd + 4),
        });
      }
    }

    start = idx + delimiter.length + 2; // +2 for CRLF after delimiter

    // Check for terminator (--boundary--)
    if (body[idx + delimiter.length] === 0x2D && body[idx + delimiter.length + 1] === 0x2D) {
      break;
    }
  }

  return parts;
}

/**
 * Format bytes into a human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
