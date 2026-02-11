import { Vec3 } from './types';
import { VoronoiField, VoronoiCell } from './VoronoiField';
import { SeededRNG } from './prng';
import { SCALE } from './constants';

export interface AtmosphericConfig {
  // Ceiling charge (2D, y = ceilingY)
  ceilingChargeCellCount: number;
  ceilingChargeIntensityRange: [number, number];
  ceilingChargeRadiusRange: [number, number];

  // Ground charge (2D, y = groundY)
  groundChargeCellCount: number;
  groundChargeIntensityRange: [number, number];
  groundChargeRadiusRange: [number, number];

  // 3D atmospheric charge (volumetric)
  atmosphericChargeCellCount: number;
  atmosphericChargeIntensityRange: [number, number];
  atmosphericChargeRadiusRange: [number, number];
  columnarChargeFraction: number; // Fraction derived from ceiling (0-1)

  // 3D moisture field (volumetric)
  moistureCellCount: number;
  moistureIntensityRange: [number, number];
  moistureRadiusRange: [number, number];

  // Ionization seeds (sparse 3D points)
  ionizationSeedCount: number;
  ionizationIntensityRange: [number, number];
  ionizationRadiusRange: [number, number];

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

  atmosphericChargeCellCount: 6,
  atmosphericChargeIntensityRange: [0.3, 0.7],
  atmosphericChargeRadiusRange: [SCALE.CHARGE_POCKET_RADIUS.MIN * 1.5, SCALE.CHARGE_POCKET_RADIUS.MAX * 1.5],
  columnarChargeFraction: 0.6,

  moistureCellCount: 5,
  moistureIntensityRange: [0.4, 0.9],
  moistureRadiusRange: [SCALE.MOISTURE_REGION_RADIUS.MIN, SCALE.MOISTURE_REGION_RADIUS.MAX],

  ionizationSeedCount: 12,
  ionizationIntensityRange: [0.6, 1.0],
  ionizationRadiusRange: [SCALE.IONIZATION_SEED_RADIUS.MIN, SCALE.IONIZATION_SEED_RADIUS.MAX],

  boundsRadius: 0.4,
};

