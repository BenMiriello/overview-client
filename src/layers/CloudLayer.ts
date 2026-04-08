import * as THREE from 'three';
import { BaseLayer } from './LayerInterface';
import { getConfig, setConfig } from '../config';
import { LAYERS } from '../services/renderLayers';
import { sharedNightUniforms } from '../services/dayNightMaterial';
import { cloudVertexShader, cloudFragmentShader } from './cloudShaders';

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
  private refreshTimer: number | null = null;
  private startTime = performance.now();
  private flashIntensity = 0;
  private flashHandler: (() => void) | null = null;

  constructor() {
    super();
  }

  /**
   * Loads a texture from a URL chain, falling back if any link fails.
   * Returns the loaded texture and the URL that succeeded.
   */
  private loadTextureWithFallback(urls: string[]): Promise<{ texture: THREE.Texture; url: string }> {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    return new Promise((resolve, reject) => {
      const tryNext = (i: number) => {
        if (i >= urls.length) { reject(new Error('All cloud texture URLs failed')); return; }
        loader.load(
          urls[i],
          tex => resolve({ texture: tex, url: urls[i] }),
          undefined,
          () => { console.warn(`CloudLayer: failed to load ${urls[i]}, trying next`); tryNext(i + 1); },
        );
      };
      tryNext(0);
    });
  }

  private buildUrlChain(): string[] {
    const useLive = getConfig<boolean>('layers.clouds.useLiveTexture') ?? true;
    const liveUrl = getConfig<string>('layers.clouds.liveTextureEndpoint') || '';
    const fallback = getConfig<string>('layers.clouds.fallbackImagePath') || '/clouds-fallback.png';
    const chain: string[] = [];
    if (useLive && liveUrl) {
      chain.push(`${liveUrl}?t=${Date.now()}`);
      chain.push(`${liveUrl}?previous=1&t=${Date.now()}`);
    }
    chain.push(fallback);
    return chain;
  }

  private async refreshTexture(): Promise<void> {
    if (!this.cloudMesh) return;
    try {
      const { texture } = await this.loadTextureWithFallback(this.buildUrlChain());
      // Equirectangular wraps in longitude (U), clamps in latitude (V).
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = true;
      const mat = this.cloudMesh.material as THREE.ShaderMaterial;
      const old = mat.uniforms.uMap.value as THREE.Texture | null;
      mat.uniforms.uMap.value = texture;
      if (old) old.dispose();
    } catch (err) {
      console.error('CloudLayer: texture refresh failed:', err);
    }
  }

  initialize(globeEl: any): void {
    super.initialize(globeEl);

    if (!this.scene || !globeEl) {
      console.warn('CloudLayer: Scene or Globe not available for initialization');
      return;
    }

    try {
      // Cloud material — Phase 2 ShaderMaterial. The base raster (uMap) is
      // set asynchronously by refreshTexture(); we start with a transparent
      // 1x1 placeholder so the mesh exists immediately and never flashes the
      // legacy unrealistic clouds.png. Tunables (uOpacity / uDetailStrength /
      // uThickness / uShadowStrength) are pulled from config so they can be
      // exposed in the settings panel later without touching this file.
      const placeholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
      placeholder.needsUpdate = true;
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uMap:             { value: placeholder },
          uSunDir:          sharedNightUniforms.sunDir,
          uCameraPos:       { value: new THREE.Vector3() },
          uOpacity:         { value: getConfig<number>('layers.clouds.opacity') ?? 0.85 },
          uTime:            { value: 0 },
          uDetailStrength:  { value: getConfig<number>('layers.clouds.detailStrength') ?? 0.35 },
          uDetailFreq:      { value: new THREE.Vector2(64, 32) },
          uThickness:       { value: getConfig<number>('layers.clouds.thickness') ?? 0.004 },
          uShadowStrength:  { value: getConfig<number>('layers.clouds.shadowStrength') ?? 1.2 },
          uFlashIntensity:  { value: 0 },
          uDetailFade:      { value: 1 },
          uDensityGamma:    { value: getConfig<number>('layers.clouds.densityGamma') ?? 1.6 },
          uNightAmbient:    { value: 0.12 },
        },
        vertexShader: cloudVertexShader,
        fragmentShader: cloudFragmentShader,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.FrontSide,
      });

      const initialAlt = CLOUD_ALT_FAR;
      const cloudGeometry = new THREE.SphereGeometry(EARTH_RADIUS, 96, 96);

      this.cloudMesh = new THREE.Mesh(cloudGeometry, material);
      this.cloudMesh.scale.setScalar(1 + initialAlt);
      this.lastCloudAlt = initialAlt;

      this.cloudMesh.renderOrder = LAYERS.CLOUDS;

      // Depth occluder: invisible BackSide sphere at globe radius.
      // The globe's FrontSide material only fills depth for its near hemisphere, leaving
      // the far hemisphere's depth buffer clear (1.0). Without this occluder, cloud fragments
      // past the globe's silhouette pass the depth test against the clear value and render
      // incorrectly. BackSide fills depth for the far hemisphere, blocking those fragments.
      this.occluderMesh = new THREE.Mesh(
        new THREE.SphereGeometry(EARTH_RADIUS, 32, 32),
        new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.BackSide })
      );
      this.occluderMesh.renderOrder = LAYERS.CLOUD_OCCLUDER;

      this.scene.add(this.cloudMesh);
      this.scene.add(this.occluderMesh);

      this.refreshTexture();
      const intervalMs = getConfig<number>('layers.clouds.refreshIntervalMs') || 30 * 60 * 1000;
      this.refreshTimer = window.setInterval(() => this.refreshTexture(), intervalMs);

      // Lightning flash bump: production globe dispatches a parameter-less
      // 'lightning-flash' event from LightningBoltEffect on each strike. Set
      // the cloud flash uniform to 1 and let update() decay it.
      this.flashHandler = () => { this.flashIntensity = 1; };
      window.addEventListener('lightning-flash', this.flashHandler);
    } catch (err) {
      console.error('CloudLayer: Error during initialization:', err);
    }
  }

  /**
   * Update method (required by Layer interface)
   * Rotates the clouds and checks visibility
   */
  update(): void {
    if (!this.cloudMesh) return;
    this.cloudMesh.visible = this.visible;
    if (!this.visible) return;

    const rotationSpeed = getConfig<number>('layers.clouds.rotationSpeed') || 0;
    if (rotationSpeed !== 0) {
      this.cloudMesh.rotation.y += rotationSpeed * Math.PI / 180;
    }

    const mat = this.cloudMesh.material as THREE.ShaderMaterial;

    // Per-frame uniforms.
    mat.uniforms.uTime.value = (performance.now() - this.startTime) / 1000;
    // Decay flash bump exponentially over ~250ms.
    if (this.flashIntensity > 0.001) {
      this.flashIntensity *= 0.88;
    } else {
      this.flashIntensity = 0;
    }
    mat.uniforms.uFlashIntensity.value = this.flashIntensity;

    if (this.globeEl) {
      try {
        const camera = this.globeEl.camera();
        (mat.uniforms.uCameraPos.value as THREE.Vector3).copy(camera.position);

        const globeRadius = (this.globeEl.getGlobeRadius?.() as number | undefined) ?? EARTH_RADIUS;
        const cameraAlt = camera.position.length() / globeRadius - 1;
        const t = Math.max(0, Math.min(1,
          (ALT_FAR_POINT - cameraAlt) / (ALT_FAR_POINT - ALT_NEAR_POINT)
        ));
        const cloudAlt = CLOUD_ALT_FAR + (CLOUD_ALT_NEAR - CLOUD_ALT_FAR) * t;

        // Fade out FBM detail + parallax as we zoom out to prevent
        // tessellation-correlated artifacts. Full at cameraAlt≤0.5, off at ≥1.0.
        const detailFade = Math.max(0, Math.min(1, (1.0 - cameraAlt) / 0.5));
        mat.uniforms.uDetailFade.value = detailFade;

        if (Math.abs(cloudAlt - this.lastCloudAlt) > 0.0001) {
          this.cloudMesh.scale.setScalar(1 + cloudAlt);
          setConfig('layers.clouds.altitude', cloudAlt);
          this.lastCloudAlt = cloudAlt;
        }
      } catch { /* globeEl not ready */ }
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
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.flashHandler) {
      window.removeEventListener('lightning-flash', this.flashHandler);
      this.flashHandler = null;
    }
    if (this.cloudMesh && this.scene) {
      this.scene.remove(this.cloudMesh);
      if (this.cloudMesh.geometry) this.cloudMesh.geometry.dispose();
      const mat = this.cloudMesh.material;
      if (mat instanceof THREE.ShaderMaterial) {
        const tex = mat.uniforms.uMap?.value as THREE.Texture | null;
        if (tex) tex.dispose();
        mat.dispose();
      } else if (mat instanceof THREE.Material) {
        mat.dispose();
      }
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
