import * as THREE from 'three';
import { Vec3 } from './simulation';

/**
 * Handles transformation between normalized simulation space and world space.
 *
 * Simulation runs in normalized space: Y from 0.5 (ceiling) to -0.5 (ground),
 * centered at origin with unit scale.
 *
 * World space is defined by worldStart (ceiling) and worldEnd (ground) points.
 * The transformation: rotate to align simulation's -Y axis with world direction,
 * scale to match world distance, then translate to world midpoint.
 */
export class CoordinateTransform {
  readonly worldOrigin: Vec3;
  readonly worldScale: number;
  readonly rotationMatrix: THREE.Matrix4;

  private readonly inverseRotation: THREE.Matrix4;

  constructor(worldStart: Vec3, worldEnd: Vec3) {
    const dx = worldEnd.x - worldStart.x;
    const dy = worldEnd.y - worldStart.y;
    const dz = worldEnd.z - worldStart.z;

    this.worldScale = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this.worldOrigin = {
      x: (worldStart.x + worldEnd.x) / 2,
      y: (worldStart.y + worldEnd.y) / 2,
      z: (worldStart.z + worldEnd.z) / 2,
    };

    // Compute rotation from simulation axis (0, -1, 0) to world direction
    const worldDir = new THREE.Vector3(dx, dy, dz).normalize();
    const simAxis = new THREE.Vector3(0, -1, 0);

    this.rotationMatrix = new THREE.Matrix4();
    const dot = simAxis.dot(worldDir);

    if (dot > 0.9999) {
      // Already aligned, identity rotation
      this.rotationMatrix.identity();
    } else if (dot < -0.9999) {
      // Opposite direction, rotate 180 degrees around X
      this.rotationMatrix.makeRotationAxis(new THREE.Vector3(1, 0, 0), Math.PI);
    } else {
      const axis = new THREE.Vector3().crossVectors(simAxis, worldDir).normalize();
      const angle = Math.acos(dot);
      this.rotationMatrix.makeRotationAxis(axis, angle);
    }

    // Cache inverse rotation for toNormalized
    this.inverseRotation = this.rotationMatrix.clone().invert();
  }

  /**
   * Transform a point from normalized simulation space to world space.
   */
  toWorld(normalized: Vec3): Vec3 {
    const v = new THREE.Vector3(normalized.x, normalized.y, normalized.z);
    v.applyMatrix4(this.rotationMatrix);
    return {
      x: v.x * this.worldScale + this.worldOrigin.x,
      y: v.y * this.worldScale + this.worldOrigin.y,
      z: v.z * this.worldScale + this.worldOrigin.z,
    };
  }

  /**
   * Transform a point from world space to normalized simulation space.
   */
  toNormalized(world: Vec3): Vec3 {
    // Reverse translate and scale
    const v = new THREE.Vector3(
      (world.x - this.worldOrigin.x) / this.worldScale,
      (world.y - this.worldOrigin.y) / this.worldScale,
      (world.z - this.worldOrigin.z) / this.worldScale
    );
    // Reverse rotation
    v.applyMatrix4(this.inverseRotation);
    return { x: v.x, y: v.y, z: v.z };
  }

  /**
   * Get the world start point (ceiling).
   */
  getWorldStart(): Vec3 {
    return this.toWorld({ x: 0, y: 0.5, z: 0 });
  }

  /**
   * Get the world end point (ground).
   */
  getWorldEnd(): Vec3 {
    return this.toWorld({ x: 0, y: -0.5, z: 0 });
  }
}
