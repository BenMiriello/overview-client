import { Vec3, AtmosphericModelData, VoronoiFieldData } from './types';
import { VoronoiField, VoronoiCell } from './VoronoiField';
import { SeededRNG, createSeededRNG } from './prng';
import { AtmosphericModel, AtmosphericConfig, DEFAULT_ATMOSPHERIC_CONFIG } from './AtmosphericModel';

export interface AtmosphereSimulatorConfig {
  // Charge dynamics
  chargeAccumulationRate: number; // Rate at which charge builds (per second)
  breakdownThreshold: number; // Intensity at which breakdown occurs
  postStrikeChargeFactor: number; // Multiplier for struck region (0.15 = retain 15%)
  postStrikeNearbyFactor: number; // Multiplier for nearby regions

  // Wind
  baseWindSpeed: number; // Units per second at cloud level
  windDirection: { x: number; z: number }; // Ground-level wind direction
  upperWindDirection: { x: number; z: number }; // Cloud-level wind direction (for shear)
  windAlpha: number; // Power law exponent for vertical wind profile

  // Bounds for cell management
  boundsRadius: number; // Cells beyond this are regenerated
  ceilingY: number;
  groundY: number;

  // Initial charge
  initialChargeRange: [number, number]; // Starting intensity range

  // Atmospheric layer config
  atmosphericConfig: AtmosphericConfig;
}

export const DEFAULT_SIMULATOR_CONFIG: AtmosphereSimulatorConfig = {
  chargeAccumulationRate: 0.09,
  breakdownThreshold: 0.85,
  postStrikeChargeFactor: 0.15,
  postStrikeNearbyFactor: 0.25,

  baseWindSpeed: 0.003, // ~19 m/s in real units at cloud level
  windDirection: { x: 1, z: 0 }, // Ground-level wind direction
  upperWindDirection: { x: 0.7, z: 0.7 }, // ~45 deg rotation at cloud level (wind shear)
  windAlpha: 0.3, // Power law exponent

  boundsRadius: 0.65,
  ceilingY: 0.5,
  groundY: -0.5,

  initialChargeRange: [0.05, 0.5],

  atmosphericConfig: DEFAULT_ATMOSPHERIC_CONFIG,
};

export interface BreakdownEvent {
  position: Vec3;
  intensity: number;
  cellIndex: number;
  timestamp: number;
}

export class AtmosphereSimulator {
  private config: AtmosphereSimulatorConfig;
  private rng: SeededRNG;

  // Mutable fields
  ceilingCharge: VoronoiField;
  groundCharge: VoronoiField;
  atmosphericCharge: VoronoiField;
  moisture: VoronoiField;
  ionizationSeeds: VoronoiField;

  // Track which ceiling cells correspond to which ground cells
  private ceilingToGroundMap: Map<number, number> = new Map();

  // Per-cell charge rate multipliers (0.5 to 1.5) to spread out breakdown timing
  private ceilingChargeRateMultipliers: number[] = [];

  constructor(seed: number, config: Partial<AtmosphereSimulatorConfig> = {}) {
    this.config = { ...DEFAULT_SIMULATOR_CONFIG, ...config };
    this.rng = createSeededRNG(seed);

    // Initialize all fields with reduced initial charge
    const { atmosphericConfig } = this.config;

    // Create ceiling charge with lower initial intensity
    this.ceilingCharge = this.createInitialCeilingCharge();

    // Create ground charge correlated with ceiling
    this.groundCharge = this.createCorrelatedGroundCharge();

    // Create 3D fields
    this.atmosphericCharge = this.createInitial3DField(
      atmosphericConfig.atmosphericChargeCellCount,
      atmosphericConfig.atmosphericChargeIntensityRange,
      atmosphericConfig.atmosphericChargeRadiusRange
    );

    this.moisture = this.createInitial3DField(
      atmosphericConfig.moistureCellCount,
      atmosphericConfig.moistureIntensityRange,
      atmosphericConfig.moistureRadiusRange
    );

    this.ionizationSeeds = this.createInitial3DField(
      atmosphericConfig.ionizationSeedCount,
      atmosphericConfig.ionizationIntensityRange,
      atmosphericConfig.ionizationRadiusRange
    );
  }

