// ==============================================================================
// HeartBeatz Shared Constants
// ==============================================================================
// Single source of truth for all DSP, protocol, and system constants used
// across feature extraction, calibration, and ground truth modules.
//
// IMPORTANT: When adding new constants, document the physical meaning and units.
// ==============================================================================

// ---------------------------------------------------------------------------
// ADR-018 Protocol Constants
// ---------------------------------------------------------------------------

/** Magic number identifying ADR-018 CSI frames (big-endian). */
export const ADR018_MAGIC = 0xC5110001;

/** Fixed header size in bytes: 4 magic + 2 ver + 6 mac + 4 seq + 4 ts + 2 csi_len */
export const ADR018_HEADER_SIZE = 22;

// ---------------------------------------------------------------------------
// ESP32-S3 CSI Configuration
// ---------------------------------------------------------------------------

/**
 * Number of subcarriers in a 20 MHz 802.11n HT20 CSI frame from ESP32-S3.
 * These are OFDM subcarriers indexed -26 to +26 (excluding DC at 0 and nulls).
 * The ESP32 reports 52 usable subcarriers as interleaved I/Q pairs.
 */
export const NUM_SUBCARRIERS = 52;

/**
 * Number of I/Q bytes per subcarrier (1 byte I + 1 byte Q, signed int8).
 */
export const BYTES_PER_SUBCARRIER = 2;

/**
 * Expected CSI data payload size in bytes.
 */
export const CSI_PAYLOAD_BYTES = NUM_SUBCARRIERS * BYTES_PER_SUBCARRIER;

/**
 * Channel bandwidth in MHz for the 802.11n HT20 configuration.
 */
export const CHANNEL_BANDWIDTH_MHZ = 20;

/**
 * Subcarrier spacing in kHz for 802.11 OFDM with 20 MHz bandwidth.
 * Calculated as 20 MHz / 64 FFT points = 312.5 kHz.
 */
export const SUBCARRIER_SPACING_KHZ = 312.5;

// ---------------------------------------------------------------------------
// Subcarrier Grouping — 8 Logical Bands
// ---------------------------------------------------------------------------
// Subcarriers are grouped into 8 bands for spatially-aware feature extraction.
// The 52 subcarriers map to OFDM indices -26..-1, +1..+26 (DC null at 0).
// We group them by sequential position in the I/Q array (indices 0..51):
//
//   Band 0: subcarriers  0- 5  (OFDM -26 to -21) — lowest negative freq
//   Band 1: subcarriers  6-12  (OFDM -20 to -14)
//   Band 2: subcarriers 13-19  (OFDM -13 to  -7)
//   Band 3: subcarriers 20-25  (OFDM  -6 to  -1) — near DC (negative side)
//   Band 4: subcarriers 26-31  (OFDM  +1 to  +6) — near DC (positive side)
//   Band 5: subcarriers 32-38  (OFDM  +7 to +13)
//   Band 6: subcarriers 39-45  (OFDM +14 to +20)
//   Band 7: subcarriers 46-51  (OFDM +21 to +26) — highest positive freq
//
// Design rationale:
//   - Even 6-7 subcarriers per band for balanced statistics
//   - Bands 3+4 (near DC) are most sensitive to slow-moving/static changes
//   - Bands 0+7 (edge) are most sensitive to multipath and fast motion
//   - 8 bands balances spatial resolution vs. per-band sample size

/** Number of logical frequency bands for subcarrier grouping. */
export const NUM_BANDS = 8;

/**
 * Subcarrier band definitions.
 * Each band specifies the start (inclusive) and end (exclusive) subcarrier index.
 * @type {ReadonlyArray<{start: number, end: number, label: string}>}
 */
export const SUBCARRIER_BANDS = Object.freeze([
  { start:  0, end:  6, label: 'edge-neg'   },  // Band 0: OFDM -26..-21
  { start:  6, end: 13, label: 'mid-neg'    },  // Band 1: OFDM -20..-14
  { start: 13, end: 20, label: 'inner-neg'  },  // Band 2: OFDM -13..-7
  { start: 20, end: 26, label: 'dc-neg'     },  // Band 3: OFDM -6..-1
  { start: 26, end: 32, label: 'dc-pos'     },  // Band 4: OFDM +1..+6
  { start: 32, end: 39, label: 'inner-pos'  },  // Band 5: OFDM +7..+13
  { start: 39, end: 46, label: 'mid-pos'    },  // Band 6: OFDM +14..+20
  { start: 46, end: 52, label: 'edge-pos'   },  // Band 7: OFDM +21..+26
]);

