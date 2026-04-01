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
  ceilingChargeCellCount: 16,
  ceilingChargeIntensityRange: [0.5, 1.0],
  ceilingChargeRadiusRange: [SCALE.CHARGE_POCKET_RADIUS.MIN, SCALE.CHARGE_POCKET_RADIUS.MAX],

  groundChargeCellCount: 22,
  groundChargeIntensityRange: [0.3, 0.8],
  groundChargeRadiusRange: [SCALE.CHARGE_POCKET_RADIUS.MIN * 2.0, SCALE.CHARGE_POCKET_RADIUS.MAX * 1.8],

  atmosphericChargeCellCount: 32,
  atmosphericChargeIntensityRange: [0.3, 0.7],
  atmosphericChargeRadiusRange: [SCALE.CHARGE_POCKET_RADIUS.MIN * 1.2, SCALE.CHARGE_POCKET_RADIUS.MAX * 1.2],
  columnarChargeFraction: 0.6,

  moistureCellCount: 16,
  moistureIntensityRange: [0.4, 0.9],
  moistureRadiusRange: [SCALE.MOISTURE_REGION_RADIUS.MIN, SCALE.MOISTURE_REGION_RADIUS.MAX],

  ionizationSeedCount: 24,
  ionizationIntensityRange: [0.6, 1.0],
  ionizationRadiusRange: [SCALE.IONIZATION_SEED_RADIUS.MIN, SCALE.IONIZATION_SEED_RADIUS.MAX],

  boundsRadius: 0.65,
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
 * Uses stratified sampling to ensure better coverage across the area.
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

  // Use stratified sampling for better coverage
  // Divide the area into rings and sectors
  const rings = Math.ceil(Math.sqrt(cellCount / 2));
  const sectorsPerRing = Math.ceil(cellCount / rings);
  let cellsCreated = 0;

  for (let ring = 0; ring < rings && cellsCreated < cellCount; ring++) {
    const ringInnerRadius = (ring / rings) * boundsRadius;
    const ringOuterRadius = ((ring + 1) / rings) * boundsRadius;

    for (let sector = 0; sector < sectorsPerRing && cellsCreated < cellCount; sector++) {
      const sectorAngleStart = (sector / sectorsPerRing) * Math.PI * 2;
      const sectorAngleEnd = ((sector + 1) / sectorsPerRing) * Math.PI * 2;

      // Random position within this ring-sector cell
      const angle = sectorAngleStart + rng.next() * (sectorAngleEnd - sectorAngleStart);
      // Use sqrt for uniform area distribution within the ring
      const t = rng.next();
      const dist = Math.sqrt(
        ringInnerRadius * ringInnerRadius + t * (ringOuterRadius * ringOuterRadius - ringInnerRadius * ringInnerRadius)
      );

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
      cellsCreated++;
    }
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
 * Uses stratified vertical distribution for better coverage.
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

  // Columnar cells: extend from ceiling charge downward with stratified vertical distribution
  const ceilingCells = ceilingCharge.cells;
  const verticalLayers = Math.ceil(columnarCells / ceilingCells.length);

  let columnarCreated = 0;
  for (let layer = 0; layer < verticalLayers && columnarCreated < columnarCells; layer++) {
    // Stratify vertically: divide ceiling-to-ground into layers
    const layerTop = ceilingY - (layer / verticalLayers) * verticalSpan;
    const layerBottom = ceilingY - ((layer + 1) / verticalLayers) * verticalSpan;

    for (let i = 0; i < ceilingCells.length && columnarCreated < columnarCells; i++) {
      const source = ceilingCells[i];

      // Random Y within this vertical layer
      const y = layerBottom + rng.next() * (layerTop - layerBottom);

      // Moderate XZ jitter to stay near the column
      const jitterX = (rng.next() - 0.5) * 0.15;
      const jitterZ = (rng.next() - 0.5) * 0.15;

      const falloffRadius =
        config.atmosphericChargeRadiusRange[0] +
        rng.next() * (config.atmosphericChargeRadiusRange[1] - config.atmosphericChargeRadiusRange[0]);

      cells.push({
        center: {
          x: source.center.x + jitterX,
          y,
          z: source.center.z + jitterZ,
        },
        intensity:
          config.atmosphericChargeIntensityRange[0] +
          rng.next() * (config.atmosphericChargeIntensityRange[1] - config.atmosphericChargeIntensityRange[0]),
        falloffRadius,
      });
      columnarCreated++;
    }
  }

  // Independent cells: stratified 3D positions for better volume coverage
  const indVerticalLayers = Math.ceil(Math.cbrt(independentCells));
  const indCellsPerLayer = Math.ceil(independentCells / indVerticalLayers);
  let indCreated = 0;

  for (let layer = 0; layer < indVerticalLayers && indCreated < independentCells; layer++) {
    const layerTop = ceilingY - (layer / indVerticalLayers) * verticalSpan;
    const layerBottom = ceilingY - ((layer + 1) / indVerticalLayers) * verticalSpan;

    for (let i = 0; i < indCellsPerLayer && indCreated < independentCells; i++) {
      const angle = rng.next() * Math.PI * 2;
      // Uniform distribution within bounds (no large multiplier)
      const dist = Math.sqrt(rng.next()) * config.boundsRadius;
      const y = layerBottom + rng.next() * (layerTop - layerBottom);

      const falloffRadius =
        config.atmosphericChargeRadiusRange[0] +
        rng.next() * (config.atmosphericChargeRadiusRange[1] - config.atmosphericChargeRadiusRange[0]);

      cells.push({
        center: {
          x: Math.cos(angle) * dist,
          y,
          z: Math.sin(angle) * dist,
        },
        intensity:
          config.atmosphericChargeIntensityRange[0] +
          rng.next() * (config.atmosphericChargeIntensityRange[1] - config.atmosphericChargeIntensityRange[0]),
        falloffRadius,
      });
      indCreated++;
    }
  }

  return new VoronoiField(cells, { is2D: false });
}