  /**
   * Update the atmosphere simulation. Called each frame.
   * Returns a BreakdownEvent if charge exceeds threshold, null otherwise.
   */
  update(dt: number): BreakdownEvent | null {
    // 1. Drift all cells with wind
    this.driftCells(dt);

    // 2. Accumulate ceiling charge
    this.accumulateCharge(dt);

    // 3. Update ground charge to follow ceiling
    this.updateGroundCharge();

    // 4. Recover 3D field intensities (fields replenish over time)
    this.recover3DFields(dt);

    // 5. Check for breakdown
    return this.checkBreakdown();
  }

  private recover3DFields(dt: number): void {
    const recoveryRate = 0.08;
    const ionizationDecayRate = 0.15;

    // Atmospheric charge recovers toward a baseline
    for (let i = 0; i < this.atmosphericCharge.cells.length; i++) {
      const cell = this.atmosphericCharge.cells[i];
      const baseline = 0.4;
      if (cell.intensity < baseline) {
        const newI = cell.intensity + recoveryRate * (baseline - cell.intensity) * dt;
        this.atmosphericCharge.setCellIntensity(i, Math.min(baseline, newI));
      }
    }

    // Moisture recovers toward baseline
    for (let i = 0; i < this.moisture.cells.length; i++) {
      const cell = this.moisture.cells[i];
      const baseline = 0.5;
      if (cell.intensity < baseline) {
        const newI = cell.intensity + recoveryRate * (baseline - cell.intensity) * dt;
        this.moisture.setCellIntensity(i, Math.min(baseline, newI));
      }
    }

    // Ionization decays after being boosted by strikes
    for (let i = 0; i < this.ionizationSeeds.cells.length; i++) {
      const cell = this.ionizationSeeds.cells[i];
      const baseline = 0.3;
      if (cell.intensity > baseline) {
        const newI = cell.intensity - ionizationDecayRate * (cell.intensity - baseline) * dt;
        this.ionizationSeeds.setCellIntensity(i, Math.max(baseline, newI));
      }
    }
  }

  /**
   * Called when a strike completes. Dissipates charge in the struck region.
   */
  onStrikeComplete(strikePosition: Vec3, dissipationRadius: number = 0.15): void {
    const { postStrikeChargeFactor, postStrikeNearbyFactor } = this.config;

    // Find cells near the strike and reduce their intensity
    for (let i = 0; i < this.ceilingCharge.cells.length; i++) {
      const cell = this.ceilingCharge.cells[i];
      const dist = this.distance2D(cell.center, strikePosition);

      if (dist < dissipationRadius * 0.5) {
        // Struck cell - heavy dissipation
        this.ceilingCharge.setCellIntensity(i, cell.intensity * postStrikeChargeFactor);
      } else if (dist < dissipationRadius) {
        // Nearby cell - partial dissipation
        const t = (dist - dissipationRadius * 0.5) / (dissipationRadius * 0.5);
        const factor = postStrikeChargeFactor + t * (postStrikeNearbyFactor - postStrikeChargeFactor);
        this.ceilingCharge.setCellIntensity(i, cell.intensity * factor);
      }
    }

    // Reduce 3D atmospheric charge near the strike path
    for (let i = 0; i < this.atmosphericCharge.cells.length; i++) {
      const cell = this.atmosphericCharge.cells[i];
      const dist = this.distance3D(cell.center, strikePosition);
      if (dist < dissipationRadius) {
        const factor = 0.1 + 0.4 * (dist / dissipationRadius);
        this.atmosphericCharge.setCellIntensity(i, cell.intensity * factor);
      }
    }

    // Moisture evaporation/disruption — dramatic near the channel
    for (let i = 0; i < this.moisture.cells.length; i++) {
      const cell = this.moisture.cells[i];
      const dist = this.distance3D(cell.center, strikePosition);
      if (dist < dissipationRadius) {
        const factor = 0.15 + 0.6 * (dist / dissipationRadius);
        this.moisture.setCellIntensity(i, cell.intensity * factor);
      }
    }

    // Ionization INCREASES strongly along the strike channel
    for (let i = 0; i < this.ionizationSeeds.cells.length; i++) {
      const cell = this.ionizationSeeds.cells[i];
      const dist = this.distance3D(cell.center, strikePosition);
      if (dist < dissipationRadius * 0.8) {
        const boost = (1.0 - dist / (dissipationRadius * 0.8)) * 0.9;
        this.ionizationSeeds.setCellIntensity(
          i, Math.min(1.0, cell.intensity + boost)
        );
      }
    }
  }

