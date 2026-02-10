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

export function sampleFromDistribution(probs: number[], rng: SeededRNG): number {
  const r = rng.next();
  let cumulative = 0;
  for (let i = 0; i < probs.length; i++) {
    cumulative += probs[i];
    if (r < cumulative) {
      return i;
    }
  }
  return probs.length - 1;
}

export interface SelectionResult {
  primaryIndex: number;
  branchIndices: number[];
}

export function selectBranches(
  candidates: Candidate[],
  probs: number[],
  primaryIndex: number,
  stepProgress: number,
  branchProbAtStart: number,
  branchProbAtEnd: number,
  maxBranchesPerStep: number,
  rng: SeededRNG,
): number[] {
  if (candidates.length <= 1) {
    return [];
  }

  const branchProb = branchProbAtEnd + (branchProbAtStart - branchProbAtEnd) * Math.exp(-stepProgress * 2);

  const indices = candidates.map((_, i) => i);
  indices.sort((a, b) => probs[b] - probs[a]);

  const branchIndices: number[] = [];
  let branchCount = 0;

  for (const idx of indices) {
    if (idx === primaryIndex) continue;
    if (branchCount >= maxBranchesPerStep) break;

    if (rng.next() < branchProb) {
      branchIndices.push(idx);
      branchCount++;
    }
  }

  return branchIndices;
}
