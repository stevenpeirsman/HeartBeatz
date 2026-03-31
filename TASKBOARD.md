# HeartBeatz Development Task Board
<!-- Single source of truth for all agent coordination -->
<!-- Updated by: architect (assigns), workers (status), reviewer (feedback) -->

## Active Sprint: Sprint 1 — Foundation & Infrastructure

**Sprint Goal:** Build feature extraction pipeline, ground truth system, adaptive baseline improvements, database layer, and admin module foundation. Establish engineering infrastructure for all accuracy and platform work.

**Sprint Start:** 2026-03-31
**Sprint End:** 2026-04-14

---

## Task Assignment Matrix

### ACC-01: Feature Extraction Pipeline (worker-alpha)

| Task ID | Title | Status | Branch | Priority | Est |
|---------|-------|--------|--------|----------|-----|
| ACC-01-T1 | Implement subcarrier grouping into 8 logical bands (guard/pilot/data) | approved | feat/subcarrier-grouping | P0 | 2h |
| ACC-01-T2 | Add phase difference extraction with linear unwrapping | approved | feat/phase-extraction | P0 | 3h |
| ACC-01-T3 | Implement short-time FFT for Doppler motion classification (breathing 0.2-0.5Hz, walking 1-3Hz) | approved | feat/doppler-fft | P0 | 4h |
| ACC-01-T4 | Add statistical features: mean, variance, kurtosis, skewness, IQR, entropy per window | approved | feat/stat-features | P1 | 3h |
| ACC-01-T5 | Implement subcarrier correlation matrix with eigenvalue spread metric | approved | feat/corr-matrix | P1 | 3h |
| ACC-01-T6 | Build frame quality scorer (RSSI stability, timestamp jitter, packet loss) | approved | feat/frame-quality | P1 | 2h |
| ACC-01-T7 | Create feature vector serializer (JSON for SSE, CSV export for ML training) | approved | feat/feature-serializer | P1 | 2h |
| ACC-01-T8 | Add /api/v1/features endpoint returning current feature vectors per node | approved | feat/features-api | P1 | 1h |
| ACC-01-T9 | Add /api/v1/features/stream SSE endpoint at 5Hz | approved (merged with T8) | feat/features-api | P1 | 1h |

### ACC-03: Adaptive Baseline Calibration (worker-beta)

| Task ID | Title | Status | Branch | Priority | Est |
|---------|-------|--------|--------|----------|-----|
| ACC-03-T1 | Implement multi-timescale baseline tracking (fast alpha=0.1/30s, medium alpha=0.01/5min, slow alpha=0.001/1hr) | approved | feat/multi-timescale-baseline | P0 | 3h |
| ACC-03-T2 | Add CUSUM environment change detection on per-subcarrier residuals | approved | feat/cusum-detection | P0 | 3h |
| ACC-03-T3 | Build automatic empty-room detection heuristic (variance < 1.2x baseline for >10min) | approved | feat/empty-room-detect | P0 | 2h |
| ACC-03-T4 | Implement baseline persistence to disk (save hourly + on shutdown, load on restart) | approved | feat/baseline-persist | P1 | 2h |
| ACC-03-T5 | Add recalibration event structured logging with shift magnitude and trigger type | in-review | feat/recal-logging | P1 | 1h |
| ACC-03-T6 | Create /api/v1/calibration/history endpoint returning last 100 recal events | in-review | feat/cal-history-api | P1 | 1h |
| ACC-03-T7 | Implement diurnal drift model (temperature correlation) | backlog | feat/diurnal-model | P2 | 3h |

### ACC-08: Ground Truth System (worker-gamma)

| Task ID | Title | Status | Branch | Priority | Est |
|---------|-------|--------|--------|----------|-----|
| INFRA-01 | Add better-sqlite3 dependency and create database init module (auto-create tables on start) | approved | feat/sqlite-init | P0 | 2h |
| INFRA-02 | Create shared constants module: subcarrier count, frame sizes, feature names enum | approved | feat/shared-types | P0 | 1h |
| ACC-08-T1 | Build /api/v1/ground-truth POST endpoint (accepts {true_count, annotator, session_id}) | approved | feat/ground-truth-api | P0 | 2h |
| ACC-08-T2 | Build label collection web UI: large 0/1/2/3+ buttons, SSE live context, keyboard shortcuts | approved | feat/ground-truth-ui | P0 | 3h |
| ACC-08-T3 | Implement CSI-label alignment: match labels to nearest CSI frame by timestamp within 100ms | in-review | feat/label-alignment | P1 | 2h |
| ACC-08-T4 | Create automated evaluation pipeline: confusion matrix, precision/recall/F1, per-class breakdown | in-review | feat/eval-pipeline | P1 | 4h |
| ACC-08-T5 | Build /api/v1/evaluation/report endpoint returning latest accuracy metrics | approved | feat/eval-report-api | P1 | 1h |
| ACC-08-T6 | Implement labeling session management (start/stop/list sessions with metadata) | backlog | feat/label-sessions | P2 | 2h |
| ACC-08-T7 | Add CSV/JSON bulk export of labeled dataset via /api/v1/ground-truth/export | backlog | feat/gt-export | P2 | 1h |

### ADMIN: Node Management Module (worker-gamma)

| Task ID | Title | Status | Branch | Priority | Est |
|---------|-------|--------|--------|----------|-----|
| ADMIN-01 | Create nodes database table (id, mac, name, ip, type, firmware_version, status, last_seen, position_x, position_y) | approved | feat/nodes-db | P0 | 2h |
| ADMIN-02 | Build /api/v1/nodes CRUD endpoints (list, get, create, update, delete) | approved | feat/nodes-crud-api | P0 | 3h |
| ADMIN-03 | Build node admin web UI: list nodes, add/edit name, delete, show status/firmware/last_seen | in-review | feat/nodes-admin-ui | P0 | 4h |
| ADMIN-04 | Integrate discovery service with nodes DB: auto-register discovered ESP32 nodes, update last_seen | approved | feat/nodes-discovery-sync | P1 | 2h |
| ADMIN-05 | Add firmware flash endpoint /api/v1/nodes/:id/flash (upload .bin, SSH to MeLE, esptool flash) | backlog | feat/nodes-firmware-flash | P1 | 4h |
| ADMIN-06 | Add node numbering/ordering system with drag-and-drop reorder in admin UI | backlog | feat/nodes-ordering | P2 | 2h |
| ADMIN-07 | Add node health check endpoint /api/v1/nodes/:id/ping (check reachability, get firmware version) | in-review | feat/nodes-health-api | P1 | 1h |

### SENSOR: LD2410S Radar Integration (worker-beta)

| Task ID | Title | Status | Branch | Priority | Est |
|---------|-------|--------|--------|----------|-----|
| SENSOR-01 | Complete LD2410S UART parser for engineering mode frames (extend existing radar.js) | approved | feat/radar-parser | P0 | 3h |
| SENSOR-02 | Add radar data to SSE stream alongside CSI data (unified sensor event model) | in-review | feat/radar-sse | P1 | 2h |
| SENSOR-03 | Build radar configuration API: set detection gates, sensitivity thresholds, engineering mode toggle | backlog | feat/radar-config-api | P1 | 2h |
| SENSOR-04 | Implement CSI + radar fusion: use radar distance + energy as validation for CSI person detection | backlog | feat/csi-radar-fusion | P1 | 4h |
| SENSOR-05 | Add radar presence data to ground truth comparison (radar as secondary ground truth source) | backlog | feat/radar-ground-truth | P2 | 2h |
| SENSOR-06 | Create radar diagnostic dashboard: live distance/energy charts, detection state, gate visualization | backlog | feat/radar-dashboard | P2 | 3h |

