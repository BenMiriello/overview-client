import * as THREE from 'three';

/**
 * Lightning bolt effect configuration
 */
export interface LightningConfig {
  startAltitude: number;     // Starting height of the lightning (above surface)
  endAltitude: number;       // Ending height of the lightning (surface level)
  color: number;             // Color of the lightning (hex)
  lineWidth: number;             // Width/thickness of the lightning lines
  lineSegments: number;          // Number of zigzag segments
  jitterAmount: number;      // How much randomness in the zigzag
  branchChance: number;      // Probability (0-1) of creating a branch at each segment
  branchFactor: number;      // Length of the branches relative to main bolt
  maxBranches: number;       // Maximum number of branches
  duration: number;          // Total duration of the lightning animation (ms)
  fadeOutDuration: number;   // How long the fade out animation lasts (ms)
  randomSeed?: number;       // Optional seed for deterministic randomness
}

/**
 * Default lightning configuration
 */
export const DEFAULT_LIGHTNING_CONFIG: LightningConfig = {
  startAltitude: 0.04,       // Higher altitude for more dramatic effect
  endAltitude: 0.0005,       // The bottom of the strike effect
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
 * Class for creating and managing lightning bolts
 */
export class LightningEffect {
  private geometry: THREE.BufferGeometry;
  private material: THREE.LineBasicMaterial;
  private mainBolt: THREE.Line;
  private branches: THREE.Line[] = [];
  private group: THREE.Group;
  private config: LightningConfig;
  private createTime: number;
  private random: () => number;
  private glowLight: THREE.PointLight | null = null;

  // Animation control flags
  public showGlow: boolean = true;
  public showLightning: boolean = true;

  /**
   * Create a new lightning effect
   * @param lat Latitude
   * @param lng Longitude
   * @param config Optional configuration override
   */
  constructor(
    public lat: number,
    public lng: number,
    config: Partial<LightningConfig> = {}
  ) {
    // Merge provided config with defaults
    this.config = { ...DEFAULT_LIGHTNING_CONFIG, ...config };
    this.createTime = Date.now();

    // Setup pseudo-random number generator (for deterministic results)
    const seed = this.config.randomSeed || Math.random() * 10000;
    this.random = this.createRandomGenerator(seed);

    // Create the group to hold all parts of the lightning
    this.group = new THREE.Group();

    // Create the geometry for the main bolt
    this.geometry = this.createLightningGeometry();

    // Create the material
    this.material = new THREE.LineBasicMaterial({
      color: this.config.color,
      transparent: true,
      opacity: 1.0,
      linewidth: this.config.lineWidth,
    });

    // Create the main bolt
    this.mainBolt = new THREE.Line(this.geometry, this.material);
    this.group.add(this.mainBolt);

    // Create branches
    this.createBranches();
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
   * Create the zigzag geometry for the main lightning bolt
   */
  private createLightningGeometry(): THREE.BufferGeometry {
    const segments = this.config.lineSegments;
    const points: THREE.Vector3[] = [];

    // Create a zigzag line from top to bottom with varying segment lengths
    let prevX = 0, prevZ = 0;
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;

      // Interpolate height from start to end altitude with non-linear curve for more natural look
      const easedT = t * t; // Quadratic easing for faster initial descent
      const altitude = this.config.startAltitude * (1 - easedT) + this.config.endAltitude * easedT;

      // More randomness at the middle segments, less at the ends
      const segmentRandomness = Math.sin(t * Math.PI); // Peaks at t=0.5 (middle)
      const jitterMultiplier = segmentRandomness * 1.5;

      // Add randomness to x and z (horizontal plane) with progressive buildup
      // Each jitter builds on the previous position for more natural branching pattern
      const jitterX = (prevX + (this.random() * 2 - 1) * this.config.jitterAmount * jitterMultiplier);
      const jitterZ = (prevZ + (this.random() * 2 - 1) * this.config.jitterAmount * jitterMultiplier);

      // No jitter at start and end points
      const finalJitterX = (i === 0 || i === segments) ? 0 : jitterX;
      const finalJitterZ = (i === 0 || i === segments) ? 0 : jitterZ;

      prevX = finalJitterX;
      prevZ = finalJitterZ;

      points.push(new THREE.Vector3(finalJitterX, altitude, finalJitterZ));
    }

    // Create geometry from points
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    return geometry;
  }

  /**
   * Create branches from the main bolt
   */
  private createBranches() {
    const segments = this.config.lineSegments;
    const maxBranches = this.config.maxBranches;
    let branchCount = 0;

    // Get the vertices of the main bolt
    const positions = this.geometry.getAttribute('position');

    // Skip the first and last segment when creating branches
    for (let i = 1; i < segments && branchCount < maxBranches; i++) {
      // Check if we should create a branch
      if (this.random() < this.config.branchChance) {
        // Get the position of the current segment
        const x = positions.getX(i);
        const y = positions.getY(i);
        const z = positions.getZ(i);

        // Calculate branch direction (angled down and outward)
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
   * Update the lightning effect based on time
   * @param currentTime Current time in milliseconds
   * @returns Whether the lightning effect is still active
   */
  update(currentTime: number, allowAnimation: boolean = true): boolean {
    const age = currentTime - this.createTime;

    // Fixed animation durations as requested
    const drawDuration = 500;        // 0.5 seconds to draw the squiggly line
    const displayDuration = 500;     // 0.5 seconds to keep it visible
    const fadeOutDuration = 500;     // 0.5 seconds to fade out
    const totalDuration = 1500;      // 1.5 seconds total
    const maxGlowDuration = 1000;    // 1 second max for glow

    // If past total duration or not in active set, lightning is done
    if (age > totalDuration || !allowAnimation) {
      // Explicitly hide lightning
      if (this.material) {
        this.material.opacity = 0;
        this.branches.forEach(branch => {
          if (branch.material instanceof THREE.LineBasicMaterial) {
            branch.material.opacity = 0;
          }
        });
      }

      if (this.glowLight) {
        this.glowLight.intensity = 0;
      }

      return age <= totalDuration; // Only return true if still within duration
    }

    // Handle lightning animation in three phases
    if (this.showLightning) {
      // Drawing phase (0-0.5s)
      if (age <= drawDuration) {
        const progress = age / drawDuration;
        // Show progressive drawing from top to bottom
        this.material.opacity = progress;
        this.branches.forEach(branch => {
          if (branch.material instanceof THREE.LineBasicMaterial) {
            branch.material.opacity = progress;
          }
        });
      } 
      // Static display phase (0.5-1.0s)
      else if (age <= drawDuration + displayDuration) {
        this.material.opacity = 1.0;
        this.branches.forEach(branch => {
          if (branch.material instanceof THREE.LineBasicMaterial) {
            branch.material.opacity = 1.0;
          }
        });
      } 
      // Fade out phase (1.0-1.5s)
      else {
        const fadeProgress = (age - (drawDuration + displayDuration)) / fadeOutDuration;
        const opacity = Math.max(0, 1.0 - fadeProgress);

        this.material.opacity = opacity;
        this.branches.forEach(branch => {
          if (branch.material instanceof THREE.LineBasicMaterial) {
            branch.material.opacity = opacity;
          }
        });
      }
    } else {
      this.material.opacity = 0;
      this.mainBolt.visible = false;
      this.branches.forEach(branch => {
        if (branch.material instanceof THREE.LineBasicMaterial) {
          branch.material.opacity = 0;
        }
        branch.visible = false;
      });
    }

    // Handle glow effect (only active for 1 second max)
    if (this.glowLight && this.showGlow) {
      if (age <= maxGlowDuration) {
        // First 0.7 seconds: ramp up and full intensity
        if (age < 700) {
          const intensity = Math.min(2.0, age / 350); // Ramp up to full intensity
          this.glowLight.intensity = intensity;
        } 
        // Last 0.3 seconds: fade out
        else {
          const fadeRatio = 1.0 - ((age - 700) / 300);
          this.glowLight.intensity = fadeRatio * 2.0;
        }
      } else {
        // After 1 second, turn off glow completely
        this.glowLight.intensity = 0;
      }
    }

    return true;
  }

  terminateImmediately() {
    // Immediately remove light from scene
    if (this.glowLight) {
      if (this.glowLight.parent) {
        this.glowLight.parent.remove(this.glowLight);
      }
      this.glowLight.intensity = 0;
      this.glowLight = null;
    }

    // Remove lightning completely from the scene
    if (this.mainBolt.parent) {
      this.mainBolt.parent.remove(this.mainBolt);
    }

    this.branches.forEach(branch => {
      if (branch.parent) {
        branch.parent.remove(branch);
      }
    });

    // Hide lightning
    this.material.opacity = 0;
    this.branches.forEach(branch => {
      if (branch.material instanceof THREE.LineBasicMaterial) {
        branch.material.opacity = 0;
      }
    });
  }

  /**
   * Get the Three.js group containing the lightning
   */
  getObject(): THREE.Group {
    return this.group;
  }

  /**
   * Position the lightning at the given coordinates on the globe
   * @param globeEl Globe reference
   * @param lat Latitude
   * @param lng Longitude
   * @param altitude Base altitude
   */
  positionOnGlobe(globeEl: any, lat: number, lng: number, altitude: number = 0): void {
    if (!globeEl) return;

    // Position the group at the surface point
    const surfaceCoords = globeEl.getCoords(lat, lng, altitude);
    this.group.position.set(surfaceCoords.x, surfaceCoords.y, surfaceCoords.z);

    // Orient the group to face outward from the center of the globe
    const globeCenter = new THREE.Vector3(0, 0, 0);
    const normal = new THREE.Vector3()
      .subVectors(surfaceCoords, globeCenter)
      .normalize();

    // Create a quaternion rotation that aligns the lightning with the surface normal
    this.group.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), // Default up vector (Y axis)
      normal                       // Target direction (surface normal)
    );

    // Add a point light for the glow effect if enabled
    if (this.showGlow) {
      console.log('showing Glow');
      this.glowLight = new THREE.PointLight(0x88ccff, 2.0, 5);
      this.glowLight.position.set(0, this.config.endAltitude * 0.5, 0); // Position near the ground
      this.group.add(this.glowLight);
    }
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    // Dispose geometries
    this.geometry.dispose();
    this.branches.forEach(branch => branch.geometry.dispose());

    // Clean up glow light
    if (this.glowLight) {
      this.group.remove(this.glowLight);
      this.glowLight = null;
    }

    // Remove from parent if attached
    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }
  }
}
