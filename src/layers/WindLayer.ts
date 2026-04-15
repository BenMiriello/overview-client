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
const DEG_TO_RAD = Math.PI / 180;

const PARTICLE_COUNT = 2000;
const PARTICLE_RADIUS = EARTH_RADIUS * 1.005;
const TRAIL_SEGMENTS = 3;        // 3 quad segments per particle (4 sample points)
const VERTS_PER_PARTICLE = (TRAIL_SEGMENTS + 1) * 2;  // 8
const INDICES_PER_PARTICLE = TRAIL_SEGMENTS * 6;       // 18

// Screen-space sizing (pixels)
const TRAIL_WIDTH_PX = 2.0;
const TRAIL_LENGTH_PX = 25;       // base length in pixels
const TRAIL_SPEED_SCALE_PX = 2;   // extra pixels per m/s

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
interface Particle { lat: number; lng: number; age: number; maxAge: number; }

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
  const lngIdx = ((lng % 360 + 360) % 360) / 0.25;
  const lat0 = Math.max(0, Math.min(GRID_H - 2, Math.floor(latIdx)));
  const lng0 = Math.floor(lngIdx);
  const lat1 = lat0 + 1;
  const fLat = latIdx - lat0;
  const fLng = lngIdx - lng0;
  const lng0w = lng0 % GRID_W, lng1w = (lng0 + 1) % GRID_W;
  const i00 = lat0 * GRID_W + lng0w, i10 = lat1 * GRID_W + lng0w;
  const i01 = lat0 * GRID_W + lng1w, i11 = lat1 * GRID_W + lng1w;
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

