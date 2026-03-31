// ==============================================================================
// LD2410S mmWave Radar Reader
// ==============================================================================
// Reads presence/motion data from HLK-LD2410S 24GHz radar module over UART.
// The LD2410S outputs binary frames at ~10Hz with:
//   - Target state (no target / moving / stationary / both)
//   - Moving target distance (cm) and energy (0-100)
//   - Stationary target distance (cm) and energy (0-100)
//   - Detection distance (cm)
//
// Engineering mode additionally provides:
//   - Per-gate moving and stationary energy values (0-100 per gate)
//   - Maximum configured detection gate indices
//   - Light sensor reading (LD2410S-specific, 0-255)
//   - Output pin state (LD2410S-specific, 0 or 1)
//
// Frame format:
//   Header: F4 F3 F2 F1
//   Length: 2 bytes (little-endian, payload byte count)
//   Payload: type byte + data (see _parseBasicFrame / _parseEngineeringFrame)
//   Tail:   F8 F7 F6 F5
//
// Protocol reference: HLK-LD2410S Datasheet v1.04, Section 4 (Data Reporting)
// Engineering mode uses report type 0x02 vs basic mode 0x01.
//
// This module is optional — if serialport is not available or no radar is
// connected, it gracefully degrades to a no-op.

import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// LD2410S Protocol Constants
// ---------------------------------------------------------------------------

/** Frame header magic bytes. */
const FRAME_HEADER = Buffer.from([0xf4, 0xf3, 0xf2, 0xf1]);

/** Frame tail magic bytes. */
const FRAME_TAIL = Buffer.from([0xf8, 0xf7, 0xf6, 0xf5]);

/** Basic data report type byte. */
export const FRAME_TYPE_BASIC = 0x01;

/** Engineering data report type byte. */
export const FRAME_TYPE_ENGINEERING = 0x02;

/** Maximum number of distance gates supported by LD2410S (0-8 inclusive). */
export const MAX_GATES = 9;

/** Human-readable target state labels indexed by state code byte. */
const TARGET_STATES = Object.freeze(['none', 'moving', 'stationary', 'both']);

/**
 * Minimum payload sizes (bytes) for frame validation.
 *   Basic:       type(1) + state(1) + movDist(2) + movE(1) + staDist(2) + staE(1) + detDist(2) = 10
 *   Engineering: basic(10) + maxMovGate(1) + maxStaGate(1) + at least 1+1 gate energy = 14
 */
const MIN_BASIC_PAYLOAD = 10;
const MIN_ENGINEERING_PAYLOAD = 14;

/** Maximum receive buffer size (bytes) before truncation. */
const MAX_BUFFER_SIZE = 1024;

/** Bytes to keep when truncating an overflowed buffer. */
const BUFFER_TAIL_KEEP = 256;

// ---------------------------------------------------------------------------
// Type Definitions
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} RadarReading
 * @property {'basic'}  mode           - Report mode: always 'basic' for basic frames
 * @property {string}   state          - 'none' | 'moving' | 'stationary' | 'both'
 * @property {number}   movingDist     - Moving target distance in cm
 * @property {number}   movingEnergy   - Moving target energy (0-100)
 * @property {number}   stationaryDist - Stationary target distance in cm
 * @property {number}   stationaryEnergy - Stationary target energy (0-100)
 * @property {number}   detectionDist  - Overall detection distance in cm
 * @property {number}   timestamp      - Unix timestamp (ms)
 */

