import { Candidate } from './types';
import { SeededRNG } from './prng';

export function computeDBMProbabilities(candidates: Candidate[], eta: number): number[] {
  const powers = new Array<number>(candidates.length);
  let sum = 0;

  for (let i = 0; i < candidates.length; i++) {
    const p = Math.pow(Math.abs(candidates[i].fieldValue), eta);
    powers[i] = p;
    sum += p;
  }

  if (sum === 0) {
    const uniform = 1 / candidates.length;
    return powers.map(() => uniform);
  }

  for (let i = 0; i < powers.length; i++) {
    powers[i] /= sum;
  }
  return powers;
}

export interface SelectionResult {
  primaryIndex: number;
  branchIndices: number[];
}

/**
 * From a set of candidates belonging to a single head, select the primary
 * growth direction and any emergent branches.
 */
export function selectForHead(
  headCandidates: Candidate[],
  headProbabilities: number[],
  headDepth: number,
  stepProgress: number,
  maxBranchDepth: number,
  baseBranchProb: number,
  branchProgressDecay: number,
  maxBranchesPerStep: number,
  rng: SeededRNG,
): SelectionResult {
  // Sort indices by probability descending
  const indices = headCandidates.map((_, i) => i);
  indices.sort((a, b) => headProbabilities[b] - headProbabilities[a]);

  const primaryIndex = indices[0];
  const branchIndices: number[] = [];

  if (indices.length <= 1 || headDepth >= maxBranchDepth) {
    return { primaryIndex, branchIndices };
  }

  const primaryProb = headProbabilities[primaryIndex];
  if (primaryProb === 0) return { primaryIndex, branchIndices };

  const progressDecay = Math.max(1.0 - stepProgress * branchProgressDecay, 0.15);
  let branchCount = 0;

  for (let i = 1; i < indices.length && branchCount < maxBranchesPerStep; i++) {
    const idx = indices[i];

    const branchProb = baseBranchProb * progressDecay;
    if (rng.next() < branchProb) {
      branchIndices.push(idx);
      branchCount++;
    }
  }

  return { primaryIndex, branchIndices };
}
