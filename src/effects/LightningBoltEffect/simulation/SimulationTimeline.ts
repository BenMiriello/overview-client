import { Vec3, VoronoiFieldData, BoltGeometry } from './types';

/**
 * A snapshot of the atmosphere state at a specific simulation time.
 * Used for playback - main thread interpolates between snapshots.
 */
export interface AtmosphereSnapshot {
  simTimeMs: number;
  ceilingCharge: VoronoiFieldData;
  groundCharge: VoronoiFieldData;
  atmosphericCharge: VoronoiFieldData;
  moisture: VoronoiFieldData;
  ionizationSeeds: VoronoiFieldData;
  ceilingY: number;
  groundY: number;
}

/**
 * A lightning strike event with pre-computed geometry.
 */
export interface StrikeEvent {
  simTimeMs: number;
  breakdownPosition: Vec3;
  geometry: BoltGeometry;
  seed: number;
  ionizationPath: Vec3[];
  dissipationRegion: {
    center: Vec3;
    radius: number;
  };
}

/**
 * Generic simulation event (currently just strikes, extensible).
 */
export type SimulationEvent = StrikeEvent;

/**
 * Configuration for the timeline simulation.
 */
export interface TimelineConfig {
  snapshotIntervalMs: number;
  speed: number;
  detail: number;
  baseWindSpeed: number;
  windDirection: { x: number; z: number };
  upperWindDirection: { x: number; z: number };
  chargeAccumulationRate: number;
  breakdownThreshold: number;
}

export const DEFAULT_TIMELINE_CONFIG: TimelineConfig = {
  snapshotIntervalMs: 100,
  speed: 1.0,
  detail: 1.0,
  baseWindSpeed: 0.002,
  windDirection: { x: 0.8, z: 0.6 },
  upperWindDirection: { x: 0.7, z: 0.7 },
  chargeAccumulationRate: 0.18,
  breakdownThreshold: 0.80,
};

/**
 * Messages sent TO the simulation worker.
 */
export type WorkerInMessage =
  | { type: 'start'; seed: number; config: TimelineConfig }
  | { type: 'set_parameters'; config: Partial<TimelineConfig>; applyAtSimTimeMs: number }
  | { type: 'pace'; visualTimeMs: number }  // Tell worker current visual time for pacing
  | { type: 'stop' };

/**
 * Messages sent FROM the simulation worker.
 */
export type WorkerOutMessage =
  | { type: 'snapshot'; snapshot: AtmosphereSnapshot }
  | { type: 'strike'; event: StrikeEvent; computeTimeMs: number }
  | { type: 'status'; simTimeMs: number; computeTimeMs: number }
  | { type: 'error'; message: string };
