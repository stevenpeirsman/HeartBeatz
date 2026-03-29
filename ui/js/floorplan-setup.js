/**
 * FloorplanSetup - Full-screen floor plan wizard for HeartBeatz room visualization
 *
 * Implements a three-step wizard:
 * 1. Upload or skip floor plan image
 * 2. Draw room outline (polygon) on canvas
 * 3. Place nodes on the floor plan
 *
 * Emits 'floorplan-updated' event when complete
 */

class FloorplanSetup {
  constructor(container = document.body) {
    this.container = container;
    this.isOpen = false;
    this.currentStep = 1;

    // Data state
    this.floorplanImage = null;
    this.floorplanImageElement = null;
    this.roomOutline = [];
    this.nodePositions = {};
    this.nodes = [];
    this.roomConfig = null;

    // Canvas and rendering
    this.canvas = null;
    this.ctx = null;
    this.overlay = null;

    // Drawing state
    this.isDrawingPolygon = false;
    this.draggedVertexIndex = null;
    this.draggedNodeId = null;
    this.imageBounds = null; // { x, y, width, height }
    this.imageScale = 1;
    this.imageOffset = { x: 0, y: 0 };

    // Input state
    this.fileInput = null;
    this.uploadedFileName = null;

    this._ensureStylesInjected();
    this._bindMethods();
  }