### SENSOR: BLE Beacon Integration (worker-beta)

| Task ID | Title | Status | Branch | Priority | Est |
|---------|-------|--------|--------|----------|-----|
| BLE-01 | Complete BLE scanner hcitool/hcidump integration for iBeacon parsing (extend existing ble-scanner.js) | approved | feat/ble-scanner-complete | P0 | 3h |
| BLE-02 | Add BLE beacon registry DB table (mac, uuid, major, minor, name, role, battery_level, last_seen) | backlog | feat/ble-registry-db | P1 | 2h |
| BLE-03 | Build beacon management admin UI: list beacons, assign names/roles (patient/staff/equipment) | backlog | feat/ble-admin-ui | P1 | 3h |
| BLE-04 | Implement RSSI-to-zone mapping: configurable RSSI thresholds per zone for proximity detection | backlog | feat/ble-zone-mapping | P1 | 3h |
| BLE-05 | Build CSI + BLE identity fusion: CSI detects "someone is here", BLE identifies "who is here" | backlog | feat/csi-ble-fusion | P1 | 4h |
| BLE-06 | Add BLE sighting data to SSE stream with identity resolution | backlog | feat/ble-sse | P2 | 1h |
| BLE-07 | Implement beacon battery monitoring with low-battery alerts | backlog | feat/ble-battery-alerts | P2 | 2h |

### DB: Database & Persistence Layer (worker-gamma)

| Task ID | Title | Status | Branch | Priority | Est |
|---------|-------|--------|--------|----------|-----|
| DB-01 | Design unified SQLite schema: nodes, sensors, events, labels, evaluations, metrics, sessions | approved | feat/db-schema | P0 | 3h |
| DB-02 | Implement database migration system (version-tracked schema changes) | approved | feat/db-migrations | P1 | 2h |
| DB-03 | Build event storage: all detection events persisted with timestamp, node, count, confidence, features hash | in-review | feat/event-storage | P1 | 2h |
| DB-04 | Add metrics storage: hourly aggregates of accuracy, detection rate, false positive rate, latency | backlog | feat/metrics-storage | P1 | 2h |
| DB-05 | Create /api/v1/metrics endpoint: query accuracy trends, compare algorithm versions, time-range filter | backlog | feat/metrics-api | P1 | 2h |
| DB-06 | Implement data retention policy: raw events (30 days), aggregates (1 year), configurable via env vars | backlog | feat/data-retention | P2 | 2h |
| DB-07 | Add improvement tracking table: version, algorithm_config, accuracy_metrics, timestamp, notes | backlog | feat/improvement-tracking | P1 | 2h |
| DB-08 | Build /api/v1/improvements endpoint: log each algorithm change with before/after accuracy metrics | backlog | feat/improvements-api | P2 | 1h |

### UX: Frontend Dashboard & Visualization (worker-alpha)

| Task ID | Title | Status | Branch | Priority | Est |
|---------|-------|--------|--------|----------|-----|
| UX-01 | Create main dashboard shell: responsive layout with sidebar nav, header, content area (HTML/CSS/JS) | backlog | feat/dashboard-shell | P0 | 4h |
| UX-02 | Build real-time overview panel: per-node person count, EMA, variance, confidence badges, trend sparklines | backlog | feat/overview-panel | P0 | 3h |
| UX-03 | Create zone/floor plan view: SVG overlay with colored zones, occupancy counts, click for zone detail | backlog | feat/floorplan-view | P1 | 5h |
| UX-04 | Build node status panel: list all ESP32 nodes, LD2410S radars, BLE scanners with health indicators | backlog | feat/node-status-panel | P1 | 2h |
| UX-05 | Create CSI feature heatmap v2: improved layout from dev-heatmap, add feature vector visualization | backlog | feat/heatmap-v2 | P1 | 3h |
| UX-06 | Build accuracy tracking dashboard: line charts of accuracy over time, confusion matrix visualization | backlog | feat/accuracy-dashboard | P1 | 3h |
| UX-07 | Create alert panel: live alerts for wandering, dwell-time, low battery, node offline, accuracy drop | backlog | feat/alert-panel | P2 | 3h |
| UX-08 | Add dark mode toggle and responsive mobile/tablet layout | backlog | feat/responsive-dark | P2 | 2h |
| UX-09 | Build settings page: configure thresholds, node positions, zone boundaries, alert rules | backlog | feat/settings-page | P2 | 4h |

### KPI: Hospital ED Metrics & Analytics (worker-gamma)

| Task ID | Title | Status | Branch | Priority | Est |
|---------|-------|--------|--------|----------|-----|
| KPI-01 | Implement zone dwell-time tracker: per-zone timers with configurable alert thresholds | backlog | feat/dwell-time-tracker | P1 | 3h |
| KPI-02 | Build door-to-triage time estimator: detect entry zone → triage zone transition, compute duration | backlog | feat/door-to-triage | P1 | 3h |
| KPI-03 | Implement patient throughput counter: zone transitions per hour, daily totals, rolling averages | backlog | feat/throughput-counter | P1 | 2h |
| KPI-04 | Add LWBS (left without being seen) detection: entry zone dwell > threshold then exit without treatment zone visit | backlog | feat/lwbs-detection | P2 | 3h |
| KPI-05 | Build ED analytics dashboard: door-to-triage, dwell times, throughput, occupancy trends, LWBS rate | backlog | feat/ed-analytics | P2 | 5h |
| KPI-06 | Implement shift handoff report: auto-generated summary at shift change with zone status, pending patients, alerts | backlog | feat/shift-handoff | P2 | 3h |
| KPI-07 | Add nurse call integration hooks: webhook receiver for nurse call events, correlate with location data | backlog | feat/nurse-call-hooks | P3 | 3h |
| KPI-08 | Build bed management status: auto-detect room occupancy state (empty/occupied/cleaning) from CSI patterns | backlog | feat/bed-management | P2 | 4h |

### ACC-02: ML Classifier (worker-alpha) — Sprint 2+

