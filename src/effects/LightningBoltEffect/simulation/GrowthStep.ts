import {
  Vec3,
  SimulationConfig,
  GrowthHead,
  BoltSegment,
  Candidate,
} from './types';
import { SeededRNG } from './prng';
import { computeFieldAtPoint, FieldContext, addChannelPoint } from './FieldComputation';
import { computeDBMProbabilities, selectForHead } from './BranchSelection';

export interface GrowthState {
  activeHeads: GrowthHead[];
  segments: BoltSegment[];
  fieldCtx: FieldContext;
  nextHeadId: number;
  nextSegmentId: number;
  currentStep: number;
  rng: SeededRNG;
  groundY: number;
}

export interface StepResult {
  connected: boolean;
  terminated: boolean;
  connectionSegmentId: number | null;
}

function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len === 0) return { x: 0, y: -1, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function computePerpendicular(dir: Vec3, rng: SeededRNG): Vec3 {
  let up: Vec3;
  if (Math.abs(dir.y) < 0.9) {
    up = { x: 0, y: 1, z: 0 };
  } else {
    up = { x: 1, y: 0, z: 0 };
  }
  // Cross product: dir x up
  const perpX = dir.y * up.z - dir.z * up.y;
  const perpY = dir.z * up.x - dir.x * up.z;
  const perpZ = dir.x * up.y - dir.y * up.x;
  const perp = normalize({ x: perpX, y: perpY, z: perpZ });

  // Rotate the perpendicular by a random angle around dir
  const angle = rng.next() * Math.PI * 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // bitangent = dir x perp
  const bx = dir.y * perp.z - dir.z * perp.y;
  const by = dir.z * perp.x - dir.x * perp.z;
  const bz = dir.x * perp.y - dir.y * perp.x;

  return {
    x: perp.x * cos + bx * sin,
    y: perp.y * cos + by * sin,
    z: perp.z * cos + bz * sin,
  };
}

function generateCandidateDirections(
  currentDir: Vec3,
  count: number,
  coneHalfAngle: number,
  rng: SeededRNG,
): Vec3[] {
  const directions: Vec3[] = [];
  const dir = normalize(currentDir);

  // Build orthonormal basis around current direction
  let up: Vec3;
  if (Math.abs(dir.y) < 0.9) {
    up = { x: 0, y: 1, z: 0 };
  } else {
    up = { x: 1, y: 0, z: 0 };
  }

  // tangent = dir x up
  const tx = dir.y * up.z - dir.z * up.y;
  const ty = dir.z * up.x - dir.x * up.z;
  const tz = dir.x * up.y - dir.y * up.x;
  const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz);
  const t = { x: tx / tLen, y: ty / tLen, z: tz / tLen };

  // bitangent = dir x tangent
  const bx = dir.y * t.z - dir.z * t.y;
  const by = dir.z * t.x - dir.x * t.z;
  const bz = dir.x * t.y - dir.y * t.x;
  const b = { x: bx, y: by, z: bz };

  for (let i = 0; i < count; i++) {
    const theta = rng.next() * coneHalfAngle;
    const phi = rng.next() * Math.PI * 2;

    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);

    // Rotate around cone axis
    const x = dir.x * cosTheta + t.x * sinTheta * cosPhi + b.x * sinTheta * sinPhi;
    const y = dir.y * cosTheta + t.y * sinTheta * cosPhi + b.y * sinTheta * sinPhi;
    const z = dir.z * cosTheta + t.z * sinTheta * cosPhi + b.z * sinTheta * sinPhi;

    directions.push(normalize({ x, y, z }));
  }

  return directions;
}

