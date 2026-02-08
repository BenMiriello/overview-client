import {
  Vec3,
  BoltSegment,
  BoltGeometry,
  SimulationInput,
  SimulationOutput,
  SimulationStats,
  SimulationConfig,
  GrowthHead,
  DetailLevel,
} from './types';
import { createSeededRNG, SeededRNG } from './prng';
import { createFieldContext, addChannelPoint } from './FieldComputation';
import { growthStep, GrowthState } from './GrowthStep';

function traceMainChannel(
  segments: BoltSegment[],
  connectionSegmentId: number,
): number[] {
  const byId = new Map<number, BoltSegment>();
  for (const seg of segments) byId.set(seg.id, seg);

  const path: number[] = [];
  let current: BoltSegment | undefined = byId.get(connectionSegmentId);

  while (current) {
    path.push(current.id);
    current.isMainChannel = true;
    if (current.parentSegmentId === null) break;
    current = byId.get(current.parentSegmentId);
  }

  path.reverse();
  return path;
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

function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len === 0) return { x: 0, y: -1, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function rotateAroundY(dir: Vec3, angle: number): Vec3 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: dir.x * cos + dir.z * sin,
    y: dir.y,
    z: -dir.x * sin + dir.z * cos,
  };
}

function perturbDirection(dir: Vec3, amount: number, rng: SeededRNG): Vec3 {
  const perturb: Vec3 = {
    x: (rng.next() - 0.5) * 2 * amount,
    y: (rng.next() - 0.5) * 2 * amount,
    z: (rng.next() - 0.5) * 2 * amount,
  };
  return normalize(add(dir, perturb));
}

function addPostProcessBranches(
  segments: BoltSegment[],
  mainChannelIds: number[],
  config: SimulationConfig,
  rng: SeededRNG,
): void {
  const mainSegmentsSet = new Set(mainChannelIds);
  const mainSegments = segments.filter(s => mainSegmentsSet.has(s.id));

  let nextSegmentId = segments.length > 0 ? Math.max(...segments.map(s => s.id)) + 1 : 0;

  for (const seg of mainSegments) {
    if (rng.next() > config.postBranchProb) continue;

    const mainDir = normalize(subtract(seg.end, seg.start));
    const angleRange = config.postBranchAngleMax - config.postBranchAngleMin;
    const angle = (config.postBranchAngleMin + rng.next() * angleRange) * Math.PI / 180;
    const sign = rng.next() < 0.5 ? 1 : -1;
    const branchDir = rotateAroundY(mainDir, angle * sign);

    let pos = seg.end;
    let dir = branchDir;
    const branchLengthRange = config.postBranchMaxLength - config.postBranchMinLength;
    const branchLength = config.postBranchMinLength + Math.floor(rng.next() * branchLengthRange);
    let parentId: number = seg.id;

    for (let i = 0; i < branchLength; i++) {
      const nextPos = add(pos, scale(dir, config.stepLength));
      const newSeg: BoltSegment = {
        id: nextSegmentId++,
        start: pos,
        end: nextPos,
        depth: 1,
        parentSegmentId: parentId,
        stepIndex: seg.stepIndex,
        intensity: 0.7,
        isMainChannel: false,
      };
      segments.push(newSeg);

      dir = perturbDirection(dir, 0.2, rng);
      pos = nextPos;
      parentId = newSeg.id;
    }
  }
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
  const fieldCtx = createFieldContext(end.y, fieldConfig, useSpatialGrid);

  // Seed the field with the start point
  addChannelPoint(fieldCtx, start);

  const initialDirection: Vec3 = {
    x: end.x - start.x,
    y: end.y - start.y,
    z: end.z - start.z,
  };
  const dirLen = Math.sqrt(
    initialDirection.x ** 2 + initialDirection.y ** 2 + initialDirection.z ** 2,
  );
  const normDir: Vec3 = {
    x: initialDirection.x / dirLen,
    y: initialDirection.y / dirLen,
    z: initialDirection.z / dirLen,
  };

  const initialHead: GrowthHead = {
    id: 0,
    position: start,
    direction: normDir,
    depth: 0,
    parentSegmentId: null,
    stepIndex: 0,
  };

  const state: GrowthState = {
    activeHeads: [initialHead],
    segments: [],
    fieldCtx,
    nextHeadId: 1,
    nextSegmentId: 0,
    currentStep: 0,
    rng,
    groundY: end.y,
  };

  let didConnect = false;
  let connectionSegmentId: number | null = null;

  for (let step = 0; step < config.maxSteps; step++) {
    if (state.activeHeads.length === 0) break;

    const result = growthStep(state, config);

    // Record first connection but don't stop - let branches continue growing
    if (result.connected && !didConnect) {
      didConnect = true;
      connectionSegmentId = result.connectionSegmentId;
    }

    if (result.terminated) break;
  }

  // If didn't connect, find the segment closest to ground and force connection
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

    // Add a final segment to ground
    const closest = state.segments.find((s) => s.id === closestId)!;
    const finalSeg: BoltSegment = {
      id: state.nextSegmentId++,
      start: closest.end,
      end: { x: closest.end.x, y: end.y, z: closest.end.z },
      depth: closest.depth,
      parentSegmentId: closestId,
      stepIndex: state.currentStep,
      intensity: closest.intensity,
      isMainChannel: false,
    };
    state.segments.push(finalSeg);
    connectionSegmentId = finalSeg.id;
    didConnect = true;
  }

  // Trace main channel
  const mainChannelIds = connectionSegmentId !== null
    ? traceMainChannel(state.segments, connectionSegmentId)
    : [];

  // Add branches via post-processing
  if (mainChannelIds.length > 0) {
    addPostProcessBranches(state.segments, mainChannelIds, config, rng);
  }

  // Normalize intensities to [0, 1]
  let maxIntensity = 0;
  for (const seg of state.segments) {
    if (seg.intensity > maxIntensity) maxIntensity = seg.intensity;
  }
  if (maxIntensity > 0) {
    for (const seg of state.segments) {
      seg.intensity /= maxIntensity;
    }
  }

  let maxDepth = 0;
  let branchCount = 0;
  for (const seg of state.segments) {
    if (seg.depth > maxDepth) maxDepth = seg.depth;
    if (seg.depth > 0) branchCount++;
  }

  const geometry: BoltGeometry = {
    segments: state.segments,
    mainChannelIds,
    totalSteps: state.currentStep,
    connectionStep: state.currentStep,
    bounds: computeBounds(state.segments),
  };

  const stats: SimulationStats = {
    totalSteps: state.currentStep,
    segmentCount: state.segments.length,
    branchCount,
    maxDepth,
    connected: didConnect,
    elapsedMs: performance.now() - t0,
  };

  return { geometry, stats };
}
