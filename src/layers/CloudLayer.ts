import * as THREE from 'three';
import { BaseLayer } from './LayerInterface';

/**
 * Configuration for the cloud layer
 */
export interface CloudLayerConfig {
  altitude: number;      // Height of the cloud layer
  opacity: number;       // Cloud opacity
  size: number;          // Size multiplier for clouds
  imagePath: string;     // Path to cloud texture
}

/**
 * Default cloud layer configuration
 */
export const DEFAULT_CLOUD_CONFIG: CloudLayerConfig = {
  altitude: 0.03,       // 1/3 of the original height (0.16)
  opacity: 0.6,          // Semi-transparent clouds
  size: 3.5,             // Size multiplier
  imagePath: '/clouds.png'  // Path to cloud image
};

/**
 * Creates a cloud layer around the globe
 */
export class CloudLayer extends BaseLayer<void> {
  private config: CloudLayerConfig;
  private cloudMesh: THREE.Mesh | null = null;
  
  /**
   * Create a new cloud layer
   */
  constructor(config: Partial<CloudLayerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CLOUD_CONFIG, ...config };
  }
  
  /**
   * Initialize the cloud layer on the globe
   */
  initialize(globeEl: any): void {
    super.initialize(globeEl);
    
    if (!this.scene || !globeEl) return;
    
    // Create cloud material using the provided texture
    const material = new THREE.MeshPhongMaterial({
      map: new THREE.TextureLoader().load(this.config.imagePath),
      transparent: true,
      opacity: this.config.opacity,
      depthWrite: false // Don't write to depth buffer to allow objects behind to render
    });
    
    // Create the cloud sphere at the specified altitude
    const EARTH_RADIUS = 100; // Base globe radius in react-globe.gl
    const cloudRadius = EARTH_RADIUS * (1 + this.config.altitude);
    const cloudGeometry = new THREE.SphereGeometry(cloudRadius, 48, 48);
    
    // Create the cloud mesh
    this.cloudMesh = new THREE.Mesh(cloudGeometry, material);
    
    // Set rendering order (lower numbers render first)
    this.cloudMesh.renderOrder = 10;
    
    // Add to scene
    this.scene.add(this.cloudMesh);
  }
  
  /**
   * Update method (required by Layer interface)
   * Clouds are static, so we just check visibility
   */
  update(): void {
    if (this.cloudMesh) {
      this.cloudMesh.visible = this.visible;
    }
  }
  
  /**
   * Add data method (required by Layer interface)
   * Not used for clouds but required by interface
   */
  addData(_data: void): void {
    // No data to add for the cloud layer
  }
  
  /**
   * Clear the layer
   */
  clear(): void {
    if (this.cloudMesh && this.scene) {
      this.scene.remove(this.cloudMesh);
      
      if (this.cloudMesh.geometry) {
        this.cloudMesh.geometry.dispose();
      }
      
      if (this.cloudMesh.material instanceof THREE.Material) {
        this.cloudMesh.material.dispose();
      }
      
      this.cloudMesh = null;
    }
  }
}
