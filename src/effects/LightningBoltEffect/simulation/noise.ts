import { createSeededRNG } from './prng';

/**
 * Seeded 3D improved Perlin noise.
 * Permutation table generated from seed, not Math.random().
 * Returns values in [-1, 1].
 */
export function createNoise3D(seed: number): (x: number, y: number, z: number) => number {
  const rng = createSeededRNG(seed);

  const perm = new Uint8Array(512);
  const permMod12 = new Uint8Array(512);

  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;

  // Fisher-Yates shuffle with seeded RNG
  for (let i = 255; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }

  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    permMod12[i] = perm[i] % 12;
  }

  const grad3 = [
    1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
    1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
    0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
  ];

  function dot3(gi: number, x: number, y: number, z: number): number {
    const i = gi * 3;
    return grad3[i] * x + grad3[i + 1] * y + grad3[i + 2] * z;
  }

  function fade(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  function lerp(a: number, b: number, t: number): number {
    return a + t * (b - a);
  }

  return function noise3D(x: number, y: number, z: number): number {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const Z = Math.floor(z) & 255;

    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const zf = z - Math.floor(z);

    const u = fade(xf);
    const v = fade(yf);
    const w = fade(zf);

    const A  = perm[X] + Y;
    const AA = perm[A] + Z;
    const AB = perm[A + 1] + Z;
    const B  = perm[X + 1] + Y;
    const BA = perm[B] + Z;
    const BB = perm[B + 1] + Z;

    return lerp(
      lerp(
        lerp(
          dot3(permMod12[AA], xf, yf, zf),
          dot3(permMod12[BA], xf - 1, yf, zf),
          u,
        ),
        lerp(
          dot3(permMod12[AB], xf, yf - 1, zf),
          dot3(permMod12[BB], xf - 1, yf - 1, zf),
          u,
        ),
        v,
      ),
      lerp(
        lerp(
          dot3(permMod12[AA + 1], xf, yf, zf - 1),
          dot3(permMod12[BA + 1], xf - 1, yf, zf - 1),
          u,
        ),
        lerp(
          dot3(permMod12[AB + 1], xf, yf - 1, zf - 1),
          dot3(permMod12[BB + 1], xf - 1, yf - 1, zf - 1),
          u,
        ),
        v,
      ),
      w,
    );
  };
}
