import * as THREE from 'three';
import { BaseLayer } from './LayerInterface';

export interface CloudLayerConfig {
  altitude: number;      // Height of the cloud layer
  opacity: number;       // Cloud opacity
  size: number;          // Size multiplier for clouds
  imagePath: string;     // Path to cloud texture
  rotationSpeed: number; // Rotation speed (degrees per second)
}

export const DEFAULT_CLOUD_CONFIG: CloudLayerConfig = {
  altitude: 0.02,
  opacity: 0.6,             // Semi-transparent clouds
  size: 3.5,                // Size multiplier
  imagePath: '/clouds.png',  // Path to cloud image
  rotationSpeed: 0.005        // Slow rotation (degrees per frame)
};

/**
 * Creates a cloud layer around the globe
 */
export class CloudLayer extends BaseLayer<void> {
  private config: CloudLayerConfig;
  private cloudMesh: THREE.Mesh | null = null;

  constructor(config: Partial<CloudLayerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CLOUD_CONFIG, ...config };
  }

  initialize(globeEl: any): void {
    super.initialize(globeEl);

    if (!this.scene || !globeEl) {
      console.warn('CloudLayer: Scene or Globe not available for initialization');
      return;
    }

    try {
      // Create cloud material using the provided texture
      const material = new THREE.MeshPhongMaterial({
        map: new THREE.TextureLoader().load(this.config.imagePath),
        transparent: true,
        opacity: this.config.opacity,
        depthWrite: false, // Don't write to depth buffer to allow objects behind to render
        side: THREE.DoubleSide, // Render both sides of the geometry
        alphaTest: 0.1         // Discard pixels with low alpha values
      });

      const EARTH_RADIUS = 100; // Base globe radius in react-globe.gl
      const cloudRadius = EARTH_RADIUS * (1 + this.config.altitude);
      const cloudGeometry = new THREE.SphereGeometry(cloudRadius, 48, 48);

      this.cloudMesh = new THREE.Mesh(cloudGeometry, material);

      // Set rendering order (lower numbers render first)
      // Make sure this is a value that renders after the globe but before lightning
      this.cloudMesh.renderOrder = 1;

      this.scene.add(this.cloudMesh);
    } catch (err) {
      console.error('CloudLayer: Error during initialization:', err);
    }
  }

  /**
   * Update method (required by Layer interface)
   * Rotates the clouds and checks visibility
   */
  update(): void {
    if (this.cloudMesh) {
      this.cloudMesh.visible = this.visible;

      // Rotate clouds counter-clockwise (if viewed from above)
      if (this.visible && this.config.rotationSpeed !== 0) {
        this.cloudMesh.rotation.y += this.config.rotationSpeed * Math.PI / 180;
      }
    }
  }

  /**
   * Add data method (required by Layer interface)
   * Not used for clouds but required by interface
   */
  addData(_data: void): void {
    // No data to add for the cloud layer
  }

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
