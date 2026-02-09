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

function perturbDirection(dir: Vec3, amount: number, rng: SeededRNG, downwardBias: number = 0): Vec3 {
  const perturb: Vec3 = {
    x: (rng.next() - 0.5) * 2 * amount,
    y: (rng.next() - 0.5) * 2 * amount - downwardBias,
    z: (rng.next() - 0.5) * 2 * amount,
  };
  return normalize(add(dir, perturb));
}

interface BranchContext {
  segments: BoltSegment[];
  nextSegmentId: number;
}

function addBranchesRecursive(
  sourceSegments: BoltSegment[],
  ctx: BranchContext,
  config: SimulationConfig,
  rng: SeededRNG,
  depth: number,
): void {
  if (depth >= config.maxPostBranchDepth) return;

  const branchProb = config.postBranchProb * Math.pow(config.subBranchProbDecay, depth);
  const lengthMultiplier = Math.pow(config.subBranchLengthDecay, depth);
  const intensity = 0.7 * Math.pow(config.branchIntensityDecay, depth);
  const branchDepth = depth + 1;

  const newBranchRoots: BoltSegment[] = [];

  for (const seg of sourceSegments) {
    if (rng.next() > branchProb) continue;

    const mainDir = normalize(subtract(seg.end, seg.start));
    const angleRange = config.postBranchAngleMax - config.postBranchAngleMin;
    const angle = (config.postBranchAngleMin + rng.next() * angleRange) * Math.PI / 180;
    const sign = rng.next() < 0.5 ? 1 : -1;
    const branchDir = rotateAroundY(mainDir, angle * sign);

    let pos = seg.end;
    let dir = branchDir;
    // Exponential distribution for branch lengths (many short, few long)
    const u = rng.next();
    const lambda = 3;
    const t = -Math.log(1 - u * (1 - Math.exp(-lambda))) / lambda;
    const baseBranchLength = config.postBranchMinLength + t * (config.postBranchMaxLength - config.postBranchMinLength);
    const branchLength = Math.max(3, Math.floor(baseBranchLength * lengthMultiplier));
    let parentId: number = seg.id;
    let isFirstSegment = true;

    for (let i = 0; i < branchLength; i++) {
      const nextPos = add(pos, scale(dir, config.stepLength));
      const newSeg: BoltSegment = {
        id: ctx.nextSegmentId++,
        start: pos,
        end: nextPos,
        depth: branchDepth,
        parentSegmentId: parentId,
        stepIndex: seg.stepIndex + i + 1,
        intensity,
        isMainChannel: false,
      };
      ctx.segments.push(newSeg);

      if (isFirstSegment) {
        newBranchRoots.push(newSeg);
        isFirstSegment = false;
      }

      dir = perturbDirection(dir, 0.2, rng, config.branchDownwardBias);
      pos = nextPos;
      parentId = newSeg.id;
    }
  }

  if (newBranchRoots.length > 0) {
    addBranchesRecursive(newBranchRoots, ctx, config, rng, depth + 1);
  }
}

function addPostProcessBranches(
  segments: BoltSegment[],
  mainChannelIds: number[],
  config: SimulationConfig,
  rng: SeededRNG,
): void {
  const mainSegmentsSet = new Set(mainChannelIds);
  const mainSegments = segments.filter(s => mainSegmentsSet.has(s.id));

  const ctx: BranchContext = {
    segments,
    nextSegmentId: segments.length > 0 ? Math.max(...segments.map(s => s.id)) + 1 : 0,
  };

  addBranchesRecursive(mainSegments, ctx, config, rng, 0);
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

    // Create multiple jittered segments to ground (not one straight line)
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

      const seg: BoltSegment = {
        id: state.nextSegmentId++,
        start: pos,
        end: nextPos,
        depth: closest.depth,
        parentSegmentId: parentId,
        stepIndex: state.currentStep,
        intensity: closest.intensity,
        isMainChannel: false,
      };
      state.segments.push(seg);
      lastSegId = seg.id;
      parentId = seg.id;
      pos = nextPos;
    }

    connectionSegmentId = lastSegId;
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
