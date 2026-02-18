export { simulateBolt } from './BoltSimulator';
export { createConfig } from './config';
export { BoltPrecomputer, type PrecomputedBolt } from './BoltPrecomputer';
export { BoltWorkerPool } from './BoltWorkerPool';
export { SCALE, metersToUnits, unitsToMeters } from './constants';
export { createSeededRNG } from './prng';
export { VoronoiField, type VoronoiCell } from './VoronoiField';
export {
  createAtmosphericModel,
  DEFAULT_ATMOSPHERIC_CONFIG,
  type AtmosphericModel,
  type AtmosphericConfig,
} from './AtmosphericModel';
export {
  AtmosphereSimulator,
  DEFAULT_SIMULATOR_CONFIG,
  type AtmosphereSimulatorConfig,
  type BreakdownEvent,
} from './AtmosphereSimulator';
export type { SeededRNG } from './prng';
export {
  DetailLevel,
  type Vec3,
  type BoltSegment,
  type BoltGeometry,
  type SimulationConfig,
  type SimulationInput,
  type SimulationOutput,
  type SimulationStats,
  type FieldConfig,
  type AtmosphericModelData,
  type VoronoiFieldData,
  type VoronoiCellData,
} from './types';

// New timeline-based simulation system
export { TimelineBuffer } from './TimelineBuffer';
export { LeadTimeManager } from './LeadTimeManager';
export { TimelinePlayer, type TimelinePlayerCallbacks, type TimelinePlayerStatus } from './TimelinePlayer';
export {
  DEFAULT_TIMELINE_CONFIG,
  type AtmosphereSnapshot,
  type StrikeEvent,
  type SimulationEvent,
  type TimelineConfig,
  type WorkerInMessage,
  type WorkerOutMessage,
} from './SimulationTimeline';
