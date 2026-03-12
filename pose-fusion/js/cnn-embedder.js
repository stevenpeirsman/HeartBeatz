/**
 * CNN Embedder — Lightweight MobileNet-V3-style feature extractor.
 *
 * Architecture mirrors ruvector-cnn: Conv2D → BatchNorm → ReLU → Pool → Project → L2 Normalize
 * Uses pre-seeded random weights (deterministic). When ruvector-cnn-wasm is available,
 * transparently delegates to the WASM implementation.
 *
 * Two instances are created: one for video frames, one for CSI pseudo-images.
 */

// Seeded PRNG for deterministic weight initialization
function mulberry32(seed) {
  return function() {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class CnnEmbedder {
  /**
   * @param {object} opts
   * @param {number} opts.inputSize   - Square input dimension (default 56 for speed)
   * @param {number} opts.embeddingDim - Output embedding dimension (default 128)
   * @param {boolean} opts.normalize  - L2 normalize output
   * @param {number} opts.seed        - PRNG seed for weight init
   */
  constructor(opts = {}) {
    this.inputSize = opts.inputSize || 56;
    this.embeddingDim = opts.embeddingDim || 128;
    this.normalize = opts.normalize !== false;
    this.wasmEmbedder = null;

    // Initialize weights with deterministic PRNG
    const rng = mulberry32(opts.seed || 42);
    const randRange = (lo, hi) => lo + rng() * (hi - lo);

    // Conv 3x3: 3 input channels → 16 output channels
    this.convWeights = new Float32Array(3 * 3 * 3 * 16);
    for (let i = 0; i < this.convWeights.length; i++) {
      this.convWeights[i] = randRange(-0.15, 0.15);
    }

    // BatchNorm params (16 channels)
    this.bnGamma = new Float32Array(16).fill(1.0);
    this.bnBeta = new Float32Array(16).fill(0.0);
    this.bnMean = new Float32Array(16).fill(0.0);
    this.bnVar = new Float32Array(16).fill(1.0);

    // Projection: 16 → embeddingDim
    this.projWeights = new Float32Array(16 * this.embeddingDim);
    for (let i = 0; i < this.projWeights.length; i++) {
      this.projWeights[i] = randRange(-0.1, 0.1);
    }
  }

  /**
   * Try to load WASM embedder from ruvector-cnn-wasm package
   * @param {string} wasmPath - Path to the WASM package directory
   */
  async tryLoadWasm(wasmPath) {
    try {
      const mod = await import(`${wasmPath}/ruvector_cnn_wasm.js`);
      await mod.default();
      const config = new mod.EmbedderConfig();
      config.input_size = this.inputSize;
      config.embedding_dim = this.embeddingDim;
      config.normalize = this.normalize;
      this.wasmEmbedder = new mod.WasmCnnEmbedder(config);
      console.log('[CNN] WASM embedder loaded successfully');
      return true;
    } catch (e) {
      console.log('[CNN] WASM not available, using JS fallback:', e.message);
      return false;
    }
  }

  /**
   * Extract embedding from RGB image data
   * @param {Uint8Array} rgbData - RGB pixel data (H*W*3)
   * @param {number} width
   * @param {number} height
   * @returns {Float32Array} embedding vector
   */
  extract(rgbData, width, height) {
    if (this.wasmEmbedder) {
      try {
        const result = this.wasmEmbedder.extract(rgbData, width, height);
        return new Float32Array(result);
      } catch (_) { /* fallback to JS */ }
    }
    return this._extractJS(rgbData, width, height);
  }

  _extractJS(rgbData, width, height) {
    // 1. Resize to inputSize × inputSize if needed
    const sz = this.inputSize;
    let input;
    if (width === sz && height === sz) {
      input = new Float32Array(rgbData.length);
      for (let i = 0; i < rgbData.length; i++) input[i] = rgbData[i] / 255.0;
    } else {
      input = this._resize(rgbData, width, height, sz, sz);
    }

    // 2. ImageNet normalization
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    const pixels = sz * sz;
    for (let i = 0; i < pixels; i++) {
      input[i * 3]     = (input[i * 3]     - mean[0]) / std[0];
      input[i * 3 + 1] = (input[i * 3 + 1] - mean[1]) / std[1];
      input[i * 3 + 2] = (input[i * 3 + 2] - mean[2]) / std[2];
    }

    // 3. Conv2D 3x3 (3 → 16 channels)
    const convOut = this._conv2d3x3(input, sz, sz, 3, 16);

    // 4. BatchNorm
    this._batchNorm(convOut, 16);

    // 5. ReLU
    for (let i = 0; i < convOut.length; i++) {
      if (convOut[i] < 0) convOut[i] = 0;
    }

    // 6. Global average pooling → 16-dim
    const outH = sz - 2, outW = sz - 2;
    const pooled = new Float32Array(16);
    const spatial = outH * outW;
    for (let i = 0; i < spatial; i++) {
      for (let c = 0; c < 16; c++) {
        pooled[c] += convOut[i * 16 + c];
      }
    }
    for (let c = 0; c < 16; c++) pooled[c] /= spatial;

    // 7. Linear projection → embeddingDim
    const emb = new Float32Array(this.embeddingDim);
    for (let o = 0; o < this.embeddingDim; o++) {
      let sum = 0;
      for (let i = 0; i < 16; i++) {
        sum += pooled[i] * this.projWeights[i * this.embeddingDim + o];
      }
      emb[o] = sum;
    }

    // 8. L2 normalize
    if (this.normalize) {
      let norm = 0;
      for (let i = 0; i < emb.length; i++) norm += emb[i] * emb[i];
      norm = Math.sqrt(norm);
      if (norm > 1e-8) {
        for (let i = 0; i < emb.length; i++) emb[i] /= norm;
      }
    }

    return emb;
  }

  _conv2d3x3(input, H, W, Cin, Cout) {
    const outH = H - 2, outW = W - 2;
    const output = new Float32Array(outH * outW * Cout);
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        for (let co = 0; co < Cout; co++) {
          let sum = 0;
          for (let ky = 0; ky < 3; ky++) {
            for (let kx = 0; kx < 3; kx++) {
              for (let ci = 0; ci < Cin; ci++) {
                const px = ((y + ky) * W + (x + kx)) * Cin + ci;
                const wt = (((ky * 3 + kx) * Cin) + ci) * Cout + co;
                sum += input[px] * this.convWeights[wt];
              }
            }
          }
          output[(y * outW + x) * Cout + co] = sum;
        }
      }
    }
    return output;
  }

  _batchNorm(data, channels) {
    const spatial = data.length / channels;
    for (let i = 0; i < spatial; i++) {
      for (let c = 0; c < channels; c++) {
        const idx = i * channels + c;
        data[idx] = this.bnGamma[c] * (data[idx] - this.bnMean[c]) / Math.sqrt(this.bnVar[c] + 1e-5) + this.bnBeta[c];
      }
    }
  }

  _resize(rgbData, srcW, srcH, dstW, dstH) {
    const output = new Float32Array(dstW * dstH * 3);
    const xRatio = srcW / dstW;
    const yRatio = srcH / dstH;
    for (let y = 0; y < dstH; y++) {
      for (let x = 0; x < dstW; x++) {
        const sx = Math.min(Math.floor(x * xRatio), srcW - 1);
        const sy = Math.min(Math.floor(y * yRatio), srcH - 1);
        const srcIdx = (sy * srcW + sx) * 3;
        const dstIdx = (y * dstW + x) * 3;
        output[dstIdx]     = rgbData[srcIdx]     / 255.0;
        output[dstIdx + 1] = rgbData[srcIdx + 1] / 255.0;
        output[dstIdx + 2] = rgbData[srcIdx + 2] / 255.0;
      }
    }
    return output;
  }

  /** Cosine similarity between two embeddings */
  static cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);
    if (normA < 1e-8 || normB < 1e-8) return 0;
    return dot / (normA * normB);
  }
}
