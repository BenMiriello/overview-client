export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface SimHead {
  id: number;
  position: Vec3;
  direction: Vec3;
  parentSegmentId: number | null;
  stepIndex: number;
}

export interface SimSegment {
  id: number;
  start: Vec3;
  end: Vec3;
  parentSegmentId: number | null;
  stepIndex: number;
  intensity: number;
}

export interface BoltSegment {
  id: number;
  start: Vec3;
  end: Vec3;
  depth: number;
  parentSegmentId: number | null;
  stepIndex: number;
  intensity: number;
  isMainChannel: boolean;
  distanceFromMain: number;
  isDeadEnd: boolean;
}

export interface BoltGeometry {
  segments: BoltSegment[];
  mainChannelIds: number[];
  totalSteps: number;
  connectionStep: number;
  bounds: {
    min: Vec3;
    max: Vec3;
  };
}

export interface SimulationConfig {
  detailLevel: DetailLevel;
  eta: number;
  stepLength: number;
  maxSteps: number;
  candidateCount: number;
  coneHalfAngle: number;
  fieldConfig: FieldConfig;
  connectionThreshold: number;
  maxSegments: number;
  mainChannelJitter: number;
  jitterDecayRate: number;

  branchProbAtStart: number;
  branchProbAtEnd: number;
  branchSurvivalProb: number;
  maxActiveHeads: number;
  maxBranchesPerStep: number;

  deadEndFadeDuration: number;
  deadEndMinBrightness: number;
}

export interface FieldConfig {
  backgroundField: number;
  channelInfluence: number;
  groundInfluence: number;
  epsilon: number;
  noiseScale: number;
  noiseAmplitude: number;
  noiseSeed: number;
}

export enum DetailLevel {
  GLOBE = 'globe',
  SHOWCASE = 'showcase',
}

export interface SimulationInput {
  start: Vec3;
  end: Vec3;
  seed: number;
  config: SimulationConfig;
}

export interface SimulationOutput {
  geometry: BoltGeometry;
  stats: SimulationStats;
}

export interface SimulationStats {
  totalSteps: number;
  segmentCount: number;
  branchCount: number;
  maxDepth: number;
  connected: boolean;
  elapsedMs: number;
}

export interface Candidate {
  headId: number;
  position: Vec3;
  direction: Vec3;
  fieldValue: number;
}
