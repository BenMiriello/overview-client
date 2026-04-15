/**
 * Centralized render-order constants. The semantic is "draw order from
 * back to front" — smaller numbers draw first.
 *
 * For correct occlusion of solid bodies, ALSO ensure they have depthWrite
 * and depthTest enabled.
 *
 * The atmosphere uses depthTest=false intentionally (its back-side shell
 * would otherwise be depth-clipped by Earth on every pixel except the limb,
 * and the shader handles planet occlusion analytically). Any solid that
 * should appear in front of the atmosphere must have a HIGHER renderOrder
 * AND its own depthTest/depthWrite enabled so it overdraws on top.
 *
 * When adding a new layer, leave gaps so future inserts don't require a
 * cascade of renumberings.
 */
export const LAYERS = {
  SKY: -100,
  SUN: -50,
  EARTH_SURFACE: 0,
  CLOUD_OCCLUDER: 5,
  CLOUDS: 10,
  ATMOSPHERE: 20,
  TEMPERATURE: 25, // must be above atmosphere so it renders on night side
  PRECIPITATION: 26,
  WIND_OVERLAY: 27,
  WIND_PARTICLES: 28,
  MOON_SURFACE: 30,
  MOON_RELIEF: 31,
  MARKERS: 100,
  /** Lightning sub-layers add small offsets to this base. */
  LIGHTNING_BASE: 1000,
} as const;

export type LayerName = keyof typeof LAYERS;
