# Star Dimming Physics Review

Analysis of the `skyBright` computation in `GlobeComponent.tsx` that dims the
star background based on bright objects in the camera's field of view.

## The model

Three sources contribute to `totalBright`, which is fed through
`smoothstep(totalBright, 0.1, 0.7)` to produce a dimming factor:

| Source | How it enters `totalBright` |
|--------|----------------------------|
| Earth  | `computeBrightArea(cam, origin, EARTH_R, fov, 0.8)` |
| Moon   | `computeBrightArea(cam, moonPos, MOON_R, fov, 0.66)` |
| Sun    | `sunHeightFraction * sunInView * 4 * (1 - occlusion)` |

`computeBrightArea` returns `lit * albedoScale * heightFraction` where:
- `heightFraction` = fraction of the vertical FOV the body subtends (0..1)
- `lit` = `dot(bodyToCam, sunDir) * 0.5 + 0.5` (phase-angle approximation, 0..1)

## Real-world surface brightness ratios

Surface brightness (luminance per steradian) of each object as seen from
low-Earth orbit or nearby:

| Object | Geometric albedo | Approx. surface luminance | Relative to Moon |
|--------|-----------------|--------------------------|-----------------|
| Moon   | 0.12            | ~2,500 cd/m^2            | 1x              |
| Earth (ocean/land avg) | 0.12-0.37 | ~6,000-15,000 cd/m^2 | 3-6x |
| Earth (cloud tops)     | 0.6-0.8   | ~25,000-40,000 cd/m^2  | 10-16x |
| Sun    | n/a (emitter)   | ~2 x 10^9 cd/m^2        | ~800,000x       |

Key insight: the Moon is dark -- roughly the albedo of worn asphalt. Earth's
surface (especially with clouds) is 3-5x brighter per unit area, and the Sun
is many orders of magnitude brighter than either.

## What the code currently does

### Earth vs Moon ratio: **1.2x** (code) vs **~3-5x** (reality)

- Code: `albedoScale` Earth = 0.8, Moon = 0.66 -> ratio 1.21x
- Reality: Earth's average albedo ~0.30, Moon ~0.12 -> ratio 2.5x without clouds.
  With our prominent cloud layer, Earth's effective albedo is closer to 0.4-0.5,
  giving a ratio of 3-4x.

The Moon's `albedoScale = 0.66` significantly overstates its brightness relative
to Earth. A more physically grounded pairing would be:

| | albedoScale | Rationale |
|--|------------|-----------|
| Earth | 0.8 | Reasonable given prominent cloud layer (effective ~0.5 albedo, scaled up because the dimming curve is compressed) |
| Moon | 0.20-0.30 | Reflects real 0.12 albedo, scaled to maintain the same relative proportion to Earth |

The current Moon value means the Moon contributes ~82% as much dimming per unit
solid angle as Earth, when it should be closer to ~25-30%.

### Sun brightness: **adequate for the dimming range, but physically dwarfed**

With the current constants at a typical 50-degree FOV:
- `sunHeightFraction` ~ 0.084 (halo subtends ~4.8 degrees)
- Max `sunBright` ~ 0.084 * 1.0 * 4 * 1.0 = **0.34**

This pushes `totalBright` past the smoothstep threshold (0.1) and into
partial dimming (~0.29 on the 0-1 scale). In reality, even a sliver of the
solar disc should instantly saturate any camera's exposure and blank out all
stars. A scale factor of 4 is a massive understatement physically (should be
~100,000+), but it's pragmatically reasonable: higher values would make the
dimming transition invisibly fast and the sun would dominate all other sources.

If we want a slightly more aggressive sun response while keeping the smooth
transition useful, `SUN_BRIGHTNESS_SCALE = 6-8` would put the sun's maximum
contribution at 0.5-0.67, enough to fully dim stars on its own (past the 0.7
upper threshold) when centered in view.

### Phase angle approximation: **reasonable**

`lit = dot(bodyToCam, sunDir) * 0.5 + 0.5`

This linearly maps the cosine of the phase angle to [0, 1]. The exact
Lambertian hemisphere integral gives a non-linear curve, but the linear
remap is a serviceable approximation:
- Full (looking at day side): lit = 1.0 (exact: 1.0)
- Quarter: lit = 0.5 (exact: ~0.32 for Lambertian)
- New (night side): lit = 0.0 (exact: 0.0)

Quarter phase is overstated by ~56%, but this is unlikely to be perceptible.

### Cloud brightness not factored dynamically

The `computeBrightArea` albedoScale for Earth is a static 0.8 regardless of
how much cloud coverage is currently visible from the camera's angle. In
reality, a cloud-heavy hemisphere would be significantly brighter than a
clear-sky view. Dynamic coupling (sampling the cloud texture from the camera's
perspective) would be expensive and likely not worth it -- the static value
serves as a reasonable worst-case.

## Summary of scaling accuracy

| Relationship | Code ratio | Physical ratio | Accuracy |
|-------------|-----------|---------------|----------|
| Earth : Moon surface brightness | 1.2x | 3-5x | Moon overstated ~3x |
| Sun : Earth (total FOV contribution) | ~0.4x at max | 1000x+ | Sun understated but intentionally clamped for UX |
| Earth day vs night | 0 to 1 linear | 0 to 1 non-linear | Acceptable |

### Recommended adjustments

1. **Moon albedoScale**: reduce from 0.66 to ~0.25 to match the real
   Earth/Moon albedo ratio while keeping Earth at 0.8.

2. **SUN_BRIGHTNESS_SCALE**: consider increasing from 4 to 6-8 so the sun
   alone can fully dim stars when centered in view. The current value only
   achieves ~50% dimming at best.

3. **No changes needed** to the phase-angle approximation, smoothstep
   thresholds, or smoothing lerp rate -- these are perceptually solid.
