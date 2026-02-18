import { BoltWorkerPool } from './BoltWorkerPool';
import { AtmosphericModel } from './AtmosphericModel';
import {
  Vec3,
  SimulationOutput,
} from './types';

export interface PrecomputedBolt {
  result: SimulationOutput;
  position: Vec3;
  seed: number;
  timestamp: number;
}

export class BoltPrecomputer {
  private workerPool: BoltWorkerPool;
  private cachedBolt: PrecomputedBolt | null = null;
  private isComputing = false;
  private abortController: AbortController | null = null;

  constructor() {
    this.workerPool = new BoltWorkerPool();
  }

  /**
   * Start pre-computing a bolt for the given position and atmosphere.
   * Runs in a Web Worker so it doesn't block the main thread.
   */
  startPrecompute(
    position: Vec3,
    atmosphere: AtmosphericModel,
    resolution: number
  ): void {
    if (this.isComputing) {
      return;
    }

    this.isComputing = true;
    this.abortController = new AbortController();
    const seed = Math.random() * 0xffffffff;

    this.workerPool.simulateBolt(position, atmosphere, resolution, seed)
      .then((result) => {
        if (this.abortController?.signal.aborted) return;

        this.cachedBolt = {
          result,
          position,
          seed,
          timestamp: performance.now(),
        };
        console.log('[BoltPrecomputer] Pre-computed bolt ready');
      })
      .catch((e) => {
        if (this.abortController?.signal.aborted) return;
        console.error('[BoltPrecomputer] Pre-computation failed:', e);
      })
      .finally(() => {
        this.isComputing = false;
        this.abortController = null;
      });
  }

  /**
   * Check if a pre-computed bolt is available.
   */
  hasCachedBolt(): boolean {
    return this.cachedBolt !== null;
  }

  /**
   * Get the cached bolt if available and compatible with the breakdown position.
   */
  getCachedBolt(breakdownPosition: Vec3, maxDistance: number = 0.3): PrecomputedBolt | null {
    if (!this.cachedBolt) return null;

    const dx = this.cachedBolt.position.x - breakdownPosition.x;
    const dz = this.cachedBolt.position.z - breakdownPosition.z;
    const distance = Math.sqrt(dx * dx + dz * dz);

    if (distance > maxDistance) {
      return null;
    }

    const bolt = this.cachedBolt;
    this.cachedBolt = null;
    return bolt;
  }

  /**
   * Force get the cached bolt regardless of position.
   */
  consumeCachedBolt(): PrecomputedBolt | null {
    const bolt = this.cachedBolt;
    this.cachedBolt = null;
    return bolt;
  }

  /**
   * Cancel any pending pre-computation.
   */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.isComputing = false;
  }

  /**
   * Clear both pending computation and cached result.
   */
  clear(): void {
    this.cancel();
    this.cachedBolt = null;
    this.workerPool.terminate();
  }

  /**
   * Check if currently computing.
   */
  isBusy(): boolean {
    return this.isComputing;
  }
}
