import * as THREE from 'three';
import { BaseLayer } from './LayerInterface';
import { LAYERS } from '../services/renderLayers';
import { setMapDesaturate } from '../services/dayNightMaterial';

const EARTH_RADIUS = 100;
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

const GRID_W = 1440;
const GRID_H = 721;

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3001';

const MAX_OPACITY = 0.65;

const tempVertexShader = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

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

const COLORMAP: [number, [number, number, number]][] = [
  [-40, [120,   0, 180]],
  [-25, [ 30,  30, 220]],
  [-10, [  0, 130, 255]],
  [  0, [  0, 220, 220]],
  [ 10, [  0, 200,  60]],
  [ 20, [200, 230,   0]],
  [ 28, [255, 165,   0]],
  [ 38, [220,   0,   0]],
  [ 48, [120,   0,  40]],
];

export function tempToRGB(temp: number): [number, number, number] {
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

interface FrameInfo {
  runId: string;
  timestamp: number;
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

async function fetchFrameList(): Promise<FrameInfo[]> {
  const res = await fetch(`${SERVER_URL}/api/temperature/frames`);
  if (!res.ok) throw new Error(`/api/temperature/frames ${res.status}`);
  return res.json();
}

async function fetchFrame(runId: string): Promise<Float32Array> {
  const encoded = runId.replace('/', '_');
  const res = await fetch(`${SERVER_URL}/api/temperature/${encoded}`);
  if (!res.ok) throw new Error(`/api/temperature/${encoded} ${res.status}`);
  const json: number[] = await res.json();
  return new Float32Array(json);
}

async function buildTemperatureTexture(temps: Float32Array): Promise<THREE.CanvasTexture> {
  const small = document.createElement('canvas');
  small.width = GRID_W;
  small.height = GRID_H;
  const ctx = small.getContext('2d')!;
  const imgData = ctx.createImageData(GRID_W, GRID_H);

  for (let latIdx = 0; latIdx < GRID_H; latIdx++) {
    for (let lngIdx = 0; lngIdx < GRID_W; lngIdx++) {
      const temp = temps[latIdx * GRID_W + lngIdx];
      const [r, g, b] = tempToRGB(temp);
      const canvasY = (GRID_H - 1) - latIdx;
      const px = (canvasY * GRID_W + lngIdx) * 4;
      imgData.data[px]     = r;
      imgData.data[px + 1] = g;
      imgData.data[px + 2] = b;
      imgData.data[px + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);

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
  private grid: Float32Array | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  // Multi-frame support — capped to avoid OOM on large frame lists
  private static readonly MAX_CACHED_FRAMES = 8;
  private frames = new Map<string, Float32Array>();
  private frameList: FrameInfo[] = [];
  private currentFrameId: string | null = null;
  private onFrameListChange: ((frames: FrameInfo[]) => void) | null = null;

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
    fetchTemperatureGrid()
      .then(async grid => {
        this.grid = grid;
        this.frames.set('__latest__', grid);
        const texture = await buildTemperatureTexture(grid);
        if (!this.mesh) { texture.dispose(); return; }
        const mat = this.mesh.material as THREE.ShaderMaterial;
        const old = this.texture;
        this.texture = texture;
        mat.uniforms.uTempMap.value = texture;
        old?.dispose();
        if (this.pendingShow) {
          this.pendingShow = false;
          this.startFade(MAX_OPACITY);
        }
        this.refreshFrameList();
      })
      .catch(err => console.error('[TemperatureLayer] fetch/build failed:', err));
  }

  private async refreshFrameList(): Promise<void> {
    try {
      this.frameList = await fetchFrameList();
      if (!this.currentFrameId || this.currentFrameId === '__latest__') {
        this.currentFrameId = this.frameList.length > 0
          ? this.frameList[this.frameList.length - 1].runId
          : null;
      }
      this.onFrameListChange?.(this.frameList);
    } catch (err) {
      console.error('[TemperatureLayer] frame list fetch failed:', err);
    }
  }

  async setFrame(runId: string): Promise<void> {
    this.currentFrameId = runId;

    let grid = this.frames.get(runId);
    if (!grid) {
      grid = await fetchFrame(runId);
      this.cacheFrame(runId, grid);
    }

    this.grid = grid;
    const texture = await buildTemperatureTexture(grid);
    if (!this.mesh) { texture.dispose(); return; }
    const mat = this.mesh.material as THREE.ShaderMaterial;
    const old = this.texture;
    this.texture = texture;
    mat.uniforms.uTempMap.value = texture;
    old?.dispose();
  }

  setOnFrameListChange(cb: ((frames: FrameInfo[]) => void) | null): void {
    this.onFrameListChange = cb;
    if (cb && this.frameList.length > 0) cb(this.frameList);
  }

  getFrameList(): FrameInfo[] {
    return this.frameList;
  }

  getCurrentFrameId(): string | null {
    return this.currentFrameId;
  }

  private cacheFrame(runId: string, data: Float32Array): void {
    this.frames.set(runId, data);
    // Evict oldest entries beyond the cap (Map preserves insertion order)
    if (this.frames.size > TemperatureLayer.MAX_CACHED_FRAMES) {
      const oldest = this.frames.keys().next().value;
      if (oldest && oldest !== '__latest__' && oldest !== this.currentFrameId) {
        this.frames.delete(oldest);
      }
    }
  }

  async prefetchAllFrames(): Promise<void> {
    const currentIdx = this.frameList.findIndex(f => f.runId === this.currentFrameId);
    const toFetch = this.frameList.filter((info, i) => {
      if (this.frames.has(info.runId)) return false;
      // Only prefetch frames adjacent to current
      return Math.abs(i - currentIdx) <= 3;
    });

    for (const info of toFetch) {
      try {
        const grid = await fetchFrame(info.runId);
        this.cacheFrame(info.runId, grid);
      } catch (err) {
        console.warn(`[TemperatureLayer] prefetch ${info.runId} failed:`, err);
      }
    }
  }

  getTempAtLatLng(lat: number, lng: number): number | null {
    if (!this.grid) return null;
    const latIdx = Math.round((lat + 90) / 0.25);
    const lngIdx = Math.round((lng + 180) / 0.25);
    return this.grid[latIdx * GRID_W + lngIdx] ?? null;
  }

  private pendingShow = false;

  private fadeFrom = 0;
  private fadeTarget = 0;
  private fadeStartMs = 0;
  private isFading = false;
  private static readonly FADE_MS = 600;

  private startFade(target: number): void {
    const mat = this.mesh?.material as THREE.ShaderMaterial | undefined;
    this.fadeFrom = mat?.uniforms.uOpacity.value ?? 0;
    this.fadeTarget = target;
    this.fadeStartMs = performance.now();
    this.isFading = true;
  }

  isVisible(): boolean {
    return this.isFading || super.isVisible();
  }

  show(): void {
    super.show();
    if (this.mesh) this.mesh.visible = true;
    if (this.texture) {
      this.startFade(MAX_OPACITY);
    } else {
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
    this.frames.clear();
    this.onFrameListChange = null;
  }
}
