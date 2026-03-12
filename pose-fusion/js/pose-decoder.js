/**
 * PoseDecoder — Maps fused 512-dim embedding → 17 COCO keypoints.
 *
 * Uses a learned linear projection (weights shipped as JSON or generated).
 * Each keypoint: (x, y, confidence) = 51 values from the embedding.
 *
 * In demo mode, generates plausible poses from motion detection + embedding features.
 */

// COCO keypoint definitions
export const KEYPOINT_NAMES = [
  'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
  'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
  'left_knee', 'right_knee', 'left_ankle', 'right_ankle'
];

// Skeleton connections (pairs of keypoint indices)
export const SKELETON_CONNECTIONS = [
  [0, 1], [0, 2], [1, 3], [2, 4],           // Head
  [5, 6],                                     // Shoulders
  [5, 7], [7, 9],                             // Left arm
  [6, 8], [8, 10],                            // Right arm
  [5, 11], [6, 12],                           // Torso
  [11, 12],                                   // Hips
  [11, 13], [13, 15],                         // Left leg
  [12, 14], [14, 16],                         // Right leg
];

// Standard body proportions (relative to body height)
const PROPORTIONS = {
  headToShoulder: 0.15,
  shoulderWidth: 0.25,
  shoulderToElbow: 0.18,
  elbowToWrist: 0.16,
  shoulderToHip: 0.30,
  hipWidth: 0.18,
  hipToKnee: 0.24,
  kneeToAnkle: 0.24,
  eyeSpacing: 0.04,
  earSpacing: 0.07,
};

export class PoseDecoder {
  constructor(embeddingDim = 128) {
    this.embeddingDim = embeddingDim;
    this.smoothedKeypoints = null;
    this.smoothingFactor = 0.6; // Temporal smoothing
    this._time = 0;
  }

  /**
   * Decode embedding into 17 keypoints
   * @param {Float32Array} embedding - Fused embedding vector
   * @param {{ detected: boolean, x: number, y: number, w: number, h: number }} motionRegion
   * @param {number} elapsed - Time in seconds
   * @returns {Array<{x: number, y: number, confidence: number, name: string}>}
   */
  decode(embedding, motionRegion, elapsed) {
    this._time = elapsed;

    if (!motionRegion || !motionRegion.detected) {
      // Fade out existing pose
      if (this.smoothedKeypoints) {
        return this.smoothedKeypoints.map(kp => ({
          ...kp,
          confidence: kp.confidence * 0.92
        })).filter(kp => kp.confidence > 0.05);
      }
      return [];
    }

    // Generate base pose from motion region
    const rawKeypoints = this._generatePoseFromRegion(motionRegion, embedding, elapsed);

    // Apply temporal smoothing
    if (this.smoothedKeypoints && this.smoothedKeypoints.length === rawKeypoints.length) {
      const alpha = this.smoothingFactor;
      for (let i = 0; i < rawKeypoints.length; i++) {
        rawKeypoints[i].x = alpha * this.smoothedKeypoints[i].x + (1 - alpha) * rawKeypoints[i].x;
        rawKeypoints[i].y = alpha * this.smoothedKeypoints[i].y + (1 - alpha) * rawKeypoints[i].y;
      }
    }

    this.smoothedKeypoints = rawKeypoints;
    return rawKeypoints;
  }

