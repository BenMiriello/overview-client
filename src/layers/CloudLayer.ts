import * as THREE from 'three';
import { BaseLayer } from './LayerInterface';
import { getConfig, setConfig } from '../config';
import { LAYERS } from '../services/renderLayers';
import { sharedNightUniforms } from '../services/dayNightMaterial';
import { cloudVertexShader, cloudFragmentShader } from './cloudShaders';

const EARTH_RADIUS = 100;
const CLOUD_ALT_FAR  = 0.03;
const CLOUD_ALT_NEAR = 0.003;
const ALT_FAR_POINT  = 1.0;
const ALT_NEAR_POINT = 0.005;

interface CloudShell {
  mesh: THREE.Mesh;
  altMultiplier: number;
}

const SHELL_DEFS = [
  { renderOrder: LAYERS.CLOUDS, altMultiplier: 1.0 },
];

export class CloudLayer extends BaseLayer<void> {
  /** Flip to true in the browser console to test whether clouds are the source of
   *  any night-side glow: `layerManagerRef.current.getLayer('clouds').constructor.ISOLATION_TEST_DISABLE = true` */
  static ISOLATION_TEST_DISABLE = false;

  private shells: CloudShell[] = [];
  private sharedGeometry: THREE.SphereGeometry | null = null;
  private occluderMesh: THREE.Mesh | null = null;
  private baseTexture: THREE.Texture | null = null;
  private lastCloudAlt = -1;
  private refreshTimer: number | null = null;
  private startTime = performance.now();
  private flashIntensity = 0;
  private flashWorldPos = new THREE.Vector3();
  private flashHandler: ((e: Event) => void) | null = null;
  private userCloudsEnabled = true;
  private userOpacity = 1.0;
  private temperatureEnabled = false;
  private fadeOpacity = 1.0;
  private fadeTarget = 1.0;
  private lastUpdateTime = -1;

