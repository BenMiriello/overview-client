/**
 * Scale conversion between normalized simulation units and real-world meters.
 * The simulation operates in normalized space for numerical stability.
 *
 * Reference: Cloud-to-ground lightning typically spans 5-8 km.
 * Our normalized space spans 1.0 unit (from y=0.5 to y=-0.5).
 */
export const SCALE = {
  // 1 simulation unit = this many meters
  METERS_PER_UNIT: 6250,

  // 1 meter = this many simulation units
  UNITS_PER_METER: 1 / 6250,

  // Common conversions
  STEP_LENGTH_METERS: 50, // Real stepped leader step
  STEP_LENGTH_UNITS: 0.008, // Corresponding simulation step

  // Atmospheric feature scales (in simulation units)
  CHARGE_POCKET_RADIUS: {
    MIN: 0.08, // ~500m in reality
    MAX: 0.24, // ~1.5km in reality
  },

  MOISTURE_REGION_RADIUS: {
    MIN: 0.08, // Similar to charge (both driven by convection)
    MAX: 0.32, // Slightly larger features
  },

  IONIZATION_SEED_RADIUS: {
    MIN: 0.002, // ~12m - cosmic ray track scale
    MAX: 0.008, // ~50m
  },
} as const;

export function metersToUnits(meters: number): number {
  return meters * SCALE.UNITS_PER_METER;
}

export function unitsToMeters(units: number): number {
  return units * SCALE.METERS_PER_UNIT;
}
