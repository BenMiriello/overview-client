import { simulateBolt } from './BoltSimulator';
import { AtmosphericModel } from './AtmosphericModel';
import { VoronoiField, VoronoiCell } from './VoronoiField';
import {
  Vec3,
  SimulationConfig,
  SimulationOutput,
  AtmosphericModelData,
} from './types';

export interface WorkerInput {
  id: string;
  start: Vec3;
  end: Vec3;
  seed: number;
  config: SimulationConfig;
  atmosphereData?: AtmosphericModelData & {
    startingPoints: Vec3[];
    ceilingY: number;
    groundY: number;
  };
}

export interface WorkerOutput {
  id: string;
  result: SimulationOutput;
  elapsedMs: number;
}

export interface WorkerError {
  id: string;
  error: string;
}

function reconstructAtmosphere(data: WorkerInput['atmosphereData']): AtmosphericModel | undefined {
  if (!data) return undefined;

  const reconstructField = (fieldData: AtmosphericModelData['ceilingCharge']): VoronoiField => {
    const cells: VoronoiCell[] = fieldData.cells.map(c => ({
      center: { ...c.center },
      intensity: c.intensity,
      falloffRadius: c.falloffRadius,
    }));
    return new VoronoiField(cells, { is2D: fieldData.is2D, fixedY: fieldData.fixedY });
  };

  return {
    ceilingCharge: reconstructField(data.ceilingCharge),
    groundCharge: reconstructField(data.groundCharge),
    atmosphericCharge: reconstructField(data.atmosphericCharge),
    moisture: reconstructField(data.moisture),
    ionizationSeeds: reconstructField(data.ionizationSeeds),
    startingPoints: data.startingPoints,
    ceilingY: data.ceilingY,
    groundY: data.groundY,
  };
}

self.onmessage = (event: MessageEvent<WorkerInput>) => {
  const { id, start, end, seed, config, atmosphereData } = event.data;
  const t0 = performance.now();

  try {
    const atmosphere = reconstructAtmosphere(atmosphereData);

    const result = simulateBolt(
      { start, end, seed, config },
      atmosphere
    );

    const output: WorkerOutput = {
      id,
      result,
      elapsedMs: performance.now() - t0,
    };

    self.postMessage(output);
  } catch (e) {
    const error: WorkerError = {
      id,
      error: e instanceof Error ? e.message : String(e),
    };
    self.postMessage(error);
  }
};
