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
  groundCharge: VoronoiField;
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
 * Generate ground charge as a smeared mirror of ceiling charge.
 * Ground charge is induced BY ceiling charge via electrostatic induction.
 * Jitter creates path variety while maintaining physical causality.
 */
function generateGroundCharge(
  ceilingCharge: VoronoiField,
  rng: SeededRNG,
  groundY: number,
  config: AtmosphericConfig
): VoronoiField {
  const cells: VoronoiCell[] = [];

  // Induced cells (correlated with ceiling)
  for (const ceilingCell of ceilingCharge.cells) {
    const jitterX = (rng.next() - 0.5) * 0.1;
    const jitterZ = (rng.next() - 0.5) * 0.1;

    cells.push({
      center: {
        x: ceilingCell.center.x + jitterX,
        y: groundY,
        z: ceilingCell.center.z + jitterZ,
      },
      intensity: ceilingCell.intensity * (0.7 + rng.next() * 0.3),
      falloffRadius: ceilingCell.falloffRadius * (0.8 + rng.next() * 0.4),
    });
  }

  // 1-2 independent local features (metal, water, etc.)
  const extraCells = 1 + Math.floor(rng.next() * 2);
  for (let i = 0; i < extraCells; i++) {
    const angle = rng.next() * Math.PI * 2;
    const dist = rng.next() * config.boundsRadius * 0.8;

    cells.push({
      center: {
        x: Math.cos(angle) * dist,
        y: groundY,
        z: Math.sin(angle) * dist,
      },
      intensity:
        config.groundChargeIntensityRange[0] +
        rng.next() * (config.groundChargeIntensityRange[1] - config.groundChargeIntensityRange[0]),
      falloffRadius:
        config.groundChargeRadiusRange[0] +
        rng.next() * (config.groundChargeRadiusRange[1] - config.groundChargeRadiusRange[0]),
    });
  }

  return new VoronoiField(cells, { is2D: true, fixedY: groundY });
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

  // Generate ground charge as smeared mirror of ceiling charge
  const groundCharge = generateGroundCharge(ceilingCharge, rng, groundY, config);

  console.log('[Atmospheric] Ceiling charge cells:', ceilingCharge.cells.length);
  console.log('[Atmospheric] Ground charge cells:', groundCharge.cells.length);
  console.log(
    '[Atmospheric] Starting points:',
    startingPoints.map(
      (p) =>
        `(${p.x.toFixed(3)}, ${p.z.toFixed(3)}) intensity=${ceilingCharge.getValue(p).toFixed(2)}`
    )
  );

  return {
    ceilingCharge,
    groundCharge,
    startingPoints,
    ceilingY,
    groundY,
  };
}
