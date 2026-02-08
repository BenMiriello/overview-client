import { DetailLevel, SimulationConfig, FieldConfig } from './types';

const FIELD_PRESETS: Record<DetailLevel, FieldConfig> = {
  [DetailLevel.GLOBE]: {
    backgroundField: 1.0,
    channelInfluence: 0.3,
    groundInfluence: 0.5,
    epsilon: 0.01,
    noiseScale: 0.1,
    noiseAmplitude: 0.2,
    noiseSeed: 0,
  },
  [DetailLevel.SHOWCASE]: {
    backgroundField: 1.0,
    channelInfluence: 0.5,
    groundInfluence: 0.7,
    epsilon: 0.005,
    noiseScale: 0.15,
    noiseAmplitude: 0.25,
    noiseSeed: 0,
  },
};

const DETAIL_PRESETS: Record<DetailLevel, Omit<SimulationConfig, 'fieldConfig'>> = {
  [DetailLevel.GLOBE]: {
    detailLevel: DetailLevel.GLOBE,
    eta: 2.0,
    stepLength: 0.02,
    maxSteps: 80,
    candidateCount: 8,
    coneHalfAngle: Math.PI / 6,
    maxBranchDepth: 0,
    baseBranchProb: 0,
    branchProgressDecay: 0,
    maxBranchesPerStep: 0,
    connectionThreshold: 0.02,
    maxSegments: 100,
    postBranchProb: 0.12,
    postBranchMinLength: 8,
    postBranchMaxLength: 15,
    postBranchAngleMin: 40,
    postBranchAngleMax: 80,
  },
  [DetailLevel.SHOWCASE]: {
    detailLevel: DetailLevel.SHOWCASE,
    eta: 2.0,
    stepLength: 0.008,
    maxSteps: 200,
    candidateCount: 16,
    coneHalfAngle: Math.PI / 6,
    maxBranchDepth: 0,
    baseBranchProb: 0,
    branchProgressDecay: 0,
    maxBranchesPerStep: 0,
    connectionThreshold: 0.02,
    maxSegments: 800,
    postBranchProb: 0.15,
    postBranchMinLength: 15,
    postBranchMaxLength: 30,
    postBranchAngleMin: 40,
    postBranchAngleMax: 80,
  },
};

export function createConfig(
  level: DetailLevel,
  overrides?: Partial<SimulationConfig>,
): SimulationConfig {
  const preset = DETAIL_PRESETS[level];
  const fieldPreset = FIELD_PRESETS[level];

  const base: SimulationConfig = {
    ...preset,
    fieldConfig: { ...fieldPreset },
  };

  if (!overrides) return base;

  const { fieldConfig: fieldOverrides, ...rest } = overrides;
  return {
    ...base,
    ...rest,
    fieldConfig: fieldOverrides ? { ...base.fieldConfig, ...fieldOverrides } : base.fieldConfig,
  };
}
