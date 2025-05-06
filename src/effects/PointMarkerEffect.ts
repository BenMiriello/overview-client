import * as THREE from 'three';
import { Effect, BaseEffectConfig } from './core/EffectInterface';

/**
 * Configuration for point marker effects
 */
export interface PointMarkerConfig extends BaseEffectConfig {
  radius: number;       // Radius of the marker
  color: number;        // Color of the marker (hex)
  opacity: number;      // Maximum opacity
  resolution: number;   // Geometry resolution (number of segments)
  altitude: number;     // Height above the globe surface
  duration: number;
  fadeInDuration: number; // Time to fade in (ms)
  maxAge: number;       // Maximum age before complete fade out (ms)
  fadeStartAge: number; // Age at which fade out begins (ms)
}

/**
 * Default point marker configuration
 */
export const DEFAULT_MARKER_CONFIG: PointMarkerConfig = {
  radius: 0.08,
  color: 0xffffff,
  opacity: 0.8,
  resolution: 25,
  altitude: 0.001,
  duration: 60000,      // 1 minute total visibility
  fadeInDuration: 1500, // Match lightning animation timing
  fadeOutDuration: 5000,
  maxAge: 60000,        // 60 seconds before complete fade
  fadeStartAge: 10000   // Start fading after 10 seconds
};

/**
 * Creates circle markers on the globe
 */
export class PointMarkerEffect implements Effect {
  private marker: THREE.Mesh;
  private geometry: THREE.CircleGeometry;
  private material: THREE.MeshBasicMaterial;
  private config: PointMarkerConfig;
  private createTime: number;
  private globeEl: any;
  private scene: THREE.Scene | null = null;
  private isTerminated: boolean = false;

  /**
   * Create a new point marker effect
   */
  constructor(
    public lat: number,
    public lng: number,
    public intensity: number = 0.5,
    config: Partial<PointMarkerConfig> = {}
  ) {
    this.config = { ...DEFAULT_MARKER_CONFIG, ...config };
    this.createTime = Date.now();

    // Create circle geometry
    this.geometry = new THREE.CircleGeometry(
      this.config.radius, 
      this.config.resolution
    );

    // Create material
    this.material = new THREE.MeshBasicMaterial({
      color: this.config.color,
      transparent: true,
      opacity: 0,  // Start invisible and fade in
      side: THREE.DoubleSide,
      depthWrite: false
    });

    // Create mesh
    this.marker = new THREE.Mesh(this.geometry, this.material);

    // Set rendering order (highest renders on top)
    this.marker.renderOrder = 30;

    // Store metadata
    this.marker.userData = {
      createdAt: this.createTime,
      intensity: this.intensity
    };
  }

  /**
   * Initialize the effect
   */
  initialize(scene: THREE.Scene, globeEl: any): void {
    this.globeEl = globeEl;
    this.scene = scene;
    if (scene && !this.marker.parent) {
      scene.add(this.marker);
    }
  }

  /**
   * Update the effect based on time
   */
  update(currentTime: number): boolean {
    // If already terminated, don't continue
    if (this.isTerminated) return false;

    const age = currentTime - this.createTime;

    // If past max age, effect is done
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

  /**
   * Position the effect on the globe
   */
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
      normal                       // Direction to face
    );
  }

  /**
   * Immediately terminate the effect
   */
  terminateImmediately() {
    if (this.isTerminated) return;
    this.isTerminated = true;

    this.material.opacity = 0;

    // Remove from scene
    if (this.scene) {
      this.scene.remove(this.marker);
    }

    // Clean up resources
    this.dispose();
  }

  /**
   * Get the Three.js object for this effect
   */
  getObject(): THREE.Object3D {
    return this.marker;
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    if (this.geometry) {
      this.geometry.dispose();
    }

    if (this.material) {
      this.material.dispose();
    }

    if (this.marker.parent) {
      this.marker.parent.remove(this.marker);
    }
  }
}