| Task ID | Title | Status | Branch | Priority | Est |
|---------|-------|--------|--------|----------|-----|
| ACC-02-T1 | Design labeled data collection protocol: annotation schema, activity types, collection UI integration | backlog | feat/ml-data-protocol | P1 | 2h |
| ACC-02-T2 | Build training data pipeline: stream features to labeled SQLite dataset, support manual annotation | backlog | feat/ml-training-pipeline | P1 | 4h |
| ACC-02-T3 | Install ONNX Runtime for Node.js on MeLE N100, verify performance | backlog | feat/onnx-setup | P1 | 2h |
| ACC-02-T4 | Train Random Forest classifier (200 trees, max_depth=12) with feature importance analysis | backlog | feat/ml-random-forest | P1 | 5h |
| ACC-02-T5 | Implement A/B comparison mode: run threshold-based + ML in parallel, log both, compare in dashboard | backlog | feat/ml-ab-compare | P1 | 3h |
| ACC-02-T6 | Build model evaluation framework: confusion matrix, per-class P/R/F1, ROC curves, auto-report | backlog | feat/ml-eval-framework | P2 | 3h |
| ACC-02-T7 | Implement online learning: high-confidence predictions auto-label, nightly retrain trigger | backlog | feat/ml-online-learning | P2 | 4h |
| ACC-02-T8 | Add model versioning: store model artifacts, config, metrics per version, rollback support | backlog | feat/ml-versioning | P2 | 2h |

### ACC-06: Breathing & Vital Signs (worker-alpha) — Sprint 2+

| Task ID | Title | Status | Branch | Priority | Est |
|---------|-------|--------|--------|----------|-----|
| ACC-06-T1 | Implement Butterworth IIR bandpass filter bank: breathing (0.1-0.5Hz), heart (0.8-2.0Hz) | backlog | feat/bandpass-filters | P1 | 3h |
| ACC-06-T2 | Add harmonic rejection via comb filter to prevent breathing rate doubling | backlog | feat/harmonic-rejection | P1 | 2h |
| ACC-06-T3 | Implement multi-subcarrier voting: median of per-band estimates, confidence = agreement ratio | backlog | feat/vital-voting | P1 | 2h |
| ACC-06-T4 | Add motion gating: suspend vital estimation when gross motion > 5x breathing threshold | backlog | feat/motion-gating | P1 | 1h |
| ACC-06-T5 | Build signal quality metric (0-1): SNR, autocorrelation prominence, subcarrier agreement | backlog | feat/vital-quality | P1 | 2h |
| ACC-06-T6 | Implement Kalman filter for continuous breathing rate tracking | backlog | feat/vital-kalman | P2 | 3h |

### ACC-09: State Machine & Temporal Smoothing (worker-beta) — Sprint 2+

| Task ID | Title | Status | Branch | Priority | Est |
|---------|-------|--------|--------|----------|-----|
| ACC-09-T1 | Design state machine model: EMPTY/OCCUPIED_1/2/3+/TRANSITIONING with transition constraints | backlog | feat/state-machine-model | P1 | 2h |
| ACC-09-T2 | Implement HMM smoother: emission from ML confidence, transition matrix encoding physical plausibility | backlog | feat/hmm-smoother | P1 | 4h |
| ACC-09-T3 | Add configurable hysteresis: different thresholds for entering vs leaving occupied state | backlog | feat/hysteresis | P1 | 2h |
| ACC-09-T4 | Implement transition event emitter: {from_state, to_state, timestamp, confidence, duration_ms} | backlog | feat/transition-events | P1 | 1h |
| ACC-09-T5 | Build anti-flicker median filter (window=7) combined with state machine | backlog | feat/anti-flicker | P1 | 1h |

### ACC-04: Spatial Fusion (worker-alpha) — Sprint 3+

| Task ID | Title | Status | Branch | Priority | Est |
|---------|-------|--------|--------|----------|-----|
| ACC-04-T1 | Implement node topology model: node positions in room coordinates, config file schema | backlog | feat/node-topology | P1 | 2h |
| ACC-04-T2 | Build probabilistic occupancy grid: 1m x 1m cells, P(occupied | CSI observations) per cell | backlog | feat/occupancy-grid | P1 | 5h |
| ACC-04-T3 | Implement Bayesian sensor fusion across nodes with temporal motion prior | backlog | feat/bayesian-fusion | P1 | 4h |
| ACC-04-T4 | Add zone entry/exit event detection with 5-second hysteresis | backlog | feat/zone-events | P1 | 2h |
| ACC-04-T5 | Build graceful degradation on node failure: widen uncertainty, reweight remaining nodes | backlog | feat/node-degradation | P2 | 2h |
| ACC-04-T6 | Add spatial consistency cross-validation between nodes | backlog | feat/spatial-consistency | P2 | 2h |

### ACC-07: Interference Rejection (worker-beta) — Sprint 3+

| Task ID | Title | Status | Branch | Priority | Est |
|---------|-------|--------|--------|----------|-----|
| ACC-07-T1 | Implement spectral interference detector: flag frames with >25% subcarrier deviation | backlog | feat/interference-detect | P1 | 3h |
| ACC-07-T2 | Build adaptive frame quality filter combining RSSI, amplitude distribution, phase coherence | backlog | feat/quality-filter | P1 | 3h |
| ACC-07-T3 | Add static multipath estimation during calibration, subtract from live observations | backlog | feat/multipath-subtract | P1 | 3h |
| ACC-07-T4 | Implement channel change detection (distinguish channel hop from human movement) | backlog | feat/channel-detect | P2 | 2h |
| ACC-07-T5 | Build interference statistics dashboard widget | backlog | feat/interference-stats | P2 | 2h |

### TECH-DEBT: Code Quality Cleanup (any worker with capacity)

| Task ID | Title | Status | Branch | Priority | Est |
|---------|-------|--------|--------|----------|-----|
| DEBT-01 | Extract shared _ema() helper from multi-timescale.js and cusum.js into shared/math-utils.js | in-review | feat/shared-ema | P1 | 0.5h |
| DEBT-02 | Remove dead `activeThreshold` variable in empty-room.js (line ~193) | in-review | feat/cleanup-empty-room | P1 | 0.5h |
| DEBT-03 | Add pino logging to empty-room.js and doppler.js on state transitions | in-review (empty-room.js done, doppler.js → worker-alpha) | feat/add-logging | P1 | 1h |
| DEBT-04 | Verify ground-truth.html transport: WebSocket vs SSE — standardize to match project conventions | in-review | feat/gt-transport-fix | P1 | 1h |

**Architect assignment (2026-03-31):** DEBT-01 + DEBT-02 → worker-beta (owns calibration modules); DEBT-03 → split: empty-room.js logging → worker-beta, doppler.js logging → worker-alpha; DEBT-04 → worker-gamma (owns ground-truth UI). Workers: pick these up as gap-fillers between main tasks — they're fast wins that clean up reviewer-flagged issues.

### RTLS: Zone & Flow Management — Sprint 3+

| Task ID | Title | Status | Branch | Priority | Est |
|---------|-------|--------|--------|----------|-----|
| RTLS-01-T1 | Build floor plan upload/calibration: web UI for PNG/SVG upload, scale setting, origin point | backlog | feat/floorplan-upload | P1 | 3h |
| RTLS-01-T2 | Implement zone drawing tool: canvas polygon drawing, edit, assign properties (name, type, color) | backlog | feat/zone-drawing | P1 | 5h |
| RTLS-01-T3 | Build node-to-zone assignment: drag nodes onto floor plan, store mapping in DB | backlog | feat/node-zone-assign | P1 | 3h |
| RTLS-01-T4 | Implement zone adjacency auto-detection from polygon boundaries | backlog | feat/zone-adjacency | P2 | 2h |
| RTLS-02-T1 | Implement per-zone occupancy state machine using ACC-09 per zone | backlog | feat/zone-state | P1 | 3h |
| RTLS-02-T2 | Build event stream: ZONE_ENTER, ZONE_EXIT, COUNT_CHANGE, DWELL_ALERT via SSE | backlog | feat/zone-events-sse | P1 | 2h |
| RTLS-02-T3 | Implement anonymous journey tracking: aggregate flow stats per zone without individual attribution | backlog | feat/anon-journey | P2 | 3h |
| RTLS-02-T4 | Build historical flow replay: slider to replay zone occupancy over past periods | backlog | feat/flow-replay | P2 | 4h |

