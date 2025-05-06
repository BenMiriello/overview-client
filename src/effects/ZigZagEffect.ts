import * as THREE from 'three';
import { Effect, BaseEffectConfig } from './core/EffectInterface';

// We no longer use CloudLayer's default config directly to avoid coupling
// Instead, we set our own default that will be updated programmatically

/**
 * Configuration for zigzag line effects
 */
export interface ZigZagEffectConfig extends BaseEffectConfig {
  startAltitude: number;     // Starting height of the zigzag (above surface)
  endAltitude: number;       // Ending height of the zigzag (surface level)
  color: number;             // Color of the zigzag (hex)
  lineWidth: number;         // Width/thickness of the lines
  lineSegments: number;      // Number of zigzag segments
  jitterAmount: number;      // How much randomness in the zigzag
  branchChance: number;      // Probability (0-1) of creating a branch at each segment
  branchFactor: number;      // Length of the branches relative to main line
  maxBranches: number;       // Maximum number of branches
  duration: number;
  randomSeed?: number;       // Optional seed for deterministic randomness
}

/**
 * Default zigzag configuration
 */
export const DEFAULT_ZIGZAG_CONFIG: ZigZagEffectConfig = {
  startAltitude: 0.05, // Default that will be updated to match cloud layer height
  endAltitude: 0.0005, // Very close to surface
  color: 0xffffff,                           // Color: white
  lineWidth: 3.5,                            // Thickness of line
  lineSegments: 12,                          // More segments for smoother zigzag
  jitterAmount: 0.004,                       // Reduced to 1/5 of previous value
  branchChance: 0.4,                         // Chance of branches
  branchFactor: 0.7,                         // Length of branches
  maxBranches: 4,                            // Number of branches
  duration: 1000,                            // Total duration
  fadeOutDuration: 300,                       // Fade out duration
};

/**
 * Creates zigzag line effects that can represent lightning or other phenomena
 */
export class ZigZagEffect implements Effect {
  private geometry: THREE.BufferGeometry;
  private material: THREE.LineBasicMaterial;
  private mainLine: THREE.Line;
  private branches: THREE.Line[] = [];
  private group: THREE.Group;
  private config: ZigZagEffectConfig;
  private createTime: number;
  private random: () => number;
  private globeEl: any;
  private scene: THREE.Scene | null = null;
  private isTerminated: boolean = false;

  /**
   * Create a new zigzag effect
   */
  constructor(
    public lat: number,
    public lng: number,
    config: Partial<ZigZagEffectConfig> = {}
  ) {
    this.config = { ...DEFAULT_ZIGZAG_CONFIG, ...config };
    this.createTime = Date.now();

    const seed = this.config.randomSeed || Math.random() * 10000;
    this.random = this.createRandomGenerator(seed);

    this.group = new THREE.Group();
    // Set rendering order (higher renders on top)
    this.group.renderOrder = 20;

    this.geometry = this.createZigZagGeometry();

    this.material = new THREE.LineBasicMaterial({
      color: this.config.color,
      transparent: true,
      opacity: 0, // Start invisible and fade in
      linewidth: this.config.lineWidth,
      depthWrite: false, // Don't write to depth buffer
    });

    this.mainLine = new THREE.Line(this.geometry, this.material);
    this.group.add(this.mainLine);

    this.createBranches();
  }

  initialize(scene: THREE.Scene, globeEl: any): void {
    this.globeEl = globeEl;
    this.scene = scene;
    if (scene && !this.group.parent) {
      scene.add(this.group);
    }
  }

  /**
   * Create a pseudorandom number generator with a seed
   */
  private createRandomGenerator(seed: number): () => number {
    return function() {
      const x = Math.sin(seed++) * 10000;
      return x - Math.floor(x);
    };
  }