/**
 * @typedef {Object} EngineeringReading
 * @property {'engineering'} mode      - Report mode: always 'engineering'
 * @property {string}   state          - 'none' | 'moving' | 'stationary' | 'both'
 * @property {number}   movingDist     - Moving target distance in cm
 * @property {number}   movingEnergy   - Moving target energy (0-100)
 * @property {number}   stationaryDist - Stationary target distance in cm
 * @property {number}   stationaryEnergy - Stationary target energy (0-100)
 * @property {number}   detectionDist  - Overall detection distance in cm
 * @property {number}   maxMovingGate  - Max configured moving detection gate (0-8)
 * @property {number}   maxStationaryGate - Max configured stationary detection gate (0-8)
 * @property {number[]} movingGateEnergy    - Per-gate moving energy [gate0..gateN] (0-100 each)
 * @property {number[]} stationaryGateEnergy - Per-gate stationary energy [gate0..gateN] (0-100 each)
 * @property {number|null} lightSensor - Ambient light level (0-255), null if not present
 * @property {number|null} outputPin   - Output pin state (0 or 1), null if not present
 * @property {number}   timestamp      - Unix timestamp (ms)
 */

/**
 * @typedef {Object} RadarStats
 * @property {number} framesReceived  - Total frames successfully parsed
 * @property {number} framesDropped   - Frames dropped due to parse errors or invalid tails
 * @property {number} basicFrames     - Count of basic mode frames
 * @property {number} engineeringFrames - Count of engineering mode frames
 * @property {number} bytesReceived   - Total raw bytes received
 * @property {number} bufferOverflows - Times buffer exceeded MAX_BUFFER_SIZE
 */

export class RadarService extends EventEmitter {
  /**
   * Create a new RadarService instance.
   *
   * @param {Object} config - Full HeartBeatz config object (needs config.radar)
   * @param {Object} logger - pino logger instance
   */
  constructor(config, logger) {
    super();
    this.config = config;
    this.log = logger.child({ module: 'radar' });
    this._port = null;
    this._buffer = Buffer.alloc(0);
    this._lastReading = null;
    this._lastEngineering = null;
    this._available = false;

    /** @type {RadarStats} */
    this._stats = {
      framesReceived: 0,
      framesDropped: 0,
      basicFrames: 0,
      engineeringFrames: 0,
      bytesReceived: 0,
      bufferOverflows: 0,
    };
  }

