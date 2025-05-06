import * as THREE from 'three';
import { BaseLayer } from './LayerInterface';
import { getConfig } from '../config';

/**
 * Creates a cloud layer around the globe
 */
export class CloudLayer extends BaseLayer<void> {
  private cloudMesh: THREE.Mesh | null = null;

  constructor() {
    super();
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
        map: new THREE.TextureLoader().load(getConfig<string>('layers.clouds.imagePath') || '/clouds.png'),
        transparent: true,
        opacity: getConfig<number>('layers.clouds.opacity') || 0.6,
        depthWrite: false, // Don't write to depth buffer to allow objects behind to render
        side: THREE.DoubleSide, // Render both sides of the geometry
        alphaTest: 0.1         // Discard pixels with low alpha values
      });

      const EARTH_RADIUS = 100; // Base globe radius in react-globe.gl
      const cloudRadius = EARTH_RADIUS * (1 + (getConfig<number>('layers.clouds.altitude') || 0.02));
      const cloudGeometry = new THREE.SphereGeometry(cloudRadius, 48, 48);

      this.cloudMesh = new THREE.Mesh(cloudGeometry, material);

      // Set rendering order (lower numbers render first)
      // IMPORTANT: Make sure this is a value that renders after the globe but before lightning
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
      
      // Rotate clouds counter-clockwise (when viewed from above)
      if (this.visible) {
        const rotationSpeed = getConfig<number>('layers.clouds.rotationSpeed') || 0.002;
        if (rotationSpeed !== 0) {
          this.cloudMesh.rotation.y += rotationSpeed * Math.PI / 180;
        }
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