  /**
   * Inject CSS styles into the document (only once)
   */
  _ensureStylesInjected() {
    if (document.getElementById('floorplan-setup-styles')) {
      return;
    }

    const style = document.createElement('style');
    style.id = 'floorplan-setup-styles';
    style.textContent = `
      .floorplan-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: #08090d;
        z-index: 10000;
        display: flex;
        flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #e2e8f0;
      }

      .floorplan-header {
        padding: 16px 20px;
        border-bottom: 1px solid #1e2130;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }

      .floorplan-title {
        font-size: 18px;
        font-weight: 600;
      }

      .floorplan-step-indicator {
        font-size: 14px;
        color: #9ca3af;
      }

      .floorplan-content {
        flex: 1;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }

      .floorplan-canvas-container {
        flex: 1;
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
      }

      #floorplan-canvas {
        max-width: 100%;
        max-height: 100%;
        display: block;
        cursor: crosshair;
        background: #0f1119;
      }

      .floorplan-step-content {
        flex: 1;
        padding: 20px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
      }

      .floorplan-upload-zone {
        flex: 1;
        border: 2px dashed #4f8cff;
        border-radius: 8px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 16px;
        padding: 20px;
        text-align: center;
        cursor: pointer;
        transition: background-color 0.2s, border-color 0.2s;
      }

      .floorplan-upload-zone.dragover {
        background-color: rgba(79, 140, 255, 0.1);
        border-color: #4f8cff;
      }

      .floorplan-upload-zone-icon {
        font-size: 48px;
        opacity: 0.6;
      }

      .floorplan-upload-zone-text {
        font-size: 16px;
        color: #e2e8f0;
      }

      .floorplan-upload-zone-hint {
        font-size: 13px;
        color: #9ca3af;
      }

      .floorplan-preview-container {
        max-width: 100%;
        max-height: 300px;
        margin: 16px 0;
        border-radius: 6px;
        overflow: hidden;
        background: #0f1119;
      }

      .floorplan-preview-container img {
        width: 100%;
        height: auto;
        display: block;
      }

      .floorplan-nodes-list {
        margin-top: 16px;
        max-height: 200px;
        overflow-y: auto;
      }

      .floorplan-node-item {
        padding: 10px 12px;
        background: #0f1119;
        border: 1px solid #1e2130;
        border-radius: 4px;
        margin-bottom: 8px;
        font-size: 13px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }

      .floorplan-node-item.placed {
        opacity: 0.6;
      }

      .floorplan-node-name {
        font-weight: 500;
        color: #e2e8f0;
      }

      .floorplan-node-status {
        font-size: 11px;
        color: #6b7280;
        margin-top: 2px;
      }

      .floorplan-node-badge {
        background: #4f8cff;
        color: #08090d;
        padding: 2px 8px;
        border-radius: 3px;
        font-size: 11px;
        font-weight: 600;
      }

      .floorplan-footer {
        padding: 16px 20px;
        border-top: 1px solid #1e2130;
        display: flex;
        gap: 12px;
        justify-content: flex-end;
      }

      .floorplan-button {
        padding: 10px 20px;
        min-height: 44px;
        min-width: 44px;
        border: none;
        border-radius: 6px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: background-color 0.2s, opacity 0.2s;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .floorplan-button-primary {
        background: #4f8cff;
        color: #08090d;
      }

      .floorplan-button-primary:hover {
        background: #3a6fdb;
      }

      .floorplan-button-primary:active {
        background: #2e59b5;
      }

      .floorplan-button-secondary {
        background: #1e2130;
        color: #e2e8f0;
      }

      .floorplan-button-secondary:hover {
        background: #2a3142;
      }

      .floorplan-button-secondary:active {
        background: #3a3d52;
      }

      .floorplan-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .floorplan-button-small {
        padding: 8px 16px;
        font-size: 13px;
      }

      .floorplan-hidden {
        display: none !important;
      }

      .floorplan-instructions {
        background: #0f1119;
        border-left: 3px solid #4f8cff;
        padding: 12px 16px;
        border-radius: 4px;
        font-size: 13px;
        color: #d1d5db;
        margin-bottom: 16px;
        line-height: 1.5;
      }

      .floorplan-help-text {
        font-size: 12px;
        color: #9ca3af;
        margin-top: 8px;
        line-height: 1.4;
      }

      input[type="file"]#floorplan-file-input {
        display: none;
      }

      .floorplan-info-row {
        display: flex;
        gap: 20px;
        margin-bottom: 16px;
        flex-wrap: wrap;
      }

      .floorplan-info-item {
        flex: 0 0 auto;
      }

      .floorplan-info-label {
        font-size: 12px;
        color: #9ca3af;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .floorplan-info-value {
        font-size: 14px;
        font-weight: 600;
        color: #e2e8f0;
        margin-top: 4px;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Bind methods to preserve 'this' context
   */
  _bindMethods() {
    this.open = this.open.bind(this);
    this.close = this.close.bind(this);
    this._handleCanvasClick = this._handleCanvasClick.bind(this);
    this._handleCanvasMouseMove = this._handleCanvasMouseMove.bind(this);
    this._handleCanvasMouseUp = this._handleCanvasMouseUp.bind(this);
    this._handleCanvasMouseDown = this._handleCanvasMouseDown.bind(this);
    this._handleFileInputChange = this._handleFileInputChange.bind(this);
    this._handleDragOver = this._handleDragOver.bind(this);
    this._handleDragLeave = this._handleDragLeave.bind(this);
    this._handleDrop = this._handleDrop.bind(this);
    this._handleUploadZoneClick = this._handleUploadZoneClick.bind(this);
  }

  /**
   * Open the wizard overlay
   */
  async open() {
    if (this.isOpen) return;

    this.isOpen = true;
    this.currentStep = 1;
    this.roomOutline = [];
    this.nodePositions = {};
    this.floorplanImage = null;
    this.floorplanImageElement = null;
    this.uploadedFileName = null;

    // Load current room config
    await this._loadRoomConfig();

    // Load nodes
    await this._loadNodes();

    // Create overlay
    this._createOverlay();

    // Render step 1
    this._renderStep();
  }

  /**
   * Close the wizard overlay
   */
  close() {
    if (!this.isOpen) return;

    this.isOpen = false;

    // Remove overlay
    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }

    // Unbind canvas listeners
    if (this.canvas) {
      this.canvas.removeEventListener('click', this._handleCanvasClick);
      this.canvas.removeEventListener('mousemove', this._handleCanvasMouseMove);
      this.canvas.removeEventListener('mousedown', this._handleCanvasMouseDown);
      this.canvas.removeEventListener('mouseup', this._handleCanvasMouseUp);
      this.canvas.removeEventListener('dblclick', this._handleCanvasClick);
      this.canvas.removeEventListener('touchstart', this._handleCanvasMouseDown);
      this.canvas.removeEventListener('touchmove', this._handleCanvasMouseMove);
      this.canvas.removeEventListener('touchend', this._handleCanvasMouseUp);
    }
  }

  /**
   * Load current room configuration from API
   */
  async _loadRoomConfig() {
    try {
      const response = await fetch('/api/room-config');
      if (response.ok) {
        this.roomConfig = await response.json();
        if (this.roomConfig.outline) {
          this.roomOutline = this.roomConfig.outline;
        }
      }
    } catch (error) {
      console.warn('Failed to load room config:', error);
    }
  }

  /**
   * Load nodes from API
   */
  async _loadNodes() {
    try {
      const response = await fetch('/api/room-layout');
      if (response.ok) {
        const data = await response.json();
        this.nodes = data.nodes || [];

        // Load existing positions
        this.nodes.forEach(node => {
          if (node.position) {
            this.nodePositions[node.id] = { x: node.position.x, y: node.position.y };
          }
        });
      }
    } catch (error) {
      console.warn('Failed to load nodes:', error);
    }
  }

  /**
   * Create the overlay DOM structure
   */
  _createOverlay() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'floorplan-overlay';

    this.overlay.innerHTML = `
      <div class="floorplan-header">
        <div class="floorplan-title">Floor Plan Setup</div>
        <div class="floorplan-step-indicator">Step <span id="floorplan-step-num">1</span> of 3</div>
      </div>

      <div class="floorplan-content">
        <div id="floorplan-step-1" class="floorplan-step-content">
          <div class="floorplan-instructions">
            📸 Upload a floor plan image, or skip to draw manually
          </div>
          <div class="floorplan-upload-zone" id="floorplan-upload-zone">
            <div class="floorplan-upload-zone-icon">📷</div>
            <div class="floorplan-upload-zone-text">Drop image here or click to select</div>
            <div class="floorplan-upload-zone-hint">PNG or JPG, up to 10 MB</div>
          </div>
          <div id="floorplan-preview" class="floorplan-hidden">
            <div style="font-weight: 600; margin-top: 16px; margin-bottom: 8px;">Preview:</div>
            <div class="floorplan-preview-container">
              <img id="floorplan-preview-img" alt="Floor plan preview">
            </div>
          </div>
        </div>

        <div id="floorplan-step-2" class="floorplan-step-content floorplan-hidden">
          <div class="floorplan-instructions">
            🎨 Tap to place corners around the room boundary. Double-tap or press "Close Polygon" when done.
          </div>
          <div class="floorplan-canvas-container">
            <canvas id="floorplan-canvas"></canvas>
          </div>
          <div class="floorplan-help-text">
            Points: <span id="floorplan-point-count">0</span> |
            <button id="floorplan-undo-btn" class="floorplan-button floorplan-button-secondary floorplan-button-small">Undo Last Point</button>
          </div>
        </div>

        <div id="floorplan-step-3" class="floorplan-step-content floorplan-hidden">
          <div class="floorplan-instructions">
            📍 Tap on the floor plan to place each node. You can drag them to adjust position.
          </div>
          <div class="floorplan-canvas-container">
            <canvas id="floorplan-canvas"></canvas>
          </div>
          <div style="margin-top: 12px; max-height: 150px; overflow-y: auto;">
            <div id="floorplan-nodes-list" class="floorplan-nodes-list"></div>
          </div>
        </div>
      </div>

      <div class="floorplan-footer">
        <button id="floorplan-btn-close" class="floorplan-button floorplan-button-secondary">Close</button>
        <button id="floorplan-btn-skip" class="floorplan-button floorplan-button-secondary floorplan-hidden">Skip Plan Upload</button>
        <button id="floorplan-btn-back" class="floorplan-button floorplan-button-secondary floorplan-hidden">Back</button>
        <button id="floorplan-btn-next" class="floorplan-button floorplan-button-primary floorplan-hidden">Next</button>
        <button id="floorplan-btn-close-polygon" class="floorplan-button floorplan-button-secondary floorplan-hidden">Close Polygon</button>
        <button id="floorplan-btn-done" class="floorplan-button floorplan-button-primary floorplan-hidden">Save & Done</button>
      </div>
    `;

    this.container.appendChild(this.overlay);

    // Setup file input
    this.fileInput = document.createElement('input');
    this.fileInput.id = 'floorplan-file-input';
    this.fileInput.type = 'file';
    this.fileInput.accept = 'image/png,image/jpeg';
    this.fileInput.addEventListener('change', this._handleFileInputChange);
    this.overlay.appendChild(this.fileInput);

    // Bind events
    this._bindOverlayEvents();

    // Get canvas reference for later use
    this.canvas = this.overlay.querySelector('#floorplan-canvas');
    if (this.canvas) {
      this.ctx = this.canvas.getContext('2d');
    }
  }

  /**
   * Bind overlay event listeners
   */
  _bindOverlayEvents() {
    // Buttons
    this.overlay.querySelector('#floorplan-btn-close').addEventListener('click', () => this.close());
    this.overlay.querySelector('#floorplan-btn-skip').addEventListener('click', () => this._nextStep());
    this.overlay.querySelector('#floorplan-btn-back').addEventListener('click', () => this._prevStep());
    this.overlay.querySelector('#floorplan-btn-next').addEventListener('click', () => this._nextStep());
    this.overlay.querySelector('#floorplan-btn-close-polygon').addEventListener('click', () => this._closePolygon());
    this.overlay.querySelector('#floorplan-btn-done').addEventListener('click', () => this._saveMeAndDone());

    // Upload zone
    const uploadZone = this.overlay.querySelector('#floorplan-upload-zone');
    uploadZone.addEventListener('click', this._handleUploadZoneClick);
    uploadZone.addEventListener('dragover', this._handleDragOver);
    uploadZone.addEventListener('dragleave', this._handleDragLeave);
    uploadZone.addEventListener('drop', this._handleDrop);

    // Undo button
    const undoBtn = this.overlay.querySelector('#floorplan-undo-btn');
    if (undoBtn) {
      undoBtn.addEventListener('click', () => {
        if (this.roomOutline.length > 0) {
          this.roomOutline.pop();
          this._redrawCanvas();
          this._updatePointCount();
        }
      });
    }

    // Canvas events
    if (this.canvas) {
      this.canvas.addEventListener('click', this._handleCanvasClick);
      this.canvas.addEventListener('dblclick', this._handleCanvasClick);
      this.canvas.addEventListener('mousemove', this._handleCanvasMouseMove);
      this.canvas.addEventListener('mousedown', this._handleCanvasMouseDown);
      this.canvas.addEventListener('mouseup', this._handleCanvasMouseUp);
      this.canvas.addEventListener('touchstart', this._handleCanvasMouseDown, { passive: false });
      this.canvas.addEventListener('touchmove', this._handleCanvasMouseMove, { passive: false });
      this.canvas.addEventListener('touchend', this._handleCanvasMouseUp, { passive: false });
    }
  }

  /**
   * Upload zone click handler
   */
  _handleUploadZoneClick(e) {
    e.preventDefault();
    this.fileInput.click();
  }

  /**
   * Drag over handler
   */
  _handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    const zone = this.overlay.querySelector('#floorplan-upload-zone');
    zone?.classList.add('dragover');
  }

  /**
   * Drag leave handler
   */
  _handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    const zone = this.overlay.querySelector('#floorplan-upload-zone');
    zone?.classList.remove('dragover');
  }

  /**
   * Drop handler
   */
  _handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    const zone = this.overlay.querySelector('#floorplan-upload-zone');
    zone?.classList.remove('dragover');

    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      this._processFile(files[0]);
    }
  }

  /**
   * File input change handler
   */
  _handleFileInputChange(e) {
    const files = e.target.files;
    if (files && files.length > 0) {
      this._processFile(files[0]);
    }
  }

  /**
   * Process selected file
   */
  _processFile(file) {
    if (!file.type.startsWith('image/')) {
      alert('Please select an image file (PNG or JPG)');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      alert('File is too large. Maximum 10 MB.');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        this.floorplanImageElement = img;
        this.uploadedFileName = file.name;
        this._showPreview(img);
      };
      img.onerror = () => {
        alert('Failed to load image. Please try another file.');
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  /**
   * Show preview of uploaded image
   */
  _showPreview(img) {
    const preview = this.overlay.querySelector('#floorplan-preview');
    const previewImg = this.overlay.querySelector('#floorplan-preview-img');
    previewImg.src = img.src;
    preview.classList.remove('floorplan-hidden');
  }

  /**
   * Move to next step
   */
  _nextStep() {
    if (this.currentStep < 3) {
      this.currentStep++;
      this._renderStep();
    }
  }

  /**
   * Move to previous step
   */
  _prevStep() {
    if (this.currentStep > 1) {
      this.currentStep--;
      this._renderStep();
    }
  }

  /**
   * Close the polygon (step 2)
   */
  _closePolygon() {
    if (this.roomOutline.length < 3) {
      alert('You need at least 3 points to create a polygon');
      return;
    }
    this._nextStep();
  }

  /**
   * Render the current step
   */
  _renderStep() {
    // Hide all steps
    const steps = this.overlay.querySelectorAll('[id^="floorplan-step-"]');
    steps.forEach(step => step.classList.add('floorplan-hidden'));

    // Update step indicator
    this.overlay.querySelector('#floorplan-step-num').textContent = this.currentStep;

    // Show current step
    const currentStepEl = this.overlay.querySelector(`#floorplan-step-${this.currentStep}`);
    if (currentStepEl) {
      currentStepEl.classList.remove('floorplan-hidden');
    }

    // Update buttons based on step
    this._updateButtons();

    // Step-specific rendering
    if (this.currentStep === 2) {
      this._initStep2();
    } else if (this.currentStep === 3) {
      this._initStep3();
    }
  }