### GDPR: Privacy & Compliance — Sprint 2+

| Task ID | Title | Status | Branch | Priority | Est |
|---------|-------|--------|--------|----------|-----|
| GDPR-01 | Implement audit logging: immutable append-only log of all API access with hash chain | backlog | feat/audit-log | P1 | 3h |
| GDPR-02 | Build data anonymization layer: hash all patient/person references with rotating salt | backlog | feat/anonymization | P1 | 2h |
| GDPR-03 | Implement right-to-erasure: delete all records for a given pseudonym across all tables | backlog | feat/data-erasure | P2 | 2h |
| GDPR-04 | Add data minimization configuration: toggle what data is collected/retained per privacy level | backlog | feat/data-minimization | P2 | 2h |

### INTEGRATION: External Systems — Sprint 4+

| Task ID | Title | Status | Branch | Priority | Est |
|---------|-------|--------|--------|----------|-----|
| INT-01 | Design EHR adapter interface: abstract class with sendLocationEvent(), queryPatientContext() | backlog | feat/ehr-adapter | P1 | 2h |
| INT-02 | Implement HL7 FHIR adapter: map zone events to FHIR Location/Encounter resources | backlog | feat/fhir-adapter | P2 | 4h |
| INT-03 | Build event queue with retry: SQLite-backed persistent queue, exponential backoff | backlog | feat/event-queue | P1 | 3h |
| INT-04 | Create data export pipeline: hourly Parquet/CSV export for data warehouse | backlog | feat/data-export | P2 | 3h |
| INT-05 | Build MQTT broker integration for IoT interop (sensor data, alerts, commands) | backlog | feat/mqtt-broker | P2 | 3h |
| INT-06 | Add webhook dispatcher for external notifications (dwell alerts, count changes, zone events) | backlog | feat/webhook-dispatch | P2 | 2h |

---

## Agent Roles

### worker-alpha (Signal Processing & UX Specialist)
**Focus:** CSI signal processing, feature extraction, spectral analysis, frontend visualization
**Current Sprint:** ACC-01 (Feature Extraction) + start UX foundation
**Skills:** DSP, FFT, filtering, subcarrier analysis, HTML/CSS/JS dashboards

### worker-beta (Calibration, Sensors & Robustness Engineer)
**Focus:** Baseline management, LD2410S radar, BLE beacons, sensor fusion, environment adaptation
**Current Sprint:** ACC-03 (Adaptive Baseline) + SENSOR (LD2410S/BLE start)
**Skills:** Statistical methods, CFAR, UART protocols, BLE, sensor fusion

### worker-gamma (Infrastructure, Data & Admin Engineer)
**Focus:** Database, APIs, ground truth, evaluation, admin module, hospital KPIs
**Current Sprint:** ACC-08 (Ground Truth) + INFRA + ADMIN + DB foundation
**Skills:** REST APIs, SQLite, web UIs, testing frameworks, data pipelines

---

## Review Queue

**⚡ Architect Note (2026-03-31 evening):** 6 items pending review — this is the sprint's primary bottleneck. Reviewer should process in the priority order below. Items are ordered by dependency chain: ACC-03-T4 and ADMIN-03 unblock nothing directly but validate persistence and admin foundations; ACC-08-T3/T4/T5 form a dependency chain (alignment → evaluator → eval-api). SENSOR-01 can be reviewed independently.

**Recommended review order:** ACC-03-T4 → SENSOR-01 → ADMIN-03 → ACC-08-T3 → ACC-08-T4 → ACC-08-T5

