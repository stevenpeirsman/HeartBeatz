// ==============================================================================
// Enhanced Room Map Visualization
// ==============================================================================
// Renders the interactive room map on the 7" kiosk touchscreen. This module
// replaces the basic drawRoomMap function in app.js with a full-featured
// visualization including:
//
//   - CSI heatmap overlay (Gaussian blobs around detected persons)
//   - Person tracking trails (fading breadcrumb paths showing movement)
//   - Node placement editor (drag nodes to match physical room layout)
//   - CSI mesh visualization (lines between node pairs showing link quality)
//   - Mini vital signs overlay (HR + BR displayed on the map)
//   - Interactive legend with color key
//
// Architecture:
//   This module exports a RoomMap class. The main app.js creates an instance
//   and calls .render() on each animation frame. The RoomMap reads state from
//   the shared app state object (passed in constructor) and handles all canvas
//   drawing internally.
//
// Usage (in app.js):
//   const roomMap = new RoomMap(canvas, state, { onNodeMoved });
//   setInterval(() => roomMap.render(), 1000 / 20);

// ---------------------------------------------------------------------------
// Configuration Constants
// ---------------------------------------------------------------------------

/** Maximum number of trail points to keep per person. */
const MAX_TRAIL_LENGTH = 60;

/** Trail point fade duration in ms — older points are more transparent. */
const TRAIL_FADE_MS = 6000;

/** Heatmap blob radius (in canvas pixels). */
const HEATMAP_RADIUS = 80;

/** How far from a node the drag handle extends (touch target in px). */
const NODE_DRAG_RADIUS = 30;

/** Animation frame time divisor for smooth sine-based motion. */
const ANIM_SPEED = 0.001;

/** Padding from canvas edge to room boundary (px). */
const ROOM_PADDING = 50;

/** Legend position offset from bottom-left. */
const LEGEND_X = 16;
const LEGEND_Y_OFFSET = 10;

// ---------------------------------------------------------------------------
// Color Palette (matches CSS variables)
// ---------------------------------------------------------------------------
const COLORS = {
  bg:         '#08090d',
  roomBorder: '#1e2130',
  roomFill:   '#0a0c14',
  nodeFill:   '#4f8cff',
  nodeGlow:   'rgba(79,140,255,0.12)',
  nodeMesh:   'rgba(79,140,255,0.06)',
  personFill: '#ff6b4f',
  personGlow: 'rgba(255,107,79,0.25)',
  trailColor: 'rgba(255,107,79,0.4)',
  heatLow:    'rgba(79,140,255,0.04)',
  heatMid:    'rgba(255,107,79,0.08)',
  heatHigh:   'rgba(239,68,68,0.12)',
  radarFill:  'rgba(52,211,153,0.12)',
  radarText:  '#34d399',
  textMuted:  '#6b7280',
  textLight:  '#9ca3af',
  accent4:    '#f59e0b',
  staff:      '#8b5cf6',
  danger:     '#ef4444',
  white:      '#e2e8f0',
};


// ===========================================================================
// RoomMap Class
// ===========================================================================