  /**
   * Update button visibility
   */
  _updateButtons() {
    const skipBtn = this.overlay.querySelector('#floorplan-btn-skip');
    const backBtn = this.overlay.querySelector('#floorplan-btn-back');
    const nextBtn = this.overlay.querySelector('#floorplan-btn-next');
    const closePolygonBtn = this.overlay.querySelector('#floorplan-btn-close-polygon');
    const doneBtn = this.overlay.querySelector('#floorplan-btn-done');

    // Reset all
    [skipBtn, backBtn, nextBtn, closePolygonBtn, doneBtn].forEach(btn => {
      if (btn) btn.classList.add('floorplan-hidden');
    });

    if (this.currentStep === 1) {
      if (skipBtn) skipBtn.classList.remove('floorplan-hidden');
      if (nextBtn) nextBtn.classList.remove('floorplan-hidden');
      if (nextBtn) nextBtn.disabled = !this.floorplanImageElement;
    } else if (this.currentStep === 2) {
      if (backBtn) backBtn.classList.remove('floorplan-hidden');
      if (closePolygonBtn) closePolygonBtn.classList.remove('floorplan-hidden');
      if (closePolygonBtn) closePolygonBtn.disabled = this.roomOutline.length < 3;
    } else if (this.currentStep === 3) {
      if (backBtn) backBtn.classList.remove('floorplan-hidden');
      if (doneBtn) doneBtn.classList.remove('floorplan-hidden');
    }
  }

