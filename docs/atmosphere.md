# Atmosphere rendering

Real-time analytic Rayleigh single scattering for Earth's atmosphere. The goal is "looks right at a glance, derived from physics, not painted on" — not a research-grade scattering simulator.

## Coordinate frame

The atmosphere mesh and its shader live in the **Earth-fixed scene frame** (`+Y` = north pole, `+Z` = prime meridian on the equator). This is the same frame the globe surface, day/night terminator shader, and visible sun sprite use. See `MEMORY.md → project_sun_direction_frames` for the broader trap with this codebase having two parallel "sun direction" definitions.

The sun direction uniform is `sharedNightUniforms.sunDir` from `client/src/services/dayNightMaterial.ts`, which is updated each tick by `updateSunDirection(now)`. The atmosphere material binds this uniform directly so it can never drift from the terminator.

## Geometry

- `EARTH_R = 100` scene units (matches `globeRadius` in `GlobeComponent`).
- `ATMOSPHERE_HEIGHT = 0.025 * EARTH_R = 2.5` → atmosphere top at radius `102.5`.
  - Real Earth's optically-relevant atmosphere is ~100 km on a 6371 km radius (~1.5%). We inflate to 2.5% so the limb glow is wide enough to read at globe-viewing distances.
  - Cloud layer (`client/src/layers/CloudLayer.ts:8-10`) sits at `EARTH_R * (1.003 .. 1.01)` — fully inside the atmosphere shell with comfortable headroom.
- `RAYLEIGH_SCALE_HEIGHT = 0.25 * ATMOSPHERE_HEIGHT = 0.625`. Independent from `ATMOSPHERE_HEIGHT` and rescaled in proportion to it. Real Earth scale height ~8.5 km → ~8.5% of the optical-atmosphere thickness; we keep that ratio loose.
- `RAYLEIGH_COEFF` (β_R, β_G, β_B): proportional to `(5.8, 13.5, 33.1)` — the canonical wavelength⁻⁴ ratio for Rayleigh at 680/550/440 nm. The absolute scale is tuned visually; physically-correct values per meter are `~10⁻⁶`, but rescaled to scene units (1 unit = ~63.7 km) and dialed up for visibility.

## Rendering strategy

A single sphere mesh at `EARTH_R + ATMOSPHERE_HEIGHT`, **back-face rendered**, **additively blended**, **`depthWrite = false`**, **`depthTest = true`**. One mesh, one material, one shader path that handles camera-outside and camera-inside uniformly.

### Shader integration

For each fragment:

1. **Reconstruct the view ray** in world space from camera position and the interpolated world-space fragment position.
2. **Intersect the view ray against the atmosphere shell** (sphere at origin, radius `atmosphereR`). Get `(tNear, tFar)`. Clamp `tNear` to `max(0, tNear)` so a camera *inside* the atmosphere starts integrating at the camera origin.
3. **Intersect the view ray against the planet** (sphere at origin, radius `planetR`). If the planet is hit and its near hit is closer than `tFar`, clamp `tFar` to that hit (the planet occludes the rest of the chord).
4. **Sample-loop the segment `[tNear, tFar]`** (8–12 samples). For each sample point `P`:
   - `altitude = length(P) - planetR`
   - `density = exp(-altitude / scaleHeight) * stepLength`
   - **Ground-shadow test:** ray-sphere intersect from `P` toward `sunDir` against the planet. If the planet is hit on the positive side, this sample is in Earth's shadow → contributes 0. (This is the single most physically important detail — without it, no twilight, no limb-bleed, no sunsets.)
   - Otherwise: accumulate `density * sunIntensity` into the per-sample contribution.
5. **Phase function:** multiply final accumulated value by `(3 / (16π)) * (1 + cos²θ)` where `θ` is the angle between the view direction and the sun direction.
6. **Color:** multiply by `RAYLEIGH_COEFF`. Output as `(rgb, 1.0)` with additive blending.

### Why one shader path, not two

O'Neil (GPU Gems 2 ch.16) splits camera-outside and camera-inside paths because his approach uses precomputed optical-depth texture lookups whose LUT key changes when the camera enters the atmosphere. We don't precompute anything — we sample optical depth analytically per fragment — so the camera-inside case is just `tNear = max(0, tNear)`. One uniform path.

## Render order

Back-to-front, since blending is order-sensitive:

| renderOrder | Mesh | Notes |
|---|---|---|
| -10 | sky sphere | `depthWrite = false` |
| -5 | sun sprites (core, halo) | additive, `depthWrite = false`. Sun is at world distance ~47500 (geometrically far behind everything), so it must enter the framebuffer first. |
| 0 (default) | Earth surface, clouds, moon | normal opaque/transparent rendering |
| +5 | atmosphere shell | additive, back-face, `depthWrite = false`. Composes on top of Earth's lit surface and adds limb glow over the sun-sprite pixels behind Earth's limb. |

## Accepted simplifications

These are intentional. Future refactors should not "fix" them without an explicit decision:

- **Single scattering only.** No multiple-scatter integration. Terminator and twilight will be slightly less luminous than reality.
- **No ozone.** Real Earth's ozone layer adds a cold blue absorption band that pulls sunsets toward red-purple. Without it our terminator may look more orange than rosy.
- **No Mie / no aerosols.** No haze, no white-yellow forward-scattering halo around the sun. Revisit if sunset colors look wrong.
- **Constant Rayleigh coefficients.** Real coefficients vary slightly with altitude/composition.
- **One scale height, exponential density.** Real atmosphere has multiple scale heights and is non-exponential at high altitudes.
- **No tone mapping.** Scene is linear-SRGB. Bright limbs may clip to white. If this looks bad we can enable `THREE.ACESFilmicToneMapping` at the renderer level — but that's a global change affecting every other material.

## What should fall out for free

If the shader is correct, all of these emerge from the physics with no special-case code:

- **Limb glow** — view chords through the atmosphere are longest at the limb, so optical density × scattering is highest there.
- **Blue sky overhead** — Rayleigh's wavelength⁻⁴ scattering preferentially scatters blue light, dominant when the view ray is short and the sun is overhead.
- **Red/orange terminator** — view rays at the day/night boundary travel through long optical paths, scattering out blue and leaving red.
- **Twilight on the night side** — samples just past the terminator are still lit by the sun (above their local horizon) and the ground-shadow test correctly admits them.
- **Sun glow bleeding around Earth's limb** — when the sun is geometrically behind Earth but angularly close to the limb, the upper atmosphere on the far side is still lit, and the view chord through it picks up that scattered light. Physically-correct corona-without-corona-sprite effect.

## References

- Sean O'Neil, "Accurate Atmospheric Scattering" — GPU Gems 2, Chapter 16. Canonical real-time reference; we simplify further by skipping the LUT.
- Nishita et al. 1993 — original analytic single-scattering model.
- Sébastien Hillaire, "A Scalable and Production Ready Sky and Atmosphere Rendering Technique" — modern reference, far more complex than what we need.