  /**
   * Get a snapshot of the current atmospheric state for simulation/rendering.
   */
  getAtmosphericModel(): AtmosphericModel {
    return {
      ceilingCharge: this.ceilingCharge,
      groundCharge: this.groundCharge,
      atmosphericCharge: this.atmosphericCharge,
      moisture: this.moisture,
      ionizationSeeds: this.ionizationSeeds,
      startingPoints: this.deriveStartingPoints(),
      ceilingY: this.config.ceilingY,
      groundY: this.config.groundY,
    };
  }

  /**
   * Set the base wind speed (in simulation units per second).
   */
  setWindSpeed(speed: number): void {
    this.config.baseWindSpeed = speed;
  }

  /**
   * Set the charge accumulation rate.
   * Used for adaptive pacing - slow down when buffer is low.
   */
  setChargeAccumulationRate(rate: number): void {
    this.config.chargeAccumulationRate = rate;
  }

  /**
   * Get the current charge accumulation rate.
   */
  getChargeAccumulationRate(): number {
    return this.config.chargeAccumulationRate;
  }

  /**
   * Get serializable data for rendering.
   */
  getAtmosphericModelData(): AtmosphericModelData {
    return {
      ceilingCharge: this.fieldToData(this.ceilingCharge),
      groundCharge: this.fieldToData(this.groundCharge),
      atmosphericCharge: this.fieldToData(this.atmosphericCharge),
      moisture: this.fieldToData(this.moisture),
      ionizationSeeds: this.fieldToData(this.ionizationSeeds),
      ceilingY: this.config.ceilingY,
      groundY: this.config.groundY,
    };
  }

  // ============ Private Methods ============

  private driftCells(dt: number): void {
    const { boundsRadius } = this.config;

    // Drift 2D ceiling cells
    for (let i = 0; i < this.ceilingCharge.cells.length; i++) {
      const cell = this.ceilingCharge.cells[i];
      const wind = this.windVectorAtHeight(cell.center.y);
      const newPos = {
        x: cell.center.x + wind.x * dt,
        y: cell.center.y,
        z: cell.center.z + wind.z * dt,
      };

      if (this.isOutOfBounds(newPos, boundsRadius)) {
        this.regenerateCeilingCell(i);
      } else {
        this.ceilingCharge.setCellPosition(i, newPos);
      }
    }

    // Drift 3D atmospheric charge
    this.driftField(this.atmosphericCharge, dt);

    // Drift 3D moisture
    this.driftField(this.moisture, dt);

    // Drift 3D ionization seeds
    this.driftField(this.ionizationSeeds, dt);
  }

  private driftField(field: VoronoiField, dt: number): void {
    const { boundsRadius } = this.config;

    for (let i = 0; i < field.cells.length; i++) {
      const cell = field.cells[i];
      const wind = this.windVectorAtHeight(cell.center.y);
      const newPos = {
        x: cell.center.x + wind.x * dt,
        y: cell.center.y,
        z: cell.center.z + wind.z * dt,
      };

      if (this.isOutOfBounds(newPos, boundsRadius * 1.5)) {
        this.regenerate3DCell(field, i);
      } else {
        field.setCellPosition(i, newPos);
      }
    }
  }