// Front-face visibility check: matches cloudShaders.ts line 117.
// dot(surfaceNormal, toCamera) > -0.05 means the surface faces the camera.
function isFacingCamera(
  px: number, py: number, pz: number,
  camX: number, camY: number, camZ: number,
): boolean {
  const nx = px / PARTICLE_RADIUS, ny = py / PARTICLE_RADIUS, nz = pz / PARTICLE_RADIUS;
  const toCamX = camX - px, toCamY = camY - py, toCamZ = camZ - pz;
  const toCamLen = Math.sqrt(toCamX*toCamX + toCamY*toCamY + toCamZ*toCamZ);
  if (toCamLen < 0.001) return true;
  const dot = (nx*toCamX + ny*toCamY + nz*toCamZ) / toCamLen;
  return dot > -0.05;
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
  // Pre-allocated trail point buffer: (TRAIL_SEGMENTS+1) * 3 floats
  private trailPts = new Float32Array((TRAIL_SEGMENTS + 1) * 3);
  // Camera target lat/lng (derived from camera position, not pointOfView)
  private camLat = 0;
  private camLng = 0;
  // Visible radius on globe surface in degrees
  private visibleDeg = 80;

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

    // Quad geometry: VERTS_PER_PARTICLE verts, INDICES_PER_PARTICLE indices per particle
    const totalVerts = PARTICLE_COUNT * VERTS_PER_PARTICLE;
    this.positions = new Float32Array(totalVerts * 3);
    this.alphas = new Float32Array(totalVerts);
    // Side attribute: -1 for left vertices, +1 for right (static pattern)
    this.sides = new Float32Array(totalVerts);
    for (let i = 0; i < totalVerts; i++) this.sides[i] = (i % 2 === 0) ? -1 : 1;
    const indices = new Uint32Array(PARTICLE_COUNT * INDICES_PER_PARTICLE);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const vBase = i * VERTS_PER_PARTICLE;
      const iBase = i * INDICES_PER_PARTICLE;
      for (let s = 0; s < TRAIL_SEGMENTS; s++) {
        const v = vBase + s * 2;
        const ii = iBase + s * 6;
        indices[ii]   = v;   indices[ii+1] = v+1; indices[ii+2] = v+2;
        indices[ii+3] = v+1; indices[ii+4] = v+3; indices[ii+5] = v+2;
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
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      this.particles.push({
        lat: Math.random() * 170 - 85,
        lng: Math.random() * 360 - 180,
        age: Math.random(),
        maxAge: 1.0 + Math.random() * 2.0,
      });
    }
  }

  private respawnParticle(p: Particle): void {
    // Respawn within the visible cone on the globe surface
    const angle = Math.random() * 2 * Math.PI;
    const dist = Math.sqrt(Math.random()) * this.visibleDeg;
    const cosC = Math.cos(this.camLat * DEG_TO_RAD);
    p.lat = this.camLat + dist * Math.cos(angle);
    p.lng = this.camLng + dist * Math.sin(angle) / Math.max(0.15, cosC);
    p.lat = Math.max(-85, Math.min(85, p.lat));
    if (p.lng > 180) p.lng -= 360;
    if (p.lng < -180) p.lng += 360;
    p.age = 0;
    p.maxAge = 1.0 + Math.random() * 2.0;
  }

  // --- data loading / frame management (unchanged) ---

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

  private cacheFrame(runId: string, frame: WindFrame): void {
    this.windFrames.set(runId, frame);
    if (this.windFrames.size > WindLayer.MAX_CACHED_FRAMES) {
      const oldest = this.windFrames.keys().next().value;
      if (oldest && oldest !== '__latest__' && oldest !== this.currentFrameId)
        this.windFrames.delete(oldest);
    }
  }

  async prefetchAllFrames(): Promise<void> {
    const ci = this.frameList.findIndex(f => f.runId === this.currentFrameId);
    for (const info of this.frameList) {
      if (this.windFrames.has(info.runId)) continue;
      if (Math.abs(this.frameList.indexOf(info) - ci) > 3) continue;
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

    // Fade
    if (this.overlayMesh && this.isFading) {
      const mat = this.overlayMesh.material as THREE.ShaderMaterial;
      const t = Math.min(1, (now - this.fadeStartMs) / WindLayer.FADE_MS);
      const opacity = this.fadeFrom + (this.fadeTarget - this.fadeFrom) * t;
      mat.uniforms.uOpacity.value = opacity;
      setMapDesaturate(opacity / MAX_OPACITY);
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
    if (this.globeEl) {
      try {
        const cam = this.globeEl.camera() as THREE.PerspectiveCamera;
        if (cam) {
          this.camX = cam.position.x; this.camY = cam.position.y; this.camZ = cam.position.z;
          this.camDist = cam.position.length();
          const fovRad = cam.fov * DEG_TO_RAD;
          const surfDist = Math.max(1, this.camDist - EARTH_RADIUS);
          const vpH = this.globeEl.renderer()?.domElement?.clientHeight || 800;
          this.pixelWorldSize = 2 * Math.tan(fovRad / 2) * surfDist / vpH;
          // Camera target lat/lng from position vector
          const ll = xyzToLatLng(this.camX, this.camY, this.camZ);
          this.camLat = ll.lat; this.camLng = ll.lng;
          // Visible cone angle on the globe surface (degrees)
          this.visibleDeg = Math.min(70, Math.max(3,
            surfDist * Math.tan(fovRad / 2) * 180 / (Math.PI * EARTH_RADIUS)
          ));
        }
      } catch { /* ignore */ }
    }

    const speedScale = 0.05;
    const halfWidth = TRAIL_WIDTH_PX * this.pixelWorldSize;
    const degPerUnit = 180 / (Math.PI * PARTICLE_RADIUS);

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.age += dt / p.maxAge;

      // Respawn if expired, out of bounds, or outside the visible cone
      const dLat = p.lat - this.camLat;
      let dLng2 = p.lng - this.camLng;
      if (dLng2 > 180) dLng2 -= 360; if (dLng2 < -180) dLng2 += 360;
      const angDist = Math.sqrt(dLat * dLat + dLng2 * dLng2 * Math.cos(p.lat * DEG_TO_RAD) ** 2);
      if (p.age >= 1.0 || p.lat < -85 || p.lat > 85 || angDist > this.visibleDeg * 1.2) {
        this.respawnParticle(p);
      }

      // Advect
      const [uVal, vVal] = sampleWind(this.currentU, this.currentV, p.lat, p.lng);
      const cosLat = Math.cos(p.lat * DEG_TO_RAD);
      p.lat += vVal * speedScale * dt;
      p.lng += (cosLat > 0.01 ? (uVal * speedScale * dt) / cosLat : 0);
      if (p.lng > 180) p.lng -= 360;
      if (p.lng < -180) p.lng += 360;

      // Fade
      const fadeIn = Math.min(p.age * 5, 1);
      const fadeOut = 1 - Math.max(0, (p.age - 0.7) / 0.3);
      let alpha = fadeIn * fadeOut;

      // Head position
      const [hx, hy, hz] = latLngToXYZ(p.lat, p.lng, PARTICLE_RADIUS);

      // Front-face cull (same check as cloud shader front faces)
      if (!isFacingCamera(hx, hy, hz, this.camX, this.camY, this.camZ)) {
        alpha = 0;
      }

      // Build trail points by backward-stepping through the wind field (curved trail)
      const speed = Math.sqrt(uVal*uVal + vVal*vVal);
      const trailWorldLen = (TRAIL_LENGTH_PX + speed * TRAIL_SPEED_SCALE_PX) * this.pixelWorldSize;
      const stepDeg = trailWorldLen * degPerUnit / TRAIL_SEGMENTS;

      // Trail points into pre-allocated buffer: head at index 0, tail segments after
      const tp = this.trailPts;
      tp[0] = hx; tp[1] = hy; tp[2] = hz;
      let tLat = p.lat, tLng = p.lng;
      for (let s = 0; s < TRAIL_SEGMENTS; s++) {
        const [su, sv] = sampleWind(this.currentU, this.currentV, tLat, tLng);
        const sp = Math.sqrt(su*su + sv*sv);
        if (sp > 0.01) {
          const cL = Math.cos(tLat * DEG_TO_RAD);
          tLat -= (sv / sp) * stepDeg;
          tLng -= (su / sp) * stepDeg / Math.max(0.15, cL);
        }
        tLat = Math.max(-85, Math.min(85, tLat));
        const [tx, ty, tz] = latLngToXYZ(tLat, tLng, PARTICLE_RADIUS);
        const si = (s + 1) * 3;
        tp[si] = tx; tp[si+1] = ty; tp[si+2] = tz;
      }

      // Build quad strip: 2 vertices per point (left/right offset perpendicular to trail)
      const vBase = i * VERTS_PER_PARTICLE;
      for (let j = 0; j <= TRAIL_SEGMENTS; j++) {
        const ji = j * 3;
        const cx = tp[ji], cy = tp[ji+1], cz = tp[ji+2];
        // Direction along trail at this point
        let dx: number, dy: number, dz: number;
        if (j < TRAIL_SEGMENTS) {
          const ni = (j+1)*3;
          dx = cx - tp[ni]; dy = cy - tp[ni+1]; dz = cz - tp[ni+2];
        } else {
          const pi = (j-1)*3;
          dx = cx - tp[pi]; dy = cy - tp[pi+1]; dz = cz - tp[pi+2];
        }
        // Perpendicular on sphere surface: cross(trailDir, surfaceNormal)
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

        // Alpha: full at head (j=0), fading toward tail
        const tailFade = 1 - j / TRAIL_SEGMENTS;
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
    setMapDesaturate(0);
    if (this.refreshTimer !== null) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    if (this.overlayMesh) { this.scene?.remove(this.overlayMesh); (this.overlayMesh.material as THREE.Material).dispose(); this.overlayMesh = null; }
    this.overlayGeometry?.dispose(); this.overlayGeometry = null;
    this.overlayTexture?.dispose(); this.overlayTexture = null;
    if (this.particleMesh) { this.scene?.remove(this.particleMesh); (this.particleMesh.material as THREE.Material).dispose(); this.particleMesh = null; }
    this.particleGeometry?.dispose(); this.particleGeometry = null;
    this.windFrames.clear(); this.onFrameListChange = null;
  }
}