  /**
   * Create the zigzag geometry with direct world coordinates
   */
  private createZigZagGeometry(): THREE.BufferGeometry {
    if (!this.globeEl) return new THREE.BufferGeometry();

    const segments = this.config.lineSegments;
    const points: THREE.Vector3[] = [];

    // Get globe radius from the globe element
    let globeRadius = 100; // Default fallback
    if (this.globeEl._mainSphere && this.globeEl._mainSphere.geometry && this.globeEl._mainSphere.geometry.parameters) {
      globeRadius = this.globeEl._mainSphere.geometry.parameters.radius || 100;
    }

    // Calculate surface and cloud points in actual world coordinates
    const surfacePoint = this.globeEl.getCoords(this.lat, this.lng, 0);
    const cloudPoint = this.globeEl.getCoords(this.lat, this.lng, this.config.startAltitude);

    // Direction from center to surface point (normalized)
    const directionVector = new THREE.Vector3()
      .subVectors(surfacePoint, new THREE.Vector3(0, 0, 0))
      .normalize();

    // Create a basis for sideways movement (perpendicular to direction)
    const sideways = new THREE.Vector3(1, 0, 0);
    if (Math.abs(directionVector.y) < 0.9) {
      sideways.crossVectors(directionVector, new THREE.Vector3(0, 1, 0)).normalize();
    } else {
      sideways.crossVectors(directionVector, new THREE.Vector3(0, 0, 1)).normalize();
    }
    const updown = new THREE.Vector3().crossVectors(directionVector, sideways).normalize();

    // Jitter scale - small enough to keep zigzag tight
    const jitterScale = globeRadius * 0.004;

    let prevJitterX = 0, prevJitterZ = 0;

    // First point is exact cloud position
    points.push(new THREE.Vector3(cloudPoint.x, cloudPoint.y, cloudPoint.z));

    // Create zigzag points between cloud and surface
    for (let i = 1; i < segments; i++) {
      const t = i / segments;

      // Position along the line from cloud to surface
      const pos = new THREE.Vector3()
        .lerpVectors(cloudPoint, surfacePoint, t);

      // Apply jitter perpendicular to the main direction
      const jitterX = (prevJitterX + (this.random() * 2 - 1) * this.config.jitterAmount);
      const jitterZ = (prevJitterZ + (this.random() * 2 - 1) * this.config.jitterAmount);

      // Pull toward center to prevent wandering
      const pullToCenter = 0.3;
      prevJitterX = jitterX * (1 - pullToCenter);
      prevJitterZ = jitterZ * (1 - pullToCenter);

      // Apply jitter in local coordinate system
      pos.add(sideways.clone().multiplyScalar(jitterX * jitterScale));
      pos.add(updown.clone().multiplyScalar(jitterZ * jitterScale));

      points.push(pos);
    }

    // Last point is exact surface position
    points.push(new THREE.Vector3(surfacePoint.x, surfacePoint.y, surfacePoint.z));

    return new THREE.BufferGeometry().setFromPoints(points);
  }

  /**
   * Create branches from the main line
   */
  private createBranches() {
    if (!this.globeEl) return;

    const segments = this.config.lineSegments;
    const maxBranches = this.config.maxBranches;
    let branchCount = 0;

    // Get the vertices of the main line
    const positions = this.geometry.getAttribute('position');

    // Skip the very top (cloud) and bottom (surface) segments
    // Only create branches in the middle portion of the lightning
    const skipTop = Math.floor(segments * 0.15); // Skip top 15%
    const skipBottom = Math.floor(segments * 0.15); // Skip bottom 15%

    // Get globe radius for scaling branches appropriately
    let globeRadius = 100; // Default fallback
    if (this.globeEl._mainSphere && this.globeEl._mainSphere.geometry && this.globeEl._mainSphere.geometry.parameters) {
      globeRadius = this.globeEl._mainSphere.geometry.parameters.radius || 100;
    }

    // Scale branches to be appropriate for globe size
    const branchScale = globeRadius * 0.005;

    for (let i = skipTop; i < segments - skipBottom && branchCount < maxBranches; i++) {
      if (this.random() < this.config.branchChance) {
        // Get the vertex position from the main lightning line
        const startPoint = new THREE.Vector3(
          positions.getX(i),
          positions.getY(i),
          positions.getZ(i)
        );

        // Calculate direction from globe center to this point
        const center = new THREE.Vector3(0, 0, 0);
        const dir = new THREE.Vector3().subVectors(startPoint, center).normalize();

        // Create a local coordinate system at this point
        const sideways = new THREE.Vector3(1, 0, 0);
        if (Math.abs(dir.y) < 0.9) {
          sideways.crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
        } else {
          sideways.crossVectors(dir, new THREE.Vector3(0, 0, 1)).normalize();
        }
        const updown = new THREE.Vector3().crossVectors(dir, sideways).normalize();

        // Create random branch direction (mostly sideways, slightly downward)
        const randomSideways = (this.random() * 2 - 1) * branchScale;

        // More downward as we get closer to ground
        const downwardBias = i / segments; 
        const randomDown = this.random() * branchScale * 0.7 * downwardBias;

        // Combined branch direction
        const branchDir = new THREE.Vector3()
          .addScaledVector(sideways, randomSideways)
          .addScaledVector(updown, randomDown);

        // Ensure branch points away from center a bit to look natural
        const outwardAmount = branchScale * 0.3;
        branchDir.addScaledVector(dir, outwardAmount);

        // End point of the branch
        const endPoint = new THREE.Vector3().copy(startPoint).add(branchDir);

        // Create a multi-point branch with zigzag effect
        const branchPoints = [startPoint.clone()];

        // Add intermediate zigzag points on the branch (fewer points for shorter branches)
        const subSegments = 1 + Math.floor(this.random() * 2);
        for (let j = 1; j <= subSegments; j++) {
          const t = j / (subSegments + 1);

          // Base interpolated position
          const midPoint = new THREE.Vector3().lerpVectors(startPoint, endPoint, t);

          // Small perpendicular jitter for zigzag effect
          const jitterSize = branchScale * 0.1;
          const jitterDir = new THREE.Vector3()
            .addScaledVector(sideways, (this.random() * 2 - 1) * jitterSize)
            .addScaledVector(updown, (this.random() * 2 - 1) * jitterSize);

          midPoint.add(jitterDir);
          branchPoints.push(midPoint);
        }

        // Add final point
        branchPoints.push(endPoint);

        // Create geometry and line for the branch
        const branchGeometry = new THREE.BufferGeometry().setFromPoints(branchPoints);
        const branchMaterial = this.material.clone();
        const branch = new THREE.Line(branchGeometry, branchMaterial);

        // Add to group and store for animation
        this.group.add(branch);
        this.branches.push(branch);
        branchCount++;
      }
    }
  }

