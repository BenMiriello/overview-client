import { Vec3 } from './types';

export interface VoronoiCell {
  center: Vec3;
  intensity: number; // Peak value at center (0-1)
  falloffRadius: number; // Distance at which value → 0
}

/**
 * Voronoi-based scalar field with smooth sinusoidal blending between cells.
 * Used for atmospheric properties like charge distribution and moisture.
 *
 * Each cell contributes: intensity × (cos(distance/radius × π) + 1) / 2
 * Multiple overlapping cells blend additively.
 */
export class VoronoiField {
  readonly cells: VoronoiCell[];
  private readonly is2D: boolean;
  private readonly fixedY: number;

  constructor(cells: VoronoiCell[], options?: { is2D?: boolean; fixedY?: number }) {
    this.cells = cells;
    this.is2D = options?.is2D ?? false;
    this.fixedY = options?.fixedY ?? 0;
  }

  /**
   * Get interpolated value at a point using sinusoidal falloff.
   * Values from overlapping cells are summed.
   */
  getValue(point: Vec3): number {
    let total = 0;

    for (const cell of this.cells) {
      const dist = this.is2D
        ? this.distance2D(point, cell.center)
        : this.distance3D(point, cell.center);

      if (dist < cell.falloffRadius) {
        const t = dist / cell.falloffRadius;
        const falloff = (Math.cos(t * Math.PI) + 1) * 0.5;
        total += cell.intensity * falloff;
      }
    }

    return total;
  }

  /**
   * Get gradient direction (toward increasing field value).
   * Returns normalized vector pointing toward higher values.
   */
  getGradient(point: Vec3): Vec3 {
    const eps = 0.001;

    const dx =
      this.getValue({ x: point.x + eps, y: point.y, z: point.z }) -
      this.getValue({ x: point.x - eps, y: point.y, z: point.z });

    const dy = this.is2D
      ? 0
      : this.getValue({ x: point.x, y: point.y + eps, z: point.z }) -
        this.getValue({ x: point.x, y: point.y - eps, z: point.z });

    const dz =
      this.getValue({ x: point.x, y: point.y, z: point.z + eps }) -
      this.getValue({ x: point.x, y: point.y, z: point.z - eps });

    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-10) {
      return { x: 0, y: 0, z: 0 };
    }

    return { x: dx / len, y: dy / len, z: dz / len };
  }

  /**
   * Find local maxima in the field.
   * For simple case, returns cell centers sorted by intensity.
   */
  getLocalMaxima(): Vec3[] {
    return [...this.cells]
      .sort((a, b) => b.intensity - a.intensity)
      .map((cell) => ({ ...cell.center }));
  }

  /**
   * Sample the field on a grid for visualization or debugging.
   */
  sampleGrid(
    bounds: { min: Vec3; max: Vec3 },
    resolution: number
  ): { position: Vec3; value: number }[] {
    const samples: { position: Vec3; value: number }[] = [];
    const stepX = (bounds.max.x - bounds.min.x) / resolution;
    const stepY = this.is2D ? 1 : (bounds.max.y - bounds.min.y) / resolution;
    const stepZ = (bounds.max.z - bounds.min.z) / resolution;

    const yStart = this.is2D ? this.fixedY : bounds.min.y;
    const yEnd = this.is2D ? this.fixedY : bounds.max.y;
    const yIterations = this.is2D ? 1 : resolution;

    for (let i = 0; i <= resolution; i++) {
      for (let j = 0; j <= yIterations; j++) {
        for (let k = 0; k <= resolution; k++) {
          const position = {
            x: bounds.min.x + i * stepX,
            y: this.is2D ? this.fixedY : bounds.min.y + j * stepY,
            z: bounds.min.z + k * stepZ,
          };
          samples.push({ position, value: this.getValue(position) });
        }
      }
    }

    return samples;
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
