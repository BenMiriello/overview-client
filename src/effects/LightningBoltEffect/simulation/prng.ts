export interface SeededRNG {
  next(): number;
  nextInt(max: number): number;
  nextGaussian(): number;
  fork(): SeededRNG;
}

function createRNG(seed: number): () => number {
  let state = seed >>> 0;

  return function mulberry32(): number {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSeededRNG(seed: number): SeededRNG {
  const base = createRNG(seed);
  let hasSpare = false;
  let spare = 0;

  return {
    next: base,

    nextInt(max: number): number {
      return Math.floor(base() * max);
    },

    nextGaussian(): number {
      if (hasSpare) {
        hasSpare = false;
        return spare;
      }

      let u, v, s;
      do {
        u = base() * 2 - 1;
        v = base() * 2 - 1;
        s = u * u + v * v;
      } while (s >= 1 || s === 0);

      const mul = Math.sqrt(-2 * Math.log(s) / s);
      spare = v * mul;
      hasSpare = true;
      return u * mul;
    },

    fork(): SeededRNG {
      const childSeed = Math.floor(base() * 0xFFFFFFFF);
      return createSeededRNG(childSeed);
    },
  };
}
