import * as THREE from 'three';
import { BaseEffect } from '../core/BaseEffect';
import { BaseEffectConfig } from '../core/EffectInterface';
import { 
  createRandomGenerator, 
  createLightningStrikeGeometry, 
  createBranches 
} from './LightningStrikeLogic';

/**
 * Configuration for lightning bolt effects
 */
export interface LightningBoltEffectConfig extends BaseEffectConfig {
  startAltitude: number;     // Starting height of the lightning strike (above surface)
  endAltitude: number;       // Ending height of the lightning strike (surface level)
  color: number;             // Color of the lightning (hex)
  lineWidth: number;         // Width/thickness of the lines
  lineSegments: number;      // Number of line segments
  jitterAmount: number;      // How much randomness in the lightning path
  branchChance: number;      // Probability (0-1) of creating a branch at each segment
  branchFactor: number;      // Length of the branches relative to main line
  maxBranches: number;       // Maximum number of branches
  duration: number;          // Total duration in milliseconds
  randomSeed?: number;       // Optional seed for deterministic randomness
  speed?: number;            // Speed multiplier for animations
}

/**
 * Default lightning bolt configuration
 */
export const DEFAULT_LIGHTNING_BOLT_CONFIG: LightningBoltEffectConfig = {
  startAltitude: 0.05,       // Default that will be updated to match cloud layer height
  endAltitude: 0.0005,       // Very close to surface
  color: 0xffffff,           // Color: white
  lineWidth: 3.5,            // Thickness of line
  lineSegments: 12,          // More segments for smoother lightning
  jitterAmount: 0.004,       // Reduced to 1/5 of previous value
  branchChance: 0.4,         // Chance of branches
  branchFactor: 0.7,         // Length of branches
  maxBranches: 4,            // Number of branches
  duration: 1500,            // Total duration - must match with ground plane
  fadeOutDuration: 300,      // Fade out duration
  speed: 1.0                 // Default speed
};

/**
 * Creates lightning bolt effects that can represent lightning strikes
 */
export class LightningBoltEffect extends BaseEffect {
  private geometry: THREE.BufferGeometry;
  private material: THREE.LineBasicMaterial;
  private mainLine: THREE.Line;
  private branches: THREE.Line[] = [];
  private group: THREE.Group;
  private config: LightningBoltEffectConfig;
  private createTime: number;
  private random: () => number;
  private startTime: number; // Track animation start time for speed adjustment
  private animationPhase: number = 0; // Track current animation phase for immediate speed changes

  /**
   * Create a new lightning bolt effect
   */
  constructor(
    lat: number,
    lng: number,
    config: Partial<LightningBoltEffectConfig> = {}
  ) {
    super(lat, lng, 0.5); // Default intensity
    this.config = { ...DEFAULT_LIGHTNING_BOLT_CONFIG, ...config };
    this.createTime = Date.now();
    this.startTime = performance.now() / 1000; // Convert to seconds

    const seed = this.config.randomSeed || Math.random() * 10000;
    this.random = createRandomGenerator(seed);

    this.group = new THREE.Group();
    // Set rendering order (higher renders on top)
    this.group.renderOrder = 20;

    // Initialize with empty geometry, will create actual geometry in initialize()
    this.geometry = new THREE.BufferGeometry();

    this.material = new THREE.LineBasicMaterial({
      color: this.config.color,
      transparent: true,
      opacity: 0, // Start invisible and fade in
      linewidth: this.config.lineWidth,
      depthWrite: false, // Don't write to depth buffer
    });

    this.mainLine = new THREE.Line(this.geometry, this.material);
    this.group.add(this.mainLine);

    // Register resources for cleanup
    this.registerResource(this.geometry);
    this.registerResource(this.material);
    this.registerResource(this.group);
    this.registerResource(this.mainLine);
  }

  /**
   * Update the current speed setting
   * This allows for immediate speed changes even during animation
   */
  updateSpeed(speed: number): void {
    if (this.config.speed !== speed) {
      this.config.speed = speed;
    }
  }

  initialize(scene: THREE.Scene, globeEl: any): void {
    this.globeEl = globeEl;
    this.scene = scene;
    if (scene && !this.group.parent) {
      scene.add(this.group);
    }

    // Now that we have globeEl, create the actual geometry
    this.group.remove(this.mainLine);  // Remove old line with empty geometry
    this.geometry = createLightningStrikeGeometry(
      this.lat, 
      this.lng, 
      this.globeEl, 
      this.config, 
      this.random
    );
    this.mainLine = new THREE.Line(this.geometry, this.material);
    this.group.add(this.mainLine);

    // Create branches after initialization when globeEl is available
    const branchResult = createBranches(
      this.globeEl,
      this.config,
      this.geometry,
      this.material,
      this.random,
      (resource) => this.registerResource(resource)
    );

    this.branches = branchResult.branches;
    branchResult.lines.forEach(line => this.group.add(line));
  }

