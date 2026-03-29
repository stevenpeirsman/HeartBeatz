// ==============================================================================
// Demo Mode Simulator
// ==============================================================================
// Generates realistic synthetic data for trade show demos when real hardware
// (ESP32 nodes, BLE beacons, LD2410S radar) is not available.
//
// The simulator produces:
//   - Fake ESP32 node discovery data (3-4 nodes with realistic RSSI)
//   - CSI-derived vital signs (heart rate, breathing rate, motion, person count)
//   - BLE beacon sightings (patient wristbands + staff badges)
//   - LD2410S radar presence/motion readings
//
// Scenarios define time-based narratives that cycle through realistic states.
// This makes demos engaging — the audience sees data change as if a patient
// walks in, sits down, a nurse checks on them, etc.
//
// Usage:
//   Set DEMO_MODE=true in .env, or the simulator auto-activates when the
//   upstream sensing server is unreachable.
//
// Architecture:
//   Simulator emits the same events as the real Discovery, BLE, and Radar
//   services, so the WebSocket hub doesn't need to know the difference.

import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Scenario Definitions
// ---------------------------------------------------------------------------
// Each scenario is an array of phases. Each phase defines what the simulated
// sensors "see" for a given duration. Phases loop continuously.

/**
 * @typedef {Object} ScenarioPhase
 * @property {string}  label         - Human-readable phase name (shown in UI)
 * @property {number}  durationMs    - How long this phase lasts
 * @property {number}  persons       - Number of detected persons
 * @property {Object}  vitals        - Heart rate, breathing rate targets
 * @property {string}  motion        - 'none' | 'stationary' | 'moving' | 'both'
 * @property {Object[]} [beacons]    - BLE beacons visible in this phase
 * @property {Object}  [radar]       - Radar state override
 */

