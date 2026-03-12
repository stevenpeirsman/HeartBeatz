/**
 * FusionEngine — Attention-weighted dual-modal embedding fusion.
 *
 * Combines visual (camera) and CSI (WiFi) embeddings with dynamic
 * confidence gating based on signal quality.
 */

export class FusionEngine {
  /**
   * @param {number} embeddingDim
   */
  constructor(embeddingDim = 128) {
    this.embeddingDim = embeddingDim;

    // Learnable attention weights (initialized to balanced 0.5)
    // In production, these would be loaded from trained JSON
    this.attentionWeights = new Float32Array(embeddingDim).fill(0.5);

    // Dynamic modality confidence [0, 1]
    this.videoConfidence = 1.0;
    this.csiConfidence = 0.0;
    this.fusedConfidence = 0.5;

    // Smoothing for confidence transitions
    this._smoothAlpha = 0.85;

    // Embedding history for visualization
    this.recentVideoEmbeddings = [];
    this.recentCsiEmbeddings = [];
    this.recentFusedEmbeddings = [];
    this.maxHistory = 50;
  }

  /**
   * Update quality-based confidence scores
   * @param {number} videoBrightness - [0,1] video brightness quality
   * @param {number} videoMotion     - [0,1] motion detected
   * @param {number} csiSnr          - CSI signal-to-noise ratio in dB
   * @param {boolean} csiActive      - Whether CSI source is connected
   */
  updateConfidence(videoBrightness, videoMotion, csiSnr, csiActive) {
    // Video confidence: drops with low brightness, boosted by motion
    let vc = 0;
    if (videoBrightness > 0.05) {
      vc = Math.min(1, videoBrightness * 1.5) * 0.7 + Math.min(1, videoMotion * 3) * 0.3;
    }

    // CSI confidence: based on SNR and connection status
    let cc = 0;
    if (csiActive) {
      cc = Math.min(1, csiSnr / 25); // 25dB = full confidence
    }

    // Smooth transitions
    this.videoConfidence = this._smoothAlpha * this.videoConfidence + (1 - this._smoothAlpha) * vc;
    this.csiConfidence = this._smoothAlpha * this.csiConfidence + (1 - this._smoothAlpha) * cc;

    // Fused confidence is the max of either (fusion can only help)
    this.fusedConfidence = Math.min(1, Math.sqrt(
      this.videoConfidence * this.videoConfidence + this.csiConfidence * this.csiConfidence
    ));
  }

  /**
   * Fuse video and CSI embeddings
   * @param {Float32Array|null} videoEmb - Visual embedding (or null if video-off)
   * @param {Float32Array|null} csiEmb   - CSI embedding (or null if CSI-off)
   * @param {string} mode                - 'dual' | 'video' | 'csi'
   * @returns {Float32Array} Fused embedding
   */
  fuse(videoEmb, csiEmb, mode = 'dual') {
    const dim = this.embeddingDim;
    const fused = new Float32Array(dim);

    if (mode === 'video' || !csiEmb) {
      if (videoEmb) fused.set(videoEmb);
      this._recordEmbedding(videoEmb, null, fused);
      return fused;
    }

    if (mode === 'csi' || !videoEmb) {
      if (csiEmb) fused.set(csiEmb);
      this._recordEmbedding(null, csiEmb, fused);
      return fused;
    }

    // Dual mode: attention-weighted fusion with confidence gating
    const totalConf = this.videoConfidence + this.csiConfidence;
    const videoWeight = totalConf > 0 ? this.videoConfidence / totalConf : 0.5;

    for (let i = 0; i < dim; i++) {
      const alpha = this.attentionWeights[i] * videoWeight +
                    (1 - this.attentionWeights[i]) * (1 - videoWeight);
      fused[i] = alpha * videoEmb[i] + (1 - alpha) * csiEmb[i];
    }

    // Re-normalize
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += fused[i] * fused[i];
    norm = Math.sqrt(norm);
    if (norm > 1e-8) {
      for (let i = 0; i < dim; i++) fused[i] /= norm;
    }

    this._recordEmbedding(videoEmb, csiEmb, fused);
    return fused;
  }

  /**
   * Get embedding pairs for 2D visualization (PCA projection)
   * @returns {{ video: Array, csi: Array, fused: Array }}
   */
  getEmbeddingPoints() {
    // Simple 2D projection using first two principal components (approximated)
    const project = (emb) => {
      if (!emb || emb.length < 4) return null;
      // Use pairs of dimensions as crude 2D projection
      let x = 0, y = 0;
      for (let i = 0; i < emb.length; i += 2) {
        x += emb[i] * (i % 4 < 2 ? 1 : -1);
        if (i + 1 < emb.length) {
          y += emb[i + 1] * (i % 4 < 2 ? 1 : -1);
        }
      }
      return [x * 2, y * 2]; // Scale for visibility
    };

    return {
      video: this.recentVideoEmbeddings.map(project).filter(Boolean),
      csi: this.recentCsiEmbeddings.map(project).filter(Boolean),
      fused: this.recentFusedEmbeddings.map(project).filter(Boolean)
    };
  }

  /**
   * Cross-modal similarity score
   * @returns {number} Cosine similarity between latest video and CSI embeddings
   */
  getCrossModalSimilarity() {
    const v = this.recentVideoEmbeddings[this.recentVideoEmbeddings.length - 1];
    const c = this.recentCsiEmbeddings[this.recentCsiEmbeddings.length - 1];
    if (!v || !c) return 0;

    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < v.length; i++) {
      dot += v[i] * c[i];
      na += v[i] * v[i];
      nb += c[i] * c[i];
    }
    na = Math.sqrt(na); nb = Math.sqrt(nb);
    return (na > 1e-8 && nb > 1e-8) ? dot / (na * nb) : 0;
  }

  _recordEmbedding(video, csi, fused) {
    if (video) {
      this.recentVideoEmbeddings.push(new Float32Array(video));
      if (this.recentVideoEmbeddings.length > this.maxHistory) this.recentVideoEmbeddings.shift();
    }
    if (csi) {
      this.recentCsiEmbeddings.push(new Float32Array(csi));
      if (this.recentCsiEmbeddings.length > this.maxHistory) this.recentCsiEmbeddings.shift();
    }
    this.recentFusedEmbeddings.push(new Float32Array(fused));
    if (this.recentFusedEmbeddings.length > this.maxHistory) this.recentFusedEmbeddings.shift();
  }
}
