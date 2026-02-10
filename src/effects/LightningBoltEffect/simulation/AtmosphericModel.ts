import { Vec3 } from './types';
import { VoronoiField, VoronoiCell } from './VoronoiField';
import { SeededRNG } from './prng';
import { SCALE } from './constants';

export interface AtmosphericConfig {
  // Ceiling charge (2D, y = ceilingY)
  ceilingChargeCellCount: number;
  ceilingChargeIntensityRange: [number, number];
  ceilingChargeRadiusRange: [number, number];

  // Ground charge (2D, y = groundY) - for later stages
  groundChargeCellCount: number;
  groundChargeIntensityRange: [number, number];
  groundChargeRadiusRange: [number, number];

  // Spatial bounds (xz plane)
  boundsRadius: number;
}

export const DEFAULT_ATMOSPHERIC_CONFIG: AtmosphericConfig = {
  ceilingChargeCellCount: 5,
  ceilingChargeIntensityRange: [0.5, 1.0],
  ceilingChargeRadiusRange: [SCALE.CHARGE_POCKET_RADIUS.MIN, SCALE.CHARGE_POCKET_RADIUS.MAX],

  groundChargeCellCount: 4,
  groundChargeIntensityRange: [0.3, 0.8],
  groundChargeRadiusRange: [SCALE.CHARGE_POCKET_RADIUS.MIN, SCALE.CHARGE_POCKET_RADIUS.MAX],

  boundsRadius: 0.4,
};

export interface AtmosphericModel {
  ceilingCharge: VoronoiField;
  groundCharge: VoronoiField | null; // null until Stage 6
  startingPoints: Vec3[];
  ceilingY: number;
  groundY: number;
}

/**
 * Generate a 2D Voronoi field for charge distribution on a plane.
 */
function generate2DChargeField(
  rng: SeededRNG,
  cellCount: number,
  intensityRange: [number, number],
  radiusRange: [number, number],
  boundsRadius: number,
  fixedY: number
): VoronoiField {
  const cells: VoronoiCell[] = [];

  for (let i = 0; i < cellCount; i++) {
    const angle = rng.next() * Math.PI * 2;
    const dist = rng.next() * boundsRadius * 0.8; // Keep within 80% of bounds

    const center: Vec3 = {
      x: Math.cos(angle) * dist,
      y: fixedY,
      z: Math.sin(angle) * dist,
    };

    const intensity =
      intensityRange[0] + rng.next() * (intensityRange[1] - intensityRange[0]);
    const falloffRadius =
      radiusRange[0] + rng.next() * (radiusRange[1] - radiusRange[0]);

    cells.push({ center, intensity, falloffRadius });
  }

  return new VoronoiField(cells, { is2D: true, fixedY });
}

/**
 * Extract starting points from ceiling charge peaks.
 * Returns positions sorted by charge intensity (highest first).
 */
function deriveStartingPoints(
  ceilingCharge: VoronoiField,
  minIntensityThreshold: number = 0.3
): Vec3[] {
  const maxima = ceilingCharge.getLocalMaxima();

  // Filter by minimum intensity
  return maxima.filter((pos) => {
    const intensity = ceilingCharge.getValue(pos);
    return intensity >= minIntensityThreshold;
  });
}

/**
 * Create an atmospheric model for a lightning simulation.
 * Currently generates ceiling charge; other layers added in later stages.
 */
export function createAtmosphericModel(
  rng: SeededRNG,
  ceilingY: number,
  groundY: number,
  config: AtmosphericConfig = DEFAULT_ATMOSPHERIC_CONFIG
): AtmosphericModel {
  const ceilingCharge = generate2DChargeField(
    rng,
    config.ceilingChargeCellCount,
    config.ceilingChargeIntensityRange,
    config.ceilingChargeRadiusRange,
    config.boundsRadius,
    ceilingY
  );

  const startingPoints = deriveStartingPoints(ceilingCharge);

  // Log for Stage 3 verification
  console.log('[Atmospheric] Ceiling charge cells:', ceilingCharge.cells.length);
  console.log(
    '[Atmospheric] Starting points:',
    startingPoints.map(
      (p) =>
        `(${p.x.toFixed(3)}, ${p.z.toFixed(3)}) intensity=${ceilingCharge.getValue(p).toFixed(2)}`
    )
  );

  return {
    ceilingCharge,
    groundCharge: null, // Stage 6
    startingPoints,
    ceilingY,
    groundY,
  };
}
