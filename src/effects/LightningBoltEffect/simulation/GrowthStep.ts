import {
  Vec3,
  SimulationConfig,
  GrowthHead,
  BoltSegment,
  Candidate,
} from './types';
import { SeededRNG } from './prng';
import { computeFieldAtPoint, FieldContext, addChannelPoint } from './FieldComputation';
import { computeDBMProbabilities } from './BranchSelection';

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

    // Select primary direction using DBM probabilities
    const probs = computeDBMProbabilities(headCandidates, config.eta);
    let primaryIndex = 0;
    let maxProb = probs[0];
    for (let i = 1; i < probs.length; i++) {
      if (probs[i] > maxProb) {
        maxProb = probs[i];
        primaryIndex = i;
      }
    }

    const primary = headCandidates[primaryIndex];
    const primarySegId = state.nextSegmentId++;
    state.segments.push({
      id: primarySegId,
      start: head.position,
      end: primary.position,
      depth: head.depth,
      parentSegmentId: head.parentSegmentId,
      stepIndex: state.currentStep,
      intensity: primary.fieldValue,
      isMainChannel: false,
    });

    addChannelPoint(state.fieldCtx, primary.position);

    const dy = primary.position.y - state.groundY;
    const isConnected = Math.abs(dy) < config.connectionThreshold;

    if (isConnected) {
      connected = true;
      connectionSegmentId = primarySegId;
    } else if (head.depth === 0) {
      newHeads.push({
        id: state.nextHeadId++,
        position: primary.position,
        direction: primary.direction,
        depth: head.depth,
        parentSegmentId: primarySegId,
        stepIndex: state.currentStep,
      });
    }

    if (state.segments.length >= config.maxSegments) break;
  }

  state.activeHeads = newHeads;
  state.currentStep++;

  return { connected, terminated: false, connectionSegmentId };
}