| Task ID | Branch | Worker | Review Status | Reviewer Notes |
|---------|--------|--------|---------------|----------------|
| INFRA-02 | feat/shared-types | worker-alpha | **approved** | Clean foundation. Excellent docs with physical meaning/units. Frozen objects for immutability. 30 tests pass. Suggestion: add @enum annotations to band labels. |
| ACC-01-T1 | feat/subcarrier-grouping | worker-alpha | **approved** | Well-written pure functions. groupSubcarriers correctly validates + computes per-band/cross-band stats. Note: slice() in groupSubcarriers allocates per band per frame — acceptable at 8×7 elements on N100 but flag if profiling shows pressure. 22 tests pass. |
| ACC-01-T2 | feat/phase-extraction | worker-alpha | **approved** | **Excellent work.** Outstanding physics-based docs. unwrapPhase handles NaN gaps correctly. fitLinearPhase uses Bessel-corrected residualStd with n-2 (correct for 2-param model). wrapToPi handles arbitrary 2π multiples. 32 tests pass with comprehensive edge cases. |
| ACC-03-T1 | feat/multi-timescale-baseline | worker-beta | **approved** | Solid design. Sigmoid blending is elegant — weights sum to 1.0 at all interpolation points. State persistence clean. Rate-limiting good for N100. 19 tests pass. Minor: _ema() duplicated in cusum.js — extract to shared utility when convenient. |
| ACC-03-T2 | feat/cusum-detection | worker-beta | **approved** | Textbook two-sided CUSUM with proper references (Page 1954, Lucas & Crosier 1982). Channel voting robust against single-subcarrier glitches. FIR headstart, adaptive running std via MAD estimator (sqrt(π/2)) correct. Float64Array good for perf. 25 tests pass. Same _ema() duplication note. |
| INFRA-01 | feat/sqlite-init | worker-gamma | **approved** | Solid singleton pattern. WAL mode, foreign keys, busy_timeout all correct. Migration in transaction for atomicity. _resetDbSingleton for testing is good practice. inMemory mode for test isolation. 10 tests pass. Suggestion: add verbose_errors pragma for better debugging in dev. |
| DB-01 | feat/db-schema | worker-gamma | **approved** | Unified schema covers all planned modules (7 tables + 6 indexes). Version tracking via user_version is clean. Index choices match expected query patterns. Schema is embedded in INFRA-01's db/index.js — good single-file approach for PoC. |
| ACC-08-T1 | feat/ground-truth-api | worker-gamma | **approved** | Clean REST API following project conventions ({ok, data} responses). Good input validation in POST /labels: checks session exists AND is active, validates true_count range. Correct HTTP status codes (201 create, 400 validation, 404 not found, 409 conflict). Pagination support. 19 tests pass with good coverage of happy/error paths. |
| ACC-08-T2 | feat/ground-truth-ui | worker-gamma | **approved** | Well-structured labeling UI. Large touch-friendly buttons, keyboard shortcuts (0-3, S, E), live CSI context sidebar, label history. Session management flow is complete. CSS-only animations for feedback. Matches dev-heatmap.html aesthetic. Note: uses WebSocket but task description says SSE — verify which transport is correct for live context (not a blocker, both work). |
| ADMIN-01 | feat/nodes-db | worker-gamma | **approved** | Nodes table schema is complete: all specified columns present, MAC uniqueness enforced, REAL types for position coords, created_at/updated_at with datetime defaults. Part of DB-01 unified schema. 9 tests pass including constraint enforcement. |
| ADMIN-02 | feat/nodes-crud-api | worker-gamma | **approved** | Full CRUD with proper validation: MAC format regex, duplicate detection (409), partial update via dynamic SQL builder, allowed-fields whitelist prevents injection. Consistent with project API conventions. Note: PUT dynamic SQL builder constructs query from allowed list — safe pattern. |
| ACC-03-T3 | feat/empty-room-detect | worker-beta | **approved** | Well-designed Schmitt-trigger hysteresis. Clean sliding window with 10% transient spike tolerance for HVAC. State persistence via getState/restoreState. Excellent JSDoc with CFAR reference. 31 tests pass. Minor: `activeThreshold` (line 193) is computed but unused — isQuiet always uses varianceRatioThreshold; hysteresis is correctly handled in _evaluateState() so not a bug, just dead code — remove it. `_observations.shift()` in while loop is O(n) but acceptable at ≤720 entries. Suggestion: add pino logging on state transitions. |
| ACC-01-T3 | feat/doppler-fft | worker-alpha | **approved** | **Excellent work.** Pure-JS radix-2 FFT with no external deps — ideal for N100 portability. Hann window caching smart for hot-path. Clean pure function / stateful class separation. Doppler bands with physical descriptions are exemplary. 52 tests with known-signal verification. Circular buffer in DopplerAnalyzer handles wrap correctly. 52×64-pt FFT ≈ 0.2ms — well within budget. Classification thresholds well-chosen for 8-bit I/Q. Suggestion: add pino logging to DopplerAnalyzer for state transitions; consider exposing per-subcarrier spectra for debugging. |
| ADMIN-03 | feat/nodes-admin-ui | worker-gamma | **changes-requested** | CRUD, MAC validation, keyboard shortcuts all correct. Two fixes needed: (1) Font family mismatch — uses 'Courier New' instead of 'SF Mono', 'Fira Code', 'Consolas' matching dev-heatmap.html; update line 20. (2) Toast name bug — when creating node without name, toast shows "undefined" instead of MAC; fix line 708 to use `data.name \|\| macInput.value`. |
| ACC-03-T4 | feat/baseline-persist | worker-beta | **approved** | **Excellent work.** Production-ready persistence with correct atomic write (temp+rename), per-module error isolation, version-checked loading, and staleness detection. Immutable DEFAULT_CONFIG, fallback logger, diagnostic getStatus(). 41 tests cover full cycle, module failures, corrupted files, version mismatches, stale state. Suggestion: extract MODULE_KEYS as a constant (line 375) for future extensibility. |
| ACC-08-T3 | feat/label-alignment | worker-gamma | **changes-requested** | Functionally correct alignment with good UTC handling and tolerance boundaries. Three fixes needed: (1) Misleading docs — header claims "binary search" but implementation uses two ORDER BY+LIMIT queries; update to "indexed range queries". (2) Missing input validation — add sessionId format check and maxDeltaMs ≥ 0 validation. (3) Extract repeated strftime format string '%Y-%m-%d %H:%M:%f' (appears 8 times) to a module-level constant TIMESTAMP_FORMAT. Also: add a SQLite datetime format test (space-separated, no 'Z') and strengthen confidence filter test (verify filtered < unfiltered). |
| ACC-01-T4 | feat/stat-features | worker-alpha | **approved** | **Excellent work.** All formulas correct: Fisher-Pearson skewness with n/((n-1)(n-2)) correction, Bessel-corrected variance, linear interpolation quantile matching NumPy, Shannon entropy normalized to [0,1]. Pure functions throughout. Named constants (ENTROPY_BINS=16, MIN_WINDOW=8, MAX_WINDOW=400). Circular buffer efficient (~16KB memory). Export aliases (statMean/statVariance) avoid conflicts with amplitude.js. 68 tests with known-answer verification. |
| SENSOR-01 | feat/radar-parser | worker-beta | **approved** | **Excellent work.** Production-ready LD2410S parser. Byte offsets verified correct against protocol. Multi-layer frame validation: header presence, minimum length, 128-byte sanity check, tail verification, payload size. Variable gate counts (0-8) handled with proper boundary checks. Optional light sensor/output pin fields correct. Named constants throughout (FRAME_HEADER, FRAME_TAIL, MAX_GATES=9, GATE_WIDTH_CM). Buffer overflow protection at 1024 bytes. Exported pure helpers + frame builders for testing. Sub-millisecond parsing suitable for 20Hz on N100. 56 tests cover basic, engineering, robustness, mixed-mode, helpers. |
| ACC-08-T4 | feat/eval-pipeline | worker-gamma | **changes-requested** | Core evaluation math is correct and validated against sklearn equivalents — confusion matrix, precision/recall/F1, macro/weighted averages all verified. Zero-division protection present. 36 tests with known-answer verification. Two fixes needed: (1) Add input validation — `sessionId` should be checked for presence/format before querying. (2) Multi-session ID storage uses comma-joined string (line 480) which is ambiguous if IDs contain commas; refactor to JSON array. Minor: document rounding+clamping behavior at line 73-74. |
| ACC-08-T5 | feat/eval-report-api | worker-gamma | **approved** | Clean REST API with 5 well-defined endpoints. Input validation correct (sessionIds array check, numeric ID validation, limit defaults). Consistent {ok, data/error} responses with proper HTTP status codes (200/400/404/500). Pino child logger with module context. JSON parsing for confusion_json with null handling. Delegates correctly to evaluator.js. Follows all project conventions. |
| BLE-01 | feat/ble-scanner-complete | worker-beta | **approved** | **Excellent work.** Correct iBeacon parsing (Apple 0x004C, type 0x0215, 16-byte UUID, big-endian major/minor, signed TX power) and Eddystone-UID (0xFEAA, frame type 0x00, 10-byte namespace, 6-byte instance). HCI advertising report decoding with LE→BE MAC reversal. Multi-line hex accumulation robust with overflow protection (4096 chars). Pure helpers exported for testing. Unified sensor event model matches project architecture decision. 42 tests cover all parsers, frame accumulation, overflow, identity resolution, stale pruning. |
| ACC-03-T5 | feat/recal-logging | worker-beta | **pending review** | Structured pino logging for recalibration events. TriggerType enum (scheduled/cusum_shift/empty_room/manual/startup). Shift magnitude computed as relative |new-old|/old. Ring buffer (default 100 events) for API. Severity-based log levels (warn >50%, info >10%, debug <10%). getSummary() for aggregate stats. 17 tests pass. |
| ACC-03-T6 | feat/cal-history-api | worker-beta | **pending review** | REST API for calibration history. GET /history with limit/nodeId/triggerType query filters. GET /summary for aggregate stats. Input validation on triggerType against TriggerType enum. Follows project API conventions ({ok, data/error}). 9 tests pass. |
| DEBT-01 | feat/shared-ema | worker-beta | **pending review** | Extracted shared ema() to shared/math-utils.js, refactored multi-timescale.js and cusum.js to import from shared module instead of duplicating _ema(). All 54 tests across both modules still pass. Also added clamp() utility. 10 math-utils tests pass. |
| DEBT-02 | feat/cleanup-empty-room | worker-beta | **pending review** | Removed dead `activeThreshold` variable from empty-room.js. Was computed but never used — hysteresis correctly handled in _evaluateState(). 31 empty-room tests pass. |
| DEBT-03 | feat/add-logging | worker-beta | **pending review** | Added optional pino logger to EmptyRoomDetector constructor. Logs state transitions (empty↔occupied) with context (variance, threshold, confidence). Logger is optional — null-safe checks throughout. worker-beta portion only (empty-room.js); doppler.js logging assigned to worker-alpha. |
| ACC-03-T5 | feat/recal-logging | worker-beta | **approved** | Clean structured logging with severity-based levels (debug <10%, info 10-50%, warn >50% shift). Frozen TriggerType enum (5 types). Ring buffer with filtering and summary aggregation. Safe baseline handling (guards division by zero). Sequential ID for deduplication. 17 tests cover shift magnitude calculations, zero baseline edge case, ring buffer FIFO, filtering, summary stats. |
| ACC-03-T6 | feat/cal-history-api | worker-beta | **approved** | Clean Express router with GET /history (filters: nodeId, triggerType, limit clamped to [1,100]) and GET /summary. Input validation with proper 400 responses for invalid triggerType. Consistent {ok, data/error} format. 9 tests cover all filters, limit enforcement, invalid input, empty data. |
| DEBT-01 | feat/shared-ema | worker-beta | **approved** | Clean extraction of reusable EMA and clamp utilities. Excellent JSDoc with Brown 1963 reference and half-life examples. 10 tests with mathematical precision checks (1e-10 tolerance), convergence verification, boundary conditions. Properly addresses reviewer-flagged duplication between multi-timescale.js and cusum.js. |
| DEBT-02 | feat/cleanup-empty-room | worker-beta | **approved** | Dead code properly removed — no activeThreshold variable present. Hysteresis correctly handled via varianceRatioThreshold and reoccupyRatioThreshold in _evaluateState(). All 31 existing tests pass. Addresses reviewer-flagged issue from cycle 2. |
| DEBT-03 | feat/add-logging | worker-beta + worker-alpha | **approved** | **worker-beta:** Structured pino logging on EmptyRoomDetector state transitions with rich context (from/to, confidence, quietFraction, quietDurationMs, observationCount). Graceful null-check. Backward-compatible. **worker-alpha:** Module-level pino logger on DopplerAnalyzer motion_class_change events with debug on reset. Both address reviewer-flagged issue from cycle 2. All existing tests pass. |
| DB-02 | feat/db-migrations | worker-gamma | **approved** | **Excellent design.** Version tracked via PRAGMA user_version (clean, no extra table). Sequential append-only migrations with per-migration transactions for atomicity. V2 handles ALTER TABLE safely with column existence check. Migration registry with metadata. Comprehensive utilities: runMigrations, getCurrentVersion, getMigrationStatus, validateSchema. Correct refactoring of db/index.js to delegate schema work. 21 tests cover fresh migration, incremental upgrade, idempotency, data preservation, all table/index creation. |
| ACC-01-T5 | feat/corr-matrix | worker-alpha | **approved** | Mathematically sound implementation. Bessel-corrected covariance, symmetric matrix, Pearson correlation clamped to [-1,1]. Power method eigenvalue solver deterministic with appropriate convergence (MAX_ITER=20, EPSILON=1e-8 for 8×8). Trace-based smallest eigenvalue estimation with MAX_SPREAD=1000 cap. Rich correlation features (mean/min/max off-diagonal, adjacent, edge-DC). O(n·64) per window, ~8KB memory per node. 46 tests with known-answer verification (identity, rank-1, known 2×2 eigenvalues). |
| ACC-01-T6 | feat/frame-quality | worker-alpha | **approved** | Well-tuned quality scorer. RSSI stability (variance thresholds), timestamp jitter (CV-based), packet loss (16-bit seq wraparound handled), amplitude validity (70% subcarrier threshold). Weights sum to 1.0 (0.25+0.25+0.30+0.20). All sub-scores normalized to [0,1]. Named constants throughout. ~400B memory per node. 33 tests including wraparound edge case [65534,65535,0,1,2] → 0% loss. |
| ACC-01-T7 | feat/feature-serializer | worker-alpha | **approved** | Clean dual-format serialization. JSON (epoch-ms for SSE), CSV (ISO 8601 for ML). Precision tuned: PRECISION_STANDARD=4, PRECISION_HIGH=6. Column definitions frozen with Object.freeze(). Band arrays correctly flattened with prefixed naming (band_0_mean, band_1_variance, etc.). Column uniqueness enforced. Pure functions throughout. Round-trip serialization verified. 35 tests. |
| ACC-01-T8 | feat/features-api | worker-alpha | **approved** | Combined ACC-01-T8 (REST) and ACC-01-T9 (SSE) cleanly in one module. FeatureStore: Map-based O(1) lookup with MAC normalization to uppercase. SSE at 5Hz (200ms) with 30s keepalive, 5min idle timeout. Correct SSE headers (Content-Type, Cache-Control, X-Accel-Buffering). Node filtering via ?node= query param. Factory pattern with DI for logger and store. Cleanup prevents memory leaks. 14 tests. |
| ADMIN-04 | feat/nodes-discovery-sync | worker-gamma | **approved** | Well-designed EventEmitter bridge. Comprehensive MAC normalization (uppercase, raw 12-char hex, colon-separated, invalid → null). COALESCE for firmware prevents null overwrites. Manually-added nodes preserved (discovery_source stays 'manual'). Reconciliation marks missing nodes offline without auto-delete. Double-subscription prevention. Error resilience with try-catch in handlers. Parameterized SQL throughout. 21 tests cover lifecycle, registration, duplicates, MAC formats, offline marking, reconciliation, error resilience. |
| ACC-08-T3 | feat/label-alignment | worker-gamma | **pending review** | **Cycle 3 fixes:** (1) Updated header docs from "binary search" to "indexed range queries" matching actual implementation. (2) Added input validation: sessionId format check (regex), maxDeltaMs ≥ 0 validation with informative errors. (3) Extracted repeated strftime format to TIMESTAMP_FORMAT module constant (was hardcoded 8 times). (4) Added 8 new tests: input validation (6 tests), SQLite datetime format handling (1 test), confidence filter strength verification (1 test). Total: 31 tests pass (was 23). |
| ACC-08-T4 | feat/eval-pipeline | worker-gamma | **pending review** | **Cycle 3 fixes:** (1) Added sessionId validation in evaluateSession() and sessionIds array validation in evaluateMultipleSessions(). (2) Refactored multi-session ID storage from comma-joined string to JSON.stringify(sessionIds) — eliminates ambiguity if IDs contain commas. (3) Documented rounding+clamping behavior at buildConfusionMatrix lines 73-74 with explanation of why (ensemble averages, 3+ class mapping). All 36 existing tests pass. |
| ADMIN-03 | feat/nodes-admin-ui | worker-gamma | **pending review** | **Cycle 3 fixes:** (1) Fixed font family from 'Courier New' to 'SF Mono', 'Fira Code', 'Consolas' matching dev-heatmap.html. (2) Fixed toast name bug: create-node toast now references `data.name \|\| macInput.value` instead of potentially-undefined `name` variable. |
| DEBT-04 | feat/gt-transport-fix | worker-gamma | **pending review** | Converted ground-truth.html from WebSocket to SSE (EventSource). Was using `new WebSocket('/ws')` — now uses `new EventSource('/api/v1/features/stream')` matching project conventions (dev-heatmap.html uses EventSource, features API provides SSE at 5Hz). Added proper EventSource cleanup on session end. Auto-reconnect handled natively by EventSource. |
| DB-03 | feat/event-storage | worker-gamma | **pending review** | Promoted from backlog (DB-01 foundation approved). New event-storage.js module: storeEvent() with full input validation (node_id, predicted_count, confidence 0-1, algorithm enum). storeBatch() for high-throughput ingestion with transactional atomicity and MAX_BATCH_SIZE=500 guard. Query functions: getEventsByNode (with since/algorithm filters), getEventsInRange, getEventSummary (per-node aggregates), countEvents. pruneOldEvents() for data retention (default 30 days). Express route handler factories for GET/POST /api/v1/events. 35 tests cover single insert, batch, validation errors, queries, pruning, constants. |
| ADMIN-07 | feat/nodes-health-api | worker-gamma | **pending review** | Promoted from backlog (ADMIN-01/02 approved). New node-health.js module: tcpPing() checks TCP reachability with configurable timeout. fetchNodeInfo() retrieves firmware version from ESP32 /info HTTP endpoint using raw socket (no node-fetch dependency). checkNodeHealth() orchestrates: DB lookup → TCP ping → optional /info fetch → DB status update. pingAllNodes() bulk checks all nodes with IPs. Express router: GET /:id/ping (single node) and GET /ping/all (bulk). Proper error handling: 404 for unknown node, 422 for no IP. 13 tests cover TCP ping (reachable/unreachable/timeout), HTTP info parsing, DB integration, bulk ping, constants. |
| SENSOR-02 | feat/radar-sse | worker-beta | **pending review** | Promoted from backlog (all SENSOR P0s approved). New radar-sse.js module: toUnifiedEvent() adapter transforms RadarReading→unified event model {type:'radar-reading', source:'radar', timestamp, data}. RadarStore class: in-memory store with SSE client management, push/broadcast, basic+engineering latest tracking. Express router: GET /api/v1/radar (snapshot), GET /api/v1/radar/stream (SSE with ?mode=engineering filter), GET /api/v1/radar/stats. connectRadarToStore() bridge function wires RadarService→RadarStore with cleanup. Mounted in api-v1.js, wired in index.js with graceful shutdown. 30 tests pass: toUnifiedEvent (5), RadarStore (12), connectRadarToStore (6), constants (4), integration (3). |

