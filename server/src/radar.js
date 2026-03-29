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
// Frame format (engineering mode):
//   Header: F4 F3 F2 F1
//   Length: 2 bytes (little-endian)
//   Payload: type byte + data
//   Tail:   F8 F7 F6 F5
//
// This module is optional — if serialport is not available or no radar is
// connected, it gracefully degrades to a no-op.

import { EventEmitter } from 'events';

// LD2410S frame delimiters
const FRAME_HEADER = Buffer.from([0xf4, 0xf3, 0xf2, 0xf1]);
const FRAME_TAIL = Buffer.from([0xf8, 0xf7, 0xf6, 0xf5]);

/**
 * @typedef {Object} RadarReading
 * @property {string}  state          - 'none' | 'moving' | 'stationary' | 'both'
 * @property {number}  movingDist     - Moving target distance in cm
 * @property {number}  movingEnergy   - Moving target energy (0-100)
 * @property {number}  stationaryDist - Stationary target distance in cm
 * @property {number}  stationaryEnergy - Stationary target energy (0-100)
 * @property {number}  detectionDist  - Overall detection distance in cm
 * @property {number}  timestamp      - Unix timestamp (ms)
 */

export class RadarService extends EventEmitter {
  /**
   * @param {Object} config - config.radar
   * @param {Object} logger - pino logger
   */
  constructor(config, logger) {
    super();
    this.config = config;
    this.log = logger.child({ module: 'radar' });
    this._port = null;
    this._buffer = Buffer.alloc(0);
    this._lastReading = null;
    this._available = false;
  }

  /** Attempt to open serial connection to LD2410S. */
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
      this.log.info({ port: portPath }, 'LD2410S radar connected');
    } catch (err) {
      this.log.warn({ err: err.message, port: portPath }, 'Failed to open radar port');
    }
  }

  /** Close serial connection. */
  stop() {
    if (this._port?.isOpen) {
      this._port.close();
    }
  }

  /** Whether the radar is connected and sending data. */
  get isAvailable() {
    return this._available;
  }

  /** Get the most recent radar reading. */
  get lastReading() {
    return this._lastReading;
  }

  // ---------------------------------------------------------------------------
  // Internal: frame parsing
  // ---------------------------------------------------------------------------

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);

    // Process all complete frames in the buffer
    while (this._buffer.length >= 10) {
      const headerIdx = this._buffer.indexOf(FRAME_HEADER);
      if (headerIdx === -1) {
        // No header found — discard buffer
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
      const frameLen = 4 + 2 + dataLen + 4; // header + len + payload + tail

      if (this._buffer.length < frameLen) break;

      // Verify tail
      const tailStart = frameLen - 4;
      if (this._buffer.subarray(tailStart, tailStart + 4).equals(FRAME_TAIL)) {
        const payload = this._buffer.subarray(6, 6 + dataLen);
        this._parseFrame(payload);
      }

      this._buffer = this._buffer.subarray(frameLen);
    }

    // Prevent buffer from growing unbounded
    if (this._buffer.length > 1024) {
      this._buffer = this._buffer.subarray(-256);
    }
  }

  _parseFrame(payload) {
    // Engineering mode report: type 0x01 or 0x02
    if (payload.length < 8) return;

    const type = payload[0];
    // 0x02 = engineering mode, 0x01 = basic mode
    if (type !== 0x01 && type !== 0x02) return;

    const stateCode = payload[1];
    const states = ['none', 'moving', 'stationary', 'both'];

    /** @type {RadarReading} */
    const reading = {
      state: states[stateCode] || 'none',
      movingDist: payload.readUInt16LE(2),
      movingEnergy: payload[4],
      stationaryDist: payload.readUInt16LE(5),
      stationaryEnergy: payload[7],
      detectionDist: payload.length >= 10 ? payload.readUInt16LE(8) : 0,
      timestamp: Date.now(),
    };

    this._lastReading = reading;
    this.emit('reading', reading);
  }

  /**
   * Auto-detect LD2410S serial port by scanning /dev/ttyUSB* and /dev/ttyACM*.
   * @param {Function} SerialPort
   * @returns {Promise<string|null>}
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
