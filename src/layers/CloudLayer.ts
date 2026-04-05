import * as THREE from 'three';
import { BaseLayer } from './LayerInterface';
import { getConfig, setConfig } from '../config';

/**
 * Creates a cloud layer around the globe
 */
const EARTH_RADIUS = 100; // Base globe radius in react-globe.gl
const CLOUD_ALT_FAR  = 0.01;  // Altitude when zoomed out (globe scale)
const CLOUD_ALT_NEAR = 0.003; // Altitude when zoomed in (realistic storm cloud scale)
const ALT_FAR_POINT  = 1.0;   // Camera altitude where far scale applies (close-mode entry threshold)
const ALT_NEAR_POINT = 0.25;  // Camera altitude where near (realistic) scale is fully reached

export class CloudLayer extends BaseLayer<void> {
  private cloudMesh: THREE.Mesh | null = null;
  private occluderMesh: THREE.Mesh | null = null;
  private lastCloudAlt = -1;

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
        side: THREE.FrontSide,
        alphaTest: 0.1         // Discard pixels with low alpha values
      });

      const initialAlt = CLOUD_ALT_FAR;
      const cloudGeometry = new THREE.SphereGeometry(EARTH_RADIUS, 48, 48);

      this.cloudMesh = new THREE.Mesh(cloudGeometry, material);
      this.cloudMesh.scale.setScalar(1 + initialAlt);
      this.lastCloudAlt = initialAlt;

      // Set rendering order (lower numbers render first)
      // IMPORTANT: Make sure this is a value that renders after the globe but before lightning
      this.cloudMesh.renderOrder = 1;

      // Depth occluder: invisible BackSide sphere at globe radius.
      // The globe's FrontSide material only fills depth for its near hemisphere, leaving
      // the far hemisphere's depth buffer clear (1.0). Without this occluder, cloud fragments
      // past the globe's silhouette pass the depth test against the clear value and render
      // incorrectly. BackSide fills depth for the far hemisphere, blocking those fragments.
      this.occluderMesh = new THREE.Mesh(
        new THREE.SphereGeometry(EARTH_RADIUS, 32, 32),
        new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.BackSide })
      );
      this.occluderMesh.renderOrder = 0;

      this.scene.add(this.cloudMesh);
      this.scene.add(this.occluderMesh);
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

      if (this.visible) {
        const rotationSpeed = getConfig<number>('layers.clouds.rotationSpeed') || 0.002;
        if (rotationSpeed !== 0) {
          this.cloudMesh.rotation.y += rotationSpeed * Math.PI / 180;
        }

        // Dynamically scale cloud altitude based on camera distance
        if (this.globeEl) {
          try {
            const camera = this.globeEl.camera();
            const globeRadius = (this.globeEl.getGlobeRadius?.() as number | undefined) ?? EARTH_RADIUS;
            const cameraAlt = camera.position.length() / globeRadius - 1;
            const t = Math.max(0, Math.min(1,
              (ALT_FAR_POINT - cameraAlt) / (ALT_FAR_POINT - ALT_NEAR_POINT)
            ));
            const cloudAlt = CLOUD_ALT_FAR + (CLOUD_ALT_NEAR - CLOUD_ALT_FAR) * t;

            if (Math.abs(cloudAlt - this.lastCloudAlt) > 0.0001) {
              this.cloudMesh.scale.setScalar(1 + cloudAlt);
              setConfig('layers.clouds.altitude', cloudAlt);
              this.lastCloudAlt = cloudAlt;
            }
          } catch { /* globeEl not ready */ }
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
      if (this.cloudMesh.geometry) this.cloudMesh.geometry.dispose();
      if (this.cloudMesh.material instanceof THREE.Material) this.cloudMesh.material.dispose();
      this.cloudMesh = null;
    }
    if (this.occluderMesh && this.scene) {
      this.scene.remove(this.occluderMesh);
      if (this.occluderMesh.geometry) this.occluderMesh.geometry.dispose();
      if (this.occluderMesh.material instanceof THREE.Material) this.occluderMesh.material.dispose();
      this.occluderMesh = null;
    }
  }
}