---

## Architecture Decisions Log

| Date | Decision | Rationale | Decided By |
|------|----------|-----------|------------|
| 2026-03-31 | Use better-sqlite3 for all storage | Synchronous API, zero-config, fast, portable. Sufficient for PoC volumes (< 1M rows). | architect |
| 2026-03-31 | Feature vectors as JSON arrays in SSE stream | Compatible with existing SSE infrastructure, easy to consume in browser | architect |
| 2026-03-31 | Workers commit to feature branches, reviewer merges to main | Prevents conflicts, ensures code review before integration | architect |
| 2026-03-31 | Unified sensor event model: {type, source, timestamp, data} | CSI, radar, BLE all emit same event structure for clean fusion | architect |
| 2026-03-31 | Admin UI as separate HTML pages (same pattern as dev-heatmap.html) | Keep deployment simple, no build step, progressive enhancement | architect |
| 2026-03-31 | LD2410S connected via ESP32 UART, not directly to MeLE | ESP32 already has UART handling, keeps MeLE USB ports free | architect |
| 2026-03-31 | BLE beacons for identity, CSI for presence/activity, radar for validation | Each sensor's strength compensates others' weaknesses | architect |
| 2026-03-31 | Hospital KPI metrics derived from zone events, not raw sensor data | Clean separation of sensing layer and analytics layer | architect |
| 2026-03-31 | Extract shared math utilities (EMA, etc.) into shared/math-utils.js | Prevent duplication across calibration modules. Reviewer flagged _ema() in both multi-timescale.js and cusum.js — single source of truth reduces maintenance risk | architect |
| 2026-03-31 | Standardize on SSE for all live data streams (not WebSocket) | Project already uses SSE infrastructure; ground-truth UI should align. WebSocket adds a second protocol with no benefit for unidirectional push | architect |
| 2026-03-31 | P1 task promotion policy: promote all P1s in a work package once all P0s in that package are approved | Keeps workers unblocked. Day 1 cleared all P0s — workers need immediate next assignments | architect |
| 2026-03-31 | E2E integration test at review cycle 4 (after ~20 reviews) | Enough modules exist to test cross-module integration. Earlier E2E would test too little. Next E2E checkpoint: when ACC-08-T3/T4/T5 + ACC-03-T4 are approved (full ground-truth + persistence pipeline) | architect |
| 2026-03-31 | Tech-debt items assigned to module owners, treated as gap-fillers | Keeps main sprint velocity while resolving reviewer-flagged issues. Workers should pick up DEBT tasks when between main task assignments | architect |

