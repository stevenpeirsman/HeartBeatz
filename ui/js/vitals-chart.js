// ==============================================================================
// Vitals Chart — Live Animated Vital Signs Dashboard
// ==============================================================================
// Renders real-time sparkline/area charts for heart rate, breathing rate,
// and other vital signs on the kiosk touchscreen. Designed for trade show
// demos where visual impact matters — smooth animations, glowing colors,
// and clear labeling that's readable from a few feet away.
//
// Architecture:
//   The main app.js pushes each new vitals reading into VitalsChart via
//   .pushReading(). The chart maintains a circular buffer (ring buffer)
//   of readings and redraws at ~20fps via .render(). Each metric gets its
//   own mini-chart canvas rendered inside the vitals grid.
//
// Usage (in app.js):
//   const vitalsChart = new VitalsChart({ maxPoints: 120 });
//   // On each new sensing frame:
//   vitalsChart.pushReading({ hr: 72, br: 16, motion: 'stationary', persons: 1, ... });
//   // In the render loop:
//   vitalsChart.render();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Maximum data points retained in the history buffer (~60s at 2Hz). */
const DEFAULT_MAX_POINTS = 120;

/** Chart padding inside each mini-chart canvas (px). */
const CHART_PADDING = { top: 40, right: 12, bottom: 24, left: 48 };

/** Smoothing factor for the interpolated line (0 = no smooth, 1 = max). */
const SMOOTH_FACTOR = 0.3;

/** Colors that match the HeartBeatz dark theme. */
const CHART_COLORS = {
  bg:          '#0c0e16',
  cardBg:      '#10121c',
  cardBorder:  '#1e2130',
  gridLine:    'rgba(30,33,48,0.5)',
  gridLabel:   '#4b5563',

  // Heart Rate: warm red/orange
  hrLine:      '#ff6b4f',
  hrFill:      'rgba(255,107,79,0.08)',
  hrGlow:      'rgba(255,107,79,0.25)',
  hrText:      '#ff6b4f',

  // Breathing Rate: cool blue
  brLine:      '#4f8cff',
  brFill:      'rgba(79,140,255,0.08)',
  brGlow:      'rgba(79,140,255,0.20)',
  brText:      '#4f8cff',

  // Motion: green
  motionActive: '#34d399',
  motionIdle:   '#374151',
  motionText:   '#34d399',

  // Confidence / Quality
  qualityHigh:  '#34d399',
  qualityMed:   '#f59e0b',
  qualityLow:   '#ef4444',
  qualityBg:    'rgba(30,33,48,0.6)',

  // Generic text
  white:        '#e2e8f0',
  muted:        '#6b7280',
  label:        '#9ca3af',
};


// ===========================================================================
// VitalsChart Class
// ===========================================================================

