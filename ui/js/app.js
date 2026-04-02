// ==============================================================================
// HeartBeatz UI — Main Application
// ==============================================================================
// Single-page app for the 7" kiosk touchscreen.
// Flow: Splash → Setup Wizard (discovery + calibration) → Live Dashboard
// Connects via REST polling (splash/setup) then upgrades to WebSocket (dashboard).

(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------
  const API = '/api';
  const WS_PATH = '/ws/live';
  const POLL_INTERVAL = 2000;       // ms — health/node polling during setup
  const CANVAS_FPS = 20;            // Room map redraw rate

  // WebSocket reconnection: exponential backoff parameters
  const WS_RECONNECT_BASE_MS = 1000;   // Start at 1 second
  const WS_RECONNECT_MAX_MS = 30000;   // Cap at 30 seconds
  const WS_RECONNECT_MULTIPLIER = 1.5; // Multiply delay on each failure

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  const state = {
    screen: 'splash',               // 'splash' | 'setup' | 'dashboard'
    setupStep: 1,                    // 1 = discovery, 2 = calibration
    nodes: [],
    beacons: [],
    radar: null,
    sensing: null,                   // Latest sensing frame from WS
    vitals: { hr: '--', br: '--', motion: 'None', persons: 0 },
    calibrating: false,
    config: {},
    // Demo mode state
    demoMode: false,
    demo: null,                      // { scenarioId, scenarioName, phaseLabel, alert, ... }
    // Connection health state (tracks server and WS connectivity)
    connection: {
      ws: 'disconnected',           // 'connected' | 'connecting' | 'disconnected'
      server: 'unknown',            // 'up' | 'down' | 'unknown'
      lastWsConnect: null,          // Timestamp of last successful WS connection
      wsReconnectAttempts: 0,       // Consecutive WS reconnect attempts
      health: null,                 // Last health snapshot from server
    },
  };

  /** @type {WebSocket|null} */
  let ws = null;
  let pollTimer = null;
  let canvasTimer = null;

  /** Current WS reconnect delay (increases with exponential backoff). */
  let _wsReconnectDelay = WS_RECONNECT_BASE_MS;

  /** Timer for WS reconnect scheduling. */
  let _wsReconnectTimer = null;

  /** @type {RoomMap|null} Enhanced room map instance (created on dashboard entry) */
  let roomMap = null;

  /** @type {VitalsChart|null} Enhanced vitals chart instance (created on dashboard entry) */
  let vitalsChart = null;

  // -------------------------------------------------------------------------
  // DOM Refs
  // -------------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // -------------------------------------------------------------------------
  // Screen Management
  // -------------------------------------------------------------------------
  function showScreen(name) {
    $$('.screen').forEach((el) => el.classList.remove('active'));
    $(`#${name}`).classList.add('active');
    state.screen = name;
  }

  function showSetupStep(step) {
    $$('.setup-step').forEach((el) => el.classList.remove('active'));
    $(`#setupStep${step}`).classList.add('active');
    state.setupStep = step;
  }

  // -------------------------------------------------------------------------
  // Splash Screen
  // -------------------------------------------------------------------------
  async function runSplash() {
    const bar = $('#splashBar');
    const status = $('#splashStatus');
    let progress = 0;

    const tick = () => {
      progress = Math.min(progress + 2, 90);
      bar.style.width = progress + '%';
    };
    const interval = setInterval(tick, 200);

    status.textContent = 'Connecting to sensing server...';

    // Poll health until the sensing server is up
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`${API}/health`);
        const data = await res.json();
        if (data.services?.sensing === 'up' || data.services?.sensing === 'simulated' || data.demoMode) {
          ready = true;
          if (data.demoMode) state.demoMode = true;
          break;
        }
        status.textContent = `Waiting for sensing server... (${i * 2}s)`;
      } catch {
        status.textContent = `Waiting for HeartBeatz server... (${i * 2}s)`;
      }
      await sleep(2000);
    }

    clearInterval(interval);
    bar.style.width = '100%';

    if (!ready) {
      status.textContent = 'Sensing server not available — entering demo mode';
      state.demoMode = true;
      await sleep(1500);
    } else {
      status.textContent = 'Ready!';
      await sleep(600);
    }

    // Check if first-run is complete — skip setup if so
    // In demo mode, the server reports firstRunComplete=true and provides nodes
    try {
      const res = await fetch(`${API}/status`);
      const data = await res.json();
      state.config = data;
      if (data.demoMode) {
        state.demoMode = true;
        state.demo = data.demo || null;
      }
      if (data.firstRunComplete && data.nodes?.length > 0) {
        state.nodes = data.nodes;
        enterDashboard();
        return;
      }
    } catch { /* proceed to setup */ }

    showScreen('setup');
    showSetupStep(1);
    startNodeDiscoveryPoll();
  }

  // -------------------------------------------------------------------------
  // Setup: Node Discovery
  // -------------------------------------------------------------------------
  function startNodeDiscoveryPoll() {
    pollTimer = setInterval(pollNodes, POLL_INTERVAL);
    pollNodes();
  }

  async function pollNodes() {
    try {
      const res = await fetch(`${API}/nodes`);
      const data = await res.json();
      state.nodes = data.nodes || [];
      renderNodeGrid();
    } catch { /* server not ready */ }
  }

  function renderNodeGrid() {
    const grid = $('#nodeGrid');
    const count = $('#nodeCount');
    const btn = $('#btnContinueToCalibrate');

    grid.innerHTML = state.nodes.map((n) => `
      <div class="node-card ${n.status}">
        <div class="node-name">${esc(n.name)}</div>
        <div class="node-id">${esc(n.id)}</div>
        <div class="node-rssi">RSSI: ${n.rssi} dBm</div>
        <div class="node-meta">${n.ip || 'discovering...'}</div>
      </div>
    `).join('');

    const onlineCount = state.nodes.filter((n) => n.status === 'online').length;
    count.textContent = onlineCount;
    btn.disabled = onlineCount === 0;
  }

  // -------------------------------------------------------------------------
  // Setup: Calibration
  // -------------------------------------------------------------------------
  async function startCalibration() {
    state.calibrating = true;
    const ring = $('.calibrate-ring');
    const label = $('#calibrateLabel');

    ring.classList.add('active');
    label.textContent = 'Calibrating...';
    $('#btnCalibrate').disabled = true;

    try {
      await fetch(`${API}/calibrate`, { method: 'POST' });
    } catch { /* */ }

    // Poll for calibration completion
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      try {
        const res = await fetch(`${API}/status`);
        const data = await res.json();
        if (data.calibration?.status === 'complete') {
          ring.classList.remove('active');
          ring.classList.add('done');
          label.textContent = 'Calibrated!';
          await sleep(1000);
          enterDashboard();
          return;
        }
        label.textContent = `Calibrating... ${i + 1}s`;
      } catch { /* */ }
    }

    // Timeout — enter dashboard anyway
    ring.classList.remove('active');
    label.textContent = 'Timeout — entering dashboard';
    await sleep(800);
    enterDashboard();
  }

  function skipCalibration() {
    clearInterval(pollTimer);
    enterDashboard();
  }

  // -------------------------------------------------------------------------
  // Dashboard
  // -------------------------------------------------------------------------
  function enterDashboard() {
    clearInterval(pollTimer);
    showScreen('dashboard');
    connectWebSocket();
    startCanvasLoop();
    updateDashIndicators();
    renderBeaconList();    // Initial beacon render from snapshot data

    // Initialize enhanced room map (replaces basic drawRoomMap)
    initRoomMap();

    // Initialize enhanced vitals charts (replaces basic renderVitals)
    initVitalsChart();

    // Initialize demo mode UI if active
    if (state.demoMode) {
      initDemoUI();
    }
  }

  /**
   * Initialize the enhanced room map module.
   * Creates a RoomMap instance and wires up edit mode controls.
   */
  function initRoomMap() {
    const canvas = $('#roomCanvas');
    if (!canvas || !window.RoomMap) return;

    // Person detail panel elements
    const personPanel  = $('#personDetail');
    const btnClosePD   = $('#btnClosePersonDetail');

    // Create the enhanced room map, passing shared state
    roomMap = new window.RoomMap(canvas, state, {
      /** Called when the user drags a node to a new position. */
      onNodeMoved: (nodeId, position) => {
        // Persist the position to the server
        fetch(`${API}/nodes/${encodeURIComponent(nodeId)}/position`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(position),
        }).catch(() => {});
      },

      /** Called when the user taps a person dot on the room map. */
      onPersonTapped: (_personIndex, _position, detail) => {
        if (!personPanel) return;
        // Populate the detail panel
        $('#personDetailName').textContent = detail.label || `Person ${detail.id}`;
        $('#pdHeartRate').textContent     = detail.heartRate   ? `${Math.round(detail.heartRate)} bpm` : '--';
        $('#pdBreathingRate').textContent = detail.breathingRate ? `${Math.round(detail.breathingRate)} rpm` : '--';
        $('#pdMotion').textContent        = detail.motionState || '--';
        $('#pdConfidence').textContent    = detail.confidence  ? `${Math.round(detail.confidence * 100)}%` : '--';
        $('#pdZone').textContent          = detail.zone        || '--';
        $('#pdDetectedBy').textContent    = detail.detectedBy  || '--';
        // Show the panel (slide up)
        personPanel.classList.remove('hidden');
      },
    });

    // Close person detail panel
    if (btnClosePD) {
      btnClosePD.addEventListener('click', () => {
        personPanel.classList.add('hidden');
      });
    }

    // Load saved node positions from server
    roomMap.loadLayout();

    // Wire up reset button (clear saved positions)
    const btnReset = $('#btnMapReset');
    if (btnReset) {
      btnReset.addEventListener('click', () => {
        roomMap.nodePositions.clear();
        // Could also clear from server — for now just local reset
      });
    }
  }

  // -------------------------------------------------------------------------
  // Vitals Chart Initialization
  // -------------------------------------------------------------------------

  /**
   * Initialize the VitalsChart module and attach canvas elements.
   * Creates a VitalsChart instance that accumulates vitals readings
   * over time and renders live animated sparkline charts.
   */
  function initVitalsChart() {
    if (!window.VitalsChart) return;

    vitalsChart = new window.VitalsChart({ maxPoints: 120 });

    // Attach the four chart canvases
    vitalsChart.setCanvases({
      hr:      $('#hrChart'),
      br:      $('#brChart'),
      motion:  $('#motionChart'),
      quality: $('#qualityChart'),
    });

    // Size canvases to fill their containers (must match pixel resolution)
    resizeVitalsCanvases();
    window.addEventListener('resize', resizeVitalsCanvases);
  }

  /**
   * Resize all vitals chart canvases to match their container dimensions.
   * Called on init and window resize.
   */
  function resizeVitalsCanvases() {
    const ids = ['hrChart', 'brChart', 'motionChart', 'qualityChart'];
    for (const id of ids) {
      const canvas = $(`#${id}`);
      if (!canvas) continue;
      const parent = canvas.parentElement;
      canvas.width = parent.clientWidth;
      canvas.height = parent.clientHeight;
    }
  }

  // -------------------------------------------------------------------------
  // WebSocket Connection (with exponential backoff reconnection)
  // -------------------------------------------------------------------------

  /**
   * Connect to the server WebSocket. Uses exponential backoff on failure:
   * starts at 1s, increases 1.5× per attempt, caps at 30s.
   * Resets to base delay on successful connection.
   */
  function connectWebSocket() {
    // Clean up any pending reconnect timer
    if (_wsReconnectTimer) {
      clearTimeout(_wsReconnectTimer);
      _wsReconnectTimer = null;
    }

    state.connection.ws = 'connecting';
    updateConnectionIndicator();

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}${WS_PATH}`;

    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.error('[WS] Failed to create WebSocket:', err.message);
      scheduleWsReconnect();
      return;
    }

    ws.onopen = () => {
      console.log('[WS] Connected');
      state.connection.ws = 'connected';
      state.connection.server = 'up';
      state.connection.lastWsConnect = Date.now();
      state.connection.wsReconnectAttempts = 0;
      _wsReconnectDelay = WS_RECONNECT_BASE_MS; // Reset backoff
      updateConnectionIndicator();
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        handleWsMessage(msg);
      } catch { /* binary or malformed — ignore gracefully */ }
    };

    ws.onclose = (evt) => {
      const wasClean = evt.wasClean;
      console.log(`[WS] Disconnected (clean=${wasClean}, code=${evt.code})`);
      state.connection.ws = 'disconnected';
      updateConnectionIndicator();
      scheduleWsReconnect();
    };

    ws.onerror = (err) => {
      // Error events don't carry useful info in browsers, but log for debug
      console.warn('[WS] Error event — will attempt reconnect');
    };
  }

  /**
   * Schedule a WebSocket reconnection with exponential backoff.
   * The delay increases each attempt: 1s → 1.5s → 2.25s → ... → max 30s.
   */
  function scheduleWsReconnect() {
    state.connection.wsReconnectAttempts++;
    const attempt = state.connection.wsReconnectAttempts;
    const delay = Math.min(_wsReconnectDelay, WS_RECONNECT_MAX_MS);
    _wsReconnectDelay = Math.min(_wsReconnectDelay * WS_RECONNECT_MULTIPLIER, WS_RECONNECT_MAX_MS);

    console.log(`[WS] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt #${attempt})`);

    _wsReconnectTimer = setTimeout(connectWebSocket, delay);
  }

  function handleWsMessage(msg) {
    switch (msg.type) {
      case 'snapshot':
        state.nodes = msg.nodes || [];
        state.beacons = msg.beacons || [];
        state.radar = msg.radar;
        renderBeaconList();
        if (msg.demoMode) {
          state.demoMode = true;
          state.demo = msg.demo || null;
          initDemoUI();
        }
        break;
      case 'nodes':
        state.nodes = msg.nodes || [];
        break;
      case 'sensing':
        state.sensing = msg.data;
        extractVitals(msg.data);
        break;
      case 'beacon':
        updateBeacon(msg.beacon, false);
        break;
      case 'beacon:discovered':
        updateBeacon(msg.beacon, true);
        addLogEntry('enter', `${msg.beacon.name || msg.beacon.mac} detected`);
        break;
      case 'beacon:lost':
        removeBeacon(msg.beacon);
        addLogEntry('leave', `${msg.beacon.name || msg.beacon.mac} left`);
        break;
      case 'radar':
        state.radar = msg.reading;
        break;
      case 'node:discovered':
      case 'node:offline':
        // Refresh full node list on next cycle
        break;
      // Demo mode events
      case 'demo:phase':
        state.demo = msg;
        updateDemoPhase(msg);
        break;
      case 'demo:scenario':
        state.demo = msg;
        updateDemoPhase(msg);
        break;
      // Health monitor events
      case 'health':
        state.connection.health = msg.health;
        state.connection.server = msg.health.overall === 'down' ? 'down' : 'up';
        updateConnectionIndicator();
        break;
      // OTA firmware update events
      case 'ota:firmware':
      case 'ota:started':
      case 'ota:progress':
      case 'ota:complete':
        handleOtaWsEvent(msg);
        break;
    }
    updateDashIndicators();
  }

  /**
   * Update or add a beacon in state and re-render the People tab.
   * @param {Object} beacon - Beacon data from WS
   * @param {boolean} isNew - Whether this is a newly discovered beacon
   */
  function updateBeacon(beacon, isNew) {
    const idx = state.beacons.findIndex((b) => b.mac === beacon.mac);
    if (idx >= 0) {
      // Preserve user-assigned name/role if the incoming data doesn't have them
      const existing = state.beacons[idx];
      beacon.name = beacon.name || existing.name;
      beacon.role = beacon.role || existing.role;
      state.beacons[idx] = beacon;
    } else {
      state.beacons.push(beacon);
    }
    // Re-render only if the People tab is active (avoid unnecessary DOM work)
    if (state.screen === 'dashboard') {
      renderBeaconList();
    }
  }

  /**
   * Remove a beacon from state (e.g., when it leaves range).
   * @param {Object} beacon - Beacon that was lost
   */
  function removeBeacon(beacon) {
    const idx = state.beacons.findIndex((b) => b.mac === beacon.mac);
    if (idx >= 0) {
      state.beacons.splice(idx, 1);
      renderBeaconList();
    }
  }

  function extractVitals(data) {
    if (!data) return;
    // Adapt to whatever the sensing server sends
    state.vitals = {
      hr: data.heart_rate ?? data.hr ?? '--',
      br: data.breathing_rate ?? data.br ?? '--',
      motion: data.motion_state ?? data.motion ?? 'Unknown',
      persons: data.person_count ?? data.persons ?? 0,
      // Pass person positions through so the room map can render them
      persons_positions: data.persons_positions || null,
    };

    // Push reading into the vitals chart history buffer for live charts.
    // We throttle to ~2Hz to keep the chart readable (sensing can be 10Hz).
    if (vitalsChart && (!extractVitals._lastPush || Date.now() - extractVitals._lastPush > 500)) {
      extractVitals._lastPush = Date.now();
      vitalsChart.pushReading(data);
    }
  }

  function updateDashIndicators() {
    const online = state.nodes.filter((n) => n.status === 'online').length;
    $('#indNodeCount').textContent = online;
    $('#indBeaconCount').textContent = state.beacons.length;

    const radarDot = $('#indRadarDot');
    if (state.radar) {
      radarDot.className = 'ind-dot ' + (state.radar.state !== 'none' ? 'green' : 'yellow');
    }

    const bleDot = $('#indBleDot');
    bleDot.className = 'ind-dot ' + (state.beacons.length > 0 ? 'green' : 'yellow');
  }

  // -------------------------------------------------------------------------
  // Room Map Canvas
  // -------------------------------------------------------------------------
  // The enhanced RoomMap module (room-map.js) handles all visualization.
  // startCanvasLoop sizes the canvas and runs the render loop.
  // If RoomMap is unavailable (script failed to load), falls back to a
  // simple "no data" placeholder.

  function startCanvasLoop() {
    const canvas = $('#roomCanvas');

    // Size canvas to fill its container (must match pixel resolution)
    function resize() {
      const parent = canvas.parentElement;
      canvas.width = parent.clientWidth;
      canvas.height = parent.clientHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    canvasTimer = setInterval(() => {
      if (roomMap) {
        // Enhanced room map handles all drawing
        roomMap.render();
      } else {
        // Fallback: simple placeholder
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#08090d';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#6b7280';
        ctx.font = '14px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Room map loading...', canvas.width / 2, canvas.height / 2);
      }

      // Render vitals charts (only when the Vitals tab is visible)
      if (vitalsChart) {
        vitalsChart.render();
      }
    }, 1000 / CANVAS_FPS);
  }

  // -------------------------------------------------------------------------
  // Vitals View
  // -------------------------------------------------------------------------
  // The VitalsChart module (vitals-chart.js) now handles all vitals rendering
  // with live animated sparkline charts, motion timeline, and quality gauges.
  // See initVitalsChart() above for setup, and the canvas render loop in
  // startCanvasLoop() for the draw call.

  // -------------------------------------------------------------------------
  // People & Beacon Management Tab
  // -------------------------------------------------------------------------
  // Real-time BLE beacon tracking with role assignment and activity logging.
  // Beacons are discovered automatically (via BLE scanner or simulator).
  // Users can tap a beacon card to assign a name and role (patient/staff/visitor).

  /** Maximum number of entries kept in the activity log. */
  const MAX_LOG_ENTRIES = 30;

  /** Activity log buffer: { time, icon, text, type } */
  const beaconLog = [];

  /** Track which beacon is being edited (MAC address). */
  let editingBeaconMac = null;

  /**
   * Render the full beacon list UI based on current state.beacons.
   * Called whenever beacons change (WS events, initial snapshot).
   */
  function renderBeaconList() {
    const list = $('#beaconList');
    let empty = $('#beaconEmpty');

    if (state.beacons.length === 0) {
      if (!empty) {
        // Re-create the empty state element if it was lost from innerHTML clearing
        empty = document.createElement('div');
        empty.id = 'beaconEmpty';
        empty.className = 'beacon-empty';
        empty.innerHTML = '<div class="beacon-empty-icon">📡</div>'
          + '<div class="beacon-empty-text">No beacons detected yet</div>'
          + '<div class="beacon-empty-hint">BLE wristbands and badges will appear here automatically</div>';
      }
      list.innerHTML = '';
      list.appendChild(empty);
      empty.style.display = 'flex';
    } else {
      if (empty) empty.style.display = 'none';

      // Sort: patients first, then staff, then visitors, then unknown
      const roleOrder = { patient: 0, staff: 1, visitor: 2, unknown: 3 };
      const sorted = [...state.beacons].sort(
        (a, b) => (roleOrder[a.role] ?? 3) - (roleOrder[b.role] ?? 3)
      );

      list.innerHTML = sorted.map((b) => {
        const role = b.role || 'unknown';
        const avatar = roleAvatar(role);
        const signal = rssiToSignal(b.rssi);
        const ago = timeAgo(b.timestamp);

        return `
          <div class="beacon-card role-${role}" data-mac="${esc(b.mac)}">
            <div class="beacon-avatar ${role}">${avatar}</div>
            <div class="beacon-info">
              <div class="beacon-name">${esc(b.name || b.mac)}</div>
              <div class="beacon-meta">
                <span class="beacon-role-badge ${role}">${role}</span>
                <span>${ago}</span>
                <span>${esc(b.mac)}</span>
              </div>
            </div>
            <div class="beacon-signal">
              <div class="signal-bars">
                ${signal.bars.map((active, i) =>
                  `<div class="signal-bar ${active ? signal.strength : ''}"></div>`
                ).join('')}
              </div>
              <div class="signal-rssi">${b.rssi} dBm</div>
            </div>
            <button class="beacon-edit-btn" data-mac="${esc(b.mac)}">Edit</button>
          </div>`;
      }).join('');

      // Attach edit button handlers
      list.querySelectorAll('.beacon-edit-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          openBeaconEdit(btn.dataset.mac);
        });
      });
    }

    // Update summary counts
    updateBeaconCounts();
  }

  /**
   * Update the role-based summary counters at the top of the People tab.
   */
  function updateBeaconCounts() {
    const counts = { patient: 0, staff: 0, visitor: 0 };
    for (const b of state.beacons) {
      if (counts[b.role] !== undefined) counts[b.role]++;
    }
    $('#patientCount').textContent = counts.patient;
    $('#staffCount').textContent = counts.staff;
    $('#visitorCount').textContent = counts.visitor;
    $('#totalBeaconCount').textContent = state.beacons.length;
  }

  /**
   * Get emoji avatar for a beacon role.
   * @param {string} role - 'patient' | 'staff' | 'visitor' | 'unknown'
   * @returns {string} Emoji character
   */
  function roleAvatar(role) {
    switch (role) {
      case 'patient': return '🏥';
      case 'staff':   return '👩‍⚕️';
      case 'visitor':  return '👤';
      default:         return '📡';
    }
  }

  /**
   * Convert RSSI dBm value to a signal strength descriptor.
   * Returns { bars: [bool x4], strength: 'strong'|'weak' }.
   * @param {number} rssi - Signal strength in dBm (negative)
   */
  function rssiToSignal(rssi) {
    // Typical BLE range: -30 (very close) to -90 (far away)
    const bars = [
      rssi > -85,  // Bar 1: detectable
      rssi > -70,  // Bar 2: weak
      rssi > -55,  // Bar 3: good
      rssi > -40,  // Bar 4: strong (very close)
    ];
    const active = bars.filter(Boolean).length;
    const strength = active >= 3 ? 'strong' : 'weak';
    return { bars, strength };
  }

  /**
   * Human-readable time-ago string from a timestamp.
   * @param {number} ts - Unix timestamp in ms
   * @returns {string} e.g. "just now", "12s ago", "3m ago"
   */
  function timeAgo(ts) {
    if (!ts) return '';
    const secs = Math.floor((Date.now() - ts) / 1000);
    if (secs < 5) return 'just now';
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    return `${Math.floor(secs / 3600)}h ago`;
  }

  /**
   * Add an entry to the beacon activity log.
   * @param {'enter'|'leave'|'update'} type - Event type
   * @param {string} text - Description
   */
  function addLogEntry(type, text) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const icons = { enter: '→', leave: '←', update: '✎' };

    beaconLog.unshift({ time, icon: icons[type] || '·', text, type });

    // Trim to max length
    if (beaconLog.length > MAX_LOG_ENTRIES) beaconLog.length = MAX_LOG_ENTRIES;

    renderBeaconLog();
  }

  /** Render the activity log entries in the DOM. */
  function renderBeaconLog() {
    const container = $('#beaconLogEntries');
    if (!container) return;

    container.innerHTML = beaconLog.slice(0, 10).map((e) => `
      <div class="log-entry ${e.type}">
        <span class="log-time">${e.time}</span>
        <span class="log-icon">${e.icon}</span>
        <span>${esc(e.text)}</span>
      </div>
    `).join('');
  }

  // ── Beacon Edit Overlay ──

  /**
   * Open the edit overlay for a specific beacon.
   * Pre-fills name and role from current state.
   * @param {string} mac - Beacon MAC address
   */
  function openBeaconEdit(mac) {
    const beacon = state.beacons.find((b) => b.mac === mac);
    if (!beacon) return;

    editingBeaconMac = mac;

    // Populate fields
    $('#beaconEditMac').textContent = mac;
    $('#beaconEditName').value = beacon.name || '';

    // Highlight the active role button
    const rolePicker = $('#beaconEditRolePicker');
    rolePicker.querySelectorAll('.role-btn').forEach((btn) => {
      btn.classList.toggle('selected', btn.dataset.role === (beacon.role || 'unknown'));
    });

    // Show overlay
    $('#beaconEditOverlay').classList.add('active');
    $('#beaconEditName').focus();
  }

  /** Close the beacon edit overlay without saving. */
  function closeBeaconEdit() {
    editingBeaconMac = null;
    $('#beaconEditOverlay').classList.remove('active');
  }

  /**
   * Save the edited beacon identity.
   * Sends PUT /api/beacons/:mac and notifies the WS hub.
   */
  function saveBeaconEdit() {
    if (!editingBeaconMac) return;

    const name = $('#beaconEditName').value.trim();
    const selectedRole = $('#beaconEditRolePicker').querySelector('.role-btn.selected');
    const role = selectedRole ? selectedRole.dataset.role : 'unknown';

    if (!name) {
      $('#beaconEditName').focus();
      return;
    }

    // Send to server via REST API
    fetch(`${API}/beacons/${encodeURIComponent(editingBeaconMac)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, role }),
    }).catch(() => {});

    // Also send via WebSocket for immediate broadcast to other clients
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        action: 'set_beacon_identity',
        mac: editingBeaconMac,
        name,
        role,
      }));
    }

    // Optimistic local update
    const beacon = state.beacons.find((b) => b.mac === editingBeaconMac);
    if (beacon) {
      beacon.name = name;
      beacon.role = role;
    }

    addLogEntry('update', `${name} tagged as ${role}`);
    renderBeaconList();
    closeBeaconEdit();
  }

  // Periodically re-render beacon list to update "time ago" labels (every 5s)
  setInterval(() => {
    if (state.screen === 'dashboard') renderBeaconList();
  }, 5000);

  // -------------------------------------------------------------------------
  // Connection Status Indicator
  // -------------------------------------------------------------------------
  // Shows a subtle toast bar when the WS connection drops or the server
  // reports health issues. Auto-hides when connection is restored.

  let _connectionToastVisible = false;

  /**
   * Update the connection status indicator in the dashboard top bar.
   * Shows/hides the connection toast based on current state.
   */
  function updateConnectionIndicator() {
    const toast = $('#connectionToast');
    const dot = $('#indConnectionDot');
    const text = $('#connectionToastText');
    if (!toast || !dot) return;

    const { ws: wsState, server, wsReconnectAttempts } = state.connection;

    // Update the indicator dot in the top bar
    if (wsState === 'connected' && server !== 'down') {
      dot.className = 'ind-dot green';
    } else if (wsState === 'connecting') {
      dot.className = 'ind-dot yellow';
    } else {
      dot.className = 'ind-dot red';
    }

    // Show/hide the connection toast bar
    if (wsState === 'connected' && server !== 'down') {
      // Connection is good — hide toast after a brief "restored" message
      if (_connectionToastVisible) {
        toast.className = 'connection-toast restored';
        text.textContent = 'Connection restored';
        _connectionToastVisible = false;
        setTimeout(() => {
          toast.className = 'connection-toast hidden';
        }, 2000);
      }
    } else if (wsState === 'connecting') {
      toast.className = 'connection-toast connecting';
      text.textContent = wsReconnectAttempts > 0
        ? `Reconnecting... (attempt ${wsReconnectAttempts})`
        : 'Connecting...';
      _connectionToastVisible = true;
    } else {
      toast.className = 'connection-toast disconnected';
      text.textContent = server === 'down'
        ? 'Server health check failed'
        : 'Connection lost — reconnecting...';
      _connectionToastVisible = true;
    }
  }

  // -------------------------------------------------------------------------
  // Settings Overlay
  // -------------------------------------------------------------------------
  function openSettings() {
    $('#settings').classList.add('active');
    // Populate
    fetch(`${API}/config`).then(r => r.json()).then(data => {
      $('#settingSource').textContent = state.demoMode
        ? 'Simulated (Demo Mode)'
        : (data.sensing?.source || '-');
      $('#settingNodes').textContent = state.nodes.filter(n => n.status === 'online').length;
      $('#settingBle').textContent = state.demoMode
        ? 'Simulated'
        : (data.ble?.enabled ? 'Enabled' : 'Disabled');
      $('#settingRadar').textContent = state.demoMode
        ? 'Simulated'
        : (data.radar?.enabled ? 'Enabled' : 'Disabled');
    }).catch(() => {});

    // Populate node list with inline rename
    renderSettingsNodeList();
  }

  /** Render the node list inside Settings for naming/numbering. */
  function renderSettingsNodeList() {
    const container = $('#settingsNodeList');
    if (!container) return;
    const nodes = state.nodes || [];
    if (nodes.length === 0) {
      container.innerHTML = '<div style="color:var(--muted);font-size:12px">No nodes discovered</div>';
      return;
    }
    container.innerHTML = '';
    nodes.forEach((node, idx) => {
      const row = document.createElement('div');
      row.className = 'settings-node-row';

      const num = document.createElement('div');
      num.className = 'settings-node-num';
      num.textContent = idx + 1;

      const mac = document.createElement('div');
      mac.className = 'settings-node-mac';
      mac.textContent = node.id.slice(-8);

      const input = document.createElement('input');
      input.className = 'settings-node-name-input';
      input.value = node.name || `Node ${idx + 1}`;
      input.placeholder = `Node ${idx + 1}`;

      const saveBtn = document.createElement('button');
      saveBtn.className = 'settings-node-save';
      saveBtn.textContent = 'Save';
      saveBtn.addEventListener('click', async () => {
        try {
          const res = await fetch(`${API}/nodes/${encodeURIComponent(node.id)}/name`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: input.value.trim() || `Node ${idx + 1}` }),
          });
          if (res.ok) {
            node.name = input.value.trim() || `Node ${idx + 1}`;
            saveBtn.textContent = 'Saved';
            setTimeout(() => { saveBtn.textContent = 'Save'; }, 1500);
            // Update room map
            if (roomMap) roomMap.render();
          }
        } catch { saveBtn.textContent = 'Error'; }
      });

      row.appendChild(num);
      row.appendChild(mac);
      row.appendChild(input);
      row.appendChild(saveBtn);
      container.appendChild(row);
    });
  }

  function closeSettings() {
    $('#settings').classList.remove('active');
  }

  // -------------------------------------------------------------------------
  // View Switching (tabs)
  // -------------------------------------------------------------------------
  function switchView(viewId) {
    $$('.dash-view').forEach((el) => el.classList.remove('active'));
    $(`#${viewId}`).classList.add('active');
    $$('.tab-btn').forEach((el) => el.classList.toggle('active', el.dataset.view === viewId));

    // Vitals canvases are sized to 0 when hidden — resize once the tab is shown
    if (viewId === 'viewVitals') {
      resizeVitalsCanvases();
    }

  }

  // -------------------------------------------------------------------------
  // Demo Mode UI
  // -------------------------------------------------------------------------

  let _demoInitialized = false;

  /** Set up demo mode banner, scenario selector, and alert overlay. */
  function initDemoUI() {
    if (_demoInitialized) return;
    _demoInitialized = true;

    const banner = $('#demoBanner');
    if (!banner) return;
    banner.classList.remove('hidden');

    // Fetch available scenarios and populate the selector
    fetch(`${API}/demo`).then(r => r.json()).then(data => {
      if (!data.demoMode) return;

      state.demo = data;
      const select = $('#demoScenarioSelect');
      select.innerHTML = '';
      (data.scenarios || []).forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name;
        if (s.active) opt.selected = true;
        select.appendChild(opt);
      });

      // Show initial phase label
      updateDemoPhase(data);

      // Scenario switch handler
      select.addEventListener('change', () => {
        fetch(`${API}/demo/scenario`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenarioId: select.value }),
        }).catch(() => {});
      });
    }).catch(() => {});
  }

  /** Update the demo phase label and alert overlay. */
  function updateDemoPhase(data) {
    const label = $('#demoPhaseLabel');
    if (label && data.phaseLabel) {
      label.textContent = data.phaseLabel;
    }

    // Show/hide alert overlay (e.g. for fall detection)
    const alertEl = $('#demoAlert');
    const alertText = $('#demoAlertText');
    if (alertEl) {
      if (data.alert) {
        alertEl.classList.remove('hidden');
        if (alertText) {
          alertText.textContent = data.phaseLabel || 'ALERT';
        }
      } else {
        alertEl.classList.add('hidden');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Global Error Boundary
  // -------------------------------------------------------------------------
  // Catches uncaught errors and unhandled promise rejections so the UI
  // degrades gracefully instead of showing a blank screen at a trade show.

  /**
   * Handle a global error. Logs it and shows a non-intrusive notification
   * rather than crashing the entire UI.
   */
  function handleGlobalError(error, source) {
    console.error(`[HeartBeatz] Unhandled error (${source}):`, error);

    // Don't spam the user with repeated error toasts — debounce
    if (handleGlobalError._lastShown && Date.now() - handleGlobalError._lastShown < 5000) return;
    handleGlobalError._lastShown = Date.now();

    // Show a brief error toast (reuse the connection toast if visible, or show inline)
    const toast = $('#connectionToast');
    const text = $('#connectionToastText');
    if (toast && text) {
      toast.className = 'connection-toast disconnected';
      text.textContent = 'UI error — recovering...';
      setTimeout(() => {
        if (state.connection.ws === 'connected') {
          toast.className = 'connection-toast hidden';
        }
      }, 4000);
    }
  }

  window.addEventListener('error', (evt) => {
    handleGlobalError(evt.error || evt.message, 'window.onerror');
  });

  window.addEventListener('unhandledrejection', (evt) => {
    handleGlobalError(evt.reason, 'unhandledrejection');
  });

  // -------------------------------------------------------------------------
  // Safe Fetch Wrapper
  // -------------------------------------------------------------------------
  // Wraps fetch calls with timeout, error handling, and retry for the UI.
  // Prevents one failed API call from breaking the entire app.

  /**
   * Fetch with timeout and structured error handling.
   * Returns { ok, data, error } — never throws.
   *
   * @param {string} url      - API endpoint
   * @param {Object} [opts]   - fetch options
   * @param {number} [timeoutMs=5000] - Request timeout
   * @returns {Promise<{ok: boolean, data: Object|null, error: string|null}>}
   */
  async function safeFetch(url, opts = {}, timeoutMs = 5000) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timer);

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        return { ok: false, data, error: data?.error || `HTTP ${res.status}` };
      }
      return { ok: true, data, error: null };
    } catch (err) {
      if (err.name === 'AbortError') {
        return { ok: false, data: null, error: 'Request timed out' };
      }
      return { ok: false, data: null, error: err.message || 'Network error' };
    }
  }

  // -------------------------------------------------------------------------
  // OTA Firmware Update UI
  // -------------------------------------------------------------------------
  // Manages firmware upload, node version display, and real-time OTA progress.
  // Accessible from Settings → Firmware Update button.

  /** Cached OTA state for the overlay. */
  let _otaState = {
    firmware: null,       // Current firmware metadata from server
    nodes: [],            // Node firmware versions
    activeUpdates: [],    // In-progress OTA downloads
    selectedFile: null,   // File selected for upload
  };

  /**
   * Open the OTA firmware management overlay.
   * Fetches current firmware info and node versions from the server.
   */
  // ---------------------------------------------------------------------------
  // Detection Tuning Panel
  // ---------------------------------------------------------------------------
  // Slider definitions grouped by category. Each entry maps a tuning key to a
  // human-readable label, min, max, step, and optional unit.

  const TUNING_GROUPS = [
    {
      title: 'Person Detection Thresholds',
      params: [
        { key: 'thresholdZero',  label: '0-person ceiling',   min: 0,   max: 1,   step: 0.01, unit: '' },
        { key: 'thresholdOne',   label: '1-person ceiling',   min: 0.05,max: 2,   step: 0.01, unit: '' },
        { key: 'thresholdTwo',   label: '1→2 transition',     min: 0.1, max: 3,   step: 0.05, unit: '' },
        { key: 'thresholdThree', label: '2→3 transition',     min: 0.2, max: 5,   step: 0.05, unit: '' },
        { key: 'thresholdFour',  label: '3→4 transition',     min: 0.5, max: 8,   step: 0.1,  unit: '' },
        { key: 'thresholdFive',  label: '4→5 transition',     min: 1,   max: 10,  step: 0.1,  unit: '' },
      ],
    },
    {
      title: 'EMA Smoothing',
      params: [
        { key: 'emaPersonCount', label: 'Person count',       min: 0.0005, max: 0.05, step: 0.0005, unit: '' },
        { key: 'emaHeartRate',   label: 'Heart rate',         min: 0.01, max: 0.5,  step: 0.01, unit: '' },
        { key: 'emaBreathing',   label: 'Breathing rate',     min: 0.01, max: 0.5,  step: 0.01, unit: '' },
        { key: 'emaMotion',      label: 'Motion level',       min: 0.05, max: 0.8,  step: 0.01, unit: '' },
      ],
    },
    {
      title: 'Hysteresis & Gating',
      params: [
        { key: 'hysteresisUp',       label: 'Flip 0→1 threshold', min: 0.05, max: 1.0, step: 0.05, unit: '' },
        { key: 'hysteresisDown',     label: 'Flip-down gap',      min: 0.1,  max: 1.5, step: 0.05, unit: '' },
        { key: 'vitalGateThreshold', label: 'Vital gate (ema)',   min: 0.1,  max: 1.0, step: 0.05, unit: '' },
        { key: 'absoluteFloor',      label: 'Abs. floor',         min: 0.05, max: 1.0, step: 0.01, unit: '' },
        { key: 'absoluteFloorScale', label: 'Abs. floor scale',   min: 0.1,  max: 2.0, step: 0.05, unit: '' },
      ],
    },
    {
      title: 'Motion Detection',
      params: [
        { key: 'motionThreshold',     label: 'Moving threshold',   min: 50,  max: 500, step: 5, unit: '' },
        { key: 'stationaryThreshold', label: 'Stationary threshold',min: 30, max: 400, step: 5, unit: '' },
      ],
    },
    {
      title: 'Variance Blending',
      params: [
        { key: 'blendWeightShort', label: 'Short weight',  min: 0, max: 1.0, step: 0.05, unit: '' },
        { key: 'blendWeightMed',   label: 'Medium weight', min: 0, max: 1.0, step: 0.05, unit: '' },
        { key: 'blendWeightLong',  label: 'Long weight',   min: 0, max: 1.0, step: 0.05, unit: '' },
      ],
    },
    {
      title: 'Multi-Node Fusion',
      params: [
        { key: 'fusionQuietThreshold', label: 'Quiet node threshold', min: 0.5, max: 10, step: 0.5, unit: '' },
        { key: 'fusionQuietWeight',    label: 'Quiet bias weight',    min: 0,   max: 1,  step: 0.05, unit: '' },
        { key: 'maxBaselineVar',       label: 'Max baseline var',     min: 2,   max: 20, step: 0.5,  unit: '' },
      ],
    },
    {
      title: 'Recalibration',
      params: [
        { key: 'calibrationFrames', label: 'Calibration frames',  min: 50,  max: 500, step: 10, unit: '' },
        { key: 'recalWindowS',      label: 'Recal window (s)',    min: 30,  max: 600, step: 10, unit: 's' },
        { key: 'recalIntervalS',    label: 'Recal interval (s)',  min: 10,  max: 120, step: 5,  unit: 's' },
        { key: 'recalMaxShift',     label: 'Max shift/cycle',     min: 0.1, max: 2.0, step: 0.1, unit: '' },
        { key: 'recalBlendAlpha',   label: 'Blend alpha',         min: 0.05,max: 0.8, step: 0.05,unit: '' },
      ],
    },
  ];

  let _tuningDefaults = null; // Stored on first fetch for reset
  let _tuningDebounce = null;

  /** Open the tuning overlay and fetch current values from the server. */
  async function openTuningOverlay() {
    closeSettings();
    $('#tuningOverlay').classList.add('active');
    $('#tuningStatus').textContent = 'Loading...';

    try {
      const res = await fetch('/api/tuning');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!_tuningDefaults) _tuningDefaults = { ...data };
      renderTuningSliders(data);
      loadTuningPresets(); // Populate preset dropdown
      $('#tuningStatus').textContent = 'Connected — changes apply live';
    } catch (err) {
      $('#tuningStatus').textContent = `Error: ${err.message}`;
      $('#tuningSliders').innerHTML = '<p style="color:var(--danger)">Could not load tuning data. Is the CSI bridge running?</p>';
    }
  }

  /** Close the tuning overlay. */
  function closeTuningOverlay() {
    $('#tuningOverlay').classList.remove('active');
  }

  /** Build slider rows from the tuning groups definition. */
  function renderTuningSliders(values) {
    const container = $('#tuningSliders');
    container.innerHTML = '';

    for (const group of TUNING_GROUPS) {
      const groupEl = document.createElement('div');
      groupEl.className = 'tuning-group';

      const titleEl = document.createElement('div');
      titleEl.className = 'tuning-group-title';
      titleEl.textContent = group.title;
      groupEl.appendChild(titleEl);

      for (const p of group.params) {
        const row = document.createElement('div');
        row.className = 'tuning-row';

        const label = document.createElement('div');
        label.className = 'tuning-label';
        label.textContent = p.label;
        label.title = p.key;

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'tuning-slider';
        slider.min = p.min;
        slider.max = p.max;
        slider.step = p.step;
        slider.value = values[p.key] ?? p.min;
        slider.dataset.key = p.key;

        const valDisplay = document.createElement('div');
        valDisplay.className = 'tuning-value';
        valDisplay.id = `tv_${p.key}`;
        valDisplay.textContent = formatTuningValue(values[p.key], p);

        slider.addEventListener('input', () => {
          const v = parseFloat(slider.value);
          valDisplay.textContent = formatTuningValue(v, p);
          debouncedTuningSend(p.key, v);
        });

        row.appendChild(label);
        row.appendChild(slider);
        row.appendChild(valDisplay);
        groupEl.appendChild(row);
      }

      container.appendChild(groupEl);
    }
  }

  /** Format a tuning value for display. */
  function formatTuningValue(val, param) {
    if (val == null) return '--';
    const num = typeof val === 'number' ? val : parseFloat(val);
    // Show enough decimal places based on step size
    const decimals = param.step < 0.01 ? 4 : param.step < 0.1 ? 3 : param.step < 1 ? 2 : 0;
    return num.toFixed(decimals) + (param.unit || '');
  }

  /** Debounce tuning updates — sends at most once every 300ms. */
  function debouncedTuningSend(key, value) {
    if (_tuningDebounce) clearTimeout(_tuningDebounce);
    _tuningDebounce = setTimeout(async () => {
      try {
        const res = await fetch('/api/tuning', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [key]: value }),
        });
        if (res.ok) {
          $('#tuningStatus').textContent = `Updated ${key} = ${value}`;
        } else {
          $('#tuningStatus').textContent = `Failed to update ${key}: HTTP ${res.status}`;
        }
      } catch (err) {
        $('#tuningStatus').textContent = `Send error: ${err.message}`;
      }
    }, 300);
  }

  /** Reset all tuning values to factory defaults. */
  async function resetTuningDefaults() {
    if (!_tuningDefaults) return;
    try {
      const res = await fetch('/api/tuning', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(_tuningDefaults),
      });
      if (res.ok) {
        const data = await res.json();
        renderTuningSliders(data.tuning || _tuningDefaults);
        $('#tuningStatus').textContent = 'Reset to defaults';
      }
    } catch (err) {
      $('#tuningStatus').textContent = `Reset error: ${err.message}`;
    }
  }

  /** Load and display saved tuning presets in the dropdown. */
  async function loadTuningPresets() {
    const select = $('#tuningPresetSelect');
    if (!select) return;
    try {
      const res = await fetch('/api/tuning/presets');
      if (!res.ok) return;
      const presets = await res.json();
      select.innerHTML = '<option value="">-- Load Preset --</option>';
      for (const p of presets) {
        const opt = document.createElement('option');
        opt.value = p.file;
        opt.textContent = `${p.version}${p.date ? ' (' + p.date.slice(0, 10) + ')' : ''}`;
        opt.title = p.description || '';
        select.appendChild(opt);
      }
    } catch { /* presets not available yet */ }
  }

  /** Restore a tuning preset by filename. */
  async function restoreTuningPreset(filename) {
    if (!filename) return;
    try {
      const res = await fetch(`/api/tuning/restore/${encodeURIComponent(filename)}`, { method: 'PUT' });
      if (res.ok) {
        const data = await res.json();
        renderTuningSliders(data.tuning || {});
        $('#tuningStatus').textContent = `Restored preset: ${data.preset}`;
      } else {
        $('#tuningStatus').textContent = `Restore failed: HTTP ${res.status}`;
      }
    } catch (err) {
      $('#tuningStatus').textContent = `Restore error: ${err.message}`;
    }
  }

  // ---------------------------------------------------------------------------
  // OTA Firmware Updates
  // ---------------------------------------------------------------------------

  async function openOtaOverlay() {
    closeSettings();
    $('#otaOverlay').classList.add('active');

    // Reset upload form
    $('#otaVersion').value = '';
    $('#otaNotes').value = '';
    $('#otaFileLabel').textContent = 'Tap to select .bin file';
    $('#btnOtaUpload').disabled = true;
    $('#otaUploadStatus').textContent = '';
    _otaState.selectedFile = null;

    // Fetch current firmware info from server
    await refreshOtaInfo();
  }

  /** Close the OTA overlay. */
  function closeOtaOverlay() {
    $('#otaOverlay').classList.remove('active');
  }

  /**
   * Fetch firmware info and node status from the server.
   * Updates the OTA overlay UI.
   */
  async function refreshOtaInfo() {
    try {
      const res = await fetch(`${API}/firmware`);
      const data = await res.json();
      _otaState.firmware = data.firmware;
      _otaState.nodes = data.nodes || [];
      _otaState.activeUpdates = data.activeUpdates || [];
      renderOtaInfo();
    } catch {
      $('#otaCurrentVersion').textContent = 'Unable to fetch firmware info';
    }
  }

  /**
   * Render the OTA overlay with current state.
   */
  function renderOtaInfo() {
    const fw = _otaState.firmware;

    // Current firmware section
    if (fw) {
      $('#otaCurrentVersion').textContent = `v${fw.version}`;
      const uploadDate = new Date(fw.uploadedAt).toLocaleString();
      const sizeKB = (fw.size / 1024).toFixed(1);
      let meta = `${sizeKB} KB — uploaded ${uploadDate}`;
      if (fw.notes) meta += ` — ${fw.notes}`;
      $('#otaCurrentMeta').textContent = meta;
    } else {
      $('#otaCurrentVersion').textContent = 'No firmware uploaded';
      $('#otaCurrentMeta').textContent = 'Upload a .bin file to enable OTA updates';
    }

    // Node firmware status
    const nodeList = $('#otaNodeList');
    if (_otaState.nodes.length === 0) {
      nodeList.innerHTML = '<div class="ota-node-empty">No nodes connected</div>';
    } else {
      nodeList.innerHTML = _otaState.nodes.map((n) => {
        const statusClass = n.needsUpdate ? 'outdated' : 'current';
        const statusText = n.needsUpdate ? 'Update available' : 'Up to date';
        const fwLabel = n.firmware || 'unknown';
        return `
          <div class="ota-node-row ${statusClass}">
            <div class="ota-node-name">${esc(n.name || n.id)}</div>
            <div class="ota-node-version">${esc(fwLabel)}</div>
            <div class="ota-node-status">${statusText}</div>
            ${n.needsUpdate
              ? `<button class="btn btn-small btn-accent ota-push-btn" data-id="${esc(n.id)}">Push</button>`
              : ''
            }
          </div>`;
      }).join('');

      // Attach push button handlers
      nodeList.querySelectorAll('.ota-push-btn').forEach((btn) => {
        btn.addEventListener('click', () => pushOtaToNode(btn.dataset.id));
      });
    }

    // Active updates section
    const activeSection = $('#otaActiveSection');
    const activeList = $('#otaActiveList');
    if (_otaState.activeUpdates.length > 0) {
      activeSection.style.display = '';
      activeList.innerHTML = _otaState.activeUpdates.map((u) => {
        return `
          <div class="ota-active-row">
            <div class="ota-active-node">${esc(u.nodeId)}</div>
            <div class="ota-active-bar">
              <div class="ota-active-fill" style="width:${u.progress}%"></div>
            </div>
            <div class="ota-active-pct">${u.progress}%</div>
            <div class="ota-active-status">${esc(u.status)}</div>
          </div>`;
      }).join('');
    } else {
      activeSection.style.display = 'none';
    }
  }

  /**
   * Handle file selection for firmware upload.
   * @param {File} file - Selected .bin file
   */
  function handleOtaFileSelect(file) {
    if (!file) return;
    _otaState.selectedFile = file;
    const sizeKB = (file.size / 1024).toFixed(1);
    $('#otaFileLabel').textContent = `${file.name} (${sizeKB} KB)`;
    validateOtaUpload();
  }

  /**
   * Enable/disable the upload button based on form state.
   */
  function validateOtaUpload() {
    const version = $('#otaVersion').value.trim();
    const hasFile = _otaState.selectedFile !== null;
    $('#btnOtaUpload').disabled = !(version && hasFile);
  }

  /**
   * Upload the selected firmware binary to the server.
   */
  async function uploadFirmware() {
    const version = $('#otaVersion').value.trim();
    const notes = $('#otaNotes').value.trim();
    const file = _otaState.selectedFile;

    if (!version || !file) return;

    const statusEl = $('#otaUploadStatus');
    const btn = $('#btnOtaUpload');
    btn.disabled = true;
    statusEl.textContent = 'Uploading...';
    statusEl.className = 'ota-upload-status uploading';

    try {
      // Read the file as ArrayBuffer and send as raw binary
      const buffer = await file.arrayBuffer();

      const res = await fetch(`${API}/firmware/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Firmware-Version': version,
          'X-Firmware-Notes': notes,
        },
        body: buffer,
      });

      const data = await res.json();

      if (res.ok && data.ok) {
        statusEl.textContent = data.message || 'Upload successful!';
        statusEl.className = 'ota-upload-status success';
        _otaState.selectedFile = null;
        await refreshOtaInfo();
      } else {
        statusEl.textContent = data.error || 'Upload failed';
        statusEl.className = 'ota-upload-status error';
        btn.disabled = false;
      }
    } catch (err) {
      statusEl.textContent = `Upload error: ${err.message}`;
      statusEl.className = 'ota-upload-status error';
      btn.disabled = false;
    }
  }

  /**
   * Request the server to push an OTA update to a specific node.
   * @param {string} nodeId - Target node identifier
   */
  async function pushOtaToNode(nodeId) {
    try {
      const res = await fetch(`${API}/firmware/push/${encodeURIComponent(nodeId)}`, {
        method: 'POST',
      });
      const data = await res.json();
      if (data.ok) {
        addLogEntry('update', `OTA push: ${data.message}`);
      }
    } catch {
      // Ignore — the node will pick up the update on next poll
    }
  }

  /**
   * Handle OTA-related WebSocket events.
   * Called from handleWsMessage for ota:* event types.
   */
  function handleOtaWsEvent(msg) {
    switch (msg.type) {
      case 'ota:firmware':
        _otaState.firmware = msg.firmware;
        if ($('#otaOverlay').classList.contains('active')) renderOtaInfo();
        break;
      case 'ota:started':
        _otaState.activeUpdates.push({
          nodeId: msg.nodeId,
          totalBytes: msg.totalBytes,
          bytesDelivered: 0,
          progress: 0,
          status: 'downloading',
        });
        if ($('#otaOverlay').classList.contains('active')) renderOtaInfo();
        break;
      case 'ota:progress': {
        const upd = _otaState.activeUpdates.find((u) => u.nodeId === msg.nodeId);
        if (upd) {
          upd.bytesDelivered = msg.bytesDelivered;
          upd.progress = msg.totalBytes > 0
            ? Math.round((msg.bytesDelivered / msg.totalBytes) * 100)
            : 0;
        }
        if ($('#otaOverlay').classList.contains('active')) renderOtaInfo();
        break;
      }
      case 'ota:complete': {
        const idx = _otaState.activeUpdates.findIndex((u) => u.nodeId === msg.nodeId);
        if (idx >= 0) {
          _otaState.activeUpdates[idx].status = msg.status;
          _otaState.activeUpdates[idx].progress = 100;
        }
        if ($('#otaOverlay').classList.contains('active')) renderOtaInfo();
        addLogEntry('update', `OTA ${msg.status}: ${msg.nodeId}`);
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Event Bindings
  // -------------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    // Setup: discovery → calibration
    $('#btnContinueToCalibrate').addEventListener('click', () => {
      clearInterval(pollTimer);
      showSetupStep(2);
    });

    // Setup: calibration
    $('#btnCalibrate').addEventListener('click', startCalibration);
    $('#btnSkipCalibrate').addEventListener('click', skipCalibration);

    // Dashboard: settings
    $('#btnSettings').addEventListener('click', openSettings);
    $('#btnCloseSettings').addEventListener('click', closeSettings);
    $('#btnRecalibrate').addEventListener('click', () => {
      closeSettings();
      showScreen('setup');
      showSetupStep(2);
    });

    // Floor plan setup wizard
    const floorplanSetup = new FloorplanSetup(document.body);
    $('#btnSetupFloorplan').addEventListener('click', () => {
      closeSettings();
      openZoneEditor();
    });
    document.addEventListener('floorplan-updated', () => {
      if (window.__roomMap) window.__roomMap.loadLayout();
    });

    // ── Zone Editor ──
    function openZoneEditor() {
      const overlay = $('#zoneEditor');
      if (!overlay) return;
      // Load current zones from server
      fetch(`${API}/zones`).then(r => r.json()).then(zones => {
        renderZoneRows(zones);
        overlay.classList.add('active');
      }).catch(() => {
        renderZoneRows([]);
        overlay.classList.add('active');
      });
    }

    function renderZoneRows(zones) {
      const list = $('#zoneList');
      // Header row
      let html = `<div class="zone-row-labels">
        <span>Name</span><span>X %</span><span>Y %</span><span>W %</span><span>H %</span><span></span>
      </div>`;
      zones.forEach((z, i) => {
        html += `<div class="zone-row" data-idx="${i}">
          <input type="text" class="zn" value="${z.name || ''}" placeholder="Zone name">
          <input type="number" class="zx" value="${Math.round((z.x || 0) * 100)}" min="0" max="100">
          <input type="number" class="zy" value="${Math.round((z.y || 0) * 100)}" min="0" max="100">
          <input type="number" class="zw" value="${Math.round((z.w || 30) * 100)}" min="5" max="100">
          <input type="number" class="zh" value="${Math.round((z.h || 30) * 100)}" min="5" max="100">
          <button class="zone-delete" title="Delete zone">&times;</button>
        </div>`;
      });
      list.innerHTML = html;
      // Delete buttons
      list.querySelectorAll('.zone-delete').forEach(btn => {
        btn.addEventListener('click', () => {
          btn.closest('.zone-row').remove();
        });
      });
    }

    function collectZones() {
      const rows = $$('#zoneList .zone-row');
      return Array.from(rows).map(row => ({
        name: row.querySelector('.zn').value.trim() || 'Zone',
        x: (parseInt(row.querySelector('.zx').value, 10) || 0) / 100,
        y: (parseInt(row.querySelector('.zy').value, 10) || 0) / 100,
        w: (parseInt(row.querySelector('.zw').value, 10) || 30) / 100,
        h: (parseInt(row.querySelector('.zh').value, 10) || 30) / 100,
      }));
    }

    $('#btnAddZone')?.addEventListener('click', () => {
      const list = $('#zoneList');
      const idx = list.querySelectorAll('.zone-row').length;
      const row = document.createElement('div');
      row.className = 'zone-row';
      row.dataset.idx = idx;
      row.innerHTML = `
        <input type="text" class="zn" value="" placeholder="Zone name">
        <input type="number" class="zx" value="0" min="0" max="100">
        <input type="number" class="zy" value="0" min="0" max="100">
        <input type="number" class="zw" value="30" min="5" max="100">
        <input type="number" class="zh" value="30" min="5" max="100">
        <button class="zone-delete" title="Delete zone">&times;</button>
      `;
      row.querySelector('.zone-delete').addEventListener('click', () => row.remove());
      list.appendChild(row);
      row.querySelector('.zn').focus();
    });

    $('#btnSaveZones')?.addEventListener('click', async () => {
      const zones = collectZones();
      try {
        await fetch(`${API}/zones`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(zones),
        });
        // Update room map immediately
        if (roomMap) {
          roomMap.zones = zones;
        }
      } catch (e) {
        console.error('Failed to save zones', e);
      }
      $('#zoneEditor').classList.remove('active');
    });

    $('#btnCloseZoneEditor')?.addEventListener('click', () => {
      $('#zoneEditor').classList.remove('active');
    });

    // Quick calibrate button on room map
    $('#btnQuickCalibrate').addEventListener('click', async () => {
      const btn = $('#btnQuickCalibrate');
      btn.disabled = true;
      btn.title = 'Calibrating...';
      btn.style.opacity = '0.5';
      try {
        await fetch(`${API}/calibrate`, { method: 'POST' });
        // Visual feedback: flash green briefly
        btn.style.background = '#0f0';
        setTimeout(() => { btn.style.background = ''; }, 1500);
        btn.title = 'Calibrated!';
        setTimeout(() => { btn.title = 'Quick calibrate (empty room)'; }, 3000);
      } catch (e) {
        btn.title = 'Calibration failed';
        btn.style.background = '#f00';
        setTimeout(() => { btn.style.background = ''; btn.title = 'Quick calibrate (empty room)'; }, 3000);
      }
      btn.disabled = false;
      btn.style.opacity = '1';
    });

    // Dashboard: tab switching
    $$('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    // Beacon edit overlay controls
    $('#btnBeaconEditSave').addEventListener('click', saveBeaconEdit);
    $('#btnBeaconEditCancel').addEventListener('click', closeBeaconEdit);

    // Role picker buttons (toggle selection)
    $$('#beaconEditRolePicker .role-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('#beaconEditRolePicker .role-btn').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
    });

    // Allow Enter key to save beacon edit
    $('#beaconEditName').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveBeaconEdit();
      if (e.key === 'Escape') closeBeaconEdit();
    });

    // Detection Tuning overlay
    $('#btnOpenTuning').addEventListener('click', openTuningOverlay);
    $('#btnCloseTuning').addEventListener('click', closeTuningOverlay);
    $('#btnResetTuning').addEventListener('click', resetTuningDefaults);
    $('#tuningPresetSelect').addEventListener('change', (e) => restoreTuningPreset(e.target.value));

    // OTA Firmware Update overlay
    $('#btnOpenOta').addEventListener('click', openOtaOverlay);
    $('#btnCloseOta').addEventListener('click', closeOtaOverlay);
    $('#otaFileDrop').addEventListener('click', () => $('#otaFileInput').click());
    $('#otaFileInput').addEventListener('change', (e) => {
      handleOtaFileSelect(e.target.files[0]);
    });
    $('#otaVersion').addEventListener('input', validateOtaUpload);
    $('#btnOtaUpload').addEventListener('click', uploadFirmware);

    // Start the app
    runSplash();
  });

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }
})();
