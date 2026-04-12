import * as THREE from 'three';
import { BaseLayer } from './LayerInterface';
import { LAYERS } from '../services/renderLayers';
import { setMapDesaturate } from '../services/dayNightMaterial';

const EARTH_RADIUS = 100;
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// 0.25° grid: 1440 lng columns × 721 lat rows = 1,038,240 points (matches server temperatureCache.js)
const GRID_W = 1440;
const GRID_H = 721;

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3001';

// 0.65 opacity: 35% tile bleed provides consistent surface structure on both day and night sides.
const MAX_OPACITY = 0.65;

const tempVertexShader = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Flat opacity across day and night — tile structure bleeds through consistently on both sides.
// The day tile desaturation (B&W via sharedNightUniforms.desaturate) provides visual
// contrast between day and night without making the temperature go opaque on one side.
const tempFragmentShader = /* glsl */`
  precision highp float;
  uniform sampler2D uTempMap;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    vec3 col = texture2D(uTempMap, vUv).rgb;
    gl_FragColor = vec4(col, uOpacity);
  }
`;

// Temperature color stops [°C, [r, g, b]]
// Calibrated so the common surface range (−10 to +38°C) spans the full spectrum.
// Matches the conventional rainbow scale used by Windy, Ventusky, earth.nullschool.
const COLORMAP: [number, [number, number, number]][] = [
  [-40, [120,   0, 180]],  // violet        — polar/arctic
  [-25, [ 30,  30, 220]],  // deep blue     — very cold
  [-10, [  0, 130, 255]],  // sky blue      — cold
  [  0, [  0, 220, 220]],  // cyan          — freezing point (prominent landmark)
  [ 10, [  0, 200,  60]],  // green         — cool
  [ 20, [200, 230,   0]],  // yellow-green  — mild/warm
  [ 28, [255, 165,   0]],  // orange        — hot
  [ 38, [220,   0,   0]],  // red           — very hot
  [ 48, [120,   0,  40]],  // dark crimson  — extreme heat
];