---

## Blocked Items

| Task ID | Blocked By | Description | Unblock Action |
|---------|------------|-------------|----------------|
| (none currently) | | | |

---

## Completed Tasks

| Task ID | Title | Worker | Completed | Review Status |
|---------|-------|--------|-----------|---------------|
| INFRA-02 | Create shared constants module: subcarrier count, frame sizes, feature names enum | worker-alpha | 2026-03-31 | approved (first try) |
| ACC-01-T1 | Implement subcarrier grouping into 8 logical bands | worker-alpha | 2026-03-31 | approved (first try) |
| ACC-01-T2 | Add phase difference extraction with linear unwrapping | worker-alpha | 2026-03-31 | approved (first try) |
| ACC-03-T1 | Implement multi-timescale baseline tracking (3-tier EMA) | worker-beta | 2026-03-31 | approved (first try) |
| ACC-03-T2 | Add CUSUM environment change detection on per-subcarrier residuals | worker-beta | 2026-03-31 | approved (first try) |
| INFRA-01 | Add better-sqlite3 database init module with WAL mode | worker-gamma | 2026-03-31 | approved (first try) |
| DB-01 | Design unified SQLite schema (7 tables + 6 indexes) | worker-gamma | 2026-03-31 | approved (first try) |
| ACC-08-T1 | Build ground truth REST API (sessions + labels CRUD) | worker-gamma | 2026-03-31 | approved (first try) |
| ACC-08-T2 | Build label collection web UI with keyboard shortcuts | worker-gamma | 2026-03-31 | approved (first try) |
| ADMIN-01 | Create nodes database table with MAC uniqueness | worker-gamma | 2026-03-31 | approved (first try) |
| ADMIN-02 | Build /api/v1/nodes CRUD endpoints with MAC validation | worker-gamma | 2026-03-31 | approved (first try) |
| ACC-03-T3 | Build automatic empty-room detection heuristic (Schmitt-trigger hysteresis) | worker-beta | 2026-03-31 | approved (first try) |
| ACC-01-T3 | Implement short-time FFT for Doppler motion classification | worker-alpha | 2026-03-31 | approved (first try) |
| ACC-03-T4 | Implement baseline persistence to disk (atomic write, per-module error isolation) | worker-beta | 2026-03-31 | approved (first try) |
| ACC-03-T5 | Add recalibration event structured logging with shift magnitude | worker-beta | 2026-03-31 | approved (first try) |
| ACC-03-T6 | Create /api/v1/calibration/history endpoint | worker-beta | 2026-03-31 | approved (first try) |
| SENSOR-01 | Complete LD2410S UART parser for engineering mode frames | worker-beta | 2026-03-31 | approved (first try) |
| BLE-01 | Complete BLE scanner hcitool/hcidump integration (iBeacon + Eddystone-UID) | worker-beta | 2026-03-31 | approved (first try) |
| ACC-01-T4 | Add statistical features (skewness, kurtosis, IQR, entropy per window) | worker-alpha | 2026-03-31 | approved (first try) |
| ACC-01-T5 | Implement subcarrier correlation matrix with eigenvalue spread | worker-alpha | 2026-03-31 | approved (first try) |
| ACC-01-T6 | Build frame quality scorer (RSSI stability, jitter, packet loss) | worker-alpha | 2026-03-31 | approved (first try) |
| ACC-01-T7 | Create feature vector serializer (JSON for SSE, CSV for ML) | worker-alpha | 2026-03-31 | approved (first try) |
| ACC-01-T8/T9 | Features REST API + SSE stream at 5Hz (combined in one module) | worker-alpha | 2026-03-31 | approved (first try) |
| ACC-08-T5 | Build /api/v1/evaluation/report endpoint | worker-gamma | 2026-03-31 | approved (first try) |
| ADMIN-04 | Integrate discovery service with nodes DB (auto-register, MAC normalization) | worker-gamma | 2026-03-31 | approved (first try) |
| DB-02 | Implement database migration system (version-tracked, transactional) | worker-gamma | 2026-03-31 | approved (first try) |
| DEBT-01 | Extract shared EMA helper into shared/math-utils.js | worker-beta | 2026-03-31 | approved (first try) |
| DEBT-02 | Remove dead activeThreshold variable in empty-room.js | worker-beta | 2026-03-31 | approved (first try) |
| DEBT-03 | Add pino logging to empty-room.js and doppler.js state transitions | worker-beta + worker-alpha | 2026-03-31 | approved (first try) |
| DEBT-04 | Verify ground-truth.html transport: standardize to SSE | worker-gamma | 2026-03-31 | pending review |
| DB-03 | Build event storage module (single/batch insert, queries, pruning) | worker-gamma | 2026-03-31 | pending review |
| ADMIN-07 | Add node health check endpoint (TCP ping, firmware fetch) | worker-gamma | 2026-03-31 | pending review |