  /**
   * Initialize step 2 (draw room outline)
   */
  _initStep2() {
    // Setup canvas
    const container = this.overlay.querySelector('.floorplan-canvas-container');
    this.canvas.width = container.clientWidth;
    this.canvas.height = container.clientHeight;

    this.isDrawingPolygon = true;
    this._redrawCanvas();
    this._updatePointCount();
  }

  /**
   * Initialize step 3 (place nodes)
   */
  _initStep3() {
    // Setup canvas
    const container = this.overlay.querySelector('.floorplan-canvas-container');
    this.canvas.width = container.clientWidth;
    this.canvas.height = container.clientHeight;

    this.isDrawingPolygon = false;
    this._redrawCanvas();
    this._updateNodesList();
  }

  /**
   * Update point count display
   */
  _updatePointCount() {
    const countEl = this.overlay.querySelector('#floorplan-point-count');
    if (countEl) {
      countEl.textContent = this.roomOutline.length;
    }
  }

  /**
   * Update nodes list display
   */
  _updateNodesList() {
    const list = this.overlay.querySelector('#floorplan-nodes-list');
    if (!list) return;

    list.innerHTML = this.nodes.map(node => {
      const placed = this.nodePositions[node.id];
      return `
        <div class="floorplan-node-item ${placed ? 'placed' : ''}">
          <div>
            <div class="floorplan-node-name">${node.name}</div>
            <div class="floorplan-node-status">${node.id}</div>
          </div>
          <div class="floorplan-node-badge">${placed ? '✓ Placed' : 'Not placed'}</div>
        </div>
      `;
    }).join('');
  }