  /**
   * Attempt to open serial connection to LD2410S.
   * Gracefully degrades if serialport package is missing or port unavailable.
   * @returns {Promise<void>}
   */
  async start() {
    if (!this.config.radar.enabled) {
      this.log.info('Radar disabled in config');
      return;
    }

    let SerialPort;
    try {
      const mod = await import('serialport');
      SerialPort = mod.SerialPort;
    } catch {
      this.log.warn('serialport package not available — radar disabled');
      return;
    }

    const portPath = this.config.radar.serialPort || await this._autoDetect(SerialPort);
    if (!portPath) {
      this.log.warn('No LD2410S serial port found');
      return;
    }

    try {
      this._port = new SerialPort({
        path: portPath,
        baudRate: this.config.radar.baudRate,
        autoOpen: false,
      });

      this._port.on('data', (chunk) => this._onData(chunk));
      this._port.on('error', (err) => this.log.error({ err }, 'Serial error'));

      await new Promise((resolve, reject) => {
        this._port.open((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      this._available = true;
      this.log.info({ port: portPath, baudRate: this.config.radar.baudRate },
        'LD2410S radar connected');
    } catch (err) {
      this.log.warn({ err: err.message, port: portPath }, 'Failed to open radar port');
    }
  }

  /**
   * Close serial connection and clean up.
   */
  stop() {
    if (this._port?.isOpen) {
      this._port.close();
      this.log.info('Radar serial port closed');
    }
  }

  /**
   * Whether the radar is connected and sending data.
   * @returns {boolean}
   */
  get isAvailable() {
    return this._available;
  }

  /**
   * Get the most recent radar reading (basic or engineering).
   * @returns {RadarReading|EngineeringReading|null}
   */
  get lastReading() {
    return this._lastReading;
  }

  /**
   * Get the most recent engineering mode reading specifically.
   * Returns null if no engineering frames have been received.
   * @returns {EngineeringReading|null}
   */
  get lastEngineering() {
    return this._lastEngineering;
  }

  /**
   * Get frame parsing statistics for diagnostics.
   * @returns {RadarStats}
   */
  get stats() {
    return { ...this._stats };
  }

  /**
   * Reset frame statistics counters.
   */
  resetStats() {
    this._stats.framesReceived = 0;
    this._stats.framesDropped = 0;
    this._stats.basicFrames = 0;
    this._stats.engineeringFrames = 0;
    this._stats.bytesReceived = 0;
    this._stats.bufferOverflows = 0;
  }

  // ---------------------------------------------------------------------------
  // Internal: Frame Accumulation & Extraction
  // ---------------------------------------------------------------------------

  /**
   * Accumulate incoming serial data and extract complete frames.
   * Handles partial frames across multiple chunks, garbage data before
   * valid headers, and buffer overflow protection.
   *
   * @param {Buffer} chunk - Raw bytes from the serial port
   * @private
   */
  _onData(chunk) {
    this._stats.bytesReceived += chunk.length;
    this._buffer = Buffer.concat([this._buffer, chunk]);

    // Process all complete frames in the buffer
    while (this._buffer.length >= 10) {
      const headerIdx = this._buffer.indexOf(FRAME_HEADER);
      if (headerIdx === -1) {
        // No header found — discard entire buffer
        this._buffer = Buffer.alloc(0);
        break;
      }

      // Discard bytes before header
      if (headerIdx > 0) {
        this._buffer = this._buffer.subarray(headerIdx);
      }

      // Need at least header(4) + length(2) to know frame size
      if (this._buffer.length < 6) break;

      const dataLen = this._buffer.readUInt16LE(4);

      // Sanity check: LD2410S frames are never larger than ~64 bytes
      // A bogus length field indicates a false header match
      if (dataLen > 128) {
        // Skip past this false header and look for the next one
        this._buffer = this._buffer.subarray(4);
        this._stats.framesDropped++;
        continue;
      }

      const frameLen = 4 + 2 + dataLen + 4; // header + len + payload + tail

      if (this._buffer.length < frameLen) break;

      // Verify tail
      const tailStart = frameLen - 4;
      if (this._buffer.subarray(tailStart, tailStart + 4).equals(FRAME_TAIL)) {
        const payload = this._buffer.subarray(6, 6 + dataLen);
        this._parseFrame(payload);
      } else {
        this._stats.framesDropped++;
        this.log.debug({ dataLen, frameLen }, 'Frame tail mismatch — dropped');
      }

      this._buffer = this._buffer.subarray(frameLen);
    }

    // Prevent buffer from growing unbounded
    if (this._buffer.length > MAX_BUFFER_SIZE) {
      this._buffer = this._buffer.subarray(-BUFFER_TAIL_KEEP);
      this._stats.bufferOverflows++;
      this.log.debug('Receive buffer overflow — truncated');
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: Frame Parsing
  // ---------------------------------------------------------------------------

  /**
   * Route a validated payload to the appropriate parser based on frame type.
   *
   * @param {Buffer} payload - Frame payload (after header+length, before tail)
   * @private
   */
  _parseFrame(payload) {
    if (payload.length < 2) return;

    const type = payload[0];

    if (type === FRAME_TYPE_BASIC) {
      this._parseBasicFrame(payload);
    } else if (type === FRAME_TYPE_ENGINEERING) {
      this._parseEngineeringFrame(payload);
    }
    // Silently ignore unknown frame types (e.g. ACK frames from command mode)
  }

  /**
   * Parse a basic mode data report (type 0x01).
   *
   * Basic payload layout (10 bytes minimum):
   *   [0]    type            = 0x01
   *   [1]    target state    (0=none, 1=moving, 2=stationary, 3=both)
   *   [2:3]  moving dist     (uint16 LE, cm)
   *   [4]    moving energy   (uint8, 0-100)
   *   [5:6]  stationary dist (uint16 LE, cm)
   *   [7]    stationary energy (uint8, 0-100)
   *   [8:9]  detection dist  (uint16 LE, cm)
   *
   * @param {Buffer} payload
   * @private
   */
  _parseBasicFrame(payload) {
    if (payload.length < MIN_BASIC_PAYLOAD) {
      this._stats.framesDropped++;
      return;
    }

    /** @type {RadarReading} */
    const reading = {
      mode: 'basic',
      state: TARGET_STATES[payload[1]] || 'none',
      movingDist: payload.readUInt16LE(2),
      movingEnergy: payload[4],
      stationaryDist: payload.readUInt16LE(5),
      stationaryEnergy: payload[7],
      detectionDist: payload.readUInt16LE(8),
      timestamp: Date.now(),
    };

    this._stats.framesReceived++;
    this._stats.basicFrames++;
    this._lastReading = reading;
    this.emit('reading', reading);
  }

  /**
   * Parse an engineering mode data report (type 0x02).
   *
   * Engineering payload layout:
   *   [0]         type                = 0x02
   *   [1]         target state        (0=none, 1=moving, 2=stationary, 3=both)
   *   [2:3]       moving dist         (uint16 LE, cm)
   *   [4]         moving energy       (uint8, 0-100)
   *   [5:6]       stationary dist     (uint16 LE, cm)
   *   [7]         stationary energy   (uint8, 0-100)
   *   [8:9]       detection dist      (uint16 LE, cm)
   *   [10]        max moving gate     (uint8, 0-8)
   *   [11]        max stationary gate (uint8, 0-8)
   *   [12..12+N]  moving energy per gate    (N = maxMovingGate + 1 bytes)
   *   [12+N..12+N+M] stationary energy per gate (M = maxStationaryGate + 1 bytes)
   *   [12+N+M]    light sensor        (uint8, 0-255) — LD2410S only
   *   [12+N+M+1]  output pin state    (uint8, 0 or 1) — LD2410S only
   *
   * Reference: HLK-LD2410S Datasheet v1.04, Section 4.2.2
   *
   * @param {Buffer} payload
   * @private
   */
  _parseEngineeringFrame(payload) {
    if (payload.length < MIN_ENGINEERING_PAYLOAD) {
      this._stats.framesDropped++;
      return;
    }

    const maxMovingGate = payload[10];
    const maxStationaryGate = payload[11];

    // Validate gate counts — LD2410S supports gates 0-8 (max 9 gates)
    if (maxMovingGate >= MAX_GATES || maxStationaryGate >= MAX_GATES) {
      this._stats.framesDropped++;
      this.log.debug(
        { maxMovingGate, maxStationaryGate },
        'Engineering frame has invalid gate count — dropped'
      );
      return;
    }

    const numMovingGates = maxMovingGate + 1;
    const numStationaryGates = maxStationaryGate + 1;
    const gateDataStart = 12;
    const stationaryGateStart = gateDataStart + numMovingGates;
    const gateDataEnd = stationaryGateStart + numStationaryGates;

    // Check payload has enough bytes for gate data
    if (payload.length < gateDataEnd) {
      this._stats.framesDropped++;
      this.log.debug(
        { expected: gateDataEnd, actual: payload.length },
        'Engineering frame too short for gate data — dropped'
      );
      return;
    }

    // Extract per-gate energy arrays
    const movingGateEnergy = new Array(numMovingGates);
    for (let i = 0; i < numMovingGates; i++) {
      movingGateEnergy[i] = payload[gateDataStart + i];
    }

    const stationaryGateEnergy = new Array(numStationaryGates);
    for (let i = 0; i < numStationaryGates; i++) {
      stationaryGateEnergy[i] = payload[stationaryGateStart + i];
    }

    // LD2410S-specific trailing fields: light sensor + output pin
    // These are optional — older firmware or non-S variants may omit them
    const hasLightSensor = payload.length > gateDataEnd;
    const hasOutputPin = payload.length > gateDataEnd + 1;

    /** @type {EngineeringReading} */
    const reading = {
      mode: 'engineering',
      state: TARGET_STATES[payload[1]] || 'none',
      movingDist: payload.readUInt16LE(2),
      movingEnergy: payload[4],
      stationaryDist: payload.readUInt16LE(5),
      stationaryEnergy: payload[7],
      detectionDist: payload.readUInt16LE(8),
      maxMovingGate,
      maxStationaryGate,
      movingGateEnergy,
      stationaryGateEnergy,
      lightSensor: hasLightSensor ? payload[gateDataEnd] : null,
      outputPin: hasOutputPin ? payload[gateDataEnd + 1] : null,
      timestamp: Date.now(),
    };

    this._stats.framesReceived++;
    this._stats.engineeringFrames++;
    this._lastReading = reading;
    this._lastEngineering = reading;
    this.emit('reading', reading);
    this.emit('engineering', reading);
  }

  // ---------------------------------------------------------------------------
  // Internal: Port Auto-Detection
  // ---------------------------------------------------------------------------

  /**
   * Auto-detect LD2410S serial port by scanning /dev/ttyUSB* and /dev/ttyACM*.
   * Looks for common USB-UART bridge chips used with the LD2410S.
   *
   * @param {Function} SerialPort - SerialPort class from the serialport package
   * @returns {Promise<string|null>} Detected port path or null
   * @private
   */
  async _autoDetect(SerialPort) {
    try {
      const ports = await SerialPort.list();
      // LD2410S typically shows up as CH340/CP210x USB-UART
      const candidate = ports.find(
        (p) =>
          p.manufacturer?.includes('1a86') || // CH340
          p.manufacturer?.includes('Silicon Labs') || // CP210x
          p.path?.includes('ttyUSB') ||
          p.path?.includes('ttyACM')
      );
      return candidate?.path || null;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Pure Helper Functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Convert a gate index to the approximate distance range it covers.
 * Each LD2410S gate spans ~75cm (0.75m).
 *
 * @param {number} gateIndex - Gate number (0-8)
 * @returns {{ minCm: number, maxCm: number }} Distance range in centimeters
 */
export function gateToDistance(gateIndex) {
  const GATE_WIDTH_CM = 75;
  return {
    minCm: gateIndex * GATE_WIDTH_CM,
    maxCm: (gateIndex + 1) * GATE_WIDTH_CM,
  };
}

/**
 * Find the gate with the highest energy from a per-gate energy array.
 * Useful for determining which distance zone has the strongest detection.
 *
 * @param {number[]} gateEnergies - Array of energy values (0-100) per gate
 * @returns {{ gate: number, energy: number }|null} Peak gate info, or null if empty
 */
export function findPeakGate(gateEnergies) {
  if (!gateEnergies || gateEnergies.length === 0) return null;

  let peakGate = 0;
  let peakEnergy = gateEnergies[0];

  for (let i = 1; i < gateEnergies.length; i++) {
    if (gateEnergies[i] > peakEnergy) {
      peakEnergy = gateEnergies[i];
      peakGate = i;
    }
  }

  return { gate: peakGate, energy: peakEnergy };
}

/**
 * Compute the total energy across all gates (sum).
 * Useful as a quick proxy for overall motion/presence strength.
 *
 * @param {number[]} gateEnergies - Array of energy values (0-100) per gate
 * @returns {number} Sum of all gate energies
 */
export function totalGateEnergy(gateEnergies) {
  if (!gateEnergies || gateEnergies.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < gateEnergies.length; i++) {
    sum += gateEnergies[i];
  }
  return sum;
}

/**
 * Build a complete LD2410S binary frame for testing or replay.
 * Constructs a valid frame with header, length, payload, and tail.
 *
 * @param {Buffer} payload - The frame payload (type byte + data)
 * @returns {Buffer} Complete frame ready for _onData()
 */
export function buildFrame(payload) {
  const length = Buffer.alloc(2);
  length.writeUInt16LE(payload.length);
  return Buffer.concat([FRAME_HEADER, length, payload, FRAME_TAIL]);
}

/**
 * Build a basic mode payload (type 0x01) for testing.
 *
 * @param {Object} opts
 * @param {number} [opts.state=0]           - Target state (0-3)
 * @param {number} [opts.movingDist=0]      - Moving target distance (cm)
 * @param {number} [opts.movingEnergy=0]    - Moving target energy (0-100)
 * @param {number} [opts.stationaryDist=0]  - Stationary target distance (cm)
 * @param {number} [opts.stationaryEnergy=0] - Stationary target energy (0-100)
 * @param {number} [opts.detectionDist=0]   - Detection distance (cm)
 * @returns {Buffer} Basic mode payload (10 bytes)
 */
export function buildBasicPayload(opts = {}) {
  const payload = Buffer.alloc(10);
  payload[0] = FRAME_TYPE_BASIC;
  payload[1] = opts.state ?? 0;
  payload.writeUInt16LE(opts.movingDist ?? 0, 2);
  payload[4] = opts.movingEnergy ?? 0;
  payload.writeUInt16LE(opts.stationaryDist ?? 0, 5);
  payload[7] = opts.stationaryEnergy ?? 0;
  payload.writeUInt16LE(opts.detectionDist ?? 0, 8);
  return payload;
}

/**
 * Build an engineering mode payload (type 0x02) for testing.
 *
 * @param {Object} opts
 * @param {number}   [opts.state=0]              - Target state (0-3)
 * @param {number}   [opts.movingDist=0]         - Moving target distance (cm)
 * @param {number}   [opts.movingEnergy=0]       - Moving target energy (0-100)
 * @param {number}   [opts.stationaryDist=0]     - Stationary target distance (cm)
 * @param {number}   [opts.stationaryEnergy=0]   - Stationary target energy (0-100)
 * @param {number}   [opts.detectionDist=0]      - Detection distance (cm)
 * @param {number}   [opts.maxMovingGate=8]      - Max moving detection gate (0-8)
 * @param {number}   [opts.maxStationaryGate=8]  - Max stationary detection gate (0-8)
 * @param {number[]} [opts.movingGateEnergy]     - Per-gate moving energy (auto-filled with zeros)
 * @param {number[]} [opts.stationaryGateEnergy] - Per-gate stationary energy (auto-filled with zeros)
 * @param {number|null} [opts.lightSensor=null]  - Light sensor value (null to omit)
 * @param {number|null} [opts.outputPin=null]    - Output pin state (null to omit)
 * @returns {Buffer} Engineering mode payload
 */
export function buildEngineeringPayload(opts = {}) {
  const maxMovGate = opts.maxMovingGate ?? 8;
  const maxStaGate = opts.maxStationaryGate ?? 8;
  const numMovGates = maxMovGate + 1;
  const numStaGates = maxStaGate + 1;

  const movEnergies = opts.movingGateEnergy || new Array(numMovGates).fill(0);
  const staEnergies = opts.stationaryGateEnergy || new Array(numStaGates).fill(0);

  // Calculate total payload size
  let size = 12 + numMovGates + numStaGates; // base + gate data
  const hasLight = opts.lightSensor != null;
  const hasPin = opts.outputPin != null;
  if (hasLight) size += 1;
  if (hasPin) size += 1;

  const payload = Buffer.alloc(size);

  // Base fields (same as basic mode)
  payload[0] = FRAME_TYPE_ENGINEERING;
  payload[1] = opts.state ?? 0;
  payload.writeUInt16LE(opts.movingDist ?? 0, 2);
  payload[4] = opts.movingEnergy ?? 0;
  payload.writeUInt16LE(opts.stationaryDist ?? 0, 5);
  payload[7] = opts.stationaryEnergy ?? 0;
  payload.writeUInt16LE(opts.detectionDist ?? 0, 8);

  // Engineering-specific fields
  payload[10] = maxMovGate;
  payload[11] = maxStaGate;

  // Per-gate energies
  let offset = 12;
  for (let i = 0; i < numMovGates; i++) {
    payload[offset++] = movEnergies[i] ?? 0;
  }
  for (let i = 0; i < numStaGates; i++) {
    payload[offset++] = staEnergies[i] ?? 0;
  }

  // LD2410S trailing fields
  if (hasLight) payload[offset++] = opts.lightSensor;
  if (hasPin) payload[offset++] = opts.outputPin;

  return payload;
}