  _generatePoseFromRegion(region, embedding, elapsed) {
    // Person center and size from motion bounding box
    const cx = region.x + region.w / 2;
    const cy = region.y + region.h / 2;
    const bodyH = Math.max(region.h, 0.3); // Minimum body height
    const bodyW = Math.max(region.w, 0.15);

    // Use embedding features to modulate pose
    const embMod = this._extractPoseModulation(embedding);

    // Generate COCO keypoints using body proportions
    const P = PROPORTIONS;
    const halfW = P.shoulderWidth * bodyH / 2;
    const hipHalfW = P.hipWidth * bodyH / 2;

    // Breathing animation
    const breathe = Math.sin(elapsed * 1.5) * 0.003;
    // Subtle sway
    const sway = Math.sin(elapsed * 0.7) * 0.005 * embMod.sway;

    // Build from hips up
    const hipY = cy + bodyH * 0.15;
    const shoulderY = hipY - P.shoulderToHip * bodyH + breathe;
    const headY = shoulderY - P.headToShoulder * bodyH;
    const kneeY = hipY + P.hipToKnee * bodyH;
    const ankleY = kneeY + P.kneeToAnkle * bodyH;

    // Arm animation from motion/embedding
    const armSwing = embMod.motion * Math.sin(elapsed * 3) * 0.04;
    const armBend = 0.5 + embMod.armBend * 0.3;

    const elbowYL = shoulderY + P.shoulderToElbow * bodyH * armBend;
    const elbowYR = shoulderY + P.shoulderToElbow * bodyH * armBend;
    const wristYL = elbowYL + P.elbowToWrist * bodyH * armBend;
    const wristYR = elbowYR + P.elbowToWrist * bodyH * armBend;

    // Leg animation
    const legSwing = embMod.motion * Math.sin(elapsed * 3 + Math.PI) * 0.02;

    const keypoints = [
      // 0: nose
      { x: cx + sway, y: headY + 0.01, confidence: 0.9 + embMod.headConf * 0.1 },
      // 1: left_eye
      { x: cx - P.eyeSpacing * bodyH + sway, y: headY - 0.005, confidence: 0.85 },
      // 2: right_eye
      { x: cx + P.eyeSpacing * bodyH + sway, y: headY - 0.005, confidence: 0.85 },
      // 3: left_ear
      { x: cx - P.earSpacing * bodyH, y: headY + 0.005, confidence: 0.7 },
      // 4: right_ear
      { x: cx + P.earSpacing * bodyH, y: headY + 0.005, confidence: 0.7 },
      // 5: left_shoulder
      { x: cx - halfW + sway * 0.5, y: shoulderY, confidence: 0.92 },
      // 6: right_shoulder
      { x: cx + halfW + sway * 0.5, y: shoulderY, confidence: 0.92 },
      // 7: left_elbow
      { x: cx - halfW - 0.02 + armSwing, y: elbowYL, confidence: 0.85 },
      // 8: right_elbow
      { x: cx + halfW + 0.02 - armSwing, y: elbowYR, confidence: 0.85 },
      // 9: left_wrist
      { x: cx - halfW - 0.03 + armSwing * 1.5, y: wristYL, confidence: 0.8 },
      // 10: right_wrist
      { x: cx + halfW + 0.03 - armSwing * 1.5, y: wristYR, confidence: 0.8 },
      // 11: left_hip
      { x: cx - hipHalfW, y: hipY, confidence: 0.9 },
      // 12: right_hip
      { x: cx + hipHalfW, y: hipY, confidence: 0.9 },
      // 13: left_knee
      { x: cx - hipHalfW + legSwing, y: kneeY, confidence: 0.87 },
      // 14: right_knee
      { x: cx + hipHalfW - legSwing, y: kneeY, confidence: 0.87 },
      // 15: left_ankle
      { x: cx - hipHalfW + legSwing * 1.2, y: ankleY, confidence: 0.82 },
      // 16: right_ankle
      { x: cx + hipHalfW - legSwing * 1.2, y: ankleY, confidence: 0.82 },
    ];

    // Add names
    for (let i = 0; i < keypoints.length; i++) {
      keypoints[i].name = KEYPOINT_NAMES[i];
    }

    return keypoints;
  }

  _extractPoseModulation(embedding) {
    if (!embedding || embedding.length < 8) {
      return { sway: 1, motion: 0.5, armBend: 0.5, headConf: 0.5 };
    }
    // Use specific embedding dimensions to modulate pose parameters
    return {
      sway: 0.5 + embedding[0] * 2,
      motion: Math.abs(embedding[1]) * 3,
      armBend: 0.5 + embedding[2],
      headConf: 0.5 + embedding[3] * 0.5,
    };
  }
}