const SCENARIOS = {
  // ── Default: patient resting in bed, periodic nurse visit ──
  'patient-monitoring': {
    name: 'Patient Monitoring',
    description: 'Patient resting in bed with periodic nurse check-in',
    phases: [
      {
        label: 'Patient resting',
        durationMs: 20_000,
        persons: 1,
        vitals: { hr: [62, 68], br: [14, 16] },
        motion: 'stationary',
        beacons: [
          { mac: 'AA:BB:CC:DD:01:01', name: 'Patient — Room 3', role: 'patient', rssi: -55 },
        ],
        radar: { state: 'stationary', dist: 180 },
      },
      {
        label: 'Nurse enters room',
        durationMs: 5_000,
        persons: 2,
        vitals: { hr: [66, 72], br: [15, 17] },
        motion: 'both',
        beacons: [
          { mac: 'AA:BB:CC:DD:01:01', name: 'Patient — Room 3', role: 'patient', rssi: -55 },
          { mac: 'AA:BB:CC:DD:02:01', name: 'Nurse Johnson', role: 'staff', rssi: -48 },
        ],
        radar: { state: 'both', dist: 120 },
      },
      {
        label: 'Nurse checking vitals',
        durationMs: 15_000,
        persons: 2,
        vitals: { hr: [70, 76], br: [16, 18] },
        motion: 'stationary',
        beacons: [
          { mac: 'AA:BB:CC:DD:01:01', name: 'Patient — Room 3', role: 'patient', rssi: -52 },
          { mac: 'AA:BB:CC:DD:02:01', name: 'Nurse Johnson', role: 'staff', rssi: -42 },
        ],
        radar: { state: 'stationary', dist: 90 },
      },
      {
        label: 'Nurse leaves',
        durationMs: 5_000,
        persons: 1,
        vitals: { hr: [68, 72], br: [15, 17] },
        motion: 'moving',
        beacons: [
          { mac: 'AA:BB:CC:DD:01:01', name: 'Patient — Room 3', role: 'patient', rssi: -55 },
          { mac: 'AA:BB:CC:DD:02:01', name: 'Nurse Johnson', role: 'staff', rssi: -65 },
        ],
        radar: { state: 'moving', dist: 250 },
      },
      {
        label: 'Patient resting (post-check)',
        durationMs: 15_000,
        persons: 1,
        vitals: { hr: [64, 70], br: [14, 16] },
        motion: 'stationary',
        beacons: [
          { mac: 'AA:BB:CC:DD:01:01', name: 'Patient — Room 3', role: 'patient', rssi: -55 },
        ],
        radar: { state: 'stationary', dist: 180 },
      },
    ],
  },

  // ── Fall detection scenario ──
  'fall-detection': {
    name: 'Fall Detection',
    description: 'Patient gets up, falls, system alerts — great for safety demos',
    phases: [
      {
        label: 'Patient resting',
        durationMs: 12_000,
        persons: 1,
        vitals: { hr: [60, 65], br: [13, 15] },
        motion: 'stationary',
        beacons: [
          { mac: 'AA:BB:CC:DD:01:01', name: 'Patient — Room 3', role: 'patient', rssi: -55 },
        ],
        radar: { state: 'stationary', dist: 180 },
      },
      {
        label: 'Patient getting up',
        durationMs: 4_000,
        persons: 1,
        vitals: { hr: [72, 80], br: [18, 22] },
        motion: 'moving',
        beacons: [
          { mac: 'AA:BB:CC:DD:01:01', name: 'Patient — Room 3', role: 'patient', rssi: -50 },
        ],
        radar: { state: 'moving', dist: 150 },
      },
      {
        label: '⚠️ FALL DETECTED',
        durationMs: 8_000,
        persons: 1,
        vitals: { hr: [88, 102], br: [22, 28] },
        motion: 'stationary',       // sudden stop after fall
        alert: 'fall',
        beacons: [
          { mac: 'AA:BB:CC:DD:01:01', name: 'Patient — Room 3', role: 'patient', rssi: -48 },
        ],
        radar: { state: 'stationary', dist: 60 },   // closer to ground
      },
      {
        label: 'Staff responding',
        durationMs: 10_000,
        persons: 2,
        vitals: { hr: [92, 98], br: [20, 24] },
        motion: 'both',
        beacons: [
          { mac: 'AA:BB:CC:DD:01:01', name: 'Patient — Room 3', role: 'patient', rssi: -48 },
          { mac: 'AA:BB:CC:DD:02:01', name: 'Nurse Johnson', role: 'staff', rssi: -40 },
        ],
        radar: { state: 'both', dist: 80 },
      },
      {
        label: 'Patient stabilized',
        durationMs: 15_000,
        persons: 2,
        vitals: { hr: [76, 82], br: [16, 19] },
        motion: 'stationary',
        beacons: [
          { mac: 'AA:BB:CC:DD:01:01', name: 'Patient — Room 3', role: 'patient', rssi: -52 },
          { mac: 'AA:BB:CC:DD:02:01', name: 'Nurse Johnson', role: 'staff', rssi: -45 },
        ],
        radar: { state: 'stationary', dist: 100 },
      },
    ],
  },

  // ── Quiet room with occupancy tracking ──
  'occupancy-tracking': {
    name: 'Room Occupancy',
    description: 'People enter and leave a room — occupancy counting demo',
    phases: [
      {
        label: 'Empty room',
        durationMs: 8_000,
        persons: 0,
        vitals: { hr: [0, 0], br: [0, 0] },
        motion: 'none',
        beacons: [],
        radar: { state: 'none', dist: 0 },
      },
      {
        label: 'First person enters',
        durationMs: 10_000,
        persons: 1,
        vitals: { hr: [72, 78], br: [15, 17] },
        motion: 'moving',
        beacons: [
          { mac: 'AA:BB:CC:DD:03:01', name: 'Dr. Smith', role: 'staff', rssi: -50 },
        ],
        radar: { state: 'moving', dist: 200 },
      },
      {
        label: 'Second person enters',
        durationMs: 12_000,
        persons: 2,
        vitals: { hr: [70, 76], br: [14, 16] },
        motion: 'both',
        beacons: [
          { mac: 'AA:BB:CC:DD:03:01', name: 'Dr. Smith', role: 'staff', rssi: -48 },
          { mac: 'AA:BB:CC:DD:03:02', name: 'Visitor A', role: 'unknown', rssi: -58 },
        ],
        radar: { state: 'both', dist: 150 },
      },
      {
        label: 'Third person enters',
        durationMs: 12_000,
        persons: 3,
        vitals: { hr: [68, 74], br: [14, 16] },
        motion: 'stationary',
        beacons: [
          { mac: 'AA:BB:CC:DD:03:01', name: 'Dr. Smith', role: 'staff', rssi: -46 },
          { mac: 'AA:BB:CC:DD:03:02', name: 'Visitor A', role: 'unknown', rssi: -55 },
          { mac: 'AA:BB:CC:DD:03:03', name: 'Visitor B', role: 'unknown', rssi: -60 },
        ],
        radar: { state: 'stationary', dist: 120 },
      },
      {
        label: 'People leaving',
        durationMs: 8_000,
        persons: 1,
        vitals: { hr: [72, 76], br: [15, 17] },
        motion: 'moving',
        beacons: [
          { mac: 'AA:BB:CC:DD:03:01', name: 'Dr. Smith', role: 'staff', rssi: -50 },
        ],
        radar: { state: 'moving', dist: 250 },
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Simulated Node Definitions
// ---------------------------------------------------------------------------
// These represent the 3 ESP32-S3 sensor nodes that would be mounted in a room.

const SIMULATED_NODES = [
  {
    id: 'DEMO:AA:BB:CC:01',
    ip: '192.168.1.101',
    name: 'Wall Left',
    meta: { firmware: 'v1.0.0-demo', chipModel: 'ESP32-S3' },
  },
  {
    id: 'DEMO:AA:BB:CC:02',
    ip: '192.168.1.102',
    name: 'Wall Right',
    meta: { firmware: 'v1.0.0-demo', chipModel: 'ESP32-S3' },
  },
  {
    id: 'DEMO:AA:BB:CC:03',
    ip: '192.168.1.103',
    name: 'Ceiling',
    meta: { firmware: 'v1.0.0-demo', chipModel: 'ESP32-S3' },
  },
];

// ---------------------------------------------------------------------------
// SimulatorService
// ---------------------------------------------------------------------------

export class SimulatorService extends EventEmitter {
  /**
   * @param {Object} config  - Full app config
   * @param {Object} logger  - Pino logger
   */
  constructor(config, logger) {
    super();
    this.config = config;
    this.log = logger.child({ module: 'simulator' });

    this._running = false;
    this._tickTimer = null;
    this._scenarioId = 'patient-monitoring';     // Default scenario
    this._phaseIndex = 0;
    this._phaseStartedAt = 0;

    // Simulated service state — mirrors what Discovery, BLE, Radar expose
    this._nodes = new Map();
    this._beacons = new Map();
    this._lastRadar = null;
    this._lastVitals = null;

    // Tracking history: stores recent person positions for trail visualization.
    // Each entry: { persons: [{ x, y }], timestamp }
    this._trackingHistory = [];
    this._maxTrackingPoints = 200;  // ~20 seconds at 10Hz emission rate
  }

  // ── Public API (matches Discovery / BLE / Radar interfaces) ──

  /** Start generating simulated data on the configured tick interval. */
  start() {
    if (this._running) return;
    this._running = true;

    // Seed simulated nodes immediately
    this._initNodes();

    // Start the simulation tick loop (same rate as sensing server)
    const tickMs = this.config.sensing?.tickMs || 100;
    this._phaseStartedAt = Date.now();
    this._tickTimer = setInterval(() => this._tick(), tickMs);

    this.log.info(
      { scenario: this._scenarioId, tickMs },
      '🎬 Demo simulator started'
    );
  }

  /** Stop the simulation. */
  stop() {
    this._running = false;
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
    this.log.info('Demo simulator stopped');
  }

  /** Whether the simulator is actively running. */
  get isRunning() {
    return this._running;
  }

  // ── Node Discovery interface ──

  getNodes() {
    return Array.from(this._nodes.values());
  }

  getNode(id) {
    return this._nodes.get(id) || null;
  }

  setNodeName(id, name) {
    const node = this._nodes.get(id);
    if (node) {
      node.name = name;
      this.emit('node:updated', node);
    }
  }

  // ── BLE Beacon interface ──

  getBeacons() {
    return Array.from(this._beacons.values());
  }

  getByRole(role) {
    return this.getBeacons().filter((b) => b.role === role);
  }

  setBeaconIdentity(mac, name, role) {
    const beacon = this._beacons.get(mac);
    if (beacon) {
      beacon.name = name;
      beacon.role = role;
      this.emit('beacon:updated', beacon);
    }
  }

  get isAvailable() {
    return this._running;
  }

  // ── Radar interface ──

  get lastReading() {
    return this._lastRadar;
  }

  // ── Vitals (unique to simulator — sensing data) ──

  get lastVitals() {
    return this._lastVitals;
  }

  // ── Tracking history (for person movement trails on the room map) ──

  /** Get recent tracking positions for trail visualization. */
  getTrackingHistory(limit = 100) {
    return this._trackingHistory.slice(-limit);
  }

  // ── Scenario control ──

  /** Get list of available scenarios with metadata. */
  getScenarios() {
    return Object.entries(SCENARIOS).map(([id, s]) => ({
      id,
      name: s.name,
      description: s.description,
      phaseCount: s.phases.length,
      active: id === this._scenarioId,
    }));
  }

  /** Get the current scenario state (for UI display). */
  getStatus() {
    const scenario = SCENARIOS[this._scenarioId];
    const phase = scenario?.phases[this._phaseIndex];
    return {
      running: this._running,
      scenarioId: this._scenarioId,
      scenarioName: scenario?.name || 'Unknown',
      phaseIndex: this._phaseIndex,
      phaseLabel: phase?.label || '',
      phaseCount: scenario?.phases.length || 0,
      alert: phase?.alert || null,
    };
  }

  /** Switch to a different scenario. */
  setScenario(scenarioId) {
    if (!SCENARIOS[scenarioId]) {
      this.log.warn({ scenarioId }, 'Unknown scenario');
      return false;
    }
    this._scenarioId = scenarioId;
    this._phaseIndex = 0;
    this._phaseStartedAt = Date.now();
    this.log.info({ scenario: scenarioId }, 'Scenario changed');
    this.emit('scenario:changed', this.getStatus());
    return true;
  }

  // ---------------------------------------------------------------------------
  // Internal: tick loop — called at sensing rate (~10Hz)
  // ---------------------------------------------------------------------------

  _tick() {
    const scenario = SCENARIOS[this._scenarioId];
    if (!scenario) return;

    const phase = scenario.phases[this._phaseIndex];
    if (!phase) return;

    const now = Date.now();
    const elapsed = now - this._phaseStartedAt;

    // Advance to next phase if duration exceeded
    if (elapsed >= phase.durationMs) {
      this._phaseIndex = (this._phaseIndex + 1) % scenario.phases.length;
      this._phaseStartedAt = now;
      const newPhase = scenario.phases[this._phaseIndex];
      this.log.debug({ phase: newPhase.label }, 'Phase transition');
      this.emit('phase:changed', {
        ...this.getStatus(),
        phase: newPhase,
      });
    }

    // Generate data for current phase
    this._generateNodeData(phase);
    this._generateVitals(phase);
    this._generateBeacons(phase);
    this._generateRadar(phase);
  }

  // ── Simulated nodes: add RSSI jitter to feel realistic ──

  _initNodes() {
    for (const def of SIMULATED_NODES) {
      const node = {
        ...def,
        rssi: -45 + jitter(5),
        status: 'online',
        lastSeen: Date.now(),
      };
      this._nodes.set(def.id, node);
      this.emit('node:discovered', node);
    }
    this.emit('discovery:complete', this.getNodes());
  }

  _generateNodeData(phase) {
    // Update RSSI with slight jitter (realistic WiFi fluctuation)
    for (const [, node] of this._nodes) {
      node.rssi = -45 + jitter(3);
      node.lastSeen = Date.now();
    }

    // Throttle node broadcasts to ~1Hz (not every tick)
    if (Date.now() % 1000 < (this.config.sensing?.tickMs || 100)) {
      this.emit('discovery:complete', this.getNodes());
    }
  }

  // ── Simulated vitals: smoothly interpolated with natural variation ──

  _generateVitals(phase) {
    const [hrMin, hrMax] = phase.vitals.hr;
    const [brMin, brMax] = phase.vitals.br;

    // Slow sine wave + jitter produces realistic-looking vital signs
    const t = Date.now() / 1000;
    const hrBase = lerp(hrMin, hrMax, (Math.sin(t * 0.15) + 1) / 2);
    const brBase = lerp(brMin, brMax, (Math.sin(t * 0.1 + 1) + 1) / 2);

    this._lastVitals = {
      heart_rate: phase.persons > 0 ? Math.round(hrBase + jitter(2)) : 0,
      breathing_rate: phase.persons > 0 ? Math.round(brBase + jitter(1)) : 0,
      motion_state: phase.motion,
      person_count: phase.persons,
      timestamp: Date.now(),
      // Additional fields the sensing server would send
      confidence: 0.85 + Math.random() * 0.14,
      csi_quality: 0.7 + Math.random() * 0.25,
    };

    // Generate simulated person positions (normalized 0-1 within the room)
    // Uses smooth curves so trails look natural rather than random
    const persons = [];
    for (let p = 0; p < phase.persons; p++) {
      persons.push({
        x: 0.5 + Math.sin(t * 0.3 + p * 2.1) * 0.2,
        y: 0.5 + Math.cos(t * 0.25 + p * 1.7) * 0.2,
      });
    }

    // Record in tracking history (for trail rendering)
    this._trackingHistory.push({
      persons,
      timestamp: Date.now(),
    });
    if (this._trackingHistory.length > this._maxTrackingPoints) {
      this._trackingHistory.shift();
    }

    // Attach positions to vitals so the UI can render them directly
    this._lastVitals.persons_positions = persons;

    // Emit as a sensing frame (same structure the WS hub expects)
    this.emit('sensing:frame', {
      type: 'sensing',
      data: this._lastVitals,
    });
  }

  // ── Simulated BLE beacons ──

  _generateBeacons(phase) {
    const currentMacs = new Set();

    for (const def of phase.beacons || []) {
      currentMacs.add(def.mac);
      const existing = this._beacons.get(def.mac);

      const sighting = {
        mac: def.mac,
        rssi: def.rssi + jitter(3),
        type: 'ibeacon',
        name: existing?.name || def.name,
        role: existing?.role || def.role,
        timestamp: Date.now(),
      };

      const isNew = !this._beacons.has(def.mac);
      this._beacons.set(def.mac, sighting);

      if (isNew) {
        this.emit('beacon:discovered', sighting);
      }

      // Throttle sighting events to ~2Hz
      if (Date.now() % 500 < (this.config.sensing?.tickMs || 100)) {
        this.emit('beacon:sighting', sighting);
      }
    }

    // Remove beacons that left the scene
    for (const [mac] of this._beacons) {
      if (!currentMacs.has(mac)) {
        const beacon = this._beacons.get(mac);
        this._beacons.delete(mac);
        this.emit('beacon:lost', beacon);
      }
    }
  }

  // ── Simulated radar ──

  _generateRadar(phase) {
    if (!phase.radar) {
      this._lastRadar = null;
      return;
    }

    const dist = phase.radar.dist + jitter(8);
    const energy = phase.radar.state === 'none' ? 0 : 40 + Math.round(Math.random() * 50);

    this._lastRadar = {
      state: phase.radar.state,
      movingDist: phase.radar.state === 'moving' || phase.radar.state === 'both' ? dist : 0,
      movingEnergy: phase.radar.state === 'moving' || phase.radar.state === 'both' ? energy : 0,
      stationaryDist: phase.radar.state === 'stationary' || phase.radar.state === 'both' ? dist : 0,
      stationaryEnergy: phase.radar.state === 'stationary' || phase.radar.state === 'both' ? energy : 0,
      detectionDist: dist,
      timestamp: Date.now(),
    };

    // Throttle radar events to ~5Hz
    if (Date.now() % 200 < (this.config.sensing?.tickMs || 100)) {
      this.emit('reading', this._lastRadar);
    }
  }
}

// ---------------------------------------------------------------------------
// Utility Helpers
// ---------------------------------------------------------------------------

/** Add small random noise around zero. */
function jitter(magnitude) {
  return (Math.random() - 0.5) * 2 * magnitude;
}

/** Linear interpolation between a and b by factor t (0-1). */
function lerp(a, b, t) {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}
