// ==============================================================================
// Service Health Monitor
// ==============================================================================
// Periodically checks all HeartBeatz subsystems and reports their status.
// Provides auto-recovery for transient failures (e.g., BLE adapter resets,
// serial port disconnections, upstream WS drops).
//
// The health monitor emits events that the WS hub forwards to UI clients,
// so the kiosk touchscreen always shows current system health.
//
// Architecture:
//   HealthMonitor runs a check loop every N seconds. For each subsystem it:
//     1. Probes the service (ping, isAvailable, last heartbeat age)
//     2. Updates the health state map
//     3. Emits 'health:changed' if any service changed status
//     4. Attempts recovery for services that transitioned to 'down'
//
// Usage:
//   const monitor = new HealthMonitor({ config, discovery, ble, radar, ... });
//   monitor.start();
//   monitor.on('health:changed', (healthMap) => broadcast(healthMap));

import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Health Status Enum
// ---------------------------------------------------------------------------

/** @enum {string} */
const Status = {
  UP: 'up',
  DOWN: 'down',
  DEGRADED: 'degraded',
  SIMULATED: 'simulated',
  DISABLED: 'disabled',
  RECOVERING: 'recovering',
};

// ---------------------------------------------------------------------------
// Default check interval and thresholds
// ---------------------------------------------------------------------------

/** How often the health loop runs (ms). */
const DEFAULT_CHECK_INTERVAL_MS = 10_000;

/** If a service hasn't sent data in this many ms, consider it stale. */
const STALE_THRESHOLD_MS = 30_000;

/** Max consecutive failures before marking a service 'down'. */
const MAX_FAILURES_BEFORE_DOWN = 3;

/** Cooldown between recovery attempts for the same service (ms). */
const RECOVERY_COOLDOWN_MS = 30_000;

// ===========================================================================
// HealthMonitor
// ===========================================================================

export class HealthMonitor extends EventEmitter {
  /**
   * @param {Object}  opts
   * @param {Object}  opts.config      - App config
   * @param {Object}  opts.discovery   - DiscoveryService or SimulatorService
   * @param {Object}  opts.ble         - BleScanner or SimulatorService
   * @param {Object}  opts.radar       - RadarService or SimulatorService
   * @param {Object}  [opts.simulator] - SimulatorService (if demo mode)
   * @param {boolean} opts.demoMode    - Whether running in demo mode
   * @param {Object}  opts.logger      - Pino logger
   */
  constructor({ config, discovery, ble, radar, simulator, demoMode, logger }) {
    super();
    this.config = config;
    this.discovery = discovery;
    this.ble = ble;
    this.radar = radar;
    this.simulator = simulator || null;
    this.demoMode = demoMode || false;
    this.log = logger.child({ module: 'health-monitor' });

    // --- Internal state ---

    /** Current health status per service. */
    this._health = {
      sensing:   demoMode ? Status.SIMULATED : Status.UP,
      discovery: Status.UP,
      ble:       demoMode ? Status.SIMULATED : (config.ble.enabled ? Status.UP : Status.DISABLED),
      radar:     demoMode ? Status.SIMULATED : (config.radar.enabled ? Status.UP : Status.DISABLED),
      simulator: demoMode ? Status.UP : Status.DISABLED,
    };

    /** Consecutive failure count per service. */
    this._failures = { sensing: 0, discovery: 0, ble: 0, radar: 0, simulator: 0 };

    /** Timestamp of last successful probe per service. */
    this._lastSuccess = {};

    /** Timestamp of last recovery attempt per service. */
    this._lastRecovery = {};

    /** Timer handle for the check loop. */
    this._timer = null;

    /** Whether the monitor is running. */
    this._running = false;

    /** Uptime counter — when the monitor started. */
    this._startedAt = null;
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /** Start the periodic health check loop. */
  start() {
    if (this._running) return;
    this._running = true;
    this._startedAt = Date.now();

    const intervalMs = this.config.healthCheck?.intervalMs || DEFAULT_CHECK_INTERVAL_MS;
    this._timer = setInterval(() => this._runChecks(), intervalMs);

    // Run first check immediately
    this._runChecks();

    this.log.info({ intervalMs }, 'Health monitor started');
  }

  /** Stop the health check loop. */
  stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.log.info('Health monitor stopped');
  }

  /**
   * Get the current health status snapshot.
   * @returns {Object} Health map with overall status + per-service breakdown.
   */
  getHealth() {
    const services = { ...this._health };

    // Compute overall status: 'healthy' if all enabled services are up/simulated,
    // 'degraded' if any enabled service is degraded, 'down' if a critical one is down.
    const criticalServices = ['sensing', 'discovery'];
    const criticalDown = criticalServices.some((s) => services[s] === Status.DOWN);
    const anyDegraded = Object.values(services).some((s) => s === Status.DEGRADED);

    let overall = 'healthy';
    if (criticalDown) overall = 'down';
    else if (anyDegraded) overall = 'degraded';

    return {
      overall,
      demoMode: this.demoMode,
      uptime: this._startedAt ? Math.floor((Date.now() - this._startedAt) / 1000) : 0,
      services,
      failures: { ...this._failures },
      lastCheck: Date.now(),
    };
  }

  // =========================================================================
  // Internal: Health Check Loop
  // =========================================================================

  /** Run all health checks and emit changes. */
  async _runChecks() {
    const prev = { ...this._health };

    // --- Check each subsystem ---
    await this._checkSensing();
    this._checkDiscovery();
    this._checkBle();
    this._checkRadar();
    this._checkSimulator();

    // --- Detect changes and emit ---
    let changed = false;
    for (const [key, status] of Object.entries(this._health)) {
      if (status !== prev[key]) {
        changed = true;
        this.log.info(
          { service: key, from: prev[key], to: status },
          `Service status changed: ${key} ${prev[key]} → ${status}`
        );
      }
    }

    if (changed) {
      this.emit('health:changed', this.getHealth());
    }

    // --- Attempt recovery for down services ---
    this._attemptRecovery();
  }