export function growthStep(state: GrowthState, config: SimulationConfig): StepResult {
  if (state.activeHeads.length === 0) {
    return { connected: false, terminated: true, connectionSegmentId: null };
  }

  const candidatesByHead: Map<number, { candidates: Candidate[]; head: GrowthHead }> = new Map();

  for (const head of state.activeHeads) {
    const directions = generateCandidateDirections(
      head.direction,
      config.candidateCount,
      config.coneHalfAngle,
      state.rng,
    );

    const headCandidates: Candidate[] = [];

    for (const dir of directions) {
      const nextPos: Vec3 = {
        x: head.position.x + dir.x * config.stepLength,
        y: head.position.y + dir.y * config.stepLength,
        z: head.position.z + dir.z * config.stepLength,
      };

      const fieldValue = computeFieldAtPoint(nextPos, state.fieldCtx, dir);

      const candidate: Candidate = {
        headId: head.id,
        position: nextPos,
        direction: dir,
        fieldValue,
        depth: head.depth,
      };

      headCandidates.push(candidate);
    }

    candidatesByHead.set(head.id, { candidates: headCandidates, head });
  }

  const newHeads: GrowthHead[] = [];
  let connected = false;
  let connectionSegmentId: number | null = null;

  for (const [, { candidates: headCandidates, head }] of candidatesByHead) {
    if (headCandidates.length === 0) continue;

    const probs = computeDBMProbabilities(headCandidates, config.eta);
    const stepProgress = state.currentStep / config.maxSteps;

    // Use selectForHead to get primary + potential branches
    const selection = selectForHead(
      headCandidates,
      probs,
      head.depth,
      stepProgress,
      config.maxBranchDepth,
      config.baseBranchProb,
      config.branchProgressDecay,
      config.maxBranchesPerStep,
      state.rng,
    );

    // Apply stochastic sampling: weighted random from DBM probs instead of max
    const r = state.rng.next();
    let cumulative = 0;
    let primaryIndex = selection.primaryIndex;
    for (let i = 0; i < probs.length; i++) {
      cumulative += probs[i];
      if (r < cumulative) {
        primaryIndex = i;
        break;
      }
    }

    const primary = headCandidates[primaryIndex];

    // Apply jitter to main channel for more natural "kinks"
    let jitteredPosition = primary.position;
    if (head.depth === 0 && config.mainChannelJitter > 0) {
      const jitterAmount = config.mainChannelJitter * Math.pow(config.jitterDecayRate, state.currentStep);
      const perpendicular = computePerpendicular(primary.direction, state.rng);
      const offset = scale(perpendicular, (state.rng.next() - 0.5) * 2 * jitterAmount * config.stepLength);
      jitteredPosition = add(primary.position, offset);
    }
    // Clamp Y so bolt never goes below ground
    if (jitteredPosition.y < state.groundY) {
      jitteredPosition = { ...jitteredPosition, y: state.groundY };
    }

    const primarySegId = state.nextSegmentId++;
    state.segments.push({
      id: primarySegId,
      start: head.position,
      end: jitteredPosition,
      depth: head.depth,
      parentSegmentId: head.parentSegmentId,
      stepIndex: state.currentStep,
      intensity: primary.fieldValue,
      isMainChannel: false,
    });

    addChannelPoint(state.fieldCtx, jitteredPosition);

    const dy = jitteredPosition.y - state.groundY;
    const isConnected = Math.abs(dy) < config.connectionThreshold;

    if (isConnected) {
      connected = true;
      connectionSegmentId = primarySegId;
    } else {
      // All depths continue, but branches have probability-based survival
      const survivalProb = Math.pow(config.branchSurvivalDecay, head.depth);
      if (head.depth === 0 || state.rng.next() < survivalProb) {
        newHeads.push({
          id: state.nextHeadId++,
          position: jitteredPosition,
          direction: primary.direction,
          depth: head.depth,
          parentSegmentId: primarySegId,
          stepIndex: state.currentStep,
        });
      }
    }

    // Spawn branch heads from selectForHead results
    for (const branchIdx of selection.branchIndices) {
      const branchCandidate = headCandidates[branchIdx];
      let branchPos = branchCandidate.position;
      if (branchPos.y < state.groundY) {
        branchPos = { ...branchPos, y: state.groundY };
      }

      const branchSegId = state.nextSegmentId++;
      state.segments.push({
        id: branchSegId,
        start: head.position,
        end: branchPos,
        depth: head.depth + 1,
        parentSegmentId: head.parentSegmentId,
        stepIndex: state.currentStep,
        intensity: branchCandidate.fieldValue * 0.7,
        isMainChannel: false,
      });

      addChannelPoint(state.fieldCtx, branchPos);

      // Spawned branches can continue growing with survival probability
      const branchDepth = head.depth + 1;
      const survivalProb = Math.pow(config.branchSurvivalDecay, branchDepth);
      if (state.rng.next() < survivalProb) {
        newHeads.push({
          id: state.nextHeadId++,
          position: branchPos,
          direction: branchCandidate.direction,
          depth: branchDepth,
          parentSegmentId: branchSegId,
          stepIndex: state.currentStep,
        });
      }
    }

    if (state.segments.length >= config.maxSegments) break;
  }

  state.activeHeads = newHeads;
  state.currentStep++;

  return { connected, terminated: false, connectionSegmentId };
}