class RoomMap {
  /**
   * @param {HTMLCanvasElement} canvas   - The room map canvas element
   * @param {Object}           appState - Shared app state (nodes, beacons, vitals, etc.)
   * @param {Object}           [opts]   - Optional callbacks and settings
   * @param {Function}         [opts.onNodeMoved] - Called with (nodeId, {x, y}) when user drags a node
   */
  constructor(canvas, appState, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.state = appState;
    this.onNodeMoved = opts.onNodeMoved || null;

    // --- Internal state ---

    /** Node positions: Map<nodeId, {x: 0-1, y: 0-1}> (normalized room coordinates) */
    this.nodePositions = new Map();

    /** Person trail history: Array of { persons: [{x,y}], timestamp } */
    this.trails = [];

    /** Currently dragged node ID (null if not dragging) */
    this._dragNodeId = null;

    /** Whether the map is in edit mode (shows drag handles on nodes) */
    this.editMode = false;

    /** Off-screen canvas for heatmap rendering (avoids re-allocation). */
    this._heatCanvas = document.createElement('canvas');
    this._heatCtx = this._heatCanvas.getContext('2d');

    /** Floor plan background image (loaded from server) */
    this._floorplanImg = null;
    this._floorplanLoaded = false;

    /** Room outline polygon from floor plan setup [{x, y}, ...] normalized 0-1 */
    this._roomOutline = null;

    // --- Touch / mouse event handling ---
    this._setupInteraction();

    // Try loading floor plan image
    this._loadFloorplan();
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /** Main render call — draw everything on the canvas. */
  render() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // Room area (padded bounding box for the L-shaped floorplan)
    const room = {
      x: ROOM_PADDING,
      y: ROOM_PADDING,
      w: w - ROOM_PADDING * 2,
      h: h - ROOM_PADDING * 2,
    };

    // Actual floorplan: open-plan rectangle with bottom-right cutout
    // (Inkomhal / spiral staircase area). Based on real dimensions:
    // ~11.6m × 7.95m with entry hall cutting into bottom-right.
    //
    //   ┌────────────────────────────┐
    //   │  Zithoek   Eethoek  Keuken│  ← garden/window wall (top)
    //   │  (sitting)  (dining) (cook)│
    //   │   couch      table   oven  │
    //   │                  ┌─────────┘  ← cutout for Inkomhal
    //   │   TV closet      │ entry/
    //   └──────────────────┘ stairs
    //
    // cutoutFraction: how far LEFT the cutout starts (from right edge)
    // cutoutHeight:   how tall the cutout is (from bottom)
    room.cutoutFracX = 0.30;   // Inkomhal is ~30% of room width
    room.cutoutFracY = 0.42;   // Inkomhal is ~42% of room height
    room.cutoutW = room.w * room.cutoutFracX;
    room.cutoutH = room.h * room.cutoutFracY;
    room.cutoutX = room.x + room.w - room.cutoutW;  // X where cutout starts
    room.cutoutY = room.y + room.h - room.cutoutH;  // Y where cutout starts
    // Main room width excluding cutout at bottom
    room.mainBottomW = room.w - room.cutoutW;

    // Record person positions for trails
    this._recordTrailPoint();

    // ── Layer 1: Background ──
    this._drawBackground(ctx, w, h);

    // ── Layer 2: Room boundary ──
    this._drawRoomBoundary(ctx, room);

    // ── Layer 2b: Floor plan image (if uploaded) ──
    if (this._floorplanImg && this._floorplanLoaded) {
      ctx.save();
      this._traceRoomPath(ctx, room);
      ctx.clip();
      // Scale image to fill the room area while maintaining aspect ratio
      const img = this._floorplanImg;
      const imgAspect = img.width / img.height;
      const roomAspect = room.w / room.h;
      let drawW, drawH, drawX, drawY;
      if (imgAspect > roomAspect) {
        drawW = room.w;
        drawH = room.w / imgAspect;
        drawX = room.x;
        drawY = room.y + (room.h - drawH) / 2;
      } else {
        drawH = room.h;
        drawW = room.h * imgAspect;
        drawX = room.x + (room.w - drawW) / 2;
        drawY = room.y;
      }
      ctx.globalAlpha = 0.25; // Semi-transparent so overlays remain visible
      ctx.drawImage(img, drawX, drawY, drawW, drawH);
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // ── Layer 3: CSI Heatmap overlay ──
    this._drawHeatmap(ctx, room);

    // ── Layer 4: CSI mesh between nodes ──
    this._drawNodeMesh(ctx, room);

    // ── Layer 5: Person trails (clipped to L-shape) ──
    ctx.save();
    this._traceRoomPath(ctx, room);
    ctx.clip();
    this._drawTrails(ctx, room);
    ctx.restore();

    // ── Layer 6: Sensor nodes ──
    this._drawNodes(ctx, room);

    // ── Layer 7: Person dots (clipped to L-shape) ──
    ctx.save();
    this._traceRoomPath(ctx, room);
    ctx.clip();
    this._drawPersons(ctx, room, w, h);
    ctx.restore();

    // ── Layer 8: Beacon indicators ──
    this._drawBeacons(ctx, room, w, h);

    // ── Layer 9: Radar indicator ──
    this._drawRadar(ctx, room, w, h);

    // ── Layer 10: Mini vitals overlay ──
    this._drawVitalsOverlay(ctx, w, h);

    // ── Layer 11: Legend ──
    this._drawLegend(ctx, w, h);

    // ── Layer 12: Edit mode handles ──
    if (this.editMode) {
      this._drawEditHandles(ctx, room);
    }
  }

  /**
   * Load saved node positions from the server.
   * Called once when the dashboard initializes.
   */
  async loadLayout() {
    try {
      const res = await fetch('/api/room-layout');
      const data = await res.json();
      for (const node of data.nodes || []) {
        if (node.position) {
          this.nodePositions.set(node.id, node.position);
        }
      }
    } catch {
      // Layout not available yet — nodes will auto-position
    }
  }

  /**
   * Load floor plan image and room config from the server.
   * The image becomes the background of the room map.
   */
  async _loadFloorplan() {
    try {
      // Load room config (outline, etc.)
      const cfgRes = await fetch('/api/room-config');
      const cfgData = await cfgRes.json();
      if (cfgData.roomConfig?.outline?.length >= 3) {
        this._roomOutline = cfgData.roomConfig.outline;
      }

      // Load floor plan image
      if (cfgData.hasFloorplan) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          this._floorplanImg = img;
          this._floorplanLoaded = true;
        };
        img.onerror = () => {
          this._floorplanLoaded = false;
        };
        img.src = '/api/floorplan?' + Date.now(); // cache bust
      }
    } catch {
      // No floor plan available — use default room shape
    }
  }

  /** Toggle the node placement edit mode on/off. */
  toggleEditMode() {
    this.editMode = !this.editMode;
    return this.editMode;
  }

  // =========================================================================
  // Drawing Layers
  // =========================================================================

  /** Layer 1: Dark background fill. */
  _drawBackground(ctx, w, h) {
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);
  }

  /** Layer 2: Room boundary with grid, zone labels, and furniture hints. */
  _drawRoomBoundary(ctx, room) {
    const { x, y, w, h, cutoutX, cutoutY, cutoutW, cutoutH, mainBottomW } = room;

    // Build room path (clockwise from top-left, with bottom-right cutout)
    this._traceRoomPath(ctx, room);

    // Room fill
    ctx.fillStyle = COLORS.roomFill;
    ctx.fill();

    // Subtle grid lines (clipped to room shape)
    ctx.save();
    this._traceRoomPath(ctx, room);
    ctx.clip();

    ctx.strokeStyle = 'rgba(30,33,48,0.4)';
    ctx.lineWidth = 0.5;
    const gridSize = 80;
    for (let gx = x + gridSize; gx < x + w; gx += gridSize) {
      ctx.beginPath();
      ctx.moveTo(gx, y);
      ctx.lineTo(gx, y + h);
      ctx.stroke();
    }
    for (let gy = y + gridSize; gy < y + h; gy += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, gy);
      ctx.lineTo(x + w, gy);
      ctx.stroke();
    }
    ctx.restore();

    // Room border
    this._traceRoomPath(ctx, room);
    ctx.strokeStyle = COLORS.roomBorder;
    ctx.lineWidth = 2;
    ctx.stroke();

    // ── Zone divider lines (dashed) ──
    ctx.strokeStyle = 'rgba(30,33,48,0.6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);

    // Vertical divider: Zithoek | Eethoek (at ~42% from left)
    const divZitEet = x + w * 0.42;
    ctx.beginPath();
    ctx.moveTo(divZitEet, y);
    ctx.lineTo(divZitEet, y + h);
    ctx.stroke();

    // Vertical divider: Eethoek | Keuken (at ~72% from left)
    const divEetKeu = x + w * 0.72;
    ctx.beginPath();
    ctx.moveTo(divEetKeu, y);
    ctx.lineTo(divEetKeu, cutoutY);
    ctx.stroke();

    ctx.setLineDash([]);

    // ── Zone labels ──
    ctx.fillStyle = 'rgba(107,114,128,0.35)';
    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('ZITHOEK', x + w * 0.21, y + 16);
    ctx.fillText('EETHOEK', (divZitEet + divEetKeu) / 2, y + 16);
    ctx.fillText('KEUKEN', (divEetKeu + x + w) / 2, y + 16);

    // Inkomhal label inside the cutout area (dimmer, outside main room)
    ctx.fillStyle = 'rgba(107,114,128,0.15)';
    ctx.font = '9px Inter, sans-serif';
    ctx.fillText('INKOMHAL', cutoutX + cutoutW / 2, cutoutY + 16);

    // ── Furniture hints (very subtle rectangles) ──
    ctx.strokeStyle = 'rgba(30,33,48,0.5)';
    ctx.lineWidth = 0.8;

    // Couch (sitting area, center-left, roughly 35% from left, 55% from top)
    const couchX = x + w * 0.15;
    const couchY = y + h * 0.45;
    const couchW = w * 0.22;
    const couchH = h * 0.18;
    ctx.strokeRect(couchX, couchY, couchW, couchH);
    ctx.fillStyle = 'rgba(107,114,128,0.12)';
    ctx.font = '8px Inter, sans-serif';
    ctx.fillText('couch', couchX + couchW / 2, couchY + couchH / 2 + 3);

    // TV closet (bottom-left, below couch)
    const tvX = x + w * 0.15;
    const tvY = y + h * 0.78;
    const tvW = w * 0.22;
    const tvH = h * 0.08;
    ctx.strokeStyle = 'rgba(30,33,48,0.5)';
    ctx.strokeRect(tvX, tvY, tvW, tvH);
    ctx.fillText('tv', tvX + tvW / 2, tvY + tvH / 2 + 3);

    // Desk (top area, center)
    const deskX = x + w * 0.28;
    const deskY = y + h * 0.10;
    const deskW = w * 0.14;
    const deskH = h * 0.10;
    ctx.strokeRect(deskX, deskY, deskW, deskH);
    ctx.fillText('desk', deskX + deskW / 2, deskY + deskH / 2 + 3);

    // Dining table (center zone)
    const tableX = x + w * 0.50;
    const tableY = y + h * 0.35;
    const tableW = w * 0.15;
    const tableH = h * 0.20;
    ctx.strokeRect(tableX, tableY, tableW, tableH);
    ctx.fillText('table', tableX + tableW / 2, tableY + tableH / 2 + 3);

    // Kitchen counter (right side, top area)
    const counterX = x + w * 0.80;
    const counterY = y + h * 0.10;
    const counterW = w * 0.12;
    const counterH = h * 0.45;
    ctx.strokeRect(counterX, counterY, counterW, counterH);
    ctx.fillText('counter', counterX + counterW / 2, counterY + counterH / 2 + 3);

    // Garden/window wall indicator (top edge)
    ctx.fillStyle = 'rgba(52,211,153,0.15)';
    ctx.font = '8px Inter, sans-serif';
    ctx.fillText('← garden / schuifraam →', x + w * 0.35, y - 4);

    // Spiral staircase hint (small circle in the cutout area)
    ctx.strokeStyle = 'rgba(30,33,48,0.3)';
    ctx.lineWidth = 0.6;
    const stairCx = cutoutX + cutoutW * 0.5;
    const stairCy = cutoutY + cutoutH * 0.55;
    ctx.beginPath();
    ctx.arc(stairCx, stairCy, 12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(107,114,128,0.12)';
    ctx.fillText('stairs', stairCx, stairCy + 20);
  }

  /** Layer 3: CSI heatmap — Gaussian blobs around each detected person. */
  _drawHeatmap(ctx, room) {
    const personCount = this.state.vitals?.persons || 0;
    if (personCount === 0) return;

    // Use off-screen canvas sized to room for heatmap compositing
    this._heatCanvas.width = room.w;
    this._heatCanvas.height = room.h;
    const hctx = this._heatCtx;
    hctx.clearRect(0, 0, room.w, room.h);

    // Get person positions from sensing data, or generate smooth positions
    const positions = this._getPersonPositions(personCount);

    for (const pos of positions) {
      const px = pos.x * room.w;
      const py = pos.y * room.h;

      // Gaussian-like radial gradient
      const grad = hctx.createRadialGradient(px, py, 0, px, py, HEATMAP_RADIUS);
      grad.addColorStop(0, 'rgba(255,107,79,0.18)');
      grad.addColorStop(0.3, 'rgba(255,107,79,0.10)');
      grad.addColorStop(0.6, 'rgba(79,140,255,0.05)');
      grad.addColorStop(1, 'rgba(79,140,255,0)');

      hctx.fillStyle = grad;
      hctx.fillRect(px - HEATMAP_RADIUS, py - HEATMAP_RADIUS,
                     HEATMAP_RADIUS * 2, HEATMAP_RADIUS * 2);
    }

    // Composite heatmap onto main canvas (clipped to L-shape)
    ctx.save();
    this._traceRoomPath(ctx, room);
    ctx.clip();
    ctx.drawImage(this._heatCanvas, room.x, room.y);
    ctx.restore();
  }

  /** Layer 4: CSI mesh — thin lines between nodes showing wireless links. */
  _drawNodeMesh(ctx, room) {
    const nodes = this._getNodeScreenPositions(room);
    if (nodes.length < 2) return;

    ctx.strokeStyle = COLORS.nodeMesh;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);

    // Draw a line between every pair of nodes
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        ctx.beginPath();
        ctx.moveTo(nodes[i].sx, nodes[i].sy);
        ctx.lineTo(nodes[j].sx, nodes[j].sy);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);

    // Draw small "signal" dots at midpoints
    ctx.fillStyle = 'rgba(79,140,255,0.08)';
    const t = Date.now() * ANIM_SPEED;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const mx = (nodes[i].sx + nodes[j].sx) / 2;
        const my = (nodes[i].sy + nodes[j].sy) / 2;
        const pulse = 3 + Math.sin(t + i * 1.5 + j * 2.3) * 2;
        ctx.beginPath();
        ctx.arc(mx, my, pulse, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /** Layer 5: Person tracking trails — fading breadcrumb path. */
  _drawTrails(ctx, room) {
    if (this.trails.length < 2) return;

    const now = Date.now();

    // We draw separate trails for each "person slot" (index in persons array)
    // Find the max person count we've seen
    let maxPersons = 0;
    for (const point of this.trails) {
      if (point.persons.length > maxPersons) maxPersons = point.persons.length;
    }

    for (let p = 0; p < maxPersons; p++) {
      ctx.beginPath();
      let started = false;

      for (let i = 0; i < this.trails.length; i++) {
        const point = this.trails[i];
        if (p >= point.persons.length) continue;

        const age = now - point.timestamp;
        if (age > TRAIL_FADE_MS) continue;

        const pos = point.persons[p];
        const sx = room.x + pos.x * room.w;
        const sy = room.y + pos.y * room.h;

        // Opacity fades with age
        const alpha = Math.max(0, 1 - age / TRAIL_FADE_MS) * 0.5;

        if (!started) {
          ctx.moveTo(sx, sy);
          started = true;
        } else {
          ctx.lineTo(sx, sy);
        }

        // Draw trail dots at intervals
        if (i % 5 === 0) {
          ctx.fillStyle = `rgba(255,107,79,${alpha * 0.6})`;
          ctx.fillRect(sx - 1.5, sy - 1.5, 3, 3);
        }
      }

      if (started) {
        ctx.strokeStyle = COLORS.trailColor;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  /** Layer 6: Sensor node icons with WiFi arcs, labels, and per-node vitals. */
  _drawNodes(ctx, room) {
    const nodes = this._getNodeScreenPositions(room);

    // Look up per-node vitals from the WebSocket data
    const nodeVitals = this.state.sensing?.node_vitals || [];

    for (const { node, sx, sy } of nodes) {
      const isOnline = node.status === 'online';

      // WiFi signal arcs (concentric circles)
      ctx.strokeStyle = isOnline
        ? 'rgba(79,140,255,0.12)' : 'rgba(107,114,128,0.06)';
      ctx.lineWidth = 1;
      for (let r = 20; r <= 60; r += 20) {
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Glow around node
      if (isOnline) {
        const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, 20);
        glow.addColorStop(0, 'rgba(79,140,255,0.15)');
        glow.addColorStop(1, 'rgba(79,140,255,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(sx, sy, 20, 0, Math.PI * 2);
        ctx.fill();
      }

      // Node dot
      ctx.fillStyle = isOnline ? COLORS.nodeFill : COLORS.textMuted;
      ctx.beginPath();
      ctx.arc(sx, sy, 7, 0, Math.PI * 2);
      ctx.fill();

      // Inner dot
      ctx.fillStyle = COLORS.bg;
      ctx.beginPath();
      ctx.arc(sx, sy, 3, 0, Math.PI * 2);
      ctx.fill();

      // Label
      ctx.fillStyle = isOnline ? COLORS.textLight : COLORS.textMuted;
      ctx.font = '10px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(node.name || 'Node', sx, sy + 20);

      // --- Per-node vitals mini-card ---
      // Match this node to the broadcast vitals by MAC address
      const vitals = nodeVitals.find(v => v.mac === node.id || v.mac === node.mac);
      if (isOnline && vitals) {
        const hr = vitals.heartRate || 0;
        const br = vitals.breathingRate || 0;
        const pc = vitals.personCount || 0;

        // Only show card if we have any vitals data
        if (hr > 0 || br > 0 || pc > 0) {
          const cardW = 78;
          const cardH = hr > 0 && br > 0 ? 42 : 30;
          const cardX = sx - cardW / 2;
          const cardY = sy + 26;

          // Card background
          ctx.fillStyle = 'rgba(12,14,22,0.85)';
          this._roundRect(ctx, cardX, cardY, cardW, cardH, 5);
          ctx.fill();
          ctx.strokeStyle = 'rgba(79,140,255,0.2)';
          ctx.lineWidth = 0.5;
          this._roundRect(ctx, cardX, cardY, cardW, cardH, 5);
          ctx.stroke();

          let lineY = cardY + 13;

          // Person count badge
          ctx.fillStyle = COLORS.personFill;
          ctx.font = 'bold 9px Inter, sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText(`${pc}p`, cardX + 5, lineY);

          // Heart rate
          if (hr > 0) {
            ctx.fillStyle = '#ff6b4f';
            ctx.font = '8px Inter, sans-serif';
            ctx.fillText('\u2764', cardX + 25, lineY);
            ctx.fillStyle = COLORS.white;
            ctx.font = 'bold 10px Inter, sans-serif';
            ctx.fillText(`${hr}`, cardX + 35, lineY);
          }

          // Breathing rate
          if (br > 0) {
            ctx.fillStyle = '#4f8cff';
            ctx.font = '8px Inter, sans-serif';
            ctx.fillText('\u2b24', cardX + 55, lineY);
            ctx.fillStyle = COLORS.white;
            ctx.font = 'bold 10px Inter, sans-serif';
            ctx.fillText(`${br}`, cardX + 63, lineY);
          }

          // Second line: motion state
          if (hr > 0 && br > 0) {
            lineY += 14;
            const motionColor = vitals.motionState === 'moving' ? '#f59e0b' :
                                vitals.motionState === 'stationary' ? '#34d399' : '#6b7280';
            ctx.fillStyle = motionColor;
            ctx.beginPath();
            ctx.arc(cardX + 8, lineY - 3, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = COLORS.textMuted;
            ctx.font = '8px Inter, sans-serif';
            ctx.fillText(vitals.motionState || 'unknown', cardX + 14, lineY);
          }
        }
      }
    }
  }

  /** Layer 7: Detected person dots with animated glow. */
  _drawPersons(ctx, room) {
    const personCount = this.state.vitals?.persons || 0;
    if (personCount === 0) return;

    const t = Date.now() * ANIM_SPEED;
    const positions = this._getPersonPositions(personCount);

    for (let p = 0; p < positions.length; p++) {
      const px = room.x + positions[p].x * room.w;
      const py = room.y + positions[p].y * room.h;

      // Pulsing glow
      const pulseSize = 25 + Math.sin(t * 2 + p * 1.5) * 5;
      const glow = ctx.createRadialGradient(px, py, 0, px, py, pulseSize);
      glow.addColorStop(0, 'rgba(255,107,79,0.30)');
      glow.addColorStop(0.5, 'rgba(255,107,79,0.10)');
      glow.addColorStop(1, 'rgba(255,107,79,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(px, py, pulseSize, 0, Math.PI * 2);
      ctx.fill();

      // Person dot
      ctx.fillStyle = COLORS.personFill;
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fill();

      // White inner dot
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fill();

      // Person label
      ctx.fillStyle = 'rgba(255,107,79,0.7)';
      ctx.font = '9px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`Person ${p + 1}`, px, py - 14);
    }
  }

  /** Layer 8: BLE beacon markers drawn near the bottom edge. */
  _drawBeacons(ctx, room, w, h) {
    const beacons = this.state.beacons || [];
    if (beacons.length === 0) return;

    const baseX = room.x + 10;
    const baseY = room.y + room.h + 20;

    beacons.forEach((b, i) => {
      const bx = baseX + i * 30;
      const by = baseY;
      const color = b.role === 'patient' ? COLORS.accent4
                  : b.role === 'staff'   ? COLORS.staff
                  : COLORS.textMuted;

      // Diamond shape
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(bx, by - 5);
      ctx.lineTo(bx + 5, by);
      ctx.lineTo(bx, by + 5);
      ctx.lineTo(bx - 5, by);
      ctx.closePath();
      ctx.fill();

      // Label
      ctx.fillStyle = 'rgba(107,114,128,0.6)';
      ctx.font = '8px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(b.name || b.mac?.slice(-5), bx, by + 14);
    });
  }

  /** Layer 9: Radar presence indicator (bottom-right corner of room). */
  _drawRadar(ctx, room) {
    const radar = this.state.radar;
    if (!radar || radar.state === 'none') return;

    const rx = room.x + room.w - 110;
    const ry = room.y + room.h - 32;

    // Background pill
    ctx.fillStyle = COLORS.radarFill;
    this._roundRect(ctx, rx, ry, 104, 26, 6);
    ctx.fill();

    // Radar icon (small concentric arcs)
    ctx.strokeStyle = COLORS.radarText;
    ctx.lineWidth = 1.5;
    const iconX = rx + 14;
    const iconY = ry + 13;
    for (let r = 4; r <= 8; r += 4) {
      ctx.beginPath();
      ctx.arc(iconX, iconY, r, -Math.PI * 0.4, Math.PI * 0.4);
      ctx.stroke();
    }

    // Text
    ctx.fillStyle = COLORS.radarText;
    ctx.font = 'bold 10px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(
      `${radar.state} ${radar.detectionDist || ''}cm`,
      rx + 24, ry + 17
    );
  }

  /** Layer 10: Mini vitals overlay in top-right of room. */
  _drawVitalsOverlay(ctx, w, h) {
    const v = this.state.vitals;
    if (!v || v.hr === '--') return;

    const ox = w - ROOM_PADDING - 140;
    const oy = ROOM_PADDING + 8;

    // Semi-transparent card background
    ctx.fillStyle = 'rgba(12,14,22,0.85)';
    this._roundRect(ctx, ox, oy, 132, 52, 8);
    ctx.fill();

    ctx.strokeStyle = 'rgba(30,33,48,0.6)';
    ctx.lineWidth = 1;
    this._roundRect(ctx, ox, oy, 132, 52, 8);
    ctx.stroke();

    // Heart rate
    ctx.fillStyle = '#ff6b4f';
    ctx.font = 'bold 10px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('HR', ox + 10, oy + 18);

    ctx.fillStyle = COLORS.white;
    ctx.font = 'bold 18px Inter, sans-serif';
    ctx.fillText(`${v.hr}`, ox + 30, oy + 20);

    ctx.fillStyle = COLORS.textMuted;
    ctx.font = '9px Inter, sans-serif';
    ctx.fillText('bpm', ox + 62, oy + 20);

    // Breathing rate
    ctx.fillStyle = '#4f8cff';
    ctx.font = 'bold 10px Inter, sans-serif';
    ctx.fillText('BR', ox + 10, oy + 42);

    ctx.fillStyle = COLORS.white;
    ctx.font = 'bold 18px Inter, sans-serif';
    ctx.fillText(`${v.br}`, ox + 30, oy + 44);

    ctx.fillStyle = COLORS.textMuted;
    ctx.font = '9px Inter, sans-serif';
    ctx.fillText('rpm', ox + 62, oy + 44);

    // Motion indicator dot
    const motionColors = {
      stationary: '#34d399',
      moving: '#f59e0b',
      both: '#8b5cf6',
      none: '#6b7280',
    };
    ctx.fillStyle = motionColors[v.motion] || motionColors.none;
    ctx.beginPath();
    ctx.arc(ox + 108, oy + 26, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = COLORS.textMuted;
    ctx.font = '8px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(v.motion || '', ox + 108, oy + 42);
  }

  /** Layer 11: Color legend at bottom-left. */
  _drawLegend(ctx, w, h) {
    const lx = LEGEND_X;
    const ly = h - LEGEND_Y_OFFSET - 60;

    // Background
    ctx.fillStyle = 'rgba(12,14,22,0.8)';
    this._roundRect(ctx, lx, ly, 120, 56, 6);
    ctx.fill();

    ctx.font = '8px Inter, sans-serif';
    ctx.textAlign = 'left';

    const items = [
      { color: COLORS.nodeFill,   label: 'Sensor Node' },
      { color: COLORS.personFill, label: 'Person Detected' },
      { color: COLORS.accent4,    label: 'Patient Beacon' },
      { color: COLORS.staff,      label: 'Staff Beacon' },
    ];

    items.forEach((item, i) => {
      const iy = ly + 10 + i * 12;
      ctx.fillStyle = item.color;
      ctx.beginPath();
      ctx.arc(lx + 10, iy, 3, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = COLORS.textMuted;
      ctx.fillText(item.label, lx + 20, iy + 3);
    });
  }

  /** Layer 12: Edit mode handles — dashed circles around nodes for dragging. */
  _drawEditHandles(ctx, room) {
    const nodes = this._getNodeScreenPositions(room);

    ctx.strokeStyle = 'rgba(245,158,11,0.5)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);

    for (const { node, sx, sy } of nodes) {
      ctx.beginPath();
      ctx.arc(sx, sy, NODE_DRAG_RADIUS, 0, Math.PI * 2);
      ctx.stroke();

      // "Drag" hint icon (arrows)
      ctx.fillStyle = 'rgba(245,158,11,0.6)';
      ctx.font = '8px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('drag', sx, sy + 38);
    }
    ctx.setLineDash([]);

    // "EDIT MODE" label
    ctx.fillStyle = 'rgba(245,158,11,0.7)';
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('EDIT MODE — Drag nodes to match room layout',
      (room.x + room.w / 2), room.y - 6);
  }

  // =========================================================================
  // Position Helpers
  // =========================================================================

  /**
   * Get screen positions for all online nodes.
   * Uses saved positions if available, otherwise auto-distributes along room edges.
   * @returns {Array<{node, sx, sy}>} Nodes with screen x,y coordinates.
   */
  _getNodeScreenPositions(room) {
    const nodes = (this.state.nodes || []).filter((n) => n.status === 'online');
    const result = [];

    // Generate auto-layout positions for nodes without saved positions
    const autoPositions = this._distributeOnEdges(nodes.length, room);

    nodes.forEach((node, i) => {
      const saved = this.nodePositions.get(node.id);
      let sx, sy;

      if (saved) {
        // Convert normalized (0-1) position to screen coordinates
        sx = room.x + saved.x * room.w;
        sy = room.y + saved.y * room.h;
      } else {
        // Auto-layout: distribute along room perimeter
        const auto = autoPositions[i];
        sx = auto ? auto[0] : room.x;
        sy = auto ? auto[1] : room.y;
      }

      result.push({ node, sx, sy });
    });

    return result;
  }

  /**
   * Get person positions from sensing data or generate smooth synthetic positions.
   * @param {number} personCount - Number of persons detected
   * @returns {Array<{x: number, y: number}>} Positions normalized 0-1.
   */
  _getPersonPositions(personCount) {
    // If the sensing data includes positions (e.g. from simulator), use them
    const sensed = this.state.sensing?.persons_positions
      || this.state.vitals?.persons_positions;

    if (sensed && sensed.length > 0) {
      return sensed;
    }

    // Fallback: generate smooth positions based on time
    const t = Date.now() / 1000;
    const positions = [];
    for (let p = 0; p < personCount; p++) {
      positions.push({
        x: 0.5 + Math.sin(t * 0.3 + p * 2.1) * 0.2,
        y: 0.5 + Math.cos(t * 0.25 + p * 1.7) * 0.2,
      });
    }
    return positions;
  }

  /**
   * Record the current person positions into the trail buffer.
   * Called once per render frame.
   */
  _recordTrailPoint() {
    const personCount = this.state.vitals?.persons || 0;
    if (personCount === 0) return;

    const positions = this._getPersonPositions(personCount);
    this.trails.push({
      persons: positions.map((p) => ({ x: p.x, y: p.y })),
      timestamp: Date.now(),
    });

    // Trim trail history
    const cutoff = Date.now() - TRAIL_FADE_MS;
    while (this.trails.length > 0 && this.trails[0].timestamp < cutoff) {
      this.trails.shift();
    }
    if (this.trails.length > MAX_TRAIL_LENGTH) {
      this.trails = this.trails.slice(-MAX_TRAIL_LENGTH);
    }
  }

  /**
   * Distribute N points evenly along the edges of the room.
   * Walks the perimeter clockwise (with bottom-right cutout) and places
   * nodes at equal intervals.
   * @returns {Array<[number, number]>} Screen coordinate pairs.
   */
  _distributeOnEdges(n, room) {
    if (n === 0) return [];
    const { x, y, w, h, cutoutX, cutoutY, cutoutW } = room;
    const mainBottomW = w - cutoutW;

    // Perimeter segments (clockwise from top-left):
    //  seg0: top wall (left → right)                length = w
    //  seg1: right wall (top → cutout top)          length = cutoutY - y
    //  seg2: cutout top edge (right → left)          length = cutoutW
    //  seg3: cutout left wall (top → bottom)         length = h - (cutoutY - y)
    //  seg4: bottom wall (right → left)              length = mainBottomW
    //  seg5: left wall (bottom → top)                length = h
    const segs = [
      { len: w,                     px: (t) => [x + t, y] },
      { len: cutoutY - y,           px: (t) => [x + w, y + t] },
      { len: cutoutW,               px: (t) => [x + w - t, cutoutY] },
      { len: y + h - cutoutY,       px: (t) => [cutoutX, cutoutY + t] },
      { len: mainBottomW,           px: (t) => [cutoutX - t, y + h] },
      { len: h,                     px: (t) => [x, y + h - t] },
    ];

    const perimeter = segs.reduce((s, seg) => s + seg.len, 0);
    const spacing = perimeter / n;
    const points = [];

    for (let i = 0; i < n; i++) {
      let d = (spacing * i + spacing * 0.25) % perimeter;
      for (const seg of segs) {
        if (d < seg.len) {
          points.push(seg.px(d));
          break;
        }
        d -= seg.len;
      }
    }
    return points;
  }

  // =========================================================================
  // Canvas Helpers
  // =========================================================================

  /**
   * Draw the room outline as a canvas path (no stroke/fill).
   * Shape: rectangle with bottom-right cutout for Inkomhal.
   * Reusable for clipping and boundary drawing.
   */
  _traceRoomPath(ctx, room) {
    const { x, y, w, h, cutoutX, cutoutY, cutoutW } = room;
    ctx.beginPath();
    ctx.moveTo(x, y);                                // Top-left
    ctx.lineTo(x + w, y);                            // Top-right
    ctx.lineTo(x + w, cutoutY);                      // Right wall down to cutout
    ctx.lineTo(cutoutX, cutoutY);                     // Step left (cutout top edge)
    ctx.lineTo(cutoutX, y + h);                       // Cutout left wall down
    ctx.lineTo(x, y + h);                            // Bottom wall (left portion)
    ctx.closePath();                                  // Left wall up to top-left
  }

  /**
   * Draw a rounded rectangle path.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @param {number} r - Corner radius
   */
  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // =========================================================================
  // Touch / Mouse Interaction (Node Dragging)
  // =========================================================================

  _setupInteraction() {
    // Unified pointer events for both touch and mouse
    this.canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this._onPointerUp(e));
  }

  _onPointerDown(e) {
    if (!this.editMode) return;

    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;

    const room = {
      x: ROOM_PADDING,
      y: ROOM_PADDING,
      w: this.canvas.width - ROOM_PADDING * 2,
      h: this.canvas.height - ROOM_PADDING * 2,
    };

    const nodes = this._getNodeScreenPositions(room);
    for (const { node, sx, sy } of nodes) {
      const dx = mx - sx;
      const dy = my - sy;
      if (Math.sqrt(dx * dx + dy * dy) < NODE_DRAG_RADIUS) {
        this._dragNodeId = node.id;
        e.preventDefault();
        return;
      }
    }
  }

  _onPointerMove(e) {
    if (!this._dragNodeId) return;

    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;

    const room = {
      x: ROOM_PADDING,
      y: ROOM_PADDING,
      w: this.canvas.width - ROOM_PADDING * 2,
      h: this.canvas.height - ROOM_PADDING * 2,
    };

    // Convert screen coordinates to normalized 0-1
    const nx = Math.max(0, Math.min(1, (mx - room.x) / room.w));
    const ny = Math.max(0, Math.min(1, (my - room.y) / room.h));

    this.nodePositions.set(this._dragNodeId, { x: nx, y: ny });
    e.preventDefault();
  }

  _onPointerUp(e) {
    if (!this._dragNodeId) return;

    const position = this.nodePositions.get(this._dragNodeId);
    if (position && this.onNodeMoved) {
      this.onNodeMoved(this._dragNodeId, position);
    }

    this._dragNodeId = null;
  }
}

// Export for use by app.js (loaded as a regular script, not a module)
window.RoomMap = RoomMap;