function tempToRGB(temp: number): [number, number, number] {
  const clipped = Math.max(COLORMAP[0][0], Math.min(COLORMAP[COLORMAP.length - 1][0], temp));
  for (let i = 0; i < COLORMAP.length - 1; i++) {
    const [t0, c0] = COLORMAP[i];
    const [t1, c1] = COLORMAP[i + 1];
    if (clipped <= t1) {
      const f = (clipped - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return COLORMAP[COLORMAP.length - 1][1];
}

async function fetchTemperatureGrid(): Promise<Float32Array> {
  const res = await fetch(`${SERVER_URL}/api/temperature?v=${GRID_W}x${GRID_H}`);
  if (!res.ok) throw new Error(`/api/temperature ${res.status}`);
  const json: number[] = await res.json();
  if (!Array.isArray(json) || json.length !== GRID_H * GRID_W) {
    throw new Error(`Unexpected grid size: ${json.length}`);
  }
  return new Float32Array(json);
}

async function buildTemperatureTexture(): Promise<THREE.CanvasTexture> {
  const temps = await fetchTemperatureGrid();

  const small = document.createElement('canvas');
  small.width = GRID_W;
  small.height = GRID_H;
  const ctx = small.getContext('2d')!;
  const imgData = ctx.createImageData(GRID_W, GRID_H);

  for (let latIdx = 0; latIdx < GRID_H; latIdx++) {
    for (let lngIdx = 0; lngIdx < GRID_W; lngIdx++) {
      const temp = temps[latIdx * GRID_W + lngIdx];
      const [r, g, b] = tempToRGB(temp);
      // flipY=true (default): canvas y=0 → north, so north lats go at top
      const canvasY = (GRID_H - 1) - latIdx;
      const px = (canvasY * GRID_W + lngIdx) * 4;
      imgData.data[px]     = r;
      imgData.data[px + 1] = g;
      imgData.data[px + 2] = b;
      imgData.data[px + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);

  // 2× upscale: bilinear interpolation smooths data point boundaries on the sphere
  const large = document.createElement('canvas');
  large.width  = GRID_W * 2;
  large.height = GRID_H * 2;
  const lctx = large.getContext('2d')!;
  lctx.imageSmoothingEnabled = true;
  lctx.imageSmoothingQuality = 'high';
  lctx.drawImage(small, 0, 0, GRID_W * 2, GRID_H * 2);

  return new THREE.CanvasTexture(large);
}

export class TemperatureLayer extends BaseLayer<void> {
  private mesh: THREE.Mesh | null = null;
  private geometry: THREE.SphereGeometry | null = null;
  private texture: THREE.CanvasTexture | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  initialize(globeEl: any): void {
    super.initialize(globeEl);
    if (!this.scene) return;

    this.geometry = new THREE.SphereGeometry(EARTH_RADIUS, 256, 128);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTempMap: { value: null },
        uOpacity: { value: 0 },
      },
      vertexShader: tempVertexShader,
      fragmentShader: tempFragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.FrontSide,
    });

    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.scale.setScalar(1.0005);
    this.mesh.renderOrder = LAYERS.TEMPERATURE;
    this.mesh.visible = this.visible;
    this.scene.add(this.mesh);

    this.loadTexture();
    this.refreshTimer = setInterval(() => this.loadTexture(), REFRESH_INTERVAL_MS);
  }

  private loadTexture(): void {
    buildTemperatureTexture()
      .then(texture => {
        if (!this.mesh) { texture.dispose(); return; }
        const mat = this.mesh.material as THREE.ShaderMaterial;
        const old = this.texture;
        this.texture = texture;
        mat.uniforms.uTempMap.value = texture;
        old?.dispose();
        // If show() was called before the texture was ready, trigger the fade now.
        if (this.pendingShow) {
          this.pendingShow = false;
          this.startFade(MAX_OPACITY);
        }
      })
      .catch(err => console.error('[TemperatureLayer] fetch/build failed:', err));
  }

  private pendingShow = false;

  private fadeFrom = 0;
  private fadeTarget = 0;
  private fadeStartMs = 0;
  private isFading = false;
  private static readonly FADE_MS = 300;

  private startFade(target: number): void {
    const mat = this.mesh?.material as THREE.ShaderMaterial | undefined;
    this.fadeFrom = mat?.uniforms.uOpacity.value ?? 0;
    this.fadeTarget = target;
    this.fadeStartMs = performance.now();
    this.isFading = true;
  }

  // Keep the layer in the update loop while fading so opacity animates.
  isVisible(): boolean {
    return this.isFading || super.isVisible();
  }

  show(): void {
    super.show();
    if (this.mesh) this.mesh.visible = true;
    if (this.texture) {
      this.startFade(MAX_OPACITY);
    } else {
      // Texture not yet ready — loadTexture() will call startFade once it lands
      this.pendingShow = true;
    }
  }

  hide(): void {
    super.hide();
    this.pendingShow = false;
    this.startFade(0);
  }

  update(_currentTime: number): void {
    if (!this.mesh || !this.isFading) return;
    const mat = this.mesh.material as THREE.ShaderMaterial;
    const t = Math.min(1, (performance.now() - this.fadeStartMs) / TemperatureLayer.FADE_MS);
    const opacity = this.fadeFrom + (this.fadeTarget - this.fadeFrom) * t;
    mat.uniforms.uOpacity.value = opacity;
    // Desaturate the tile map in sync with the fade so tiles smoothly go B&W as temperature appears
    setMapDesaturate(opacity / MAX_OPACITY);
    if (t >= 1) {
      this.isFading = false;
      if (this.fadeTarget === 0) this.mesh.visible = false;
    }
  }

  addData(_data: void): void {}

  clear(): void {
    setMapDesaturate(0);
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.mesh) {
      this.scene?.remove(this.mesh);
      (this.mesh.material as THREE.Material).dispose();
      this.mesh = null;
    }
    this.geometry?.dispose();
    this.geometry = null;
    this.texture?.dispose();
    this.texture = null;
  }
}
