import * as THREE from 'three';
import { BaseLayer } from './LayerInterface';
import { LAYERS } from '../services/renderLayers';
import { setLayerDesaturate } from '../services/dayNightMaterial';

const EARTH_RADIUS = 100;
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const GRID_W = 1440;
const GRID_H = 721;
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3001';
const MAX_OPACITY = 0.65;
const DEG_TO_RAD = Math.PI / 180;

const MAX_PARTICLES = 8000;
const PARTICLE_RADIUS = EARTH_RADIUS * 1.005;
const TRAIL_HISTORY = 15;
const VERTS_PER_PARTICLE = TRAIL_HISTORY * 2;
const INDICES_PER_PARTICLE = (TRAIL_HISTORY - 1) * 6;
const PIXELS_PER_PARTICLE = 120;
const TRAIL_WIDTH_PX = 2.0;

const SPEED_COLORMAP: [number, [number, number, number]][] = [
  [ 0, [ 68,  68, 170]], [ 2, [ 68, 136, 221]], [ 5, [ 68, 204,  68]],
  [10, [221, 221,   0]], [15, [255, 136,   0]], [20, [204,   0,   0]],
  [30, [255,   0, 255]],
];

export function windSpeedToRGB(speed: number): [number, number, number] {
  const clipped = Math.max(0, Math.min(30, speed));
  for (let i = 0; i < SPEED_COLORMAP.length - 1; i++) {
    const [s0, c0] = SPEED_COLORMAP[i];
    const [s1, c1] = SPEED_COLORMAP[i + 1];
    if (clipped <= s1) {
      const f = (clipped - s0) / (s1 - s0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return SPEED_COLORMAP[SPEED_COLORMAP.length - 1][1];
}

const overlayVS = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const overlayFS = /* glsl */`
  precision highp float;
  uniform sampler2D uWindMap; uniform float uOpacity; varying vec2 vUv;
  void main() { vec3 col = texture2D(uWindMap, vUv).rgb; gl_FragColor = vec4(col, uOpacity); }
`;
const quadVS = /* glsl */`
  attribute float alpha;
  attribute float side;
  varying float vAlpha;
  varying float vSide;
  void main() {
    vAlpha = alpha;
    vSide = side;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const quadFS = /* glsl */`
  varying float vAlpha;
  varying float vSide;
  void main() {
    float edge = 1.0 - abs(vSide);
    float soft = smoothstep(0.0, 0.4, edge);
    gl_FragColor = vec4(1.0, 1.0, 1.0, vAlpha * soft * 0.55);
  }
`;

interface FrameInfo { runId: string; timestamp: number; }
interface WindFrame { u: Float32Array; v: Float32Array; }

interface Particle {
  age: number;
  maxAge: number;
  histLat: Float32Array;
  histLng: Float32Array;
  histIdx: number;
  histLen: number;
}

async function fetchLatestFrame(): Promise<WindFrame> {
  const res = await fetch(`${SERVER_URL}/api/wind`);
  if (!res.ok) throw new Error(`/api/wind ${res.status}`);
  const json = await res.json();
  return { u: new Float32Array(json.u), v: new Float32Array(json.v) };
}
async function fetchFrameList(): Promise<FrameInfo[]> {
  const res = await fetch(`${SERVER_URL}/api/wind/frames`);
  if (!res.ok) throw new Error(`/api/wind/frames ${res.status}`);
  return res.json();
}
async function fetchFrame(runId: string): Promise<WindFrame> {
  const encoded = runId.replace('/', '_');
  const res = await fetch(`${SERVER_URL}/api/wind/${encoded}`);
  if (!res.ok) throw new Error(`/api/wind/${encoded} ${res.status}`);
  const json = await res.json();
  return { u: new Float32Array(json.u), v: new Float32Array(json.v) };
}

function sampleWind(u: Float32Array, v: Float32Array, lat: number, lng: number): [number, number] {
  const latIdx = (lat + 90) / 0.25;
  const lngIdx = (lng + 180) / 0.25;
  const lat0 = Math.max(0, Math.min(GRID_H - 2, Math.floor(latIdx)));
  const lng0 = Math.floor(lngIdx);
  const lat1 = lat0 + 1;
  const fLat = latIdx - lat0;
  const fLng = lngIdx - lng0;
  const lng0w = lng0 % GRID_W, lng1w = (lng0 + 1) % GRID_W;
  const i00 = lat0*GRID_W+lng0w, i10 = lat1*GRID_W+lng0w;
  const i01 = lat0*GRID_W+lng1w, i11 = lat1*GRID_W+lng1w;
  return [
    u[i00]*(1-fLat)*(1-fLng) + u[i10]*fLat*(1-fLng) + u[i01]*(1-fLat)*fLng + u[i11]*fLat*fLng,
    v[i00]*(1-fLat)*(1-fLng) + v[i10]*fLat*(1-fLng) + v[i01]*(1-fLat)*fLng + v[i11]*fLat*fLng,
  ];
}

function latLngToXYZ(lat: number, lng: number, r: number): [number, number, number] {
  const phi = (90 - lat) * DEG_TO_RAD, theta = (lng + 180) * DEG_TO_RAD;
  return [-(r*Math.sin(phi)*Math.cos(theta)), r*Math.cos(phi), r*Math.sin(phi)*Math.sin(theta)];
}
function xyzToLatLng(x: number, y: number, z: number): { lat: number; lng: number } {
  const r = Math.sqrt(x*x + y*y + z*z);
  const lat = 90 - Math.acos(y / r) * 180 / Math.PI;
  const lng = Math.atan2(z, -x) * 180 / Math.PI - 180;
  return { lat, lng: ((lng + 540) % 360) - 180 };
}

function buildSpeedTexture(u: Float32Array, v: Float32Array): THREE.CanvasTexture {
  const small = document.createElement('canvas');
  small.width = GRID_W; small.height = GRID_H;
  const ctx = small.getContext('2d')!;
  const imgData = ctx.createImageData(GRID_W, GRID_H);
  for (let la = 0; la < GRID_H; la++) for (let lo = 0; lo < GRID_W; lo++) {
    const idx = la*GRID_W+lo;
    const spd = Math.sqrt(u[idx]*u[idx]+v[idx]*v[idx]);
    const [r,g,b] = windSpeedToRGB(spd);
    const cy = (GRID_H-1)-la, px = (cy*GRID_W+lo)*4;
    imgData.data[px]=r; imgData.data[px+1]=g; imgData.data[px+2]=b; imgData.data[px+3]=255;
  }
  ctx.putImageData(imgData, 0, 0);
  const large = document.createElement('canvas');
  large.width=GRID_W*2; large.height=GRID_H*2;
  const lc = large.getContext('2d')!;
  lc.imageSmoothingEnabled=true; lc.imageSmoothingQuality='high';
  lc.drawImage(small,0,0,GRID_W*2,GRID_H*2);
  return new THREE.CanvasTexture(large);
}

function isFacingCamera(
  px: number, py: number, pz: number,
  camX: number, camY: number, camZ: number,
): boolean {
  const nx = px / PARTICLE_RADIUS, ny = py / PARTICLE_RADIUS, nz = pz / PARTICLE_RADIUS;
  const toCamX = camX - px, toCamY = camY - py, toCamZ = camZ - pz;
  const toCamLen = Math.sqrt(toCamX*toCamX + toCamY*toCamY + toCamZ*toCamZ);
  if (toCamLen < 0.001) return true;
  return (nx*toCamX + ny*toCamY + nz*toCamZ) / toCamLen > -0.05;
}

export class WindLayer extends BaseLayer<void> {
  private overlayMesh: THREE.Mesh | null = null;
  private overlayGeometry: THREE.SphereGeometry | null = null;
  private overlayTexture: THREE.CanvasTexture | null = null;

  private particleMesh: THREE.Mesh | null = null;
  private particleGeometry: THREE.BufferGeometry | null = null;
  private positions: Float32Array | null = null;
  private alphas: Float32Array | null = null;
  private sides: Float32Array | null = null;
  private particles: Particle[] = [];
  private activeCount = 0;

  private currentU: Float32Array | null = null;
  private currentV: Float32Array | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastUpdateTime = 0;

  private static readonly MAX_CACHED_FRAMES = 8;
  private windFrames = new Map<string, WindFrame>();
  private frameList: FrameInfo[] = [];
  private currentFrameId: string | null = null;
  private onFrameListChange: ((frames: FrameInfo[]) => void) | null = null;

  private camDist = 300;
  private camX = 0;
  private camY = 0;
  private camZ = 300;
  private pixelWorldSize = 1;

  initialize(globeEl: any): void {
    super.initialize(globeEl);
    if (!this.scene) return;

    this.overlayGeometry = new THREE.SphereGeometry(EARTH_RADIUS, 256, 128);
    this.overlayMesh = new THREE.Mesh(this.overlayGeometry, new THREE.ShaderMaterial({
      uniforms: { uWindMap: { value: null }, uOpacity: { value: 0 } },
      vertexShader: overlayVS, fragmentShader: overlayFS,
      transparent: true, depthWrite: false, depthTest: false, side: THREE.FrontSide,
    }));
    this.overlayMesh.scale.setScalar(1.0007);
    this.overlayMesh.renderOrder = LAYERS.WIND_OVERLAY;
    this.overlayMesh.visible = this.visible;
    this.scene.add(this.overlayMesh);

    const totalVerts = MAX_PARTICLES * VERTS_PER_PARTICLE;
    this.positions = new Float32Array(totalVerts * 3);
    this.alphas = new Float32Array(totalVerts);
    this.sides = new Float32Array(totalVerts);
    for (let i = 0; i < totalVerts; i++) this.sides[i] = (i % 2 === 0) ? -1 : 1;

    const indices = new Uint32Array(MAX_PARTICLES * INDICES_PER_PARTICLE);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const vBase = i * VERTS_PER_PARTICLE;
      const iBase = i * INDICES_PER_PARTICLE;
      for (let s = 0; s < TRAIL_HISTORY - 1; s++) {
        const v = vBase + s * 2;
        const ii = iBase + s * 6;
        indices[ii]=v; indices[ii+1]=v+1; indices[ii+2]=v+2;
        indices[ii+3]=v+1; indices[ii+4]=v+3; indices[ii+5]=v+2;
      }
    }

    this.particleGeometry = new THREE.BufferGeometry();
    this.particleGeometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.particleGeometry.setAttribute('alpha', new THREE.BufferAttribute(this.alphas, 1));
    this.particleGeometry.setAttribute('side', new THREE.BufferAttribute(this.sides, 1));
    this.particleGeometry.setIndex(new THREE.BufferAttribute(indices, 1));

    this.particleMesh = new THREE.Mesh(this.particleGeometry, new THREE.ShaderMaterial({
      vertexShader: quadVS, fragmentShader: quadFS,
      transparent: true, depthWrite: false, depthTest: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }));
    this.particleMesh.renderOrder = LAYERS.WIND_PARTICLES;
    this.particleMesh.frustumCulled = false;
    this.particleMesh.visible = this.visible;
    this.scene.add(this.particleMesh);

    this.initParticles();
    this.loadLatest();
    this.refreshTimer = setInterval(() => this.loadLatest(), REFRESH_INTERVAL_MS);
  }

  private initParticles(): void {
    this.particles = [];
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({
        age: Math.random(),
        maxAge: 1.0 + Math.random() * 2.0,
        histLat: new Float32Array(TRAIL_HISTORY),
        histLng: new Float32Array(TRAIL_HISTORY),
        histIdx: 0,
        histLen: 0,
      });
    }
    // Seed initial positions globally
    for (const p of this.particles) {
      const lat = Math.random() * 170 - 85;
      const lng = Math.random() * 360 - 180;
      p.histLat[0] = lat;
      p.histLng[0] = lng;
      p.histIdx = 0;
      p.histLen = 1;
    }
  }

  private respawnParticle(p: Particle): void {
    // Spawn uniformly on the visible spherical cap
    const horizonAngle = Math.acos(Math.min(1, EARTH_RADIUS / Math.max(EARTH_RADIUS + 1, this.camDist)));
    const cosHA = Math.cos(horizonAngle);

    // Uniform random on spherical cap: cosTheta in [cosHA, 1]
    const cosTheta = cosHA + Math.random() * (1 - cosHA);
    const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
    const phi = Math.random() * 2 * Math.PI;

    // Local frame point (Z = camera direction)
    const lx = sinTheta * Math.cos(phi);
    const ly = sinTheta * Math.sin(phi);
    const lz = cosTheta;

    // Camera direction (normalized camera position, globe at origin)
    const cl = this.camDist || 1;
    const cdx = this.camX / cl, cdy = this.camY / cl, cdz = this.camZ / cl;

    // Orthonormal basis: right, up, camDir
    let rx: number, ry: number, rz: number;
    if (Math.abs(cdy) < 0.9) {
      rx = cdz; ry = 0; rz = -cdx;
    } else {
      rx = 0; ry = -cdz; rz = cdy;
    }
    const rLen = Math.sqrt(rx*rx + ry*ry + rz*rz) || 1;
    rx /= rLen; ry /= rLen; rz /= rLen;
    const ux = ry*cdz - rz*cdy;
    const uy = rz*cdx - rx*cdz;
    const uz = rx*cdy - ry*cdx;

    // World-space point on unit sphere → lat/lng
    const wx = lx*rx + ly*ux + lz*cdx;
    const wy = lx*ry + ly*uy + lz*cdy;
    const wz = lx*rz + ly*uz + lz*cdz;
    const ll = xyzToLatLng(wx, wy, wz);

    p.age = 0;
    p.maxAge = 1.0 + Math.random() * 2.0;
    p.histLat[0] = ll.lat;
    p.histLng[0] = ll.lng;
    p.histIdx = 0;
    p.histLen = 1;
  }

  // --- data loading / frame management ---

  private async loadLatest(): Promise<void> {
    try {
      const frame = await fetchLatestFrame();
      this.windFrames.set('__latest__', frame);
      this.currentU = frame.u; this.currentV = frame.v;
      const texture = buildSpeedTexture(frame.u, frame.v);
      if (!this.overlayMesh) { texture.dispose(); return; }
      const mat = this.overlayMesh.material as THREE.ShaderMaterial;
      const old = this.overlayTexture;
      this.overlayTexture = texture; mat.uniforms.uWindMap.value = texture;
      old?.dispose();
      if (this.pendingShow) { this.pendingShow = false; this.startFade(MAX_OPACITY); }
      this.refreshFrameList();
    } catch (err) { console.error('[WindLayer] fetch/build failed:', err); }
  }

  private async refreshFrameList(): Promise<void> {
    try {
      this.frameList = await fetchFrameList();
      if (!this.currentFrameId || this.currentFrameId === '__latest__')
        this.currentFrameId = this.frameList.length > 0 ? this.frameList[this.frameList.length-1].runId : null;
      this.onFrameListChange?.(this.frameList);
    } catch (err) { console.error('[WindLayer] frame list fetch failed:', err); }
  }

  async setFrame(runId: string): Promise<void> {
    this.currentFrameId = runId;
    let frame = this.windFrames.get(runId);
    if (!frame) { frame = await fetchFrame(runId); this.cacheFrame(runId, frame); }
    this.currentU = frame.u; this.currentV = frame.v;
    const texture = buildSpeedTexture(frame.u, frame.v);
    if (!this.overlayMesh) { texture.dispose(); return; }
    const mat = this.overlayMesh.material as THREE.ShaderMaterial;
    const old = this.overlayTexture;
    this.overlayTexture = texture; mat.uniforms.uWindMap.value = texture;
    old?.dispose();
  }

  setOnFrameListChange(cb: ((frames: FrameInfo[]) => void) | null): void {
    this.onFrameListChange = cb;
    if (cb && this.frameList.length > 0) cb(this.frameList);
  }
  getFrameList(): FrameInfo[] { return this.frameList; }
  getCurrentFrameId(): string | null { return this.currentFrameId; }

  private onFrameReady: ((readyIds: Set<string>) => void) | null = null;

  private cacheFrame(runId: string, frame: WindFrame): void {
    this.windFrames.set(runId, frame);
    this.onFrameReady?.(this.getReadyFrameIds());
  }

  getReadyFrameIds(): Set<string> {
    return new Set(this.windFrames.keys());
  }

  setOnFrameReady(cb: ((readyIds: Set<string>) => void) | null): void {
    this.onFrameReady = cb;
  }

  async prefetchAllFrames(): Promise<void> {
    for (const info of this.frameList) {
      if (this.windFrames.has(info.runId)) continue;
      try { this.cacheFrame(info.runId, await fetchFrame(info.runId)); }
      catch (err) { console.warn(`[WindLayer] prefetch ${info.runId} failed:`, err); }
    }
  }

  getWindAtLatLng(lat: number, lng: number): { speed: number; direction: number } | null {
    if (!this.currentU || !this.currentV) return null;
    const latIdx = Math.round((lat+90)/0.25), lngIdx = Math.round((lng+180)/0.25);
    const idx = latIdx*GRID_W+lngIdx;
    if (idx < 0 || idx >= this.currentU.length) return null;
    const u = this.currentU[idx], v = this.currentV[idx];
    const speed = Math.sqrt(u*u+v*v);
    const direction = (270 - Math.atan2(v,u)*180/Math.PI) % 360;
    return { speed: Math.round(speed*10)/10, direction: Math.round(direction) };
  }

  // --- visibility / fade ---

  private pendingShow = false;
  private fadeFrom = 0; private fadeTarget = 0;
  private fadeStartMs = 0; private isFading = false;
  private static readonly FADE_MS = 600;

  private startFade(target: number): void {
    const mat = this.overlayMesh?.material as THREE.ShaderMaterial | undefined;
    this.fadeFrom = mat?.uniforms.uOpacity.value ?? 0;
    this.fadeTarget = target; this.fadeStartMs = performance.now(); this.isFading = true;
  }
  isVisible(): boolean { return this.isFading || super.isVisible(); }
  show(): void {
    super.show();
    if (this.overlayMesh) this.overlayMesh.visible = true;
    if (this.particleMesh) this.particleMesh.visible = true;
    if (this.overlayTexture) this.startFade(MAX_OPACITY);
    else this.pendingShow = true;
  }
  hide(): void {
    super.hide(); this.pendingShow = false; this.startFade(0);
  }

  // --- main update loop ---

  update(_currentTime: number): void {
    const now = performance.now();

    if (this.overlayMesh && this.isFading) {
      const mat = this.overlayMesh.material as THREE.ShaderMaterial;
      const t = Math.min(1, (now - this.fadeStartMs) / WindLayer.FADE_MS);
      const opacity = this.fadeFrom + (this.fadeTarget - this.fadeFrom) * t;
      mat.uniforms.uOpacity.value = opacity;
      setLayerDesaturate('wind', opacity / MAX_OPACITY);
      if (t >= 1) {
        this.isFading = false;
        if (this.fadeTarget === 0) {
          this.overlayMesh.visible = false;
          if (this.particleMesh) this.particleMesh.visible = false;
        }
      }
    }

    if (!this.currentU || !this.currentV || !this.positions || !this.alphas) return;
    if (!this.particleMesh?.visible) return;

    const dt = this.lastUpdateTime > 0 ? Math.min((now - this.lastUpdateTime) / 1000, 0.1) : 0.016;
    this.lastUpdateTime = now;

    // Camera
    let vpW = 1440, vpH = 900, fovRad = 50 * DEG_TO_RAD;
    if (this.globeEl) {
      try {
        const cam = this.globeEl.camera() as THREE.PerspectiveCamera;
        if (cam) {
          this.camX = cam.position.x; this.camY = cam.position.y; this.camZ = cam.position.z;
          this.camDist = cam.position.length();
          fovRad = cam.fov * DEG_TO_RAD;
          const surfDist = Math.max(1, this.camDist - EARTH_RADIUS);
          const domEl = this.globeEl.renderer()?.domElement;
          vpH = domEl?.clientHeight || 900;
          vpW = domEl?.clientWidth || 1440;
          this.pixelWorldSize = 2 * Math.tan(fovRad / 2) * surfDist / vpH;
        }
      } catch { /* ignore */ }
    }

    // Dynamic particle count based on globe's screen area
    const angularR = Math.asin(Math.min(1, EARTH_RADIUS / Math.max(EARTH_RADIUS + 1, this.camDist)));
    const screenR = Math.tan(angularR) * vpH / (2 * Math.tan(fovRad / 2));
    const globeScreenArea = Math.min(vpW * vpH, Math.PI * screenR * screenR);
    this.activeCount = Math.min(MAX_PARTICLES, Math.max(200, Math.floor(globeScreenArea / PIXELS_PER_PARTICLE)));

    // Scale particle movement so trails are a consistent pixel length regardless of zoom.
    const degPerPixel = this.pixelWorldSize * 180 / (Math.PI * PARTICLE_RADIUS);
    // Particles move ~4 pixels per frame per m/s of wind speed
    const speedScale = degPerPixel * 4.0;
    // Minimum movement per frame (ensures visible trail even at low wind)
    const minMoveDeg = degPerPixel * 0.5;
    const halfWidth = TRAIL_WIDTH_PX * this.pixelWorldSize;

    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.particles[i];

      // Particles beyond activeCount are dormant
      if (i >= this.activeCount) {
        const vBase = i * VERTS_PER_PARTICLE;
        for (let j = 0; j < VERTS_PER_PARTICLE; j++) this.alphas[vBase + j] = 0;
        continue;
      }

      p.age += dt / p.maxAge;

      // Current position from history
      const curLat = p.histLat[p.histIdx];
      const curLng = p.histLng[p.histIdx];

      // Respawn if expired or out of bounds
      if (p.age >= 1.0 || curLat < -85 || curLat > 85) {
        this.respawnParticle(p);
      }

      // Read current position (may have changed from respawn)
      const lat = p.histLat[p.histIdx];
      const lng = p.histLng[p.histIdx];

      // Advect and push new position into history
      const [uVal, vVal] = sampleWind(this.currentU, this.currentV, lat, lng);
      const cosLat = Math.cos(lat * DEG_TO_RAD);
      let dLat = vVal * speedScale * dt;
      let dLng = cosLat > 0.01 ? (uVal * speedScale * dt) / cosLat : 0;
      // Ensure minimum movement so trail has visible length
      const moveMag = Math.sqrt(dLat * dLat + dLng * dLng);
      if (moveMag > 0 && moveMag < minMoveDeg) {
        const boost = minMoveDeg / moveMag;
        dLat *= boost;
        dLng *= boost;
      }
      const newLat = lat + dLat;
      let newLng = lng + dLng;
      if (newLng > 180) newLng -= 360;
      if (newLng < -180) newLng += 360;

      // Push to circular buffer
      const nextIdx = (p.histIdx + 1) % TRAIL_HISTORY;
      p.histLat[nextIdx] = newLat;
      p.histLng[nextIdx] = newLng;
      p.histIdx = nextIdx;
      if (p.histLen < TRAIL_HISTORY) p.histLen++;

      // Fade in/out
      const fadeIn = Math.min(p.age * 5, 1);
      const fadeOut = 1 - Math.max(0, (p.age - 0.7) / 0.3);
      let alpha = fadeIn * fadeOut;

      // Head position (newest in buffer)
      const [hx, hy, hz] = latLngToXYZ(newLat, newLng, PARTICLE_RADIUS);

      if (!isFacingCamera(hx, hy, hz, this.camX, this.camY, this.camZ)) {
        alpha = 0;
      }

      // Build quad strip through history positions (newest=head at j=0, oldest=tail)
      const vBase = i * VERTS_PER_PARTICLE;
      for (let j = 0; j < TRAIL_HISTORY; j++) {
        if (j >= p.histLen) {
          // Not enough history yet — zero out remaining vertices
          const vi = (vBase + j * 2) * 3;
          this.positions[vi]=0; this.positions[vi+1]=0; this.positions[vi+2]=0;
          this.positions[vi+3]=0; this.positions[vi+4]=0; this.positions[vi+5]=0;
          this.alphas[vBase + j*2] = 0;
          this.alphas[vBase + j*2 + 1] = 0;
          continue;
        }

        // Read position from circular buffer (j=0 is newest, j=histLen-1 is oldest)
        const hIdx = ((p.histIdx - j) % TRAIL_HISTORY + TRAIL_HISTORY) % TRAIL_HISTORY;
        const pLat = p.histLat[hIdx];
        const pLng = p.histLng[hIdx];
        const [cx, cy, cz] = latLngToXYZ(pLat, pLng, PARTICLE_RADIUS);

        // Direction: toward the next-newer point (or use current direction for head)
        let dx: number, dy: number, dz: number;
        if (j < p.histLen - 1) {
          const nIdx = ((p.histIdx - j + 1) % TRAIL_HISTORY + TRAIL_HISTORY) % TRAIL_HISTORY;
          const [nx, ny, nz] = latLngToXYZ(p.histLat[nIdx], p.histLng[nIdx], PARTICLE_RADIUS);
          dx = nx - cx; dy = ny - cy; dz = nz - cz;
        } else if (j > 0) {
          const pIdx = ((p.histIdx - j + 1) % TRAIL_HISTORY + TRAIL_HISTORY) % TRAIL_HISTORY;
          const [px2, py2, pz2] = latLngToXYZ(p.histLat[pIdx], p.histLng[pIdx], PARTICLE_RADIUS);
          dx = px2 - cx; dy = py2 - cy; dz = pz2 - cz;
        } else {
          dx = uVal * 0.01; dy = vVal * 0.01; dz = 0;
        }

        // Perpendicular on sphere surface
        let perpX = dy*cz - dz*cy;
        let perpY = dz*cx - dx*cz;
        let perpZ = dx*cy - dy*cx;
        const pLen = Math.sqrt(perpX*perpX + perpY*perpY + perpZ*perpZ);
        if (pLen > 0.0001) {
          const s = halfWidth / pLen;
          perpX *= s; perpY *= s; perpZ *= s;
        } else {
          perpX = halfWidth; perpY = 0; perpZ = 0;
        }

        const vi = (vBase + j * 2) * 3;
        this.positions[vi]   = cx - perpX; this.positions[vi+1] = cy - perpY; this.positions[vi+2] = cz - perpZ;
        this.positions[vi+3] = cx + perpX; this.positions[vi+4] = cy + perpY; this.positions[vi+5] = cz + perpZ;

        const tailFade = 1 - j / (p.histLen - 1 || 1);
        const ai = vBase + j * 2;
        this.alphas[ai]   = alpha * tailFade * 0.85;
        this.alphas[ai+1] = alpha * tailFade * 0.85;
      }
    }

    this.particleGeometry!.attributes.position.needsUpdate = true;
    this.particleGeometry!.attributes.alpha.needsUpdate = true;
  }

  addData(_data: void): void {}

  clear(): void {
    setLayerDesaturate('wind', 0);
    if (this.refreshTimer !== null) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    if (this.overlayMesh) { this.scene?.remove(this.overlayMesh); (this.overlayMesh.material as THREE.Material).dispose(); this.overlayMesh = null; }
    this.overlayGeometry?.dispose(); this.overlayGeometry = null;
    this.overlayTexture?.dispose(); this.overlayTexture = null;
    if (this.particleMesh) { this.scene?.remove(this.particleMesh); (this.particleMesh.material as THREE.Material).dispose(); this.particleMesh = null; }
    this.particleGeometry?.dispose(); this.particleGeometry = null;
    this.windFrames.clear(); this.onFrameListChange = null;
  }
}
