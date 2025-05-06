import * as THREE from 'three';
import { Effect, BaseEffectConfig } from './core/EffectInterface';

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
  startAltitude: 0.03,       // Cloud height - increased for visibility
  endAltitude: 0.001,        // Surface level
  color: 0xffffff,           // Color: white
  lineWidth: 3.5,            // Thickness of line
  lineSegments: 8,           // Number of line segments
  jitterAmount: 0.02,        // Randomness
  branchChance: 0.4,         // Chance of branches
  branchFactor: 0.7,         // Length of branches
  maxBranches: 4,            // Number of branches
  duration: 1000,            // Total duration
  fadeOutDuration: 300,      // Fade out duration
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
   * Create the zigzag geometry
   */
  private createZigZagGeometry(): THREE.BufferGeometry {
    const segments = this.config.lineSegments;
    const points: THREE.Vector3[] = [];

    // Create a zigzag line from cloud height to surface
    let prevX = 0, prevZ = 0;
    
    // We need a significant difference between start and end altitude
    // to make the lightning actually visible from clouds to surface
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;

      // Create a much more pronounced difference in altitude
      // First point is at cloud height, last point at surface
      const altitude = this.config.startAltitude * (1 - t) + this.config.endAltitude * t;

      const jitterX = (prevX + (this.random() * 2 - 1) * this.config.jitterAmount);
      const jitterZ = (prevZ + (this.random() * 2 - 1) * this.config.jitterAmount);

      // No jitter at start and end points
      const finalJitterX = (i === 0 || i === segments) ? 0 : jitterX;
      const finalJitterZ = (i === 0 || i === segments) ? 0 : jitterZ;

      prevX = finalJitterX;
      prevZ = finalJitterZ;

      // Use real positional values with a proper scale
      points.push(new THREE.Vector3(finalJitterX, altitude, finalJitterZ));
    }

    return new THREE.BufferGeometry().setFromPoints(points);
  }

  /**
   * Create branches from the main line
   */
  private createBranches() {
    const segments = this.config.lineSegments;
    const maxBranches = this.config.maxBranches;
    let branchCount = 0;

    // Get the vertices of the main line
    const positions = this.geometry.getAttribute('position');

    // Skip the very top (cloud) and bottom (surface) segments
    // Only create branches in the middle portion of the lightning
    const skipTop = Math.floor(segments * 0.15); // Skip top 15%
    const skipBottom = Math.floor(segments * 0.15); // Skip bottom 15%
    
    for (let i = skipTop; i < segments - skipBottom && branchCount < maxBranches; i++) {
      if (this.random() < this.config.branchChance) {
        const x = positions.getX(i);
        const y = positions.getY(i);
        const z = positions.getZ(i);

        // Calculate branch direction - make branches more pronounced
        const branchLength = this.config.branchFactor * this.config.jitterAmount * 15;
        
        // Branches should go sideways and slightly downward
        const branchX = x + (this.random() * 2 - 1) * branchLength;
        
        // Bias branches downward (towards earth) but with some randomness
        // The lower we are on the main lightning bolt, the more downward branches go
        const downwardBias = i / segments; // More bias as we get closer to the ground
        const branchY = y - (this.random() * branchLength * 0.7 * downwardBias);
        
        const branchZ = z + (this.random() * 2 - 1) * branchLength;

        // Create a multi-point branch with zigzag effect
        const branchPoints = [new THREE.Vector3(x, y, z)];
        
        // Add 1-3 intermediate zigzag points on the branch
        const subSegments = 1 + Math.floor(this.random() * 3);
        for (let j = 1; j <= subSegments; j++) {
          const t = j / (subSegments + 1);
          const midX = x + (branchX - x) * t + (this.random() * 2 - 1) * branchLength * 0.3;
          const midY = y + (branchY - y) * t;
          const midZ = z + (branchZ - z) * t + (this.random() * 2 - 1) * branchLength * 0.3;
          branchPoints.push(new THREE.Vector3(midX, midY, midZ));
        }
        
        // Add final point
        branchPoints.push(new THREE.Vector3(branchX, branchY, branchZ));

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
   * Position the effect on the globe
   */
  positionOnGlobe(lat: number, lng: number, altitude: number = 0): void {
    if (!this.globeEl) return;

    // Get the coordinates of the point on the surface
    // We deliberately position at exact surface level (altitude=0)
    const surfaceCoords = this.globeEl.getCoords(lat, lng, 0);
    this.group.position.set(surfaceCoords.x, surfaceCoords.y, surfaceCoords.z);

    // Orient the group to face outward from the center of the globe
    const globeCenter = new THREE.Vector3(0, 0, 0);
    const normal = new THREE.Vector3()
      .subVectors(surfaceCoords, globeCenter)
      .normalize();

    // Create a quaternion rotation that aligns the effect with the surface normal
    // The Y-axis of our geometry points upward, and we want it to point along the normal
    this.group.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), // Default up vector (Y axis) 
      normal                      // Target direction (surface normal)
    );
    
    // Scale the group to ensure the lightning is properly sized relative to the globe
    // We need to get the actual globe radius from the globe element
    let globeRadius = 100; // Default fallback
    if (this.globeEl._mainSphere && this.globeEl._mainSphere.geometry && this.globeEl._mainSphere.geometry.parameters) {
      globeRadius = this.globeEl._mainSphere.geometry.parameters.radius || 100;
    }
    
    // Apply a scale that makes the lightning visible but not too large
    this.group.scale.setScalar(globeRadius * 0.3);
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
