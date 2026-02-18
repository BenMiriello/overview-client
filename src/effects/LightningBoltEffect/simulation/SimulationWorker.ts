/**
 * SimulationWorker - Runs the full simulation ahead of visual time.
 *
 * This worker:
 * 1. Runs AtmosphereSimulator continuously
 * 2. Detects breakdown events
 * 3. Computes bolt geometry SYNCHRONOUSLY (atmosphere + strikes are causally linked)
 * 4. Applies post-strike effects (ionization, charge dissipation)
 * 5. Streams snapshots and events to main thread via postMessage
 *
 * Main thread NEVER runs simulation logic - only plays back pre-computed data.
 *
 * ARCHITECTURE: Everything runs in sequence because:
 * - Strike path depends on current atmosphere state
 * - Strike affects atmosphere (ionization, charge dissipation)
 * - These are deterministic and must stay in sync
 */

import { AtmosphereSimulator } from './AtmosphereSimulator';
import { simulateBolt } from './BoltSimulator';
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
import { DetailLevel, Vec3, VoronoiFieldData } from './types';

let simulator: AtmosphereSimulator | null = null;
let config: TimelineConfig = { ...DEFAULT_TIMELINE_CONFIG };
let simTimeMs = 0;
let isRunning = false;
let lastSnapshotTimeMs = 0;
let strikeCooldownUntilMs = 0;
let visualTimeMs = 0;  // Tracked from main thread for pacing

const STRIKE_COOLDOWN_MS = 500;
const SNAPSHOT_INTERVAL_MS = 33;  // ~30fps snapshots for smooth animation
const SIM_STEP_MS = 16;
const MAX_LEAD_MS = 45000;  // Don't compute more than 45 seconds ahead

// Adaptive charge rate thresholds
// When buffer is low, we slow charge accumulation so strikes happen less frequently
// This gives time to build buffer before the next strike blocks the worker
const MIN_LEAD_FOR_NORMAL_CHARGE_MS = 15000;  // Below this, start slowing charge
const CRITICAL_LEAD_MS = 5000;  // Below this, charge very slowly
const BASE_CHARGE_RATE = 0.15;  // Normal charge accumulation rate

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
 * Compute strike synchronously and return the event.
 * This blocks the simulation loop during computation - that's intentional
 * because strikes and atmosphere are causally linked.
 */
function computeStrike(breakdownPosition: Vec3): StrikeEvent | null {
  if (!simulator) return null;

  const t0 = performance.now();
  const seed = Math.random() * 0xffffffff;

  // Get current atmosphere model
  const atmosphere = simulator.getAtmosphericModel();

  // Create config based on detail level
  const baseConfig = createConfig(DetailLevel.SHOWCASE);
  const simConfig = createConfig(DetailLevel.SHOWCASE, {
    stepLength: baseConfig.stepLength / config.detail,
    maxSteps: Math.round(baseConfig.maxSteps * config.detail),
    candidateCount: Math.round(
      baseConfig.candidateCount * Math.sqrt(config.detail)
    ),
    maxSegments: Math.round(baseConfig.maxSegments * config.detail),
  });

  // Run bolt simulation
  const result = simulateBolt(
    {
      start: breakdownPosition,
      end: { x: breakdownPosition.x * 0.3, y: -0.5, z: breakdownPosition.z * 0.3 },
      seed,
      config: simConfig,
    },
    atmosphere
  );

  const computeTimeMs = performance.now() - t0;
  console.log(`[Worker] Strike computed in ${computeTimeMs.toFixed(0)}ms`);

  // Extract ionization path from main channel
  const ionizationPath: Vec3[] = result.geometry.segments
    .filter((s) => s.isMainChannel)
    .map((s) => ({ ...s.end }));

  return {
    simTimeMs,
    breakdownPosition,
    geometry: result.geometry,
    seed,
    ionizationPath,
    dissipationRegion: {
      center: breakdownPosition,
      radius: 0.2,
    },
  };
}

function applyPostStrikeEffects(strike: StrikeEvent): void {
  if (!simulator) return;
  simulator.onStrikeComplete(strike.breakdownPosition, strike.dissipationRegion.radius);
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

  // ADAPTIVE CHARGE RATE: When buffer is low, slow charge accumulation
  // This delays breakdown, giving time to build buffer before next strike blocks
  let chargeRate = BASE_CHARGE_RATE;
  if (leadTime < CRITICAL_LEAD_MS) {
    // Very low buffer - barely any charge buildup (10% of normal)
    chargeRate = BASE_CHARGE_RATE * 0.1;
  } else if (leadTime < MIN_LEAD_FOR_NORMAL_CHARGE_MS) {
    // Low buffer - interpolate between 10% and 100%
    const t = (leadTime - CRITICAL_LEAD_MS) / (MIN_LEAD_FOR_NORMAL_CHARGE_MS - CRITICAL_LEAD_MS);
    chargeRate = BASE_CHARGE_RATE * (0.1 + 0.9 * t);
  }
  simulator.setChargeAccumulationRate(chargeRate);

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

  // Handle breakdown -> compute strike SYNCHRONOUSLY
  // This blocks but maintains causal consistency
  if (breakdownEvent && simTimeMs >= strikeCooldownUntilMs) {
    const strike = computeStrike(breakdownEvent.position);
    if (strike) {
      // Send strike event to main thread
      const msg: WorkerOutMessage = { type: 'strike', event: strike };
      self.postMessage(msg);

      // Apply post-strike effects (ionization, charge dissipation)
      applyPostStrikeEffects(strike);

      strikeCooldownUntilMs = simTimeMs + STRIKE_COOLDOWN_MS;
    }
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
