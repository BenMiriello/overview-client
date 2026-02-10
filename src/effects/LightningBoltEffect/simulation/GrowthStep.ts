import {
  Vec3,
  SimulationConfig,
  SimHead,
  SimSegment,
  Candidate,
} from './types';
import { SeededRNG } from './prng';
import { computeFieldAtPoint, FieldContext, addChannelPoint } from './FieldComputation';
import { computeDBMProbabilities, sampleFromDistribution } from './BranchSelection';
import { AtmosphericModel } from './AtmosphericModel';

export interface GrowthState {
  activeHeads: SimHead[];
  segments: SimSegment[];
  fieldCtx: FieldContext;
  nextHeadId: number;
  nextSegmentId: number;
  currentStep: number;
  rng: SeededRNG;
  groundY: number;
  atmosphere?: AtmosphericModel;
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

/**
 * Competition-based death filter.
 * Leaders die based on how far behind the frontrunner they are.
 * The leading head always survives; others have survival probability
 * based on their lag and progress.
 */
function filterByCompetition(
  heads: SimHead[],
  groundY: number,
  rng: SeededRNG,
  ceilingY: number = 0.5
): SimHead[] {
  if (heads.length <= 1) return heads;

  // Find the leader (closest to ground = lowest y)
  const sorted = [...heads].sort((a, b) => a.position.y - b.position.y);
  const leaderY = sorted[0].position.y;
  const leaderId = sorted[0].id;
  const totalProgress = ceilingY - groundY;

  return heads.filter(head => {
    // Leader always survives
    if (head.id === leaderId) return true;

    // How far behind the leader?
    const lag = head.position.y - leaderY;
    const lagRatio = lag / totalProgress;

    // How much progress has this head made?
    const progress = (ceilingY - head.position.y) / totalProgress;

    // Base survival probability
    let survivalProb = 0.97;

    // Penalty for falling behind (up to -30%)
    survivalProb -= lagRatio * 0.3;

    // Bonus for progress (up to +10%)
    survivalProb += progress * 0.1;

    // Clamp to reasonable range
    survivalProb = Math.max(0.6, Math.min(0.99, survivalProb));

    return rng.next() < survivalProb;
  });
}

export function growthStep(state: GrowthState, config: SimulationConfig): StepResult {
  if (state.activeHeads.length === 0) {
    return { connected: false, terminated: true, connectionSegmentId: null };
  }

  // Competition-based death: heads falling behind have lower survival probability
  state.activeHeads = filterByCompetition(state.activeHeads, state.groundY, state.rng);

  if (state.activeHeads.length === 0) {
    return { connected: false, terminated: true, connectionSegmentId: null };
  }

  const newHeads: SimHead[] = [];
  let connected = false;
  let connectionSegmentId: number | null = null;

  const stepProgress = state.currentStep / config.maxSteps;

  // Event-based branching: decide at step level which heads will branch
  // Target ~0.6 branches per step on average, with noise for burstiness
  const avgNoisePos = state.activeHeads[0]?.position ?? { x: 0, y: 0, z: 0 };
  const noiseVal = state.fieldCtx.noise3D(avgNoisePos.x * 3, avgNoisePos.y * 3, avgNoisePos.z * 3);
  const burstFactor = 1 + noiseVal * 0.6; // 0.4 to 1.6x

  const baseBranchRate = config.branchProbAtStart +
    (config.branchProbAtEnd - config.branchProbAtStart) * stepProgress;
  const targetBranches = baseBranchRate * 5 * burstFactor; // ~0.3 branches per step average

  // Poisson-like: for each potential branch, roll dice
  let numBranches = 0;
  for (let i = 0; i < Math.ceil(targetBranches * 2); i++) {
    if (state.rng.next() < targetBranches / Math.ceil(targetBranches * 2)) {
      numBranches++;
    }
  }

  // Select which heads will branch (generation < 3)
  const eligibleForBranching = state.activeHeads
    .filter(h => h.generation < 3)
    .map(h => h.id);

  // Shuffle and take numBranches
  for (let i = eligibleForBranching.length - 1; i > 0; i--) {
    const j = Math.floor(state.rng.next() * (i + 1));
    [eligibleForBranching[i], eligibleForBranching[j]] = [eligibleForBranching[j], eligibleForBranching[i]];
  }
  const selectedToBranch = new Set(eligibleForBranching.slice(0, numBranches));

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
        age: head.age + 1,
        isFromBranch: head.isFromBranch,
        generation: head.generation,
      });
    }

    // Event-based branching: only branch if this head was selected
    if (selectedToBranch.has(head.id)) {
      // Pick best non-primary candidate for branching
      let bestBranchIdx = -1;
      let bestBranchField = -Infinity;
      for (let i = 0; i < candidates.length; i++) {
        if (i !== primaryIndex && candidates[i].fieldValue > bestBranchField) {
          bestBranchField = candidates[i].fieldValue;
          bestBranchIdx = i;
        }
      }

      if (bestBranchIdx >= 0) {
        const branchCandidate = candidates[bestBranchIdx];
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

        newHeads.push({
          id: state.nextHeadId++,
          position: branchPos,
          direction: branchCandidate.direction,
          parentSegmentId: branchSegId,
          stepIndex: state.currentStep,
          age: 0,
          isFromBranch: true,
          generation: head.generation + 1,
        });
      }
    }

    if (state.segments.length >= config.maxSegments) break;
  }

  // Random culling: primary path protected, branches shuffled randomly
  if (newHeads.length > config.maxActiveHeads) {
    const primary = newHeads.filter(h => !h.isFromBranch);
    const branches = newHeads.filter(h => h.isFromBranch);

    // Fisher-Yates shuffle for random selection
    for (let i = branches.length - 1; i > 0; i--) {
      const j = Math.floor(state.rng.next() * (i + 1));
      [branches[i], branches[j]] = [branches[j], branches[i]];
    }

    const toKeep = config.maxActiveHeads - primary.length;
    newHeads.length = 0;
    newHeads.push(...primary);
    newHeads.push(...branches.slice(0, Math.max(0, toKeep)));
  }

  state.activeHeads = newHeads;
  state.currentStep++;

  return { connected, terminated: false, connectionSegmentId };
}
