import {
  Vec3,
  SimulationConfig,
  SimHead,
  SimSegment,
  Candidate,
} from './types';
import { SeededRNG } from './prng';
import { computeFieldAtPoint, FieldContext, addChannelPoint } from './FieldComputation';
import { computeDBMProbabilities, sampleFromDistribution, selectBranches } from './BranchSelection';

export interface GrowthState {
  activeHeads: SimHead[];
  segments: SimSegment[];
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
  const perpX = dir.y * up.z - dir.z * up.y;
  const perpY = dir.z * up.x - dir.x * up.z;
  const perpZ = dir.x * up.y - dir.y * up.x;
  const perp = normalize({ x: perpX, y: perpY, z: perpZ });

  const angle = rng.next() * Math.PI * 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

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

  let up: Vec3;
  if (Math.abs(dir.y) < 0.9) {
    up = { x: 0, y: 1, z: 0 };
  } else {
    up = { x: 1, y: 0, z: 0 };
  }

  const tx = dir.y * up.z - dir.z * up.y;
  const ty = dir.z * up.x - dir.x * up.z;
  const tz = dir.x * up.y - dir.y * up.x;
  const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz);
  const t = { x: tx / tLen, y: ty / tLen, z: tz / tLen };

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

  const newHeads: SimHead[] = [];
  let connected = false;
  let connectionSegmentId: number | null = null;

  const stepProgress = state.currentStep / config.maxSteps;

  for (const head of state.activeHeads) {
    const directions = generateCandidateDirections(
      head.direction,
      config.candidateCount,
      config.coneHalfAngle,
      state.rng,
    );

    const candidates: Candidate[] = [];

    for (const dir of directions) {
      const nextPos: Vec3 = {
        x: head.position.x + dir.x * config.stepLength,
        y: head.position.y + dir.y * config.stepLength,
        z: head.position.z + dir.z * config.stepLength,
      };

      const fieldValue = computeFieldAtPoint(nextPos, state.fieldCtx, dir);

      candidates.push({
        headId: head.id,
        position: nextPos,
        direction: dir,
        fieldValue,
      });
    }

    if (candidates.length === 0) continue;

    const probs = computeDBMProbabilities(candidates, config.eta);
    const primaryIndex = sampleFromDistribution(probs, state.rng);
    const primary = candidates[primaryIndex];

    let primaryPosition = primary.position;

    if (config.mainChannelJitter > 0) {
      const jitterAmount = config.mainChannelJitter * Math.pow(config.jitterDecayRate, state.currentStep);
      const perpendicular = computePerpendicular(primary.direction, state.rng);
      const offset = scale(perpendicular, (state.rng.next() - 0.5) * 2 * jitterAmount * config.stepLength);
      primaryPosition = add(primary.position, offset);
    }

    if (primaryPosition.y < state.groundY) {
      primaryPosition = { ...primaryPosition, y: state.groundY };
    }

    const primarySegId = state.nextSegmentId++;
    state.segments.push({
      id: primarySegId,
      start: head.position,
      end: primaryPosition,
      parentSegmentId: head.parentSegmentId,
      stepIndex: state.currentStep,
      intensity: primary.fieldValue,
    });

    addChannelPoint(state.fieldCtx, primaryPosition);

    const dy = primaryPosition.y - state.groundY;
    const isConnected = Math.abs(dy) < config.connectionThreshold;

    if (isConnected && !connected) {
      connected = true;
      connectionSegmentId = primarySegId;
    }

    if (!isConnected) {
      newHeads.push({
        id: state.nextHeadId++,
        position: primaryPosition,
        direction: primary.direction,
        parentSegmentId: primarySegId,
        stepIndex: state.currentStep,
      });
    }

    const branchIndices = selectBranches(
      candidates,
      probs,
      primaryIndex,
      stepProgress,
      config.branchProbAtStart,
      config.branchProbAtEnd,
      config.maxBranchesPerStep,
      state.rng,
    );

    for (const branchIdx of branchIndices) {
      const branchCandidate = candidates[branchIdx];
      let branchPos = branchCandidate.position;

      if (branchPos.y < state.groundY) {
        branchPos = { ...branchPos, y: state.groundY };
      }

      const branchSegId = state.nextSegmentId++;
      state.segments.push({
        id: branchSegId,
        start: head.position,
        end: branchPos,
        parentSegmentId: primarySegId,
        stepIndex: state.currentStep,
        intensity: branchCandidate.fieldValue * 0.8,
      });

      addChannelPoint(state.fieldCtx, branchPos);

      if (state.rng.next() < config.branchSurvivalProb) {
        newHeads.push({
          id: state.nextHeadId++,
          position: branchPos,
          direction: branchCandidate.direction,
          parentSegmentId: branchSegId,
          stepIndex: state.currentStep,
        });
      }
    }

    if (state.segments.length >= config.maxSegments) break;
  }

  if (newHeads.length > config.maxActiveHeads) {
    newHeads.sort(() => state.rng.next() - 0.5);
    newHeads.length = config.maxActiveHeads;
  }

  state.activeHeads = newHeads;
  state.currentStep++;

  return { connected, terminated: false, connectionSegmentId };
}