  private windSpeedAtHeight(y: number): number {
    // Power law wind profile: wind increases with altitude
    // normalizedY: 0 = ground, 1 = ceiling
    const normalizedY = (y - this.config.groundY) / (this.config.ceilingY - this.config.groundY);
    const clampedY = Math.max(0.01, Math.min(1, normalizedY));
    const minFraction = 0.15; // Ground wind is 15% of ceiling wind
    const heightFactor = minFraction + (1 - minFraction) * Math.pow(clampedY, this.config.windAlpha);
    return this.config.baseWindSpeed * heightFactor;
  }

  private windVectorAtHeight(y: number): { x: number; z: number } {
    // Interpolate direction from ground to upper level (wind shear)
    const normalizedY = (y - this.config.groundY) / (this.config.ceilingY - this.config.groundY);
    const t = Math.max(0, Math.min(1, normalizedY));
    const lo = this.config.windDirection;
    const hi = this.config.upperWindDirection;
    const dx = lo.x * (1 - t) + hi.x * t;
    const dz = lo.z * (1 - t) + hi.z * t;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const speed = this.windSpeedAtHeight(y);
    return { x: (dx / len) * speed, z: (dz / len) * speed };
  }

  private isOutOfBounds(pos: Vec3, radius: number): boolean {
    return Math.abs(pos.x) > radius || Math.abs(pos.z) > radius;
  }

  private regenerateCeilingCell(index: number): void {
    const { boundsRadius, windDirection, ceilingY, atmosphericConfig } = this.config;

    // New cell enters from upwind edge
    const entryX = -boundsRadius * Math.sign(windDirection.x || 1);
    const entryZ = (this.rng.next() - 0.5) * boundsRadius * 2;

    const newIntensity =
      this.config.initialChargeRange[0] +
      this.rng.next() * (this.config.initialChargeRange[1] - this.config.initialChargeRange[0]);

    const newRadius =
      atmosphericConfig.ceilingChargeRadiusRange[0] +
      this.rng.next() *
        (atmosphericConfig.ceilingChargeRadiusRange[1] - atmosphericConfig.ceilingChargeRadiusRange[0]);

    this.ceilingCharge.setCellPosition(index, { x: entryX, y: ceilingY, z: entryZ });
    this.ceilingCharge.setCellIntensity(index, newIntensity);
    this.ceilingCharge.setCellRadius(index, newRadius);

    // Assign new rate multiplier for varied breakdown timing
    this.ceilingChargeRateMultipliers[index] = 0.5 + this.rng.next() * 1.0;

    // Also update the correlated ground cell
    const groundIndex = this.ceilingToGroundMap.get(index);
    if (groundIndex !== undefined) {
      const jitterX = (this.rng.next() - 0.5) * 0.1;
      const jitterZ = (this.rng.next() - 0.5) * 0.1;
      this.groundCharge.setCellPosition(groundIndex, {
        x: entryX + jitterX,
        y: this.config.groundY,
        z: entryZ + jitterZ,
      });
      this.groundCharge.setCellIntensity(groundIndex, newIntensity * (0.7 + this.rng.next() * 0.3));
    }
  }

  private regenerate3DCell(field: VoronoiField, index: number): void {
    const { boundsRadius, windDirection, ceilingY, groundY } = this.config;

    // Entry from upwind edge
    const entryX = -boundsRadius * 1.2 * Math.sign(windDirection.x || 1);
    const entryZ = (this.rng.next() - 0.5) * boundsRadius * 2;
    const entryY = groundY + this.rng.next() * (ceilingY - groundY);

    field.setCellPosition(index, { x: entryX, y: entryY, z: entryZ });
    field.setCellIntensity(index, 0.3 + this.rng.next() * 0.5);
  }