  /**
   * Redraw canvas based on current step
   */
  _redrawCanvas() {
    if (!this.ctx || !this.canvas) return;

    const { width, height } = this.canvas;
    this.ctx.clearRect(0, 0, width, height);

    // Draw background
    this.ctx.fillStyle = '#0f1119';
    this.ctx.fillRect(0, 0, width, height);

    if (this.currentStep === 2) {
      this._drawStep2Canvas();
    } else if (this.currentStep === 3) {
      this._drawStep3Canvas();
    }
  }

  /**
   * Draw step 2 canvas (room outline)
   */
  _drawStep2Canvas() {
    const { width, height } = this.canvas;

    // Draw grid if no image
    if (!this.floorplanImageElement) {
      this._drawGrid();
    } else {
      // Draw floor plan image scaled and centered
      this._drawFloorplanImage();
    }

    // Draw polygon
    this._drawPolygon();
  }

  /**
   * Draw step 3 canvas (place nodes)
   */
  _drawStep3Canvas() {
    const { width, height } = this.canvas;

    // Draw floor plan with outline
    if (!this.floorplanImageElement) {
      this._drawGrid();
    } else {
      this._drawFloorplanImage();
    }

    // Draw room outline
    this._drawPolygon(true);

    // Draw nodes
    this._drawNodes();
  }