  // ── Per-service checks ──

  /** Check upstream sensing server reachability. */
  async _checkSensing() {
    if (this.demoMode) {
      this._health.sensing = Status.SIMULATED;
      return;
    }

    try {
      const res = await fetch(`${this.config.sensing.baseUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        this._recordSuccess('sensing');
        this._health.sensing = Status.UP;
      } else {
        this._recordFailure('sensing');
      }
    } catch {
      this._recordFailure('sensing');
    }
  }

  /** Check node discovery service — are we seeing nodes? */
  _checkDiscovery() {
    const nodes = this.discovery.getNodes();
    const onlineCount = nodes.filter((n) => n.status === 'online').length;

    if (onlineCount > 0) {
      this._recordSuccess('discovery');
      this._health.discovery = Status.UP;
    } else if (this.demoMode) {
      // In demo mode, simulator should always have nodes
      this._health.discovery = nodes.length > 0 ? Status.UP : Status.DEGRADED;
    } else {
      // No nodes found — could be normal during startup, or a problem
      const age = Date.now() - (this._lastSuccess.discovery || this._startedAt || Date.now());
      if (age > STALE_THRESHOLD_MS) {
        this._recordFailure('discovery');
      } else {
        // Still within grace period — likely just starting up
        this._health.discovery = Status.DEGRADED;
      }
    }
  }

  /** Check BLE scanner health. */
  _checkBle() {
    if (this.demoMode) {
      this._health.ble = Status.SIMULATED;
      return;
    }
    if (!this.config.ble.enabled) {
      this._health.ble = Status.DISABLED;
      return;
    }

    if (this.ble.isAvailable) {
      this._recordSuccess('ble');
      this._health.ble = Status.UP;
    } else {
      this._recordFailure('ble');
    }
  }

  /** Check radar service health. */
  _checkRadar() {
    if (this.demoMode) {
      this._health.radar = Status.SIMULATED;
      return;
    }
    if (!this.config.radar.enabled) {
      this._health.radar = Status.DISABLED;
      return;
    }

    if (this.radar.isAvailable) {
      this._recordSuccess('radar');
      this._health.radar = Status.UP;
    } else {
      this._recordFailure('radar');
    }
  }

  /** Check simulator health (demo mode only). */
  _checkSimulator() {
    if (!this.demoMode || !this.simulator) {
      this._health.simulator = Status.DISABLED;
      return;
    }

    if (this.simulator.isRunning) {
      this._recordSuccess('simulator');
      this._health.simulator = Status.UP;
    } else {
      this._recordFailure('simulator');
    }
  }

  // =========================================================================
  // Failure Tracking
  // =========================================================================

  /**
   * Record a successful probe for a service.
   * Resets the failure counter and updates last-success timestamp.
   */
  _recordSuccess(service) {
    this._failures[service] = 0;
    this._lastSuccess[service] = Date.now();
  }

  /**
   * Record a failed probe for a service.
   * Increments failure counter; transitions to DOWN after threshold.
   */
  _recordFailure(service) {
    this._failures[service]++;
    if (this._failures[service] >= MAX_FAILURES_BEFORE_DOWN) {
      this._health[service] = Status.DOWN;
    } else {
      this._health[service] = Status.DEGRADED;
    }
  }

  // =========================================================================
  // Auto-Recovery
  // =========================================================================

  /**
   * Attempt to restart services that are in 'down' state.
   * Respects a cooldown to avoid rapid restart loops.
   */
  _attemptRecovery() {
    const now = Date.now();

    for (const [service, status] of Object.entries(this._health)) {
      if (status !== Status.DOWN) continue;

      const lastAttempt = this._lastRecovery[service] || 0;
      if (now - lastAttempt < RECOVERY_COOLDOWN_MS) continue;

      this._lastRecovery[service] = now;
      this._health[service] = Status.RECOVERING;
      this.log.warn({ service }, `Attempting recovery for ${service}`);

      try {
        this._recoverService(service);
      } catch (err) {
        this.log.error({ service, err: err.message }, `Recovery failed for ${service}`);
      }
    }
  }

  /**
   * Service-specific recovery logic.
   * Each service type has its own restart strategy.
   */
  _recoverService(service) {
    switch (service) {
      case 'simulator':
        // Restart the simulator if it stopped unexpectedly
        if (this.simulator && !this.simulator.isRunning) {
          this.log.info('Restarting simulator...');
          this.simulator.start();
          this.simulator.setScenario(this.config.demo.scenario);
        }
        break;

      case 'ble':
        // BLE adapter sometimes needs a restart after disconnect
        if (typeof this.ble.restart === 'function') {
          this.log.info('Restarting BLE scanner...');
          this.ble.restart();
        }
        break;

      case 'radar':
        // Serial port can drop — attempt reconnect
        if (typeof this.radar.reconnect === 'function') {
          this.log.info('Reconnecting radar serial port...');
          this.radar.reconnect();
        }
        break;

      case 'discovery':
        // Discovery is passive (polls sensing server), so just reset the failure count
        // and let it try again on the next poll cycle
        this._failures.discovery = 0;
        this.log.info('Reset discovery failure counter — will retry on next poll');
        break;

      case 'sensing':
        // Upstream server is external — nothing we can do except keep probing.
        // If it stays down, the UI should show a clear "sensing server offline" state.
        this._failures.sensing = 0;
        this.log.info('Reset sensing failure counter — will retry on next probe');
        break;
    }
  }
}
