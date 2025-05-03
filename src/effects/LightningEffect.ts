import * as THREE from 'three';

/**
 * Lightning bolt effect configuration
 */
export interface LightningConfig {
  startAltitude: number;     // Starting height of the lightning (above surface)
  endAltitude: number;       // Ending height of the lightning (surface level)
  color: number;             // Color of the lightning (hex)
  width: number;             // Width/thickness of the lightning lines
  segments: number;          // Number of zigzag segments
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
  startAltitude: 0.03,       // Higher altitude than before (2x higher)
  endAltitude: 0.0005,
  color: 0xffffff,
  width: 3,
  segments: 6,
  jitterAmount: 0.015,
  branchChance: 0.3,
  branchFactor: 0.6,
  maxBranches: 3,
  duration: 750,             // Total duration
  fadeOutDuration: 250,      // Fade out duration
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
      linewidth: this.config.width,
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
    const segments = this.config.segments;
    const points: THREE.Vector3[] = [];
    
    // Create a zigzag line from top to bottom
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      
      // Interpolate height from start to end altitude
      const altitude = this.config.startAltitude * (1 - t) + this.config.endAltitude * t;
      
      // Add randomness to x and z (horizontal plane)
      const jitterX = (this.random() * 2 - 1) * this.config.jitterAmount;
      const jitterZ = (this.random() * 2 - 1) * this.config.jitterAmount;
      
      // No jitter at start and end points
      const finalJitterX = (i === 0 || i === segments) ? 0 : jitterX;
      const finalJitterZ = (i === 0 || i === segments) ? 0 : jitterZ;
      
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
    const segments = this.config.segments;
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
  update(currentTime: number): boolean {
    const age = currentTime - this.createTime;
    const { duration, fadeOutDuration } = this.config;
    
    // If past duration, the lightning is done
    if (age > duration) {
      return false;
    }
    
    // Calculate the current opacity based on age
    let opacity = 1.0;
    
    // Fade out towards the end
    if (age > duration - fadeOutDuration) {
      opacity = 1.0 - (age - (duration - fadeOutDuration)) / fadeOutDuration;
    }
    
    // Update opacity of main bolt and branches
    this.material.opacity = opacity;
    this.branches.forEach(branch => {
      (branch.material as THREE.LineBasicMaterial).opacity = opacity;
    });
    
    return true;
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
  }
  
  /**
   * Dispose resources
   */
  dispose(): void {
    // Dispose geometries
    this.geometry.dispose();
    this.branches.forEach(branch => branch.geometry.dispose());
    
    // Remove from parent if attached
    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }
  }
}