  /**
   * Draw grid background
   */
  _drawGrid() {
    const { width, height } = this.canvas;
    const gridSize = 40;

    this.ctx.strokeStyle = '#1e2130';
    this.ctx.lineWidth = 1;

    for (let x = 0; x <= width; x += gridSize) {
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, height);
      this.ctx.stroke();
    }

    for (let y = 0; y <= height; y += gridSize) {
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(width, y);
      this.ctx.stroke();
    }
  }

  /**
   * Draw floor plan image scaled and centered
   */
  _drawFloorplanImage() {
    if (!this.floorplanImageElement) return;

    const { width, height } = this.canvas;
    const img = this.floorplanImageElement;

    // Calculate scaling to fit canvas while maintaining aspect ratio
    const scale = Math.min(
      width / img.width,
      height / img.height,
      1 // Don't scale up
    );

    const scaledWidth = img.width * scale;
    const scaledHeight = img.height * scale;

    const x = (width - scaledWidth) / 2;
    const y = (height - scaledHeight) / 2;

    // Store bounds for coordinate transformation
    this.imageBounds = { x, y, width: scaledWidth, height: scaledHeight };
    this.imageScale = scale;
    this.imageOffset = { x, y };

    // Draw with slight transparency
    this.ctx.globalAlpha = 0.8;
    this.ctx.drawImage(img, x, y, scaledWidth, scaledHeight);
    this.ctx.globalAlpha = 1;

    // Draw border
    this.ctx.strokeStyle = '#4f8cff';
    this.ctx.lineWidth = 2;
    this.ctx.strokeRect(x, y, scaledWidth, scaledHeight);
  }

  /**
   * Draw polygon (room outline)
   */
  _drawPolygon(filled = false) {
    if (this.roomOutline.length === 0) return;

    const points = this.roomOutline.map(p => this._normalizedToCanvas(p));

    // Draw lines
    this.ctx.strokeStyle = '#4f8cff';
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();

    points.forEach((p, i) => {
      if (i === 0) {
        this.ctx.moveTo(p.x, p.y);
      } else {
        this.ctx.lineTo(p.x, p.y);
      }
    });

    // Close polygon if filled
    if (filled && this.roomOutline.length >= 3) {
      this.ctx.closePath();
    }

    this.ctx.stroke();

    // Fill if requested
    if (filled && this.roomOutline.length >= 3) {
      this.ctx.fillStyle = 'rgba(79, 140, 255, 0.1)';
      this.ctx.fill();
    }

    // Draw vertices as circles
    this.ctx.fillStyle = '#4f8cff';
    points.forEach((p, i) => {
      this.ctx.beginPath();
      this.ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      this.ctx.fill();

      // Draw number
      this.ctx.fillStyle = '#08090d';
      this.ctx.font = 'bold 11px sans-serif';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText((i + 1).toString(), p.x, p.y);

      this.ctx.fillStyle = '#4f8cff';
    });
  }

  /**
   * Draw nodes on canvas
   */
  _drawNodes() {
    this.nodes.forEach(node => {
      const pos = this.nodePositions[node.id];
      if (!pos) return;

      const canvasPos = this._normalizedToCanvas(pos);

      // Draw circle
      const radius = 12;
      this.ctx.fillStyle = node.status === 'online' ? '#10b981' : '#ef4444';
      this.ctx.beginPath();
      this.ctx.arc(canvasPos.x, canvasPos.y, radius, 0, Math.PI * 2);
      this.ctx.fill();

      // Draw border
      this.ctx.strokeStyle = '#e2e8f0';
      this.ctx.lineWidth = 2;
      this.ctx.stroke();

      // Draw label
      this.ctx.fillStyle = '#e2e8f0';
      this.ctx.font = 'bold 11px sans-serif';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText(node.name.substring(0, 1), canvasPos.x, canvasPos.y);
    });
  }

  /**
   * Convert normalized coordinates (0-1) to canvas coordinates
   */
  _normalizedToCanvas(pos) {
    const { width, height } = this.canvas;
    let x = pos.x * width;
    let y = pos.y * height;

    // If we have image bounds, scale within image
    if (this.imageBounds) {
      x = this.imageBounds.x + (pos.x * this.imageBounds.width);
      y = this.imageBounds.y + (pos.y * this.imageBounds.height);
    }

    return { x, y };
  }

  /**
   * Convert canvas coordinates to normalized (0-1)
   */
  _canvasToNormalized(canvasPos) {
    const { width, height } = this.canvas;
    let x = canvasPos.x / width;
    let y = canvasPos.y / height;

    // If we have image bounds, unscale from image
    if (this.imageBounds) {
      x = (canvasPos.x - this.imageBounds.x) / this.imageBounds.width;
      y = (canvasPos.y - this.imageBounds.y) / this.imageBounds.height;
    }

    // Clamp to 0-1
    x = Math.max(0, Math.min(1, x));
    y = Math.max(0, Math.min(1, y));

    return { x, y };
  }

  /**
   * Get canvas position from event (handles mouse and touch)
   */
  _getEventCanvasPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    let clientX, clientY;

    if (e.touches) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  }

  /**
   * Check if point is near a vertex (for dragging)
   */
  _getVertexAtPos(canvasPos, threshold = 15) {
    const points = this.roomOutline.map(p => this._normalizedToCanvas(p));

    for (let i = 0; i < points.length; i++) {
      const dx = points[i].x - canvasPos.x;
      const dy = points[i].y - canvasPos.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < threshold) {
        return i;
      }
    }

    return null;
  }

  /**
   * Check if point is near a node (for dragging)
   */
  _getNodeAtPos(canvasPos, threshold = 20) {
    for (const nodeId of Object.keys(this.nodePositions)) {
      const pos = this.nodePositions[nodeId];
      const canvasNodePos = this._normalizedToCanvas(pos);

      const dx = canvasNodePos.x - canvasPos.x;
      const dy = canvasNodePos.y - canvasPos.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < threshold) {
        return nodeId;
      }
    }

    return null;
  }

  /**
   * Canvas click handler
   */
  _handleCanvasClick(e) {
    if (!this.isOpen) return;

    e.preventDefault();
    const canvasPos = this._getEventCanvasPos(e);
    const isDoubleClick = e.dblclick || (e.type === 'dblclick');

    if (this.currentStep === 2) {
      if (isDoubleClick || e.type === 'dblclick') {
        this._closePolygon();
      } else {
        // Add point to polygon
        const normalized = this._canvasToNormalized(canvasPos);
        this.roomOutline.push(normalized);
        this._redrawCanvas();
        this._updatePointCount();
        this._updateButtons();
      }
    } else if (this.currentStep === 3) {
      // Place node
      const nodeId = this._getNodeAtPos(canvasPos);

      // Get first unplaced node if clicking on empty area
      let targetNodeId = nodeId;
      if (!targetNodeId) {
        targetNodeId = this.nodes.find(n => !this.nodePositions[n.id])?.id;
      }

      if (targetNodeId) {
        const normalized = this._canvasToNormalized(canvasPos);
        this.nodePositions[targetNodeId] = normalized;
        this._redrawCanvas();
        this._updateNodesList();
      }
    }
  }

  /**
   * Canvas mouse down handler
   */
  _handleCanvasMouseDown(e) {
    if (!this.isOpen) return;

    e.preventDefault();
    const canvasPos = this._getEventCanvasPos(e);

    if (this.currentStep === 2) {
      // Check if clicking on a vertex to drag
      const vertexIndex = this._getVertexAtPos(canvasPos);
      if (vertexIndex !== null) {
        this.draggedVertexIndex = vertexIndex;
      }
    } else if (this.currentStep === 3) {
      // Check if clicking on a node to drag
      const nodeId = this._getNodeAtPos(canvasPos);
      if (nodeId) {
        this.draggedNodeId = nodeId;
      }
    }
  }

  /**
   * Canvas mouse move handler
   */
  _handleCanvasMouseMove(e) {
    if (!this.isOpen) return;

    e.preventDefault();
    const canvasPos = this._getEventCanvasPos(e);

    if (this.draggedVertexIndex !== null) {
      const normalized = this._canvasToNormalized(canvasPos);
      this.roomOutline[this.draggedVertexIndex] = normalized;
      this._redrawCanvas();
    } else if (this.draggedNodeId !== null) {
      const normalized = this._canvasToNormalized(canvasPos);
      this.nodePositions[this.draggedNodeId] = normalized;
      this._redrawCanvas();
      this._updateNodesList();
    }

    // Update cursor
    if (this.currentStep === 2) {
      const vertexIndex = this._getVertexAtPos(canvasPos);
      this.canvas.style.cursor = vertexIndex !== null ? 'grab' : 'crosshair';
    } else if (this.currentStep === 3) {
      const nodeId = this._getNodeAtPos(canvasPos);
      this.canvas.style.cursor = nodeId ? 'grab' : 'crosshair';
    }
  }

  /**
   * Canvas mouse up handler
   */
  _handleCanvasMouseUp(e) {
    if (!this.isOpen) return;

    this.draggedVertexIndex = null;
    this.draggedNodeId = null;
  }

  /**
   * Save everything and close
   */
  async _saveMeAndDone() {
    try {
      // Disable button during save
      const doneBtn = this.overlay.querySelector('#floorplan-btn-done');
      doneBtn.disabled = true;
      doneBtn.textContent = 'Saving...';

      // Step 1: Upload floor plan image if we have one
      if (this.floorplanImageElement && !this.uploadedFileName.startsWith('blob:')) {
        // Convert canvas to blob and upload
        const canvas = document.createElement('canvas');
        canvas.width = this.floorplanImageElement.width;
        canvas.height = this.floorplanImageElement.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(this.floorplanImageElement, 0, 0);

        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));

        const formData = new FormData();
        formData.append('plan', blob, 'floorplan.png');

        const response = await fetch('/api/floorplan', {
          method: 'POST',
          body: formData
        });

        if (!response.ok) {
          throw new Error('Failed to upload floor plan');
        }
      }

      // Step 2: Save room configuration
      const roomConfig = {
        outline: this.roomOutline,
        floorplanScale: this.imageScale,
        floorplanOffset: this.imageOffset
      };

      const configResponse = await fetch('/api/room-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(roomConfig)
      });

      if (!configResponse.ok) {
        throw new Error('Failed to save room config');
      }

      // Step 3: Save node positions
      for (const [nodeId, position] of Object.entries(this.nodePositions)) {
        const response = await fetch(`/api/nodes/${nodeId}/position`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(position)
        });

        if (!response.ok) {
          console.warn(`Failed to save position for node ${nodeId}`);
        }
      }

      // Emit success event
      const event = new CustomEvent('floorplan-updated', {
        detail: {
          outline: this.roomOutline,
          nodePositions: this.nodePositions,
          floorplanScale: this.imageScale,
          floorplanOffset: this.imageOffset
        }
      });
      document.dispatchEvent(event);

      // Close
      this.close();
    } catch (error) {
      console.error('Failed to save:', error);
      alert('Failed to save floor plan. Please try again.');

      const doneBtn = this.overlay.querySelector('#floorplan-btn-done');
      if (doneBtn) {
        doneBtn.disabled = false;
        doneBtn.textContent = 'Save & Done';
      }
    }
  }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FloorplanSetup;
}
