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
  duration: number;          // Total time the effect is displayed
  randomSeed?: number;       // Optional seed for deterministic randomness
}

/**
 * Default zigzag configuration
 */
export const DEFAULT_ZIGZAG_CONFIG: ZigZagEffectConfig = {
  startAltitude: 0.04,       // Higher altitude for more dramatic effect
  endAltitude: 0.0005,       // The bottom of the effect
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

    this.geometry = this.createZigZagGeometry();

    this.material = new THREE.LineBasicMaterial({
      color: this.config.color,
      transparent: true,
      opacity: 1.0,
      linewidth: this.config.lineWidth,
    });

    this.mainLine = new THREE.Line(this.geometry, this.material);
    this.group.add(this.mainLine);

    this.createBranches();
  }

  initialize(scene: THREE.Scene, globeEl: any): void {
    this.globeEl = globeEl;
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

    // Create a zigzag line from top to bottom
    let prevX = 0, prevZ = 0;
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;

      const altitude = this.config.startAltitude * (1 - t) + this.config.endAltitude * t;

      const jitterX = (prevX + (this.random() * 2 - 1) * this.config.jitterAmount);
      const jitterZ = (prevZ + (this.random() * 2 - 1) * this.config.jitterAmount);

      // No jitter at start and end points
      const finalJitterX = (i === 0 || i === segments) ? 0 : jitterX;
      const finalJitterZ = (i === 0 || i === segments) ? 0 : jitterZ;

      prevX = finalJitterX;
      prevZ = finalJitterZ;

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

    // Skip the first and last segment when creating branches
    for (let i = 1; i < segments && branchCount < maxBranches; i++) {
      if (this.random() < this.config.branchChance) {
        const x = positions.getX(i);
        const y = positions.getY(i);
        const z = positions.getZ(i);

        // Calculate branch direction
        const branchLength = this.config.branchFactor * this.config.jitterAmount * 10;
        const branchX = x + (this.random() * 2 - 1) * branchLength;
        const branchY = y - this.random() * branchLength * 0.5; // Branches go down
        const branchZ = z + (this.random() * 2 - 1) * branchLength;

        // Create a simple branch with two points
        const branchPoints = [
          new THREE.Vector3(x, y, z),
          new THREE.Vector3(branchX, branchY, branchZ)
        ];

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
    const age = currentTime - this.createTime;

    // Fixed animation durations
    const drawDuration = 500;        // 0.5 seconds to draw the zigzag line
    const displayDuration = 500;     // 0.5 seconds to keep it visible
    const fadeOutDuration = 500;     // 0.5 seconds to fade out
    const totalDuration = 1500;      // 1.5 seconds total

    // If past total duration, effect is done
    if (age > totalDuration) {
      // Explicitly hide the effect
      if (this.material) {
        this.material.opacity = 0;
        this.branches.forEach(branch => {
          if (branch.material instanceof THREE.LineBasicMaterial) {
            branch.material.opacity = 0;
          }
        });
      }

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

    // Position the group at the surface point
    const surfaceCoords = this.globeEl.getCoords(lat, lng, altitude);
    this.group.position.set(surfaceCoords.x, surfaceCoords.y, surfaceCoords.z);

    // Orient the group to face outward from the center of the globe
    const globeCenter = new THREE.Vector3(0, 0, 0);
    const normal = new THREE.Vector3()
      .subVectors(surfaceCoords, globeCenter)
      .normalize();

    // Create a quaternion rotation that aligns the effect with the surface normal
    this.group.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), // Default up vector (Y axis)
      normal                      // Target direction (surface normal)
    );
  }

  /**
   * Immediately terminate the effect
   */
  terminateImmediately() {
    // Remove effect completely from the scene
    if (this.mainLine.parent) {
      this.mainLine.parent.remove(this.mainLine);
    }

    this.branches.forEach(branch => {
      if (branch.parent) {
        branch.parent.remove(branch);
      }
    });

    // Hide lines
    this.material.opacity = 0;
    this.branches.forEach(branch => {
      if (branch.material instanceof THREE.LineBasicMaterial) {
        branch.material.opacity = 0;
      }
    });
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
    this.geometry.dispose();
    this.branches.forEach(branch => branch.geometry.dispose());

    // Clean up materials
    this.material.dispose();
    this.branches.forEach(branch => {
      if (branch.material instanceof THREE.Material) {
        branch.material.dispose();
      }
    });

    // Remove from parent if attached
    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }
  }
}