  /**
   * Update the effect based on time
   */
  update(currentTime: number): boolean {
    // If already terminated, don't continue
    if (this.isTerminated) return false;

    const age = currentTime - this.createTime;

    // Fixed animation durations
    const drawDuration = 500;        // 0.5 seconds to draw the zigzag line
    const displayDuration = 500;     // 0.5 seconds to keep it visible
    const fadeOutDuration = 500;     // 0.5 seconds to fade out
    const totalDuration = 1500;      // 1.5 seconds total

    // If past total duration, effect is done
    if (age > totalDuration) {
      this.terminateImmediately();
      return false;
    }

    // Animation phases
    if (age <= drawDuration) {
      // Drawing phase (0-0.5s)
      const progress = age / drawDuration;
      this.material.opacity = progress;
      this.branches.forEach(branch => {
        if (branch.material instanceof THREE.LineBasicMaterial) {
          branch.material.opacity = progress;
        }
      });
    } 
    else if (age <= drawDuration + displayDuration) {
      // Static display phase (0.5-1.0s)
      this.material.opacity = 1.0;
      this.branches.forEach(branch => {
        if (branch.material instanceof THREE.LineBasicMaterial) {
          branch.material.opacity = 1.0;
        }
      });
    } 
    else {
      // Fade out phase (1.0-1.5s)
      const fadeProgress = (age - (drawDuration + displayDuration)) / fadeOutDuration;
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
        this.geometry = this.createZigZagGeometry();
        this.mainLine = new THREE.Line(this.geometry, this.material);
        this.group.add(this.mainLine);

        // Recreate branches with new coordinates
        this.branches.forEach(branch => {
          this.group.remove(branch);
          if (branch.geometry) branch.geometry.dispose();
          if (branch.material instanceof THREE.Material) branch.material.dispose();
        });
        this.branches = [];
        this.createBranches();
      }
    }
  }

  /**
   * Position the effect on the globe
   * With our new approach using world coordinates, we don't need to position or rotate the group
   */
  positionOnGlobe(lat: number, lng: number, altitude: number = 0): void {
    if (!this.globeEl) return;

    // Store lat/lng values for use in createZigZagGeometry
    this.lat = lat;
    this.lng = lng;

    // If we already initialized, we need to rebuild the geometry with the new coords
    if (this.group && this.group.parent) {
      // Remove old line and create new one
      this.group.remove(this.mainLine);
      this.geometry = this.createZigZagGeometry();
      this.mainLine = new THREE.Line(this.geometry, this.material);
      this.group.add(this.mainLine);

      // Recreate branches with new coordinates
      this.branches.forEach(branch => {
        this.group.remove(branch);
        if (branch.geometry) branch.geometry.dispose();
        if (branch.material instanceof THREE.Material) branch.material.dispose();
      });
      this.branches = [];
      this.createBranches();
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
  terminateImmediately() {
    if (this.isTerminated) return;
    this.isTerminated = true;

    // Ensure all materials are set to zero opacity
    this.material.opacity = 0;
    this.branches.forEach(branch => {
      if (branch.material instanceof THREE.LineBasicMaterial) {
        branch.material.opacity = 0;
      }
    });

    // Remove from scene
    if (this.scene) {
      this.scene.remove(this.group);
    }

    // Clean up THREE.js objects
    this.dispose();
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
    // Dispose geometries
    if (this.geometry) {
      this.geometry.dispose();
    }

    this.branches.forEach(branch => {
      if (branch.geometry) {
        branch.geometry.dispose();
      }
    });

    // Clean up materials
    if (this.material) {
      this.material.dispose();
    }

    this.branches.forEach(branch => {
      if (branch.material instanceof THREE.Material) {
        branch.material.dispose();
      }
    });

    // Remove from parent if attached
    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }

    // Clear references for GC
    this.branches = [];
  }
}
