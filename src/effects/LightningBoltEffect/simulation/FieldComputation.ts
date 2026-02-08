import { Vec3, FieldConfig } from './types';
import { createNoise3D } from './noise';
import { SpatialGrid } from './spatial';

export interface FieldContext {
  channelGrid: SpatialGrid;
  channelPoints: Vec3[];
  groundY: number;
  noise3D: (x: number, y: number, z: number) => number;
  config: FieldConfig;
  useSpatialGrid: boolean;
}

export function createFieldContext(
  groundY: number,
  config: FieldConfig,
  useSpatialGrid: boolean,
): FieldContext {
  return {
    channelGrid: new SpatialGrid(0.05),
    channelPoints: [],
    groundY,
    noise3D: createNoise3D(config.noiseSeed),
    config,
    useSpatialGrid,
  };
}

export function addChannelPoint(ctx: FieldContext, point: Vec3): void {
  ctx.channelPoints.push(point);
  if (ctx.useSpatialGrid) {
    ctx.channelGrid.add(point);
  }
}

export function computeFieldAtPoint(point: Vec3, ctx: FieldContext, direction?: Vec3): number {
  const { config, groundY } = ctx;

  let field = config.backgroundField;

  // Channel influence via distance approximation
  const points = ctx.useSpatialGrid
    ? ctx.channelGrid.getNearby(point, 0.2)
    : ctx.channelPoints;

  for (let i = 0; i < points.length; i++) {
    const cp = points[i];
    const dx = point.x - cp.x;
    const dy = point.y - cp.y;
    const dz = point.z - cp.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < config.epsilon) continue;
    field += config.channelInfluence / (dist + config.epsilon);
  }

  // Ground proximity (image charge effect)
  const groundDist = point.y - groundY;
  if (groundDist > 0) {
    field += config.groundInfluence / (groundDist + config.epsilon);
  }

  // Directional bias: gently favor downward-pointing directions
  if (direction) {
    const downwardness = -direction.y;
    field *= 1 + downwardness * 0.5;
  }

  // Atmospheric noise
  const nx = point.x * config.noiseScale;
  const ny = point.y * config.noiseScale;
  const nz = point.z * config.noiseScale;
  const noise = ctx.noise3D(nx, ny, nz);
  field *= 1 + noise * config.noiseAmplitude;

  return field;
}
