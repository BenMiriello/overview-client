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

const TYPE_NONE = 0;
const TYPE_RAIN = 1;
const TYPE_SNOW = 2;
const TYPE_ICE  = 3;
const TYPE_FRZR = 4;

const precipVertexShader = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const precipFragmentShader = /* glsl */`
  precision highp float;
  uniform sampler2D uPrecipMap;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    vec4 col = texture2D(uPrecipMap, vUv);
    gl_FragColor = vec4(col.rgb, col.a * uOpacity);
  }
`;

// NEXRAD-inspired: green→yellow→orange→red for rain
const RAIN_STOPS: [number, [number, number, number]][] = [
  [0.1,  [136, 204,  68]],  // light green
  [1,    [ 68, 170,   0]],  // green
  [4,    [221, 221,   0]],  // yellow
  [8,    [255, 136,   0]],  // orange
  [16,   [204,   0,   0]],  // red
];

// Lavender→purple→pink for snow
const SNOW_STOPS: [number, [number, number, number]][] = [
  [0.1,  [187, 170, 221]],  // light lavender
  [1,    [136, 102, 204]],  // purple
  [3,    [255, 102, 170]],  // pink
];

const ICE_COLOR: [number, number, number] = [255, 136, 153]; // salmon/pink

function interpolateStops(rate: number, stops: [number, [number, number, number]][]): [number, number, number] {
  if (rate <= stops[0][0]) return stops[0][1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [r0, c0] = stops[i];
    const [r1, c1] = stops[i + 1];
    if (rate <= r1) {
      const f = (rate - r0) / (r1 - r0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

export function precipToRGBA(rate: number, type: number): [number, number, number, number] {
  if (rate < 0.1 || type === TYPE_NONE) return [0, 0, 0, 0];

  let rgb: [number, number, number];
  if (type === TYPE_SNOW) {
    rgb = interpolateStops(rate, SNOW_STOPS);
  } else if (type === TYPE_ICE || type === TYPE_FRZR) {
    rgb = ICE_COLOR;
  } else {
    rgb = interpolateStops(rate, RAIN_STOPS);
  }
  return [rgb[0], rgb[1], rgb[2], 255];
}

export const PRECIP_TYPE_LABELS = ['None', 'Rain', 'Snow', 'Ice Pellets', 'Freezing Rain'] as const;

interface PrecipFrame {
  rates: Float32Array;
  types: Uint8Array;
}

interface FrameInfo {
  runId: string;
  timestamp: number;
}

async function fetchLatestFrame(): Promise<{ rates: Float32Array; types: Uint8Array }> {
  const res = await fetch(`${SERVER_URL}/api/precipitation`);
  if (!res.ok) throw new Error(`/api/precipitation ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json.rates) || json.rates.length !== GRID_H * GRID_W) {
    throw new Error(`Unexpected grid size: ${json.rates?.length}`);
  }
  return {
    rates: new Float32Array(json.rates),
    types: new Uint8Array(json.types),
  };
}

async function fetchFrameList(): Promise<FrameInfo[]> {
  const res = await fetch(`${SERVER_URL}/api/precipitation/frames`);
  if (!res.ok) throw new Error(`/api/precipitation/frames ${res.status}`);
  return res.json();
}

async function fetchFrame(runId: string): Promise<PrecipFrame> {
  const encoded = runId.replace('/', '_');
  const res = await fetch(`${SERVER_URL}/api/precipitation/${encoded}`);
  if (!res.ok) throw new Error(`/api/precipitation/${encoded} ${res.status}`);
  const json = await res.json();
  return {
    rates: new Float32Array(json.rates),
    types: new Uint8Array(json.types),
  };
}

function buildPrecipTexture(rates: Float32Array, types: Uint8Array): THREE.CanvasTexture {
  const small = document.createElement('canvas');
  small.width = GRID_W;
  small.height = GRID_H;
  const ctx = small.getContext('2d')!;
  const imgData = ctx.createImageData(GRID_W, GRID_H);

  for (let latIdx = 0; latIdx < GRID_H; latIdx++) {
    for (let lngIdx = 0; lngIdx < GRID_W; lngIdx++) {
      const dataIdx = latIdx * GRID_W + lngIdx;
      const [r, g, b, a] = precipToRGBA(rates[dataIdx], types[dataIdx]);
      const canvasY = (GRID_H - 1) - latIdx;
      const px = (canvasY * GRID_W + lngIdx) * 4;
      imgData.data[px]     = r;
      imgData.data[px + 1] = g;
      imgData.data[px + 2] = b;
      imgData.data[px + 3] = a;
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

export class PrecipitationLayer extends BaseLayer<void> {
  private mesh: THREE.Mesh | null = null;
  private geometry: THREE.SphereGeometry | null = null;
  private texture: THREE.CanvasTexture | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  // Multi-frame support — capped to avoid OOM on large frame lists
  private static readonly MAX_CACHED_FRAMES = 8;
  private frames = new Map<string, PrecipFrame>();
  private frameList: FrameInfo[] = [];
  private currentFrameId: string | null = null;
  private currentRates: Float32Array | null = null;
  private currentTypes: Uint8Array | null = null;

  // Frame change callbacks
  private onFrameListChange: ((frames: FrameInfo[]) => void) | null = null;

  initialize(globeEl: any): void {
    super.initialize(globeEl);
    if (!this.scene) return;

    this.geometry = new THREE.SphereGeometry(EARTH_RADIUS, 256, 128);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uPrecipMap: { value: null },
        uOpacity: { value: 0 },
      },
      vertexShader: precipVertexShader,
      fragmentShader: precipFragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.FrontSide,
    });

    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.scale.setScalar(1.0006);
    this.mesh.renderOrder = LAYERS.PRECIPITATION;
    this.mesh.visible = this.visible;
    this.scene.add(this.mesh);

    this.loadLatest();
    this.refreshTimer = setInterval(() => this.loadLatest(), REFRESH_INTERVAL_MS);
  }

  private async loadLatest(): Promise<void> {
    try {
      const frame = await fetchLatestFrame();
      const latestRunId = '__latest__';
      this.frames.set(latestRunId, frame);
      this.currentRates = frame.rates;
      this.currentTypes = frame.types;

      const texture = buildPrecipTexture(frame.rates, frame.types);
      if (!this.mesh) { texture.dispose(); return; }
      const mat = this.mesh.material as THREE.ShaderMaterial;
      const old = this.texture;
      this.texture = texture;
      mat.uniforms.uPrecipMap.value = texture;
      old?.dispose();

      if (this.pendingShow) {
        this.pendingShow = false;
        this.startFade(MAX_OPACITY);
      }

      // Also refresh frame list
      this.refreshFrameList();
    } catch (err) {
      console.error('[PrecipitationLayer] fetch/build failed:', err);
    }
  }

  private async refreshFrameList(): Promise<void> {
    try {
      this.frameList = await fetchFrameList();
      // Set currentFrameId to latest if not already set by user
      if (!this.currentFrameId || this.currentFrameId === '__latest__') {
        this.currentFrameId = this.frameList.length > 0
          ? this.frameList[this.frameList.length - 1].runId
          : null;
      }
      this.onFrameListChange?.(this.frameList);
    } catch (err) {
      console.error('[PrecipitationLayer] frame list fetch failed:', err);
    }
  }

  async setFrame(runId: string): Promise<void> {
    this.currentFrameId = runId;

    let frame = this.frames.get(runId);
    if (!frame) {
      frame = await fetchFrame(runId);
      this.cacheFrame(runId, frame);
    }

    this.currentRates = frame.rates;
    this.currentTypes = frame.types;

    const texture = buildPrecipTexture(frame.rates, frame.types);
    if (!this.mesh) { texture.dispose(); return; }
    const mat = this.mesh.material as THREE.ShaderMaterial;
    const old = this.texture;
    this.texture = texture;
    mat.uniforms.uPrecipMap.value = texture;
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

  getPrecipAtLatLng(lat: number, lng: number): { rate: number; type: number } | null {
    if (!this.currentRates || !this.currentTypes) return null;
    const latIdx = Math.round((lat + 90) / 0.25);
    const lngIdx = Math.round((lng + 90) / 0.25);
    const idx = latIdx * GRID_W + lngIdx;
    if (idx < 0 || idx >= this.currentRates.length) return null;
    return { rate: this.currentRates[idx], type: this.currentTypes[idx] };
  }

  private onFrameReady: ((readyIds: Set<string>) => void) | null = null;

  private cacheFrame(runId: string, frame: PrecipFrame): void {
    this.frames.set(runId, frame);
    this.onFrameReady?.(this.getReadyFrameIds());
  }

  getReadyFrameIds(): Set<string> {
    return new Set(this.frames.keys());
  }

  setOnFrameReady(cb: ((readyIds: Set<string>) => void) | null): void {
    this.onFrameReady = cb;
  }

  async prefetchAllFrames(): Promise<void> {
    for (const info of this.frameList) {
      if (this.frames.has(info.runId)) continue;
      try {
        const frame = await fetchFrame(info.runId);
        this.cacheFrame(info.runId, frame);
      } catch (err) {
        console.warn(`[PrecipitationLayer] prefetch ${info.runId} failed:`, err);
      }
    }
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
    const t = Math.min(1, (performance.now() - this.fadeStartMs) / PrecipitationLayer.FADE_MS);
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