  constructor() {
    super();
  }

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
    if (this.shells.length === 0) return;
    try {
      const { texture } = await this.loadTextureWithFallback(this.buildUrlChain());
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = true;
      try {
        const renderer = this.globeEl?.renderer?.();
        const maxAniso = renderer?.capabilities?.getMaxAnisotropy?.() ?? 1;
        texture.anisotropy = maxAniso;
      } catch { /* renderer not ready */ }

      const img = texture.image as HTMLImageElement | undefined;
      const w = img?.naturalWidth || 8192;
      const h = img?.naturalHeight || 4096;
      const texel = new THREE.Vector2(1 / w, 1 / h);

      const old = this.baseTexture;
      this.baseTexture = texture;
      sharedNightUniforms.cloudTex.value = texture;
      for (const { mesh } of this.shells) {
        const mat = mesh.material as THREE.ShaderMaterial;
        mat.uniforms.uMap.value = texture;
        (mat.uniforms.uTexelSize.value as THREE.Vector2).copy(texel);
      }
      if (old) old.dispose();
    } catch (err) {
      console.error('CloudLayer: texture refresh failed:', err);
    }
  }

  private createShellMaterial(): THREE.ShaderMaterial {
    const placeholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
    placeholder.needsUpdate = true;
    return new THREE.ShaderMaterial({
      uniforms: {
        uMap:             { value: placeholder },
        uSunDir:          sharedNightUniforms.sunDir,
        uOpacity:         { value: getConfig<number>('layers.clouds.opacity') ?? 1.0 },
        uTime:            { value: 0 },
        uDetailStrength:  { value: getConfig<number>('layers.clouds.detailStrength') ?? 0.10 },
        uDetailFreq:      { value: new THREE.Vector2(64, 32) },
        uFlashIntensity:  { value: 0 },
        uFlashWorldPos:   { value: new THREE.Vector3() },
        uFlashFalloff:    { value: 20000.0 },
        uDetailFade:      { value: 1 },
        uDensityLo:       { value: getConfig<number>('layers.clouds.densityLo') ?? 0.05 },
        uNightAmbient:    { value: 0.12 },
        uTexelSize:       { value: new THREE.Vector2(1 / 8192, 1 / 4096) },
        uBumpStrength:    { value: getConfig<number>('layers.clouds.bumpStrength') ?? 3.0 },
        uReliefAmount:    { value: getConfig<number>('layers.clouds.reliefAmount') ?? 1.4 },
      },
      vertexShader: cloudVertexShader,
      fragmentShader: cloudFragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    });
  }

  initialize(globeEl: any): void {
    super.initialize(globeEl);

    if (!this.scene || !globeEl) {
      console.warn('CloudLayer: Scene or Globe not available for initialization');
      return;
    }

    try {
      this.sharedGeometry = new THREE.SphereGeometry(EARTH_RADIUS, 96, 96);

      for (const def of SHELL_DEFS) {
        const mat = this.createShellMaterial();
        const mesh = new THREE.Mesh(this.sharedGeometry, mat);
        mesh.scale.setScalar(1 + CLOUD_ALT_FAR * def.altMultiplier);
        mesh.renderOrder = def.renderOrder;
        this.scene.add(mesh);
        this.shells.push({ mesh, altMultiplier: def.altMultiplier });
      }

      this.refreshTexture();
      const intervalMs = getConfig<number>('layers.clouds.refreshIntervalMs') || 30 * 60 * 1000;
      this.refreshTimer = window.setInterval(() => this.refreshTexture(), intervalMs);

      this.flashHandler = (e: Event) => {
        this.flashIntensity = 2.0;
        const detail = (e as CustomEvent).detail;
        if (detail?.lat != null && detail?.lng != null) {
          const phi = (90 - detail.lat) * Math.PI / 180;
          const theta = (90 - detail.lng) * Math.PI / 180;
          this.flashWorldPos.set(
            Math.sin(phi) * Math.cos(theta),
            Math.cos(phi),
            Math.sin(phi) * Math.sin(theta),
          ).multiplyScalar(EARTH_RADIUS);
        }
      };
      window.addEventListener('lightning-flash', this.flashHandler);
    } catch (err) {
      console.error('CloudLayer: Error during initialization:', err);
    }
  }

  update(): void {
    if (this.shells.length === 0) return;
    if (CloudLayer.ISOLATION_TEST_DISABLE) {
      for (const { mesh } of this.shells) mesh.visible = false;
      return;
    }

    for (const { mesh } of this.shells) {
      mesh.visible = this.visible;
    }
    if (!this.visible) return;

    const nowMs = performance.now();
    const time = (nowMs - this.startTime) / 1000;
    const dt = this.lastUpdateTime >= 0 ? (nowMs - this.lastUpdateTime) / 1000 : 0;
    this.lastUpdateTime = nowMs;

    if (this.flashIntensity > 0.001) {
      // Decay to ~1% in 250ms regardless of frame rate (half-life ≈ 55ms)
      this.flashIntensity *= Math.pow(0.001, dt / 0.25);
    } else {
      this.flashIntensity = 0;
    }
    sharedNightUniforms.flashIntensity.value = this.flashIntensity;
    sharedNightUniforms.flashWorldPos.value.copy(this.flashWorldPos);

    let detailFade = 1;
    let cloudAlt = CLOUD_ALT_FAR;

    // Reference camera distance for falloff scaling (altitude ≈ 0.2 → dist ≈ 120).
    // Falloff ∝ 1/dist² so glow world-radius scales with apparent globe size.
    const REF_DIST = 120;
    let cloudFalloff = 60000.0;
    let groundFalloff = 6.0;

    if (this.globeEl) {
      try {
        const camera = this.globeEl.camera();
        const globeRadius = (this.globeEl.getGlobeRadius?.() as number | undefined) ?? EARTH_RADIUS;
        const camDist = camera.position.length();
        const cameraAlt = camDist / globeRadius - 1;

        // Suppress glow entirely at extreme zoom (moon distance)
        if (cameraAlt >= 5.0) {
          this.flashIntensity = 0;
          sharedNightUniforms.flashIntensity.value = 0;
        }

        // Scale falloff so glow appears proportional to globe screen size.
        // Clamp to 3x expansion maximum to avoid runaway at mid zoom.
        const distRatio = REF_DIST / Math.max(camDist, REF_DIST);
        const scale = Math.max(distRatio * distRatio, 1 / 9);
        cloudFalloff = 20000.0 * scale;
        groundFalloff = 15.0 * scale;

        const t = Math.max(0, Math.min(1,
          (ALT_FAR_POINT - cameraAlt) / (ALT_FAR_POINT - ALT_NEAR_POINT)
        ));
        cloudAlt = CLOUD_ALT_FAR + (CLOUD_ALT_NEAR - CLOUD_ALT_FAR) * t;
        detailFade = Math.max(0, Math.min(1, (1.0 - cameraAlt) / 0.5));

        this.fadeTarget = this.userCloudsEnabled ? 1.0 : 0.0;
      } catch { /* globeEl not ready */ }
    }

    // Animate fade opacity toward target (0.5-second linear fade)
    if (this.fadeOpacity !== this.fadeTarget && dt > 0) {
      const step = dt * 3.0;
      if (this.fadeOpacity < this.fadeTarget) {
        this.fadeOpacity = Math.min(this.fadeTarget, this.fadeOpacity + step);
      } else {
        this.fadeOpacity = Math.max(this.fadeTarget, this.fadeOpacity - step);
      }
    }

    // Always sync altitude to config so lightning height tracks zoom even when clouds are off
    if (Math.abs(cloudAlt - this.lastCloudAlt) > 0.0001) {
      setConfig('layers.clouds.altitude', cloudAlt);
      this.lastCloudAlt = cloudAlt;
    }

    // Skip rendering entirely when fully faded out
    if (this.fadeOpacity <= 0) {
      sharedNightUniforms.cloudShadowEnabled.value = 0.0;
      for (const { mesh } of this.shells) {
        mesh.visible = false;
      }
      return;
    }

    const baseOpacity = getConfig<number>('layers.clouds.opacity') ?? 1.0;

    sharedNightUniforms.cloudShadowEnabled.value = this.fadeOpacity * this.userOpacity;
    sharedNightUniforms.flashFalloff.value = groundFalloff;

    for (const { mesh, altMultiplier } of this.shells) {
      const mat = mesh.material as THREE.ShaderMaterial;
      mat.uniforms.uTime.value = time;
      mat.uniforms.uOpacity.value = baseOpacity * this.userOpacity * this.fadeOpacity;
      mat.uniforms.uFlashIntensity.value = this.flashIntensity;
      (mat.uniforms.uFlashWorldPos.value as THREE.Vector3).copy(this.flashWorldPos);
      mat.uniforms.uFlashFalloff.value = cloudFalloff;
      mat.uniforms.uDetailFade.value = detailFade;
      mesh.scale.setScalar(1 + cloudAlt * altMultiplier);
    }
  }

  setCloudsEnabled(enabled: boolean): void {
    this.userCloudsEnabled = enabled;
    sharedNightUniforms.cloudShadowEnabled.value = enabled ? 1.0 : 0.0;
  }

  setUserOpacity(opacity: number): void {
    this.userOpacity = opacity;
  }

  setTemperatureEnabled(enabled: boolean): void {
    this.temperatureEnabled = enabled;
  }

  isCloudsEnabled(): boolean {
    return this.userCloudsEnabled;
  }

  addData(_data: void): void {}

  clear(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.flashHandler) {
      window.removeEventListener('lightning-flash', this.flashHandler);
      this.flashHandler = null;
    }

    for (const { mesh } of this.shells) {
      if (this.scene) this.scene.remove(mesh);
      (mesh.material as THREE.ShaderMaterial).dispose();
    }
    this.shells = [];

    if (this.sharedGeometry) {
      this.sharedGeometry.dispose();
      this.sharedGeometry = null;
    }
    if (this.baseTexture) {
      this.baseTexture.dispose();
      this.baseTexture = null;
    }
    if (this.occluderMesh) {
      if (this.scene) this.scene.remove(this.occluderMesh);
      if (this.occluderMesh.geometry) this.occluderMesh.geometry.dispose();
      if (this.occluderMesh.material instanceof THREE.Material) this.occluderMesh.material.dispose();
      this.occluderMesh = null;
    }
  }
}
