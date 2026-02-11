import {
  Vec3,
  BoltSegment,
  BoltGeometry,
  SimulationInput,
  SimulationOutput,
  SimulationStats,
  SimHead,
  SimSegment,
  DetailLevel,
} from './types';
import { createSeededRNG } from './prng';
import { createFieldContext, addChannelPoint } from './FieldComputation';
import { growthStep, GrowthState } from './GrowthStep';
import { createAtmosphericModel, AtmosphericModel } from './AtmosphericModel';

function segmentLength(seg: SimSegment): number {
  const dx = seg.end.x - seg.start.x;
  const dy = seg.end.y - seg.start.y;
  const dz = seg.end.z - seg.start.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function traceToMain(
  segId: number,
  byId: Map<number, SimSegment>,
  mainChannelIds: Set<number>,
): { distanceFromMain: number; branchPointId: number } {
  let distance = 0;
  let current = byId.get(segId);
  let branchPointId = segId;

  while (current && !mainChannelIds.has(current.id)) {
    distance += segmentLength(current);
    branchPointId = current.id;
    current = current.parentSegmentId !== null ? byId.get(current.parentSegmentId) : undefined;
  }

  return { distanceFromMain: distance, branchPointId };
}

function hasDescendantInSet(
  segId: number,
  targetSet: Set<number>,
  children: Map<number, number[]>,
  visited: Set<number> = new Set(),
): boolean {
  if (visited.has(segId)) return false;
  visited.add(segId);

  if (targetSet.has(segId)) return true;

  const kids = children.get(segId) || [];
  for (const kid of kids) {
    if (hasDescendantInSet(kid, targetSet, children, visited)) {
      return true;
    }
  }
  return false;
}

function assignDepthFromWinner(
  simSegments: SimSegment[],
  connectionSegmentId: number,
): BoltSegment[] {
  const byId = new Map<number, SimSegment>();
  const children = new Map<number, number[]>();

  for (const seg of simSegments) {
    byId.set(seg.id, seg);
    if (seg.parentSegmentId !== null) {
      const siblings = children.get(seg.parentSegmentId) || [];
      siblings.push(seg.id);
      children.set(seg.parentSegmentId, siblings);
    }
  }

  const mainChannelIds = new Set<number>();
  let current: number | null = connectionSegmentId;
  let mainChannelLength = 0;

  while (current !== null) {
    mainChannelIds.add(current);
    const segData: SimSegment = byId.get(current)!;
    mainChannelLength += segmentLength(segData);
    current = segData.parentSegmentId;
  }

  if (mainChannelLength === 0) mainChannelLength = 1;

  const result: BoltSegment[] = [];

  for (const seg of simSegments) {
    if (mainChannelIds.has(seg.id)) {
      result.push({
        ...seg,
        depth: 0,
        isMainChannel: true,
        distanceFromMain: 0,
        isDeadEnd: false,
      });
    } else {
      const { distanceFromMain } = traceToMain(seg.id, byId, mainChannelIds);
      const depth = Math.min(distanceFromMain / mainChannelLength, 2.0);
      const isDeadEnd = !hasDescendantInSet(seg.id, mainChannelIds, children);

      result.push({
        ...seg,
        depth,
        isMainChannel: false,
        distanceFromMain,
        isDeadEnd,
      });
    }
  }

  return result;
}

function computeBounds(segments: BoltSegment[]): { min: Vec3; max: Vec3 } {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };

  for (const seg of segments) {
    for (const p of [seg.start, seg.end]) {
      if (p.x < min.x) min.x = p.x;
      if (p.y < min.y) min.y = p.y;
      if (p.z < min.z) min.z = p.z;
      if (p.x > max.x) max.x = p.x;
      if (p.y > max.y) max.y = p.y;
      if (p.z > max.z) max.z = p.z;
    }
  }

  return { min, max };
}