  private accumulateCharge(dt: number): void {
    const { chargeAccumulationRate } = this.config;

    for (let i = 0; i < this.ceilingCharge.cells.length; i++) {
      const cell = this.ceilingCharge.cells[i];
      // Per-cell rate variation (0.5x to 1.5x) spreads out breakdown timing
      const rateMultiplier = this.ceilingChargeRateMultipliers[i] ?? 1.0;
      const cellRate = chargeAccumulationRate * rateMultiplier;
      // Asymptotic growth: dI/dt = rate * (1 - I)
      const newIntensity = cell.intensity + cellRate * (1 - cell.intensity) * dt;
      this.ceilingCharge.setCellIntensity(i, Math.min(1.0, newIntensity));
    }
  }

  private updateGroundCharge(): void {
    // Ground charge follows ceiling with slight lag
    for (let i = 0; i < this.ceilingCharge.cells.length; i++) {
      const ceilingCell = this.ceilingCharge.cells[i];
      const groundIndex = this.ceilingToGroundMap.get(i);

      if (groundIndex !== undefined && groundIndex < this.groundCharge.cells.length) {
        const groundCell = this.groundCharge.cells[groundIndex];

        // Ground position follows ceiling with offset
        const jitterX = (groundCell.center.x - ceilingCell.center.x) * 0.95;
        const jitterZ = (groundCell.center.z - ceilingCell.center.z) * 0.95;
        this.groundCharge.setCellPosition(groundIndex, {
          x: ceilingCell.center.x + jitterX,
          y: this.config.groundY,
          z: ceilingCell.center.z + jitterZ,
        });

        // Ground intensity tracks ceiling
        const targetIntensity = ceilingCell.intensity * 0.8;
        const currentIntensity = groundCell.intensity;
        this.groundCharge.setCellIntensity(groundIndex, currentIntensity + (targetIntensity - currentIntensity) * 0.1);
      }
    }
  }

  private checkBreakdown(): BreakdownEvent | null {
    const { breakdownThreshold } = this.config;

    let maxIntensity = 0;
    let maxIndex = -1;
    let maxPosition: Vec3 | null = null;

    for (let i = 0; i < this.ceilingCharge.cells.length; i++) {
      const cell = this.ceilingCharge.cells[i];
      if (cell.intensity > maxIntensity) {
        maxIntensity = cell.intensity;
        maxIndex = i;
        maxPosition = { ...cell.center };
      }
    }

    if (maxIntensity >= breakdownThreshold && maxPosition) {
      return {
        position: maxPosition,
        intensity: maxIntensity,
        cellIndex: maxIndex,
        timestamp: performance.now(),
      };
    }

    return null;
  }

  private deriveStartingPoints(): Vec3[] {
    // Return positions sorted by intensity
    return this.ceilingCharge.cells
      .map((cell) => ({ pos: { ...cell.center }, intensity: cell.intensity }))
      .sort((a, b) => b.intensity - a.intensity)
      .filter((p) => p.intensity >= 0.3)
      .map((p) => p.pos);
  }

  private createInitialCeilingCharge(): VoronoiField {
    const { ceilingY, boundsRadius, initialChargeRange, atmosphericConfig } = this.config;
    const cells: VoronoiCell[] = [];
    this.ceilingChargeRateMultipliers = [];

    for (let i = 0; i < atmosphericConfig.ceilingChargeCellCount; i++) {
      const angle = this.rng.next() * Math.PI * 2;
      const dist = Math.sqrt(this.rng.next()) * boundsRadius;

      cells.push({
        center: {
          x: Math.cos(angle) * dist,
          y: ceilingY,
          z: Math.sin(angle) * dist,
        },
        intensity: initialChargeRange[0] + this.rng.next() * (initialChargeRange[1] - initialChargeRange[0]),
        falloffRadius:
          atmosphericConfig.ceilingChargeRadiusRange[0] +
          this.rng.next() *
            (atmosphericConfig.ceilingChargeRadiusRange[1] - atmosphericConfig.ceilingChargeRadiusRange[0]),
      });

      // Per-cell charge rate: 0.5x to 1.5x creates ~16s spread in breakdown timing
      this.ceilingChargeRateMultipliers.push(0.5 + this.rng.next() * 1.0);
    }

    return new VoronoiField(cells, { is2D: true, fixedY: ceilingY });
  }

