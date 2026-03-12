/**
 * PoseDecoder — Maps motion detection grid → 17 COCO keypoints.
 *
 * Uses per-cell motion intensity to track actual body part positions:
 * - Head: top-center motion cluster
 * - Shoulders/Elbows/Wrists: lateral motion in upper body zone
 * - Hips/Knees/Ankles: lower body motion distribution
 *
 * When person exits frame, CSI data continues tracking (through-wall mode).
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
    this.smoothingFactor = 0.45; // Lower = more responsive to movement
    this._time = 0;

    // Through-wall tracking state
    this._lastBodyState = null;
    this._ghostState = null;
    this._ghostConfidence = 0;
    this._ghostVelocity = { x: 0, y: 0 };

    // Arm tracking history (smoothed positions)
    this._leftArmY = 0.5;
    this._rightArmY = 0.5;
    this._leftArmX = 0;
    this._rightArmX = 0;
    this._headOffsetX = 0;
  }

  /**
   * Decode motion data into 17 keypoints
   * @param {Float32Array} embedding - Fused embedding vector
   * @param {{ detected, x, y, w, h, motionGrid, gridCols, gridRows, motionCx, motionCy, exitDirection }} motionRegion
   * @param {number} elapsed - Time in seconds
   * @param {{ csiPresence: number }} csiState - CSI sensing state for through-wall
   * @returns {Array<{x: number, y: number, confidence: number, name: string}>}
   */
  decode(embedding, motionRegion, elapsed, csiState = {}) {
    this._time = elapsed;

    const hasMotion = motionRegion && motionRegion.detected;
    const hasCsi = csiState && csiState.csiPresence > 0.1;

    if (hasMotion) {
      // Active tracking from video motion grid
      this._ghostConfidence = 0;
      const rawKeypoints = this._trackFromMotionGrid(motionRegion, embedding, elapsed);
      this._lastBodyState = { keypoints: rawKeypoints.map(kp => ({...kp})), time: elapsed };

      // Track exit velocity
      if (motionRegion.exitDirection) {
        const speed = 0.008;
        this._ghostVelocity = {
          x: motionRegion.exitDirection === 'left' ? -speed : motionRegion.exitDirection === 'right' ? speed : 0,
          y: motionRegion.exitDirection === 'up' ? -speed : motionRegion.exitDirection === 'down' ? speed : 0
        };
      }

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

    } else if (this._lastBodyState && (hasCsi || this._ghostConfidence > 0.05)) {
      // Through-wall mode: person left frame but CSI still senses them
      return this._trackThroughWall(elapsed, csiState);

    } else if (this.smoothedKeypoints) {
      // Fade out
      const faded = this.smoothedKeypoints.map(kp => ({
        ...kp,
        confidence: kp.confidence * 0.88
      })).filter(kp => kp.confidence > 0.05);
      if (faded.length === 0) this.smoothedKeypoints = null;
      else this.smoothedKeypoints = faded;
      return faded;
    }

    return [];
  }

  /**
   * Track body parts from the motion grid.
   * The grid tells us WHERE motion is happening → we map that to joint positions.
   */
  _trackFromMotionGrid(region, embedding, elapsed) {
    const grid = region.motionGrid;
    const cols = region.gridCols || 10;
    const rows = region.gridRows || 8;

    // Body bounding box
    const cx = region.x + region.w / 2;
    const cy = region.y + region.h / 2;
    const bodyH = Math.max(region.h, 0.3);
    const bodyW = Math.max(region.w, 0.15);

    // Analyze the motion grid to find arm positions
    // Divide body into zones: head (top 20%), arms (top 60% sides), torso (center), legs (bottom 40%)
    if (grid) {
      const armAnalysis = this._analyzeArmMotion(grid, cols, rows, region);
      // Smooth arm tracking
      this._leftArmY = 0.6 * this._leftArmY + 0.4 * armAnalysis.leftArmHeight;
      this._rightArmY = 0.6 * this._rightArmY + 0.4 * armAnalysis.rightArmHeight;
      this._leftArmX = 0.6 * this._leftArmX + 0.4 * armAnalysis.leftArmSpread;
      this._rightArmX = 0.6 * this._rightArmX + 0.4 * armAnalysis.rightArmSpread;
      this._headOffsetX = 0.7 * this._headOffsetX + 0.3 * armAnalysis.headOffsetX;
    }

    const P = PROPORTIONS;
    const halfW = P.shoulderWidth * bodyH / 2;
    const hipHalfW = P.hipWidth * bodyH / 2;

    // Breathing (subtle)
    const breathe = Math.sin(elapsed * 1.5) * 0.002;

    // Core body positions from detection center
    const hipY = cy + bodyH * 0.15;
    const shoulderY = hipY - P.shoulderToHip * bodyH + breathe;
    const headY = shoulderY - P.headToShoulder * bodyH;
    const kneeY = hipY + P.hipToKnee * bodyH;
    const ankleY = kneeY + P.kneeToAnkle * bodyH;

    // HEAD follows motion centroid
    const headX = cx + this._headOffsetX * bodyW * 0.3;

    // ARM POSITIONS driven by motion grid analysis
    // leftArmY: 0 = arm down at side, 1 = arm fully raised
    // leftArmSpread: how far out the arm extends
    const leftArmRaise = this._leftArmY;  // 0-1
    const rightArmRaise = this._rightArmY;
    const leftSpread = 0.02 + this._leftArmX * 0.12;
    const rightSpread = 0.02 + this._rightArmX * 0.12;

    // Elbow: interpolate between "at side" and "raised"
    const lElbowY = shoulderY + P.shoulderToElbow * bodyH * (1 - leftArmRaise * 0.9);
    const rElbowY = shoulderY + P.shoulderToElbow * bodyH * (1 - rightArmRaise * 0.9);
    const lElbowX = cx - halfW - leftSpread;
    const rElbowX = cx + halfW + rightSpread;

    // Wrist: extends further when raised
    const lWristY = lElbowY + P.elbowToWrist * bodyH * (1 - leftArmRaise * 1.1);
    const rWristY = rElbowY + P.elbowToWrist * bodyH * (1 - rightArmRaise * 1.1);
    const lWristX = lElbowX - leftSpread * 0.6;
    const rWristX = rElbowX + rightSpread * 0.6;

    // Leg motion from lower grid cells
    const legMotion = grid ? this._analyzeLegMotion(grid, cols, rows) : { left: 0, right: 0 };
    const legSwing = 0.015;

    const keypoints = [
      // 0: nose
      { x: headX, y: headY + 0.01, confidence: 0.92 },
      // 1: left_eye
      { x: headX - P.eyeSpacing * bodyH, y: headY - 0.005, confidence: 0.88 },
      // 2: right_eye
      { x: headX + P.eyeSpacing * bodyH, y: headY - 0.005, confidence: 0.88 },
      // 3: left_ear
      { x: headX - P.earSpacing * bodyH, y: headY + 0.005, confidence: 0.72 },
      // 4: right_ear
      { x: headX + P.earSpacing * bodyH, y: headY + 0.005, confidence: 0.72 },
      // 5: left_shoulder
      { x: cx - halfW, y: shoulderY, confidence: 0.94 },
      // 6: right_shoulder
      { x: cx + halfW, y: shoulderY, confidence: 0.94 },
      // 7: left_elbow
      { x: lElbowX, y: lElbowY, confidence: 0.87 },
      // 8: right_elbow
      { x: rElbowX, y: rElbowY, confidence: 0.87 },
      // 9: left_wrist
      { x: lWristX, y: lWristY, confidence: 0.82 },
      // 10: right_wrist
      { x: rWristX, y: rWristY, confidence: 0.82 },
      // 11: left_hip
      { x: cx - hipHalfW, y: hipY, confidence: 0.91 },
      // 12: right_hip
      { x: cx + hipHalfW, y: hipY, confidence: 0.91 },
      // 13: left_knee
      { x: cx - hipHalfW + legMotion.left * legSwing, y: kneeY, confidence: 0.88 },
      // 14: right_knee
      { x: cx + hipHalfW + legMotion.right * legSwing, y: kneeY, confidence: 0.88 },
      // 15: left_ankle
      { x: cx - hipHalfW + legMotion.left * legSwing * 1.3, y: ankleY, confidence: 0.83 },
      // 16: right_ankle
      { x: cx + hipHalfW + legMotion.right * legSwing * 1.3, y: ankleY, confidence: 0.83 },
    ];

    for (let i = 0; i < keypoints.length; i++) {
      keypoints[i].name = KEYPOINT_NAMES[i];
    }

    return keypoints;
  }

  /**
   * Analyze the motion grid to determine arm positions.
   * Left side of grid = left side of body, etc.
   */
  _analyzeArmMotion(grid, cols, rows, region) {
    // Body center column
    const centerCol = Math.floor(cols / 2);

    // Upper body rows (top 60% of detected region)
    const upperEnd = Math.floor(rows * 0.6);

    // Compute motion intensity for left vs right, at different heights
    let leftUpperMotion = 0, leftMidMotion = 0;
    let rightUpperMotion = 0, rightMidMotion = 0;
    let leftCount = 0, rightCount = 0;
    let headMotionX = 0, headMotionWeight = 0;

    for (let r = 0; r < upperEnd; r++) {
      const heightWeight = 1.0 - (r / upperEnd) * 0.3; // Upper rows weighted more

      // Head zone: top 25%, center 40% of width
      if (r < Math.floor(rows * 0.25)) {
        const headLeft = Math.floor(cols * 0.3);
        const headRight = Math.floor(cols * 0.7);
        for (let c = headLeft; c <= headRight; c++) {
          const val = grid[r][c];
          headMotionX += (c / cols - 0.5) * val;
          headMotionWeight += val;
        }
      }

      // Left arm zone: left 40% of grid
      for (let c = 0; c < Math.floor(cols * 0.4); c++) {
        const val = grid[r][c];
        if (r < rows * 0.3) leftUpperMotion += val * heightWeight;
        else leftMidMotion += val * heightWeight;
        leftCount++;
      }

      // Right arm zone: right 40% of grid
      for (let c = Math.floor(cols * 0.6); c < cols; c++) {
        const val = grid[r][c];
        if (r < rows * 0.3) rightUpperMotion += val * heightWeight;
        else rightMidMotion += val * heightWeight;
        rightCount++;
      }
    }

    // Normalize
    const leftTotal = leftUpperMotion + leftMidMotion;
    const rightTotal = rightUpperMotion + rightMidMotion;
    const maxMotion = 0.15; // Calibration threshold

    // Arm height: 0 = at side, 1 = raised
    // High motion in upper-left → left arm is raised
    const leftArmHeight = Math.min(1, (leftUpperMotion / maxMotion) * 2);
    const rightArmHeight = Math.min(1, (rightUpperMotion / maxMotion) * 2);

    // Arm spread: how far out from body
    const leftArmSpread = Math.min(1, leftTotal / maxMotion);
    const rightArmSpread = Math.min(1, rightTotal / maxMotion);

    // Head offset
    const headOffsetX = headMotionWeight > 0.01 ? headMotionX / headMotionWeight : 0;

    return { leftArmHeight, rightArmHeight, leftArmSpread, rightArmSpread, headOffsetX };
  }

  /**
   * Analyze lower grid for leg motion.
   */
  _analyzeLegMotion(grid, cols, rows) {
    const lowerStart = Math.floor(rows * 0.6);
    let leftMotion = 0, rightMotion = 0;

    for (let r = lowerStart; r < rows; r++) {
      for (let c = 0; c < Math.floor(cols / 2); c++) {
        leftMotion += grid[r][c];
      }
      for (let c = Math.floor(cols / 2); c < cols; c++) {
        rightMotion += grid[r][c];
      }
    }

    // Return as -1 to 1 range (asymmetry indicates which leg is moving)
    const total = leftMotion + rightMotion + 0.001;
    return {
      left: (leftMotion - rightMotion) / total,
      right: (rightMotion - leftMotion) / total
    };
  }

  /**
   * Through-wall tracking: continue showing pose via CSI when person left video frame.
   * The skeleton drifts in the exit direction with decreasing confidence.
   */
  _trackThroughWall(elapsed, csiState) {
    if (!this._lastBodyState) return [];

    const dt = elapsed - this._lastBodyState.time;
    const csiPresence = csiState.csiPresence || 0;

    // Initialize ghost on first call
    if (this._ghostConfidence <= 0.05) {
      this._ghostConfidence = 0.8;
      this._ghostState = this._lastBodyState.keypoints.map(kp => ({...kp}));
    }

    // Ghost confidence decays, but CSI presence sustains it
    const csiBoost = Math.min(0.7, csiPresence * 0.8);
    this._ghostConfidence = Math.max(0.05, this._ghostConfidence * 0.995 - 0.001 + csiBoost * 0.002);

    // Drift the ghost in exit direction
    const vx = this._ghostVelocity.x;
    const vy = this._ghostVelocity.y;

    // Breathing continues via CSI
    const breathe = Math.sin(elapsed * 1.5) * 0.003 * csiPresence;

    const keypoints = this._ghostState.map((kp, i) => {
      return {
        x: kp.x + vx * dt * 0.3,
        y: kp.y + vy * dt * 0.3 + (i >= 5 && i <= 6 ? breathe : 0),
        confidence: kp.confidence * this._ghostConfidence * (0.5 + csiPresence * 0.5),
        name: kp.name
      };
    });

    // Slow down drift over time
    this._ghostVelocity.x *= 0.998;
    this._ghostVelocity.y *= 0.998;

    this.smoothedKeypoints = keypoints;
    return keypoints;
  }
}