function createInitialHeads(
  atmosphere: AtmosphericModel,
  target: Vec3,
  rng: { next(): number }
): SimHead[] {
  const heads: SimHead[] = [];
  const startingPoints = atmosphere.startingPoints;

  // Use at least 1, at most 4 starting points
  const maxLeaders = Math.min(4, startingPoints.length);
  const numLeaders = Math.max(1, maxLeaders);

  for (let i = 0; i < numLeaders; i++) {
    const pos = startingPoints[i] ?? { x: 0, y: atmosphere.ceilingY, z: 0 };

    // Direction toward ground target with slight randomization
    const dx = target.x - pos.x + (rng.next() - 0.5) * 0.1;
    const dy = target.y - pos.y;
    const dz = target.z - pos.z + (rng.next() - 0.5) * 0.1;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);

    const direction: Vec3 = {
      x: dx / len,
      y: dy / len,
      z: dz / len,
    };

    heads.push({
      id: i,
      position: { ...pos },
      direction,
      parentSegmentId: null,
      stepIndex: 0,
      age: 0,
      isFromBranch: false,
      generation: 0,
    });
  }

  return heads;
}

export function simulateBolt(input: SimulationInput): SimulationOutput {
  const t0 = performance.now();
  const { start, end, seed, config } = input;

  const rng = createSeededRNG(seed);
  const fieldConfig = {
    ...config.fieldConfig,
    noiseSeed: config.fieldConfig.noiseSeed || seed,
  };

  const useSpatialGrid = config.detailLevel === DetailLevel.SHOWCASE;

  // Create atmospheric model with ceiling and ground charge distribution
  const atmoRng = rng.fork();
  const atmosphere = createAtmosphericModel(atmoRng, start.y, end.y);

  // Pass atmosphere to field context for ground charge influence
  const fieldCtx = createFieldContext(end.y, fieldConfig, useSpatialGrid, atmosphere);

  // Spawn initial heads from ceiling charge peaks (multi-leader)
  const initialHeads = createInitialHeads(atmosphere, end, rng);

  // Add all starting points to field context
  for (const head of initialHeads) {
    addChannelPoint(fieldCtx, head.position);
  }

  console.log(`[Simulation] Spawning ${initialHeads.length} leaders from charge peaks`);

  const state: GrowthState = {
    activeHeads: initialHeads,
    segments: [],
    fieldCtx,
    nextHeadId: initialHeads.length,
    nextSegmentId: 0,
    currentStep: 0,
    rng,
    groundY: end.y,
    atmosphere,
  };

  let didConnect = false;
  let connectionSegmentId: number | null = null;

  for (let step = 0; step < config.maxSteps; step++) {
    if (state.activeHeads.length === 0) break;

    const result = growthStep(state, config);

    if (result.connected && !didConnect) {
      didConnect = true;
      connectionSegmentId = result.connectionSegmentId;
    }

    if (result.terminated) break;
  }

  if (!didConnect && state.segments.length > 0) {
    let closestId = 0;
    let closestDist = Infinity;

    for (const seg of state.segments) {
      const dist = Math.abs(seg.end.y - end.y);
      if (dist < closestDist) {
        closestDist = dist;
        closestId = seg.id;
      }
    }

    const closest = state.segments.find((s) => s.id === closestId)!;
    const distToGround = closest.end.y - end.y;
    const numSteps = Math.max(1, Math.ceil(distToGround / config.stepLength));
    const stepY = distToGround / numSteps;
    const jitterAmount = config.stepLength * 1.5;

    let pos = { ...closest.end };
    let parentId = closestId;
    let lastSegId = closestId;

    for (let i = 0; i < numSteps; i++) {
      const isLast = i === numSteps - 1;
      const nextY = isLast ? end.y : pos.y - stepY;
      const nextPos = {
        x: pos.x + (rng.next() - 0.5) * jitterAmount,
        y: nextY,
        z: pos.z + (rng.next() - 0.5) * jitterAmount,
      };

      const seg: SimSegment = {
        id: state.nextSegmentId++,
        start: pos,
        end: nextPos,
        parentSegmentId: parentId,
        stepIndex: state.currentStep,
        intensity: closest.intensity,
      };
      state.segments.push(seg);
      lastSegId = seg.id;
      parentId = seg.id;
      pos = nextPos;
    }

    connectionSegmentId = lastSegId;
    didConnect = true;
  }

  const finalSegments = connectionSegmentId !== null
    ? assignDepthFromWinner(state.segments, connectionSegmentId)
    : state.segments.map(seg => ({
        ...seg,
        depth: 0,
        isMainChannel: false,
        distanceFromMain: 0,
        isDeadEnd: true,
      }));

  const mainChannelIds = finalSegments
    .filter(s => s.isMainChannel)
    .map(s => s.id);

  let maxIntensity = 0;
  for (const seg of finalSegments) {
    if (seg.intensity > maxIntensity) maxIntensity = seg.intensity;
  }
  if (maxIntensity > 0) {
    for (const seg of finalSegments) {
      seg.intensity /= maxIntensity;
    }
  }

  let maxDepth = 0;
  let branchCount = 0;
  let maxStepIndex = state.currentStep;
  for (const seg of finalSegments) {
    if (seg.depth > maxDepth) maxDepth = seg.depth;
    if (!seg.isMainChannel) branchCount++;
    if (seg.stepIndex > maxStepIndex) maxStepIndex = seg.stepIndex;
  }

  const geometry: BoltGeometry = {
    segments: finalSegments,
    mainChannelIds,
    totalSteps: maxStepIndex,
    connectionStep: state.currentStep,
    bounds: computeBounds(finalSegments),
  };

  const stats: SimulationStats = {
    totalSteps: state.currentStep,
    segmentCount: finalSegments.length,
    branchCount,
    maxDepth,
    connected: didConnect,
    elapsedMs: performance.now() - t0,
  };

  // Analyze when branches were created (by stepIndex)
  const branchSegments = finalSegments.filter(s => !s.isMainChannel);
  const stepBuckets: Record<string, number> = {};
  for (const seg of branchSegments) {
    const bucket = Math.floor(seg.stepIndex / 10) * 10; // Group by 10s
    const key = `${bucket}-${bucket + 9}`;
    stepBuckets[key] = (stepBuckets[key] || 0) + 1;
  }
  console.log('[Simulation] Branch segments by step range:', stepBuckets);
  console.log(`[Simulation] Total: ${finalSegments.length} segs, ${branchSegments.length} branch segs, ${state.currentStep} steps`);

  // Serialize atmosphere data for visualization
  const atmosphereData = {
    ceilingCharge: {
      cells: atmosphere.ceilingCharge.cells.map(c => ({
        center: c.center,
        intensity: c.intensity,
        falloffRadius: c.falloffRadius,
      })),
      is2D: true,
      fixedY: atmosphere.ceilingY,
    },
    groundCharge: {
      cells: atmosphere.groundCharge.cells.map(c => ({
        center: c.center,
        intensity: c.intensity,
        falloffRadius: c.falloffRadius,
      })),
      is2D: true,
      fixedY: atmosphere.groundY,
    },
    atmosphericCharge: {
      cells: atmosphere.atmosphericCharge.cells.map(c => ({
        center: c.center,
        intensity: c.intensity,
        falloffRadius: c.falloffRadius,
      })),
      is2D: false,
      fixedY: 0,
    },
    moisture: {
      cells: atmosphere.moisture.cells.map(c => ({
        center: c.center,
        intensity: c.intensity,
        falloffRadius: c.falloffRadius,
      })),
      is2D: false,
      fixedY: 0,
    },
    ionizationSeeds: {
      cells: atmosphere.ionizationSeeds.cells.map(c => ({
        center: c.center,
        intensity: c.intensity,
        falloffRadius: c.falloffRadius,
      })),
      is2D: false,
      fixedY: 0,
    },
    ceilingY: atmosphere.ceilingY,
    groundY: atmosphere.groundY,
  };

  return { geometry, stats, atmosphere: atmosphereData };
}