  private createCorrelatedGroundCharge(): VoronoiField {
    const { groundY, atmosphericConfig } = this.config;
    const cells: VoronoiCell[] = [];

    // Create ground cells correlated with ceiling
    this.ceilingCharge.cells.forEach((ceilingCell, i) => {
      const jitterX = (this.rng.next() - 0.5) * 0.1;
      const jitterZ = (this.rng.next() - 0.5) * 0.1;

      cells.push({
        center: {
          x: ceilingCell.center.x + jitterX,
          y: groundY,
          z: ceilingCell.center.z + jitterZ,
        },
        intensity: ceilingCell.intensity * (0.7 + this.rng.next() * 0.3),
        falloffRadius: ceilingCell.falloffRadius * (0.8 + this.rng.next() * 0.4),
      });

      // Track the mapping
      this.ceilingToGroundMap.set(i, i);
    });

    // Add a couple independent ground features
    const extraCells = 1 + Math.floor(this.rng.next() * 2);
    for (let i = 0; i < extraCells; i++) {
      const angle = this.rng.next() * Math.PI * 2;
      const dist = this.rng.next() * this.config.boundsRadius * 0.8;

      cells.push({
        center: {
          x: Math.cos(angle) * dist,
          y: groundY,
          z: Math.sin(angle) * dist,
        },
        intensity:
          atmosphericConfig.groundChargeIntensityRange[0] +
          this.rng.next() *
            (atmosphericConfig.groundChargeIntensityRange[1] - atmosphericConfig.groundChargeIntensityRange[0]),
        falloffRadius:
          atmosphericConfig.groundChargeRadiusRange[0] +
          this.rng.next() * (atmosphericConfig.groundChargeRadiusRange[1] - atmosphericConfig.groundChargeRadiusRange[0]),
      });
    }

    return new VoronoiField(cells, { is2D: true, fixedY: groundY });
  }

  private createInitial3DField(
    cellCount: number,
    intensityRange: [number, number],
    radiusRange: [number, number]
  ): VoronoiField {
    const { boundsRadius, ceilingY, groundY } = this.config;
    const cells: VoronoiCell[] = [];
    const verticalSpan = ceilingY - groundY;

    // Stratified vertical distribution for better coverage
    const verticalLayers = Math.ceil(Math.sqrt(cellCount));
    const cellsPerLayer = Math.ceil(cellCount / verticalLayers);
    let created = 0;

    for (let layer = 0; layer < verticalLayers && created < cellCount; layer++) {
      const layerTop = ceilingY - (layer / verticalLayers) * verticalSpan;
      const layerBottom = ceilingY - ((layer + 1) / verticalLayers) * verticalSpan;

      for (let i = 0; i < cellsPerLayer && created < cellCount; i++) {
        const angle = this.rng.next() * Math.PI * 2;
        const dist = Math.sqrt(this.rng.next()) * boundsRadius;
        const y = layerBottom + this.rng.next() * (layerTop - layerBottom);

        cells.push({
          center: {
            x: Math.cos(angle) * dist,
            y,
            z: Math.sin(angle) * dist,
          },
          intensity: intensityRange[0] + this.rng.next() * (intensityRange[1] - intensityRange[0]),
          falloffRadius: radiusRange[0] + this.rng.next() * (radiusRange[1] - radiusRange[0]),
        });
        created++;
      }
    }

    return new VoronoiField(cells, { is2D: false });
  }

  private fieldToData(field: VoronoiField): VoronoiFieldData {
    const config = field.getConfig();
    return {
      cells: field.cells.map((cell) => ({
        center: { ...cell.center },
        intensity: cell.intensity,
        falloffRadius: cell.falloffRadius,
      })),
      is2D: config.is2D,
      fixedY: config.fixedY,
    };
  }

  private distance2D(a: Vec3, b: Vec3): number {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  private distance3D(a: Vec3, b: Vec3): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
}