  /**
   * Update the effect based on time
   */
  update(currentTime: number): boolean {
    // If already terminated, don't continue
    if (this.isTerminated) return false;

    // Get elapsed time in seconds and scale by current speed
    const elapsedTime = (performance.now() / 1000) - this.startTime;
    const speedFactor = this.config.speed || 1.0;
    
    // Scale time by speed factor
    const scaledTime = elapsedTime * speedFactor;
    
    // Total animation time in seconds
    const totalDuration = this.config.duration / 1000; // Convert ms to seconds
    
    // If past total duration, effect is done
    if (scaledTime > totalDuration) {
      this.terminateImmediately();
      return false;
    }

    // Animation phases with 3 equal segments
    const phaseLength = totalDuration / 3;
    
    // Update animation based on scaled time
    if (scaledTime < phaseLength) {
      // Fade in phase (0 - 1/3)
      const progress = scaledTime / phaseLength;
      this.animationPhase = 1; // Track phase for speed changes
      this.material.opacity = progress;
      this.branches.forEach(branch => {
        if (branch.material instanceof THREE.LineBasicMaterial) {
          branch.material.opacity = progress;
        }
      });
    } 
    else if (scaledTime < phaseLength * 2) {
      // Full brightness phase (1/3 - 2/3)
      this.animationPhase = 2; // Track phase for speed changes
      this.material.opacity = 1.0;
      this.branches.forEach(branch => {
        if (branch.material instanceof THREE.LineBasicMaterial) {
          branch.material.opacity = 1.0;
        }
      });
    } 
    else {
      // Fade out phase (2/3 - 3/3)
      this.animationPhase = 3; // Track phase for speed changes
      const fadeProgress = (scaledTime - phaseLength * 2) / phaseLength;
      const opacity = Math.max(0, 1.0 - fadeProgress);
      
      this.material.opacity = opacity;
      this.branches.forEach(branch => {
        if (branch.material instanceof THREE.LineBasicMaterial) {
          branch.material.opacity = opacity;
        }
      });
    }

    return true;
  }

  /**
   * Update the starting altitude for this effect
   */
  updateStartAltitude(altitude: number): void {
    if (this.config.startAltitude !== altitude) {
      this.config.startAltitude = altitude;

      // Rebuild the geometry with the new altitude
      if (this.group && this.group.parent) {
        // Remove old line and create new one
        this.group.remove(this.mainLine);
        this.geometry = createLightningStrikeGeometry(
          this.lat, 
          this.lng, 
          this.globeEl, 
          this.config, 
          this.random
        );
        this.mainLine = new THREE.Line(this.geometry, this.material);
        this.group.add(this.mainLine);

        // Recreate branches with new coordinates
        this.branches.forEach(branch => {
          this.group.remove(branch);
          if (branch.geometry) branch.geometry.dispose();
          if (branch.material instanceof THREE.Material) branch.material.dispose();
        });
        this.branches = [];

        const branchResult = createBranches(
          this.globeEl,
          this.config,
          this.geometry,
          this.material,
          this.random,
          (resource) => this.registerResource(resource)
        );

        this.branches = branchResult.branches;
        branchResult.lines.forEach(line => this.group.add(line));
      }
    }
  }

  /**
   * Position the effect on the globe
   * With our new approach using world coordinates, we don't need to position or rotate the group
   */
  positionOnGlobe(lat: number, lng: number, altitude: number = 0): void {
    if (!this.globeEl) return;

    // Store lat/lng values for use in createLightningStrikeGeometry
    this.lat = lat;
    this.lng = lng;

    // If we already initialized, we need to rebuild the geometry with the new coords
    if (this.group && this.group.parent) {
      // Remove old line and create new one
      this.group.remove(this.mainLine);
      this.geometry = createLightningStrikeGeometry(
        this.lat, 
        this.lng, 
        this.globeEl, 
        this.config, 
        this.random
      );
      this.mainLine = new THREE.Line(this.geometry, this.material);
      this.group.add(this.mainLine);

      // Recreate branches with new coordinates
      this.branches.forEach(branch => {
        this.group.remove(branch);
        if (branch.geometry) branch.geometry.dispose();
        if (branch.material instanceof THREE.Material) branch.material.dispose();
      });
      this.branches = [];

      const branchResult = createBranches(
        this.globeEl,
        this.config,
        this.geometry,
        this.material,
        this.random,
        (resource) => this.registerResource(resource)
      );

      this.branches = branchResult.branches;
      branchResult.lines.forEach(line => this.group.add(line));
    }

    // Since we're using world coordinates directly, we don't need
    // to position, rotate or scale the group
    this.group.position.set(0, 0, 0);
    this.group.quaternion.identity();
    this.group.scale.set(1, 1, 1);
  }

  /**
   * Immediately terminate the effect and remove from scene
   */
  terminateImmediately(): void {
    // Ensure all materials are set to zero opacity
    this.material.opacity = 0;
    this.branches.forEach(branch => {
      if (branch.material instanceof THREE.LineBasicMaterial) {
        branch.material.opacity = 0;
      }
    });

    super.terminateImmediately();
  }

  /**
   * Get the Three.js group containing the effect
   */
  getObject(): THREE.Group {
    return this.group;
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    // Clear references
    this.branches = [];

    // Call parent dispose to clean up registered resources
    super.dispose();
  }
}