class VitalsChart {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.maxPoints=120] - Max readings in the ring buffer
   */
  constructor(opts = {}) {
    this.maxPoints = opts.maxPoints || DEFAULT_MAX_POINTS;

    // --- Ring buffer of vitals readings ---
    // Each entry: { hr, br, motion, persons, confidence, csiQuality, timestamp }
    this._buffer = [];

    // --- Canvas references (set by app.js after DOM ready) ---
    this._hrCanvas = null;
    this._brCanvas = null;
    this._motionCanvas = null;
    this._qualityCanvas = null;

    // --- Stats (computed on each push for the summary cards) ---
    this.stats = {
      hr:  { current: 0, min: 0, max: 0, avg: 0 },
      br:  { current: 0, min: 0, max: 0, avg: 0 },
      motion: 'none',
      persons: 0,
      confidence: 0,
      csiQuality: 0,
    };
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Attach canvas elements for each chart. Call once after DOM ready.
   * @param {Object} canvases - Map of chart name → HTMLCanvasElement
   */
  setCanvases(canvases) {
    this._hrCanvas = canvases.hr || null;
    this._brCanvas = canvases.br || null;
    this._motionCanvas = canvases.motion || null;
    this._qualityCanvas = canvases.quality || null;
  }

  /**
   * Push a new vital signs reading into the buffer.
   * Called by app.js on each sensing frame (~2-10Hz).
   * @param {Object} reading - Vitals data from the sensing server or simulator
   */
  pushReading(reading) {
    if (!reading) return;

    const entry = {
      hr:          reading.hr ?? reading.heart_rate ?? 0,
      br:          reading.br ?? reading.breathing_rate ?? 0,
      motion:      reading.motion ?? reading.motion_state ?? 'none',
      persons:     reading.persons ?? reading.person_count ?? 0,
      confidence:  reading.confidence ?? 0,
      csiQuality:  reading.csi_quality ?? reading.csiQuality ?? 0,
      timestamp:   reading.timestamp ?? Date.now(),
    };

    this._buffer.push(entry);

    // Trim to max size (ring buffer behavior)
    if (this._buffer.length > this.maxPoints) {
      this._buffer.shift();
    }

    // Recompute stats
    this._computeStats();
  }

  /**
   * Main render call — draw all chart canvases.
   * Called from the UI render loop (~20fps).
   */
  render() {
    if (this._hrCanvas)      this._drawLineChart(this._hrCanvas, 'hr');
    if (this._brCanvas)      this._drawLineChart(this._brCanvas, 'br');
    if (this._motionCanvas)  this._drawMotionTimeline(this._motionCanvas);
    if (this._qualityCanvas) this._drawQualityGauge(this._qualityCanvas);
  }

  /** Get the number of readings currently buffered. */
  get length() {
    return this._buffer.length;
  }

  // =========================================================================
  // Statistics
  // =========================================================================

  /** Recompute summary statistics from the buffer. */
  _computeStats() {
    const buf = this._buffer;
    if (buf.length === 0) return;

    const last = buf[buf.length - 1];

    // Heart Rate stats (exclude zeros — no person detected)
    const hrValues = buf.map(r => r.hr).filter(v => v > 0);
    const brValues = buf.map(r => r.br).filter(v => v > 0);

    this.stats.hr = {
      current: last.hr,
      min:     hrValues.length > 0 ? Math.min(...hrValues) : 0,
      max:     hrValues.length > 0 ? Math.max(...hrValues) : 0,
      avg:     hrValues.length > 0 ? Math.round(hrValues.reduce((a, b) => a + b, 0) / hrValues.length) : 0,
    };

    this.stats.br = {
      current: last.br,
      min:     brValues.length > 0 ? Math.min(...brValues) : 0,
      max:     brValues.length > 0 ? Math.max(...brValues) : 0,
      avg:     brValues.length > 0 ? Math.round(brValues.reduce((a, b) => a + b, 0) / brValues.length) : 0,
    };

    this.stats.motion     = last.motion;
    this.stats.persons    = last.persons;
    this.stats.confidence = last.confidence;
    this.stats.csiQuality = last.csiQuality;
  }

  // =========================================================================
  // Chart Renderers
  // =========================================================================

  /**
   * Draw a line/area chart for either HR or BR.
   * Shows: filled area, smooth line, current value callout, grid, min/max/avg.
   *
   * @param {HTMLCanvasElement} canvas - Target canvas
   * @param {'hr'|'br'} metric - Which vital sign to chart
   */
  _drawLineChart(canvas, metric) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const buf = this._buffer;

    // Extract relevant values
    const values = buf.map(r => r[metric]);
    const nonZero = values.filter(v => v > 0);

    // Color scheme based on metric
    const colors = metric === 'hr'
      ? { line: CHART_COLORS.hrLine, fill: CHART_COLORS.hrFill, glow: CHART_COLORS.hrGlow, text: CHART_COLORS.hrText }
      : { line: CHART_COLORS.brLine, fill: CHART_COLORS.brFill, glow: CHART_COLORS.brGlow, text: CHART_COLORS.brText };

    // Labels
    const label = metric === 'hr' ? 'Heart Rate' : 'Breathing Rate';
    const unit  = metric === 'hr' ? 'bpm' : 'rpm';
    const stats = this.stats[metric];

    // Y-axis range (auto-scale with padding)
    const yMin = nonZero.length > 0 ? Math.max(0, Math.min(...nonZero) - 5) : 0;
    const yMax = nonZero.length > 0 ? Math.max(...nonZero) + 5 : (metric === 'hr' ? 100 : 25);
    const yRange = Math.max(yMax - yMin, 1);

    // Chart area
    const pad = CHART_PADDING;
    const cx = pad.left;
    const cy = pad.top;
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    // ── Background ──
    ctx.fillStyle = CHART_COLORS.bg;
    ctx.fillRect(0, 0, w, h);

    // ── Card background ──
    ctx.fillStyle = CHART_COLORS.cardBg;
    this._roundRect(ctx, 4, 4, w - 8, h - 8, 8);
    ctx.fill();
    ctx.strokeStyle = CHART_COLORS.cardBorder;
    ctx.lineWidth = 1;
    this._roundRect(ctx, 4, 4, w - 8, h - 8, 8);
    ctx.stroke();

    // ── Title + Current Value ──
    ctx.fillStyle = CHART_COLORS.label;
    ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label.toUpperCase(), cx, 20);

    ctx.fillStyle = colors.text;
    ctx.font = 'bold 22px Inter, system-ui, sans-serif';
    ctx.fillText(`${stats.current || '--'}`, cx + (metric === 'hr' ? 90 : 130), 22);

    ctx.fillStyle = CHART_COLORS.muted;
    ctx.font = '11px Inter, system-ui, sans-serif';
    const valueWidth = ctx.measureText(`${stats.current || '--'}`).width;
    ctx.fillText(unit, cx + (metric === 'hr' ? 90 : 130) + valueWidth + 4, 22);

    // ── Min / Avg / Max badges (top-right) ──
    if (nonZero.length > 2) {
      const badges = [
        { label: 'min', value: stats.min, x: w - 160 },
        { label: 'avg', value: stats.avg, x: w - 105 },
        { label: 'max', value: stats.max, x: w - 50 },
      ];
      for (const b of badges) {
        ctx.fillStyle = 'rgba(30,33,48,0.6)';
        this._roundRect(ctx, b.x, 8, 44, 20, 4);
        ctx.fill();

        ctx.fillStyle = CHART_COLORS.muted;
        ctx.font = '8px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(b.label, b.x + 22, 18);

        ctx.fillStyle = CHART_COLORS.label;
        ctx.font = 'bold 9px Inter, system-ui, sans-serif';
        ctx.fillText(b.value, b.x + 22, 26);
      }
    }

    // ── Horizontal grid lines ──
    const gridLines = 4;
    ctx.textAlign = 'right';
    ctx.font = '9px Inter, system-ui, sans-serif';
    for (let i = 0; i <= gridLines; i++) {
      const y = cy + (ch * i) / gridLines;
      const val = Math.round(yMax - (yRange * i) / gridLines);

      ctx.strokeStyle = CHART_COLORS.gridLine;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(cx, y);
      ctx.lineTo(cx + cw, y);
      ctx.stroke();

      ctx.fillStyle = CHART_COLORS.gridLabel;
      ctx.fillText(val, cx - 6, y + 3);
    }

    // ── No data placeholder ──
    if (values.length < 2) {
      ctx.fillStyle = CHART_COLORS.muted;
      ctx.font = '12px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for data...', cx + cw / 2, cy + ch / 2);
      return;
    }

    // ── Area fill ──
    ctx.beginPath();
    for (let i = 0; i < values.length; i++) {
      const x = cx + (i / (this.maxPoints - 1)) * cw;
      const y = cy + ch - ((values[i] - yMin) / yRange) * ch;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    // Close path down to baseline
    ctx.lineTo(cx + ((values.length - 1) / (this.maxPoints - 1)) * cw, cy + ch);
    ctx.lineTo(cx, cy + ch);
    ctx.closePath();
    ctx.fillStyle = colors.fill;
    ctx.fill();

    // ── Glow line (thicker, blurred) ──
    ctx.save();
    ctx.shadowColor = colors.glow;
    ctx.shadowBlur = 8;
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < values.length; i++) {
      const x = cx + (i / (this.maxPoints - 1)) * cw;
      const y = cy + ch - ((values[i] - yMin) / yRange) * ch;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();

    // ── Sharp line on top ──
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < values.length; i++) {
      const x = cx + (i / (this.maxPoints - 1)) * cw;
      const y = cy + ch - ((values[i] - yMin) / yRange) * ch;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // ── Current value dot (pulsing) ──
    if (values.length > 0) {
      const lastVal = values[values.length - 1];
      const lx = cx + ((values.length - 1) / (this.maxPoints - 1)) * cw;
      const ly = cy + ch - ((lastVal - yMin) / yRange) * ch;

      // Pulse animation
      const pulse = 4 + Math.sin(Date.now() * 0.005) * 2;

      // Outer glow
      const glow = ctx.createRadialGradient(lx, ly, 0, lx, ly, pulse + 6);
      glow.addColorStop(0, colors.glow);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(lx, ly, pulse + 6, 0, Math.PI * 2);
      ctx.fill();

      // Dot
      ctx.fillStyle = colors.line;
      ctx.beginPath();
      ctx.arc(lx, ly, 4, 0, Math.PI * 2);
      ctx.fill();

      // White inner
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(lx, ly, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // ── Time axis label ──
    ctx.fillStyle = CHART_COLORS.gridLabel;
    ctx.font = '8px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('now', cx + cw - 10, cy + ch + 14);
    ctx.textAlign = 'right';
    const secondsBack = Math.round((this.maxPoints * 0.5));  // Approximate seconds
    ctx.fillText(`-${secondsBack}s`, cx + 10, cy + ch + 14);
  }

  /**
   * Draw a horizontal timeline showing motion states over time.
   * Each time slot is a colored bar: green=stationary, amber=moving, purple=both.
   *
   * @param {HTMLCanvasElement} canvas - Target canvas
   */
  _drawMotionTimeline(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const buf = this._buffer;

    // ── Background ──
    ctx.fillStyle = CHART_COLORS.bg;
    ctx.fillRect(0, 0, w, h);

    // ── Card ──
    ctx.fillStyle = CHART_COLORS.cardBg;
    this._roundRect(ctx, 4, 4, w - 8, h - 8, 8);
    ctx.fill();
    ctx.strokeStyle = CHART_COLORS.cardBorder;
    ctx.lineWidth = 1;
    this._roundRect(ctx, 4, 4, w - 8, h - 8, 8);
    ctx.stroke();

    // ── Title ──
    ctx.fillStyle = CHART_COLORS.label;
    ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('MOTION STATE', 16, 20);

    // ── Current state badge ──
    const motionColors = {
      stationary: CHART_COLORS.motionActive,
      moving:     '#f59e0b',
      both:       '#8b5cf6',
      none:       CHART_COLORS.muted,
    };
    const current = this.stats.motion || 'none';
    const badgeColor = motionColors[current] || CHART_COLORS.muted;

    ctx.fillStyle = badgeColor;
    ctx.font = 'bold 14px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(current.charAt(0).toUpperCase() + current.slice(1), 120, 22);

    // ── Person count ──
    ctx.fillStyle = CHART_COLORS.label;
    ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${this.stats.persons} person${this.stats.persons !== 1 ? 's' : ''}`, w - 16, 20);

    // ── Timeline bars ──
    const barY = 34;
    const barH = h - barY - 20;
    const barLeft = 16;
    const barRight = w - 16;
    const barW = barRight - barLeft;

    // Background track
    ctx.fillStyle = 'rgba(30,33,48,0.4)';
    this._roundRect(ctx, barLeft, barY, barW, barH, 4);
    ctx.fill();

    if (buf.length < 2) {
      ctx.fillStyle = CHART_COLORS.muted;
      ctx.font = '10px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Collecting data...', barLeft + barW / 2, barY + barH / 2 + 4);
      return;
    }

    // Draw each reading as a tiny colored segment
    const segW = barW / this.maxPoints;
    for (let i = 0; i < buf.length; i++) {
      const x = barLeft + (i / this.maxPoints) * barW;
      const motion = buf[i].motion;
      ctx.fillStyle = motionColors[motion] || CHART_COLORS.motionIdle;
      // Slight alpha based on age for fade effect
      ctx.globalAlpha = 0.4 + 0.6 * (i / buf.length);
      this._roundRect(ctx, x, barY + 2, Math.max(segW, 2), barH - 4, 1);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // ── Legend ──
    const legendItems = [
      { color: CHART_COLORS.motionActive, label: 'Still' },
      { color: '#f59e0b', label: 'Moving' },
      { color: '#8b5cf6', label: 'Both' },
    ];
    let lx = barLeft;
    ctx.font = '8px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    for (const item of legendItems) {
      ctx.fillStyle = item.color;
      ctx.fillRect(lx, barY + barH + 6, 8, 8);
      ctx.fillStyle = CHART_COLORS.muted;
      ctx.fillText(item.label, lx + 11, barY + barH + 13);
      lx += 50;
    }
  }

  /**
   * Draw a quality/confidence gauge — two arc gauges showing how reliable
   * the current sensing data is. Helps demo operators know if the setup
   * is working well.
   *
   * @param {HTMLCanvasElement} canvas - Target canvas
   */
  _drawQualityGauge(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    // ── Background ──
    ctx.fillStyle = CHART_COLORS.bg;
    ctx.fillRect(0, 0, w, h);

    // ── Card ──
    ctx.fillStyle = CHART_COLORS.cardBg;
    this._roundRect(ctx, 4, 4, w - 8, h - 8, 8);
    ctx.fill();
    ctx.strokeStyle = CHART_COLORS.cardBorder;
    ctx.lineWidth = 1;
    this._roundRect(ctx, 4, 4, w - 8, h - 8, 8);
    ctx.stroke();

    // ── Title ──
    ctx.fillStyle = CHART_COLORS.label;
    ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('SIGNAL QUALITY', 16, 20);

    // Draw two semi-circle gauges side by side
    const conf = this.stats.confidence;
    const qual = this.stats.csiQuality;

    const gauges = [
      { label: 'Confidence', value: conf, cx: w * 0.28 },
      { label: 'CSI Quality', value: qual, cx: w * 0.72 },
    ];

    const gaugeRadius = Math.min(w * 0.18, h * 0.30);
    const gaugeY = h * 0.58;

    for (const g of gauges) {
      // Color based on value
      let color;
      if (g.value >= 0.8)      color = CHART_COLORS.qualityHigh;
      else if (g.value >= 0.5) color = CHART_COLORS.qualityMed;
      else                     color = CHART_COLORS.qualityLow;

      // Background arc (track)
      ctx.strokeStyle = CHART_COLORS.qualityBg;
      ctx.lineWidth = 8;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(g.cx, gaugeY, gaugeRadius, Math.PI, 2 * Math.PI);
      ctx.stroke();

      // Value arc
      const angle = Math.PI + Math.PI * Math.max(0, Math.min(1, g.value));
      ctx.strokeStyle = color;
      ctx.lineWidth = 8;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(g.cx, gaugeY, gaugeRadius, Math.PI, angle);
      ctx.stroke();

      // Percentage text
      ctx.fillStyle = CHART_COLORS.white;
      ctx.font = 'bold 16px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${Math.round(g.value * 100)}%`, g.cx, gaugeY - 4);

      // Label
      ctx.fillStyle = CHART_COLORS.muted;
      ctx.font = '9px Inter, system-ui, sans-serif';
      ctx.fillText(g.label, g.cx, gaugeY + 16);
    }
  }

  // =========================================================================
  // Canvas Helpers
  // =========================================================================

  /**
   * Draw a rounded rectangle path.
   * @param {CanvasRenderingContext2D} ctx
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
}

// Export for use by app.js (loaded as a regular script, not a module)
window.VitalsChart = VitalsChart;