/**
 * Generate 3D moisture field.
 * Moisture lowers the breakdown threshold, making paths prefer moist regions.
 * Moisture distribution correlates loosely with convection (similar to charge)
 * but has its own independent variation.
 * Uses stratified distribution for better volume coverage.
 */
function generateMoistureField(
  rng: SeededRNG,
  ceilingY: number,
  groundY: number,
  config: AtmosphericConfig
): VoronoiField {
  const cells: VoronoiCell[] = [];
  const verticalSpan = ceilingY - groundY;

  // Stratified vertical distribution
  const verticalLayers = Math.ceil(Math.sqrt(config.moistureCellCount));
  const cellsPerLayer = Math.ceil(config.moistureCellCount / verticalLayers);
  let created = 0;

  for (let layer = 0; layer < verticalLayers && created < config.moistureCellCount; layer++) {
    const layerTop = ceilingY - (layer / verticalLayers) * verticalSpan;
    const layerBottom = ceilingY - ((layer + 1) / verticalLayers) * verticalSpan;

    for (let i = 0; i < cellsPerLayer && created < config.moistureCellCount; i++) {
      const angle = rng.next() * Math.PI * 2;
      const dist = Math.sqrt(rng.next()) * config.boundsRadius;
      const y = layerBottom + rng.next() * (layerTop - layerBottom);

      const falloffRadius =
        config.moistureRadiusRange[0] +
        rng.next() * (config.moistureRadiusRange[1] - config.moistureRadiusRange[0]);

      cells.push({
        center: {
          x: Math.cos(angle) * dist,
          y,
          z: Math.sin(angle) * dist,
        },
        intensity:
          config.moistureIntensityRange[0] +
          rng.next() * (config.moistureIntensityRange[1] - config.moistureIntensityRange[0]),
        falloffRadius,
      });
      created++;
    }
  }

  return new VoronoiField(cells, { is2D: false });
}

/**
 * Generate ionization seeds (small pre-ionized points).
 * Represents cosmic ray tracks, previous discharge remnants, local breakdown.
 * Many small points with high local attraction.
 * Uses stratified distribution for better volume coverage.
 */
function generateIonizationSeeds(
  rng: SeededRNG,
  ceilingY: number,
  groundY: number,
  config: AtmosphericConfig
): VoronoiField {
  const cells: VoronoiCell[] = [];
  const verticalSpan = ceilingY - groundY;

  // Stratified vertical distribution
  const verticalLayers = Math.ceil(Math.sqrt(config.ionizationSeedCount));
  const cellsPerLayer = Math.ceil(config.ionizationSeedCount / verticalLayers);
  let created = 0;

  for (let layer = 0; layer < verticalLayers && created < config.ionizationSeedCount; layer++) {
    const layerTop = ceilingY - (layer / verticalLayers) * verticalSpan;
    const layerBottom = ceilingY - ((layer + 1) / verticalLayers) * verticalSpan;

    for (let i = 0; i < cellsPerLayer && created < config.ionizationSeedCount; i++) {
      const angle = rng.next() * Math.PI * 2;
      const dist = Math.sqrt(rng.next()) * config.boundsRadius;
      const y = layerBottom + rng.next() * (layerTop - layerBottom);

      const falloffRadius =
        config.ionizationRadiusRange[0] +
        rng.next() * (config.ionizationRadiusRange[1] - config.ionizationRadiusRange[0]);

      cells.push({
        center: {
          x: Math.cos(angle) * dist,
          y,
          z: Math.sin(angle) * dist,
        },
        intensity:
          config.ionizationIntensityRange[0] +
          rng.next() * (config.ionizationIntensityRange[1] - config.ionizationIntensityRange[0]),
        falloffRadius,
      });
      created++;
    }
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
