/**
 * SimulationWorker - Runs the full simulation ahead of visual time.
 *
 * This worker:
 * 1. Runs AtmosphereSimulator continuously
 * 2. Detects breakdown events
 * 3. Applies post-strike effects IMMEDIATELY (doesn't need geometry)
 * 4. Sends atmosphere snapshot to BoltSimulationWorker for ASYNC geometry computation
 * 5. Streams snapshots and events to main thread via postMessage
 *
 * Main thread NEVER runs simulation logic - only plays back pre-computed data.
 *
 * ARCHITECTURE: Geometry computation is decoupled because:
 * - onStrikeComplete() only needs position + radius, NOT geometry
 * - Geometry is a leaf node - it's only used for rendering, never feeds back
 * - This allows simulation to continue while 30-second bolt computations run
 */

import { AtmosphereSimulator } from './AtmosphereSimulator';
import { createConfig } from './config';
import { VoronoiField } from './VoronoiField';
import {
  WorkerInMessage,
  WorkerOutMessage,
  TimelineConfig,
  AtmosphereSnapshot,
  StrikeEvent,
  DEFAULT_TIMELINE_CONFIG,
} from './SimulationTimeline';
import { DetailLevel, Vec3, VoronoiFieldData, AtmosphericModelData, SimulationConfig } from './types';
import { WorkerInput, WorkerOutput } from './BoltSimulationWorker';

let simulator: AtmosphereSimulator | null = null;
let config: TimelineConfig = { ...DEFAULT_TIMELINE_CONFIG };
let simTimeMs = 0;
let isRunning = false;
let lastSnapshotTimeMs = 0;
let strikeCooldownUntilMs = 0;
let visualTimeMs = 0;  // Tracked from main thread for pacing

// Bolt geometry worker for async computation
let boltWorker: Worker | null = null;
const pendingStrikes = new Map<string, { simTimeMs: number; position: Vec3 }>();
let strikeIdCounter = 0;

const STRIKE_COOLDOWN_MS = 3000;
const SNAPSHOT_INTERVAL_MS = 33;  // ~30fps snapshots for smooth animation
const SIM_STEP_MS = 16;
const MAX_LEAD_MS = 45000;  // Don't compute more than 45 seconds ahead


function fieldToData(field: VoronoiField): VoronoiFieldData {
  const fieldConfig = field.getConfig();
  return {
    cells: field.cells.map((cell) => ({
      center: { ...cell.center },
      intensity: cell.intensity,
      falloffRadius: cell.falloffRadius,
    })),
    is2D: fieldConfig.is2D,
    fixedY: fieldConfig.fixedY,
  };
}

function createSnapshot(): AtmosphereSnapshot {
  if (!simulator) throw new Error('Simulator not initialized');

  return {
    simTimeMs,
    ceilingCharge: fieldToData(simulator.ceilingCharge),
    groundCharge: fieldToData(simulator.groundCharge),
    atmosphericCharge: fieldToData(simulator.atmosphericCharge),
    moisture: fieldToData(simulator.moisture),
    ionizationSeeds: fieldToData(simulator.ionizationSeeds),
    ceilingY: 0.5,
    groundY: -0.5,
  };
}

/**
 * Serialize atmosphere state for sending to bolt worker.
 */
function serializeAtmosphere(): AtmosphericModelData & { startingPoints: Vec3[]; ceilingY: number; groundY: number } {
  if (!simulator) throw new Error('Simulator not initialized');
  const model = simulator.getAtmosphericModel();
  return {
    ceilingCharge: fieldToData(model.ceilingCharge),
    groundCharge: fieldToData(model.groundCharge),
    atmosphericCharge: fieldToData(model.atmosphericCharge),
    moisture: fieldToData(model.moisture),
    ionizationSeeds: fieldToData(model.ionizationSeeds),
    startingPoints: model.startingPoints,
    ceilingY: model.ceilingY,
    groundY: model.groundY,
  };
}

/**
 * Get simulation config based on detail level.
 */
function getSimConfig(): SimulationConfig {
  const baseConfig = createConfig(DetailLevel.SHOWCASE);
  return createConfig(DetailLevel.SHOWCASE, {
    stepLength: baseConfig.stepLength / config.detail,
    maxSteps: Math.round(baseConfig.maxSteps * config.detail),
    candidateCount: Math.round(baseConfig.candidateCount * Math.sqrt(config.detail)),
    maxSegments: Math.round(baseConfig.maxSegments * config.detail),
  });
}

/**
 * Start async geometry computation for a breakdown.
 * This captures atmosphere state BEFORE applying effects, then applies effects immediately.
 * Geometry computation runs in parallel without blocking the simulation loop.
 */
function handleBreakdown(breakdownPosition: Vec3): void {
  if (!simulator || !boltWorker) return;

  const id = `strike-${strikeIdCounter++}`;
  const seed = Math.random() * 0xffffffff;

  // 1. Capture atmosphere snapshot BEFORE applying effects
  const atmosphereData = serializeAtmosphere();

  // 2. Apply post-strike effects IMMEDIATELY (doesn't need geometry)
  simulator.onStrikeComplete(breakdownPosition, 0.7);

  // 3. Track pending strike
  pendingStrikes.set(id, { simTimeMs, position: breakdownPosition });

  // 4. Send to geometry worker (ASYNC)
  const workerInput: WorkerInput = {
    id,
    start: breakdownPosition,
    end: { x: breakdownPosition.x * 0.3, y: -0.5, z: breakdownPosition.z * 0.3 },
    seed,
    config: getSimConfig(),
    atmosphereData,
  };
  boltWorker.postMessage(workerInput);

  console.log(`[Worker] Breakdown at simTime=${simTimeMs.toFixed(0)}ms, sent to bolt worker (id=${id})`);
}

