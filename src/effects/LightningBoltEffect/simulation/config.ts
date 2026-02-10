import { DetailLevel, SimulationConfig, FieldConfig } from './types';

const FIELD_PRESETS: Record<DetailLevel, FieldConfig> = {
  [DetailLevel.GLOBE]: {
    backgroundField: 1.0,
    channelInfluence: 0.2,
    groundInfluence: 0.3,
    epsilon: 0.01,
    noiseScale: 0.1,
    noiseAmplitude: 0.3,
    noiseSeed: 0,
  },
  [DetailLevel.SHOWCASE]: {
    backgroundField: 1.0,
    channelInfluence: 0.3,
    groundInfluence: 0.15,
    epsilon: 0.005,
    noiseScale: 0.12,
    noiseAmplitude: 0.7,
    noiseSeed: 0,
  },
};

const DETAIL_PRESETS: Record<DetailLevel, Omit<SimulationConfig, 'fieldConfig'>> = {
  [DetailLevel.GLOBE]: {
    detailLevel: DetailLevel.GLOBE,
    eta: 2.0,
    stepLength: 0.02,
    maxSteps: 80,
    candidateCount: 12,
    coneHalfAngle: Math.PI / 5,
    connectionThreshold: 0.02,
    maxSegments: 200,
    mainChannelJitter: 1.5,
    jitterDecayRate: 0.97,

    branchProbAtStart: 0.15,
    branchProbAtEnd: 0.08,
    branchDeathRate: 0.06,
    minBranchAge: 8,
    maxActiveHeads: 30,
    maxBranchesPerStep: 2,

    deadEndFadeDuration: 0.20,
    deadEndMinBrightness: 0.15,
  },
  [DetailLevel.SHOWCASE]: {
    detailLevel: DetailLevel.SHOWCASE,
    eta: 2.0,
    stepLength: 0.008,
    maxSteps: 200,
    candidateCount: 24,
    coneHalfAngle: Math.PI / 4,
    connectionThreshold: 0.02,
    maxSegments: 3000,
    mainChannelJitter: 1.5,
    jitterDecayRate: 0.97,

    branchProbAtStart: 0.03,
    branchProbAtEnd: 0.06,
    branchDeathRate: 0.025,
    minBranchAge: 0,
    maxActiveHeads: 25,
    maxBranchesPerStep: 2,

    deadEndFadeDuration: 0.20,
    deadEndMinBrightness: 0.15,
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
