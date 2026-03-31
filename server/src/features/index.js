// ==============================================================================
// Feature Extraction Pipeline — Orchestrator
// ==============================================================================
// Central entry point for all CSI feature extraction. Coordinates the various
// feature modules (amplitude/grouping, phase, Doppler, etc.) and produces a
// unified FeatureVector for downstream consumers.
//
// Currently implements:
//   - Subcarrier grouping into 8 bands (ACC-01-T1)
//
// Implemented:
//   - Phase difference extraction with linear unwrapping (ACC-01-T2)
//
// Implemented:
//   - Short-time FFT / Doppler classification (ACC-01-T3)
//
// Implemented:
//   - Statistical features per window (ACC-01-T4)
//
// Implemented:
//   - Subcarrier correlation matrix with eigenvalue spread (ACC-01-T5)
//
// Implemented:
//   - Frame quality scorer (ACC-01-T6)
//
// Implemented:
//   - Feature vector serializer — JSON (SSE) + CSV (ML export) (ACC-01-T7)
// ==============================================================================

export { groupSubcarriers, computeTemporalBandFeatures, computeBandMotionScore, mean, variance } from './amplitude.js';
export {
  extractPhases,
  computeAdjacentPhaseDiffs,
  unwrapPhase,
  fitLinearPhase,
  computeBandPhaseFeatures,
  extractPhaseFeatures,
  wrapToPi,
  NUM_PHASE_DIFFS,
} from './phase.js';
export {
  hannWindow,
  fftMagnitude,
  computeDopplerSpectrum,
  computeAverageDopplerSpectrum,
  extractDopplerFeatures,
  classifyMotion,
  DopplerAnalyzer,
  DEFAULT_FFT_SIZE,
  MIN_FFT_SIZE,
  MAX_FFT_SIZE,
  DOPPLER_BANDS,
  NUM_DOPPLER_BANDS,
  MOTION_CLASS,
  NOISE_FLOOR_ENERGY,
  BAND_DOMINANCE_THRESHOLD,
} from './doppler.js';
export {
  mean as statMean,
  variance as statVariance,
  stddev,
  skewness,
  kurtosis,
  iqr,
  quantile,
  entropy,
  computeBandStatistics,
  computeWindowStatistics,
  StatisticalFeatureExtractor,
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  MAX_WINDOW_SIZE,
  ENTROPY_BINS,
} from './statistics.js';
export {
  computeBandMeans,
  computeCovarianceMatrix,
  covarianceToCorrelation,
  dominantEigenvalue,
  estimateSmallestEigenvalue,
  computeEigenvalueSpread,
  computeCorrelationFeatures,
  CorrelationAnalyzer,
  DEFAULT_CORR_WINDOW,
  MIN_CORR_WINDOW,
  MAX_CORR_WINDOW,
} from './correlation.js';
export {
  computeRssiStability,
  computeTimestampJitter,
  computePacketLoss,
  computeAmplitudeValidity,
  computeQualityReport,
  FrameQualityScorer,
  QUALITY_WINDOW_SIZE,
  QUALITY_WEIGHTS,
  RSSI_VARIANCE_GOOD,
  RSSI_VARIANCE_BAD,
  MIN_VALID_AMPLITUDE,
  MIN_VALID_SUBCARRIER_FRACTION,
} from './quality.js';
export {
  serializeToJSON,
  deserializeFromJSON,
  csvHeader,
  serializeToCSVRow,
  serializeToCSV,
  parseCSVRow,
  getColumnCount,
  getColumnNames,
  resolvePath,
  formatValue,
  CSV_COLUMNS,
  PRECISION_STANDARD,
  PRECISION_HIGH,
} from './serializer.js';