// ---------------------------------------------------------------------------
// EMA Smoothing Factors
// ---------------------------------------------------------------------------
// Alpha in range (0, 1]. Lower = more smoothing, longer memory.
// Half-life ≈ -ln(2) / ln(1 - alpha). E.g., alpha=0.002 → ~346 frames ≈ 13.9s at 25 Hz.

/** EMA alpha for person count — very slow to prevent jitter. */
export const EMA_ALPHA_PERSON_COUNT = 0.002;

/** EMA alpha for heart rate estimate. */
export const EMA_ALPHA_HEART_RATE = 0.12;

/** EMA alpha for breathing rate estimate. */
export const EMA_ALPHA_BREATHING = 0.08;

/** EMA alpha for motion level — fast to catch sudden movement. */
export const EMA_ALPHA_MOTION = 0.30;

// ---------------------------------------------------------------------------
// Calibration Parameters
// ---------------------------------------------------------------------------

/** Number of frames required for initial calibration (~6s at 25 Hz). */
export const CALIBRATION_FRAMES = 150;

// ---------------------------------------------------------------------------
// Rolling Recalibration (v3)
// ---------------------------------------------------------------------------

/** Sliding window duration (seconds) for finding quiet periods. */
export const RECAL_WINDOW_S = 120;

/** How often (seconds) to re-evaluate the baseline. */
export const RECAL_INTERVAL_S = 30;

/** Percentile of variance history used as the "quiet floor". */
export const RECAL_QUIET_PERCENTILE = 10;

/** Minimum frames before first recalibration attempt. */
export const RECAL_MIN_FRAMES = 500;

/** Maximum baseline shift per cycle (damping). */
export const RECAL_MAX_SHIFT = 0.5;

/** Blend factor for new baseline (0=keep old, 1=fully new). */
export const RECAL_BLEND_ALPHA = 0.3;

// ---------------------------------------------------------------------------
// Vital Sign Frequency Ranges (Hz)
// ---------------------------------------------------------------------------

/** Breathing rate range: 9-30 breaths per minute → 0.15-0.5 Hz. */
export const BREATHING_FREQ_MIN = 0.15;
export const BREATHING_FREQ_MAX = 0.50;

/** Heart rate range: 48-150 BPM → 0.8-2.5 Hz. */
export const HEART_FREQ_MIN = 0.8;
export const HEART_FREQ_MAX = 2.5;

// ---------------------------------------------------------------------------
// Buffer Sizes (frames)
// ---------------------------------------------------------------------------

/** Amplitude history window (~20s at 20 Hz). */
export const AMPLITUDE_WINDOW_SIZE = 400;

/** Variance tracking window (~2s at 25 Hz, responsive). */
export const VARIANCE_WINDOW_SIZE = 50;

/** Breathing analysis window (~10s at 20 Hz, needs ≥2 full cycles). */
export const BREATHING_WINDOW_SIZE = 200;

/** Heart rate analysis window (~8s at 20 Hz). */
export const HEART_WINDOW_SIZE = 160;

/** Per-subcarrier history window (~3s at 20 Hz). */
export const SUBCARRIER_WINDOW_SIZE = 60;

/** Median filter buffer for raw person count (~1.4s at 25 Hz). */
export const RAW_COUNT_BUFFER_SIZE = 35;

/** Heatmap ring buffer depth (~5s at 20 Hz). */
export const HEATMAP_BUFFER_SIZE = 100;

// ---------------------------------------------------------------------------
// Network Ports (defaults)
// ---------------------------------------------------------------------------

/** UDP port for receiving CSI frames from ESP32 nodes. */
export const DEFAULT_UDP_PORT = 5005;

/** HTTP port for REST API and heatmap. */
export const DEFAULT_HTTP_PORT = 3000;

/** WebSocket port for real-time streaming. */
export const DEFAULT_WS_PORT = 3001;

/** Output tick interval in milliseconds (10 Hz output rate). */
export const DEFAULT_TICK_MS = 100;

// ---------------------------------------------------------------------------
// Performance Targets
// ---------------------------------------------------------------------------

/** Maximum CPU usage target on MeLE N100 (fraction). */
export const MAX_CPU_FRACTION = 0.40;

/** Maximum frames per second per node to stay within CPU budget. */
export const TARGET_FPS_PER_NODE = 20;

/** Maximum number of ESP32 nodes supported simultaneously. */
export const MAX_NODES = 8;
