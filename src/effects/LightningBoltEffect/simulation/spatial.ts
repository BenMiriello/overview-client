import { Vec3 } from './types';

export class SpatialGrid {
  private cells: Map<string, Vec3[]> = new Map();
  private cellSize: number;

  constructor(cellSize: number = 0.05) {
    this.cellSize = cellSize;
  }

  add(point: Vec3): void {
    const key = this.cellKey(point);
    let cell = this.cells.get(key);
    if (!cell) {
      cell = [];
      this.cells.set(key, cell);
    }
    cell.push(point);
  }

  getNearby(point: Vec3, radius: number): Vec3[] {
    const result: Vec3[] = [];
    const cellRadius = Math.ceil(radius / this.cellSize);
    const cx = Math.floor(point.x / this.cellSize);
    const cy = Math.floor(point.y / this.cellSize);
    const cz = Math.floor(point.z / this.cellSize);
    const r2 = radius * radius;

    for (let dx = -cellRadius; dx <= cellRadius; dx++) {
      for (let dy = -cellRadius; dy <= cellRadius; dy++) {
        for (let dz = -cellRadius; dz <= cellRadius; dz++) {
          const key = `${cx + dx},${cy + dy},${cz + dz}`;
          const cell = this.cells.get(key);
          if (!cell) continue;
          for (let i = 0; i < cell.length; i++) {
            const p = cell[i];
            const ddx = point.x - p.x;
            const ddy = point.y - p.y;
            const ddz = point.z - p.z;
            if (ddx * ddx + ddy * ddy + ddz * ddz <= r2) {
              result.push(p);
            }
          }
        }
      }
    }

    return result;
  }

  private cellKey(p: Vec3): string {
    return `${Math.floor(p.x / this.cellSize)},${Math.floor(p.y / this.cellSize)},${Math.floor(p.z / this.cellSize)}`;
  }
}
