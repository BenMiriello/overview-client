import { createConfig } from './config';
import { AtmosphericModel } from './AtmosphericModel';
import {
  Vec3,
  DetailLevel,
  SimulationOutput,
} from './types';
import type { WorkerInput, WorkerOutput, WorkerError } from './BoltSimulationWorker';

export interface PendingJob {
  id: string;
  resolve: (result: SimulationOutput) => void;
  reject: (error: Error) => void;
  startTime: number;
}

function serializeAtmosphere(atmosphere: AtmosphericModel): WorkerInput['atmosphereData'] {
  const serializeField = (field: AtmosphericModel['ceilingCharge']) => {
    const config = field.getConfig();
    return {
      cells: field.cells.map(c => ({
        center: { ...c.center },
        intensity: c.intensity,
        falloffRadius: c.falloffRadius,
      })),
      is2D: config.is2D,
      fixedY: config.fixedY,
    };
  };

  return {
    ceilingCharge: serializeField(atmosphere.ceilingCharge),
    groundCharge: serializeField(atmosphere.groundCharge),
    atmosphericCharge: serializeField(atmosphere.atmosphericCharge),
    moisture: serializeField(atmosphere.moisture),
    ionizationSeeds: serializeField(atmosphere.ionizationSeeds),
    startingPoints: atmosphere.startingPoints.map(p => ({ ...p })),
    ceilingY: atmosphere.ceilingY,
    groundY: atmosphere.groundY,
  };
}

export class BoltWorkerPool {
  private worker: Worker | null = null;
  private pendingJobs: Map<string, PendingJob> = new Map();
  private nextJobId = 0;
  private isTerminated = false;

  constructor() {
    this.initWorker();
  }

  private initWorker(): void {
    try {
      this.worker = new Worker(
        new URL('./BoltSimulationWorker.ts', import.meta.url),
        { type: 'module' }
      );

      this.worker.onmessage = (event: MessageEvent<WorkerOutput | WorkerError>) => {
        const data = event.data;
        const job = this.pendingJobs.get(data.id);
        if (!job) return;

        this.pendingJobs.delete(data.id);

        if ('error' in data) {
          job.reject(new Error(data.error));
        } else {
          const elapsed = performance.now() - job.startTime;
          console.log(`[BoltWorkerPool] Simulation completed in ${elapsed.toFixed(0)}ms (worker time: ${data.elapsedMs.toFixed(0)}ms)`);
          job.resolve(data.result);
        }
      };

      this.worker.onerror = (event) => {
        console.error('[BoltWorkerPool] Worker error:', event);
        for (const job of this.pendingJobs.values()) {
          job.reject(new Error('Worker error: ' + event.message));
        }
        this.pendingJobs.clear();
      };

      console.log('[BoltWorkerPool] Worker initialized');
    } catch (e) {
      console.warn('[BoltWorkerPool] Failed to create worker, falling back to main thread:', e);
      this.worker = null;
    }
  }

  async simulateBolt(
    _position: Vec3,
    atmosphere: AtmosphericModel,
    resolution: number,
    seed?: number
  ): Promise<SimulationOutput> {
    if (this.isTerminated) {
      throw new Error('Worker pool is terminated');
    }

    const baseConfig = createConfig(DetailLevel.SHOWCASE);
    const config = createConfig(DetailLevel.SHOWCASE, {
      stepLength: baseConfig.stepLength / resolution,
      maxSteps: Math.round(baseConfig.maxSteps * resolution),
      candidateCount: Math.round(baseConfig.candidateCount * Math.sqrt(resolution)),
      maxSegments: Math.round(baseConfig.maxSegments * resolution),
    });

    const jobId = `job-${this.nextJobId++}`;
    const actualSeed = seed ?? Math.random() * 0xffffffff;

    const input: WorkerInput = {
      id: jobId,
      start: { x: 0, y: 0.5, z: 0 },
      end: { x: 0, y: -0.5, z: 0 },
      seed: actualSeed,
      config,
      atmosphereData: serializeAtmosphere(atmosphere),
    };

    if (!this.worker) {
      console.warn('[BoltWorkerPool] No worker available, running on main thread');
      const { simulateBolt } = await import('./BoltSimulator');
      return simulateBolt(
        { start: input.start, end: input.end, seed: input.seed, config: input.config },
        atmosphere
      );
    }

    return new Promise((resolve, reject) => {
      this.pendingJobs.set(jobId, {
        id: jobId,
        resolve,
        reject,
        startTime: performance.now(),
      });

      this.worker!.postMessage(input);
    });
  }

  hasPendingJobs(): boolean {
    return this.pendingJobs.size > 0;
  }

  terminate(): void {
    this.isTerminated = true;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    for (const job of this.pendingJobs.values()) {
      job.reject(new Error('Worker terminated'));
    }
    this.pendingJobs.clear();
  }
}