/**
 * Handle completed geometry from bolt worker.
 */
function handleBoltResult(event: MessageEvent<WorkerOutput>): void {
  const { id, result, elapsedMs } = event.data;
  const pending = pendingStrikes.get(id);
  if (!pending) {
    console.warn(`[Worker] Received result for unknown strike ${id}`);
    return;
  }
  pendingStrikes.delete(id);

  console.log(`[Worker] Strike geometry computed in ${elapsedMs.toFixed(0)}ms (id=${id})`);

  // Extract ionization path from main channel
  const ionizationPath: Vec3[] = result.geometry.segments
    .filter((s) => s.isMainChannel)
    .map((s) => ({ ...s.end }));

  const strike: StrikeEvent = {
    simTimeMs: pending.simTimeMs,
    breakdownPosition: pending.position,
    geometry: result.geometry,
    seed: 0,
    ionizationPath,
    dissipationRegion: {
      center: pending.position,
      radius: 0.2,
    },
  };

  // Send to main thread
  const msg: WorkerOutMessage = { type: 'strike', event: strike, computeTimeMs: elapsedMs };
  self.postMessage(msg);
}

function simulationStep(): void {
  if (!simulator || !isRunning) return;

  // Pacing: pause if too far ahead of visual time
  const leadTime = simTimeMs - visualTimeMs;
  if (leadTime > MAX_LEAD_MS) {
    // Wait and check again later
    setTimeout(simulationStep, 100);
    return;
  }

  // Use config charge rate directly -- geometry is async so charge
  // accumulation no longer needs to be throttled for buffer safety
  simulator.setChargeAccumulationRate(config.chargeAccumulationRate);

  const dtSec = (SIM_STEP_MS / 1000) * config.speed;

  // Run atmosphere simulation step
  const breakdownEvent = simulator.update(dtSec);

  simTimeMs += SIM_STEP_MS * config.speed;

  // Emit snapshot at regular intervals
  if (simTimeMs - lastSnapshotTimeMs >= SNAPSHOT_INTERVAL_MS) {
    const snapshot = createSnapshot();
    const msg: WorkerOutMessage = { type: 'snapshot', snapshot };
    self.postMessage(msg);
    lastSnapshotTimeMs = simTimeMs;
  }

  // Handle breakdown -> send to bolt worker ASYNCHRONOUSLY
  // Post-strike effects are applied immediately; geometry is computed in parallel
  if (breakdownEvent && simTimeMs >= strikeCooldownUntilMs) {
    handleBreakdown(breakdownEvent.position);
    strikeCooldownUntilMs = simTimeMs + STRIKE_COOLDOWN_MS;
  }

  // Schedule next step - run at max speed until MAX_LEAD reached
  // No gradual slowdown; pacing is handled by pausing at MAX_LEAD check above
  if (isRunning) {
    setTimeout(simulationStep, 0);
  }
}

function startSimulation(seed: number, newConfig: TimelineConfig): void {
  config = { ...DEFAULT_TIMELINE_CONFIG, ...newConfig };
  simTimeMs = 0;
  lastSnapshotTimeMs = 0;
  strikeCooldownUntilMs = 0;
  strikeIdCounter = 0;
  pendingStrikes.clear();

  // Spawn bolt geometry worker
  if (boltWorker) {
    boltWorker.terminate();
  }
  boltWorker = new Worker(new URL('./BoltSimulationWorker.ts', import.meta.url), { type: 'module' });
  boltWorker.onmessage = handleBoltResult;
  boltWorker.onerror = (e) => console.error('[Worker] Bolt worker error:', e);

  simulator = new AtmosphereSimulator(seed, {
    chargeAccumulationRate: config.chargeAccumulationRate,
    breakdownThreshold: config.breakdownThreshold,
    baseWindSpeed: config.baseWindSpeed,
    windDirection: config.windDirection,
    upperWindDirection: config.upperWindDirection,
  });

  isRunning = true;

  // Emit initial snapshot immediately
  const snapshot = createSnapshot();
  const msg: WorkerOutMessage = { type: 'snapshot', snapshot };
  self.postMessage(msg);
  lastSnapshotTimeMs = simTimeMs;

  // Start simulation loop
  simulationStep();
}

function updateParameters(
  newConfig: Partial<TimelineConfig>,
  _applyAtSimTimeMs: number
): void {
  config = { ...config, ...newConfig };

  if (simulator) {
    if (newConfig.baseWindSpeed !== undefined) {
      simulator.setWindSpeed(newConfig.baseWindSpeed);
      console.log(`[Worker] Wind speed updated to ${newConfig.baseWindSpeed}`);
    }
  }
}

function stopSimulation(): void {
  isRunning = false;
  simulator = null;
  if (boltWorker) {
    boltWorker.terminate();
    boltWorker = null;
  }
  pendingStrikes.clear();
}

// Message handler
self.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;

  switch (msg.type) {
    case 'start':
      startSimulation(msg.seed, msg.config);
      break;

    case 'set_parameters':
      updateParameters(msg.config, msg.applyAtSimTimeMs);
      break;

    case 'pace':
      // Update visual time for pacing calculations
      visualTimeMs = msg.visualTimeMs;
      break;

    case 'stop':
      stopSimulation();
      break;
  }
};

// Export types for use by worker pool
export type { WorkerInMessage, WorkerOutMessage };
