import * as THREE from 'three';
import { BaseEffect } from './core/BaseEffect';
import { BaseEffectConfig } from './core/EffectInterface';

export enum MarkerType {
  CIRCLE = 'CIRCLE',
  DONUT = 'DONUT'
}

export interface PointMarkerConfig extends BaseEffectConfig {
  markerType: MarkerType;  // Type of marker (CIRCLE or DONUT)
  radius: number;       // Radius of the marker (used for CIRCLE)
  color: number;        // Color of the marker (hex)
  opacity: number;      // Maximum opacity
  resolution: number;   // Geometry resolution (number of segments)
  altitude: number;     // Height above the globe surface
  duration: number;
  fadeInDuration: number; // Time to fade in (ms)
  maxAge: number;       // Maximum age before complete fade out (ms)
  fadeStartAge: number; // Age at which fade out begins (ms)
  innerRadius: number;  // Inner radius (used for DONUT)
  outerRadius: number;  // Outer radius (used for DONUT)
}

export const DEFAULT_MARKER_CONFIG: PointMarkerConfig = {
  markerType: MarkerType.CIRCLE,  // Default to circle
  radius: 0.1,
  color: 0xffffff,
  opacity: 1,
  resolution: 25,
  altitude: 0.001,
  duration: 60000,      // 1 minute total visibility
  fadeInDuration: 1500, // Match lightning animation timing
  fadeOutDuration: 5000,
  maxAge: 60000,        // 60 seconds before complete fade
  fadeStartAge: 10000,  // Start fading after 10 seconds
  innerRadius: 0.05,    // Inner radius for DONUT type
  outerRadius: 0.07,    // Outer radius for DONUT type
};

export class PointMarkerEffect extends BaseEffect {
  private marker: THREE.Mesh;
  private geometry: THREE.CircleGeometry | THREE.RingGeometry;
  private material: THREE.MeshBasicMaterial;
  private config: PointMarkerConfig;
  private createTime: number;

  constructor(
    lat: number,
    lng: number,
    intensity: number = 0.5,
    config: Partial<PointMarkerConfig> = {}
  ) {
    super(lat, lng, intensity);
    this.config = { ...DEFAULT_MARKER_CONFIG, ...config };
    this.createTime = Date.now();

    // Create geometry based on marker type
    if (this.config.markerType === MarkerType.CIRCLE) {
      this.geometry = new THREE.CircleGeometry(
        this.config.radius,
        this.config.resolution
      );
    } else {
      this.geometry = new THREE.RingGeometry(
        this.config.innerRadius,
        this.config.outerRadius,
        this.config.resolution,
        0,
        0,
        Math.PI * 2
      );
    }

    this.material = new THREE.MeshBasicMaterial({
      color: this.config.color,
      transparent: true,
      opacity: 0,  // Start invisible and fade in
      side: THREE.DoubleSide,
      depthWrite: false
    });

    this.marker = new THREE.Mesh(this.geometry, this.material);

    /** Render order is important. Be careful when changing it.
     * Even though clouds are transparent, they can still obscure other elements beneath them if order is changed. */
    this.marker.renderOrder = 30; // (highest value renders on top)

    this.marker.userData = {
      createdAt: this.createTime,
      intensity: this.intensity
    };

    // Register resources for cleanup
    this.registerResource(this.geometry);
    this.registerResource(this.material);
    this.registerResource(this.marker);
  }

  initialize(scene: THREE.Scene, globeEl: any): void {
    this.globeEl = globeEl;
    this.scene = scene;
    if (scene && !this.marker.parent) {
      scene.add(this.marker);
    }
  }

  update(currentTime: number): boolean {
    if (this.isTerminated) return false;

    const age = currentTime - this.createTime;

    if (age > this.config.maxAge) {
      this.terminateImmediately();
      return false;
    }

    // Fade in stage
    if (age < this.config.fadeInDuration) {
      const fadeRatio = age / this.config.fadeInDuration;
      this.material.opacity = Math.min(this.config.opacity, fadeRatio * this.config.opacity);
    }
    // Full visibility stage
    else if (age < this.config.fadeStartAge) {
      this.material.opacity = this.config.opacity;
    }
    // Fade out stage
    else {
      const fadeRatio = 1 - ((age - this.config.fadeStartAge) /
                           (this.config.maxAge - this.config.fadeStartAge));
      this.material.opacity = Math.max(0, Math.min(this.config.opacity, fadeRatio * this.config.opacity));
    }

    return true;
  }

  positionOnGlobe(lat: number, lng: number, altitude: number = this.config.altitude): void {
    if (!this.globeEl) return;

    // Position the marker at the surface point
    const surfaceCoords = this.globeEl.getCoords(lat, lng, altitude);
    this.marker.position.set(surfaceCoords.x, surfaceCoords.y, surfaceCoords.z);

    // Orient to face outward from globe center
    const normal = new THREE.Vector3()
      .subVectors(surfaceCoords, new THREE.Vector3(0, 0, 0))
      .normalize();

    this.marker.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1), // Default circle marker orientation (Z axis)
      normal                      // Direction to face
    );
  }

  terminateImmediately(): void {
    this.material.opacity = 0;
    super.terminateImmediately();
  }

  getObject(): THREE.Object3D {
    return this.marker;
  }

  dispose(): void {
    super.dispose();
  }
}