---

## Quality Metrics

- Review cycle count: 3 (E2E test on every 4th — **next E2E: cycle 4**)
- Tasks reviewed: 32 (13 in cycles 1-2 + 19 in cycle 3)
- Approved first try: 29
- Changes requested: 3
  - ACC-08-T3 (label alignment): misleading docs, missing input validation, repeated magic string
  - ACC-08-T4 (eval pipeline): missing sessionId validation, unsafe comma-joined multi-session IDs
  - ADMIN-03 (nodes admin UI): font family mismatch with dev-heatmap.html, toast name bug
- Common issues (cumulative):
  - ~~`_ema()` helper duplicated~~ **RESOLVED by DEBT-01** (shared/math-utils.js)
  - ~~Dead code: `activeThreshold` in empty-room.js~~ **RESOLVED by DEBT-02**
  - ~~No pino logging in empty-room.js, doppler.js~~ **RESOLVED by DEBT-03**
  - ground-truth.html uses WebSocket but task spec says SSE — verify correct transport (not blocking)
  - **NEW:** Input validation gaps in ground-truth pipeline (alignment + evaluator) — sessionId format checks, parameter validation
  - **NEW:** Font inconsistency in admin UIs (admin-nodes.html uses Courier New, should match SF Mono/Fira Code stack)
- Test suite: 883/884 pass (1 pre-existing ota-manager.test.js failure)
- Notes: Cycle 3 was the largest review batch yet — 19 items across all 3 workers + tech debt. Quality remains exceptionally high: 16/19 approved first try. The 3 changes-requested items have minor-to-medium severity issues (no correctness bugs in core logic). worker-alpha delivered the complete feature extraction pipeline (statistics, correlation, quality, serializer, API+SSE) — all 6 modules approved first try with excellent math, pure functions, and comprehensive tests. worker-beta's sensor work is production-ready: LD2410S radar parser and BLE scanner both have thorough protocol handling and defensive parsing. worker-gamma's infrastructure work (migrations, discovery sync, eval API) is solid, but the ground-truth alignment/evaluation chain needs input validation hardening. All 4 tech-debt items from cycle 2 feedback are now resolved. Sprint 1 is nearing completion — only 3 items need fixes before the full pipeline is reviewable end-to-end.

---

## E2E Test Results

| Date | Cycle # | Tests Pass | API OK | SSE OK | UI OK | DB OK | Memory | Issues Found |
|------|---------|------------|--------|--------|-------|-------|--------|--------------|
| (no tests yet) | | | | | | | | |

---

## Sprint Backlog Summary

| Sprint | Focus | Story Points | Tasks | Status |
|--------|-------|-------------|-------|--------|
| Sprint 1 | Foundation: Features + Baseline + Ground Truth + DB + Admin | ~65 SP | 30 done, 3 changes-requested, 5 backlog | Active (Day 1 EOD — review bottleneck cleared, 3 items need fixes) |
| Sprint 2 | ML Classifier + Vital Signs + State Machine + GDPR | ~55 SP | 23 tasks | Planned |
| Sprint 3 | Spatial Fusion + Interference + Zones + Radar/BLE Fusion | ~60 SP | 22 tasks | Planned |
| Sprint 4 | Dashboard + KPIs + Integrations + Analytics | ~55 SP | 18 tasks | Planned |
| Sprint 5 | Polish + E2E Testing + Deployment Hardening + Documentation | TBD | TBD | Planned |

---

## Next Sprint Planning (Sprint 2 Preview)

**Promote to ready when Sprint 1 P0 tasks complete:**
- ACC-02-T1 through ACC-02-T5 (ML Classifier foundation)
- ACC-06-T1 through ACC-06-T4 (Vital sign hardening)
- ACC-09-T1 through ACC-09-T3 (State machine)
- GDPR-01, GDPR-02 (Audit logging, anonymization)
- UX-01, UX-02 (Dashboard shell, overview panel)

**Hardware dependencies for Sprint 2:**
- LD2410S radar modules (on order) → SENSOR-01 through SENSOR-06
- BLE beacons (on order) → BLE-01 through BLE-07