export interface AtmosphericModel {
  ceilingCharge: VoronoiField;
  groundCharge: VoronoiField;
  atmosphericCharge: VoronoiField;
  moisture: VoronoiField;
  ionizationSeeds: VoronoiField;
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
 * Generate 3D atmospheric charge field.
 * Combines columnar charge (extending from ceiling) with independent 3D pockets.
 * Columnar charge represents convective charge separation.
 * Independent pockets represent cosmic ray ionization, previous strikes, turbulence.
 */
function generate3DAtmosphericCharge(
  ceilingCharge: VoronoiField,
  rng: SeededRNG,
  ceilingY: number,
  groundY: number,
  config: AtmosphericConfig
): VoronoiField {
  const cells: VoronoiCell[] = [];
  const totalCells = config.atmosphericChargeCellCount;
  const columnarCells = Math.floor(totalCells * config.columnarChargeFraction);
  const independentCells = totalCells - columnarCells;
  const verticalSpan = ceilingY - groundY;

  // Columnar cells: extend from ceiling charge downward
  const ceilingCells = ceilingCharge.cells;
  for (let i = 0; i < columnarCells && i < ceilingCells.length; i++) {
    const source = ceilingCells[i % ceilingCells.length];

    // Extended vertical span (4x, centered)
    const heightFactor = rng.next() * 4 - 1.5;
    const y = groundY + verticalSpan * heightFactor;

    // Large XZ jitter (2x)
    const jitterX = (rng.next() - 0.5) * 2.0;
    const jitterZ = (rng.next() - 0.5) * 2.0;

    cells.push({
      center: {
        x: source.center.x + jitterX,
        y,
        z: source.center.z + jitterZ,
      },
      intensity:
        config.atmosphericChargeIntensityRange[0] +
        rng.next() * (config.atmosphericChargeIntensityRange[1] - config.atmosphericChargeIntensityRange[0]),
      falloffRadius:
        config.atmosphericChargeRadiusRange[0] +
        rng.next() * (config.atmosphericChargeRadiusRange[1] - config.atmosphericChargeRadiusRange[0]),
    });
  }

  // Independent cells: random 3D positions (sqrt for uniform area distribution)
  for (let i = 0; i < independentCells; i++) {
    const angle = rng.next() * Math.PI * 2;
    const dist = Math.sqrt(rng.next()) * config.boundsRadius * 6.0;
    const heightFactor = rng.next() * 4 - 1.5;
    const y = groundY + verticalSpan * heightFactor;

    cells.push({
      center: {
        x: Math.cos(angle) * dist,
        y,
        z: Math.sin(angle) * dist,
      },
      intensity:
        config.atmosphericChargeIntensityRange[0] +
        rng.next() * (config.atmosphericChargeIntensityRange[1] - config.atmosphericChargeIntensityRange[0]),
      falloffRadius:
        config.atmosphericChargeRadiusRange[0] +
        rng.next() * (config.atmosphericChargeRadiusRange[1] - config.atmosphericChargeRadiusRange[0]),
    });
  }

  return new VoronoiField(cells, { is2D: false });
}

/**
 * Generate 3D moisture field.
 * Moisture lowers the breakdown threshold, making paths prefer moist regions.
 * Moisture distribution correlates loosely with convection (similar to charge)
 * but has its own independent variation.
 */
function generateMoistureField(
  rng: SeededRNG,
  ceilingY: number,
  groundY: number,
  config: AtmosphericConfig
): VoronoiField {
  const cells: VoronoiCell[] = [];
  const verticalSpan = ceilingY - groundY;

  for (let i = 0; i < config.moistureCellCount; i++) {
    const angle = rng.next() * Math.PI * 2;
    const dist = Math.sqrt(rng.next()) * config.boundsRadius * 6.0;
    const heightFactor = rng.next() * 4 - 1.5;
    const y = groundY + verticalSpan * heightFactor;

    cells.push({
      center: {
        x: Math.cos(angle) * dist,
        y,
        z: Math.sin(angle) * dist,
      },
      intensity:
        config.moistureIntensityRange[0] +
        rng.next() * (config.moistureIntensityRange[1] - config.moistureIntensityRange[0]),
      falloffRadius:
        config.moistureRadiusRange[0] +
        rng.next() * (config.moistureRadiusRange[1] - config.moistureRadiusRange[0]),
    });
  }

  return new VoronoiField(cells, { is2D: false });
}

/**
 * Generate ionization seeds (small pre-ionized points).
 * Represents cosmic ray tracks, previous discharge remnants, local breakdown.
 * Many small points with high local attraction.
 */
function generateIonizationSeeds(
  rng: SeededRNG,
  ceilingY: number,
  groundY: number,
  config: AtmosphericConfig
): VoronoiField {
  const cells: VoronoiCell[] = [];
  const verticalSpan = ceilingY - groundY;

  for (let i = 0; i < config.ionizationSeedCount; i++) {
    const angle = rng.next() * Math.PI * 2;
    const dist = Math.sqrt(rng.next()) * config.boundsRadius * 6.0;
    const heightFactor = rng.next() * 4 - 1.5;
    const y = groundY + verticalSpan * heightFactor;

    cells.push({
      center: {
        x: Math.cos(angle) * dist,
        y,
        z: Math.sin(angle) * dist,
      },
      intensity:
        config.ionizationIntensityRange[0] +
        rng.next() * (config.ionizationIntensityRange[1] - config.ionizationIntensityRange[0]),
      falloffRadius:
        config.ionizationRadiusRange[0] +
        rng.next() * (config.ionizationRadiusRange[1] - config.ionizationRadiusRange[0]),
    });
  }

  return new VoronoiField(cells, { is2D: false });
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

  // Generate 3D atmospheric charge
  const atmosphericCharge = generate3DAtmosphericCharge(ceilingCharge, rng, ceilingY, groundY, config);

  // Generate 3D moisture field
  const moisture = generateMoistureField(rng, ceilingY, groundY, config);

  // Generate ionization seeds
  const ionizationSeeds = generateIonizationSeeds(rng, ceilingY, groundY, config);

  console.log('[Atmospheric] Ceiling charge cells:', ceilingCharge.cells.length);
  console.log('[Atmospheric] Ground charge cells:', groundCharge.cells.length);
  console.log('[Atmospheric] 3D atmospheric charge cells:', atmosphericCharge.cells.length);
  console.log('[Atmospheric] Moisture cells:', moisture.cells.length);
  console.log('[Atmospheric] Ionization seeds:', ionizationSeeds.cells.length);
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
    atmosphericCharge,
    moisture,
    ionizationSeeds,
    startingPoints,
    ceilingY,
    groundY,
  };
}
