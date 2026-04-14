/**
 * Vendored fork of three-slippy-map-globe v1.0.3 by Vasco Asturiano (MIT).
 * Source: https://github.com/vasturiano/three-slippy-map-globe
 *
 * Why vendored:
 * - We need fine-grained control over tile material creation so callers can
 *   patch shaders the instant a tile is added (no 1-frame flash).
 * - We use this for both Earth (Mercator) and Moon (equirectangular) layers.
 * - The d3-geo / d3-scale dependencies are inlined as ~10 lines of math.
 *
 * Behavioural diff from upstream:
 * - `materialFactory` constructor option lets callers supply a fresh material
 *   for each tile (replaces the hard-coded `new MeshLambertMaterial()`).
 * - `onTileLoaded` callback fires after a tile's texture is assigned and the
 *   tile is added to the scene graph.
 * - Inlined mercator y-projection (no d3-geo dependency).
 * - Removed d3-scale dependency (replaced with two-line linear interpolation).
 * - TypeScript throughout, private fields via `#`.
 */

import {
  Group,
  Mesh,
  SphereGeometry,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Camera,
  Vector3,
  Frustum,
  Matrix4,
  Sphere,
  SRGBColorSpace,
  Material,
  Texture,
  BufferAttribute,
} from 'three';
import { octree } from 'd3-octree';

export type TileUrlFn = (x: number, y: number, level: number) => string;

export interface SlippyMapOptions {
  tileUrl?: TileUrlFn;
  minLevel?: number;
  maxLevel?: number;
  /** When false, tiles are addressed in equirectangular (plate carrée) projection. Default true (Web Mercator). */
  mercatorProjection?: boolean;
  /** Optional factory called for every new tile to provide its material. Defaults to MeshLambertMaterial. */
  materialFactory?: () => Material;
  /**
   * Optional texture binder. Called after a tile texture loads, with the
   * tile's material and the loaded texture. Defaults to assigning
   * `material.map = texture` (correct for MeshLambertMaterial and similar).
   * Custom materials (e.g. ShaderMaterial) should set their own uniform.
   */
  applyTexture?: (material: Material, texture: Texture) => void;
  /** Optional callback fired after a tile's texture loads and it joins the scene graph. */
  onTileLoaded?: (tile: Mesh) => void;
  /** Render order assigned to every tile mesh as it's created. Defaults to 0. */
  tileRenderOrder?: number;
  /**
   * Hysteresis fraction applied specifically to the transition into/out of maxLevel.
   * A larger value (e.g. 0.5) means the camera must zoom much deeper before max-level
   * tiles load, and zoom out further before they drop. Defaults to LEVEL_HYSTERESIS (0.05).
   */
  maxLevelHysteresis?: number;
}

interface TileMeta {
  x: number;
  y: number;
  lng: number;
  lat: number;
  latLen: number;
  centroid?: { x: number; y: number; z: number };
  tileRadius?: number;
  obj?: Mesh;
  loading?: boolean;
  failedAt?: number;
  failCount?: number;
  controller?: AbortController;
  _sortDot?: number;
}

interface TileMetaLevel extends Array<TileMeta> {
  octree?: ReturnType<typeof octree>;
  record?: Record<string, TileMeta>;
}

// Scratch objects reused across updatePov / fetchNeededTiles calls to avoid
// per-frame allocation churn. Never store references to these externally.
const _tmpMat4 = new Matrix4();
const _tmpVec3A = new Vector3();
const _tmpVec3B = new Vector3();
const _tmpVec3C = new Vector3();
const _tmpSphere = new Sphere();
const _tmpFrustum = new Frustum();

// ── Math helpers (inlined from d3-geo / d3-scale) ─────────────────────────

// d3-geo's geoMercatorRaw, evaluated at lng=0: y = log(tan(π/4 + φ/2))
const mercatorRawY = (phi: number): number => Math.log(Math.tan(Math.PI / 4 + phi / 2));
const mercatorRawYInvert = (y: number): number => 2 * Math.atan(Math.exp(y)) - Math.PI / 2;

// Map y∈[0,1] (top→bottom) through Mercator projection back into [0,1].
const yMercatorScale = (y: number): number =>
  1 - (mercatorRawY((0.5 - y) * Math.PI) / Math.PI + 1) / 2;
const yMercatorScaleClamped = (y: number): number => Math.max(0, Math.min(1, yMercatorScale(y)));
const yMercatorScaleInvert = (y: number): number =>
  0.5 - mercatorRawYInvert((2 * (1 - y) - 1) * Math.PI) / Math.PI;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/**
 * Stretches a tile's UV.y attribute to compensate for the Mercator projection
 * so the loaded tile image lines up correctly on the spherical patch.
 */
function convertMercatorUV(uvs: BufferAttribute, y0: number, y1: number): void {
  // domain [1,0] → range [y0,y1]
  const offsetScale = (v: number): number => clamp01(lerp(y0, y1, 1 - v));
  const a = yMercatorScaleClamped(y0);
  const b = yMercatorScaleClamped(y1);
  // domain [a,b] → range [1,0]
  const revOffsetScale = (v: number): number => clamp01(1 - (v - a) / (b - a || 1));
  const arr = uvs.array as Float32Array;
  for (let i = 0, len = arr.length; i < len; i += 2) {
    arr[i + 1] = revOffsetScale(yMercatorScaleClamped(offsetScale(arr[i + 1])));
  }
  uvs.needsUpdate = true;
}

function polar2Cartesian(lat: number, lng: number, r: number): { x: number; y: number; z: number } {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((90 - lng) * Math.PI) / 180;
  return {
    x: r * Math.sin(phi) * Math.cos(theta),
    y: r * Math.cos(phi),
    z: r * Math.sin(phi) * Math.sin(theta),
  };
}

function cartesian2Polar({ x, y, z }: { x: number; y: number; z: number }): { lat: number; lng: number; r: number } {
  const r = Math.sqrt(x * x + y * y + z * z);
  const phi = Math.acos(y / r);
  const theta = Math.atan2(z, x);
  return {
    lat: 90 - (phi * 180) / Math.PI,
    lng: 90 - (theta * 180) / Math.PI - (theta < -Math.PI / 2 ? 360 : 0),
    r,
  };
}

const deg2Rad = (deg: number): number => (deg * Math.PI) / 180;

// ── Tile coordinate generation ────────────────────────────────────────────

/**
 * Returns the tile-matrix dimensions at a given level for the chosen projection.
 *   - Web Mercator (Google/OSM convention): square 2^level × 2^level grid.
 *   - Equirectangular (NASA Trek "default028mm"/GoogleCRS84Quad convention):
 *     2:1 grid → 2*2^level columns × 2^level rows. At level 0 there are 2
 *     tiles covering the eastern and western hemispheres respectively.
 */
function gridDims(level: number, isMercator: boolean): { gx: number; gy: number } {
  const gy = Math.pow(2, level);
  return { gx: isMercator ? gy : gy * 2, gy };
}

function findTileXY(level: number, isMercator: boolean, lng: number, lat: number): [number, number] {
  const { gx, gy } = gridDims(level, isMercator);
  const x = Math.max(0, Math.min(gx - 1, Math.floor(((lng + 180) * gx) / 360)));
  let relY = (90 - lat) / 180;
  if (isMercator) relY = clamp01(yMercatorScale(relY));
  const y = Math.max(0, Math.min(gy - 1, Math.floor(relY * gy)));
  return [x, y];
}

function genTilesCoords(
  level: number,
  isMercator: boolean,
  x0 = 0,
  y0 = 0,
  x1Opt?: number,
  y1Opt?: number,
): TileMeta[] {
  const tiles: TileMeta[] = [];
  const { gx, gy } = gridDims(level, isMercator);
  const tileLngLen = 360 / gx;
  const regTileLatLen = 180 / gy;
  const x1 = x1Opt === undefined ? gx - 1 : x1Opt;
  const y1 = y1Opt === undefined ? gy - 1 : y1Opt;
  for (let x = x0, maxX = Math.min(gx - 1, x1); x <= maxX; x++) {
    for (let y = y0, maxY = Math.min(gy - 1, y1); y <= maxY; y++) {
      let reproY: number = y;
      let tileLatLen = regTileLatLen;
      if (isMercator) {
        // lat needs reprojection, but stretch to cover poles
        reproY = y === 0 ? y : yMercatorScaleInvert(y / gy) * gy;
        const reproYEnd = y + 1 === gy ? y + 1 : yMercatorScaleInvert((y + 1) / gy) * gy;
        tileLatLen = ((reproYEnd - reproY) * 180) / gy;
      }
      const lng = -180 + (x + 0.5) * tileLngLen;
      const lat = 90 - ((reproY * 180) / gy + tileLatLen / 2);
      tiles.push({ x, y, lng, lat, latLen: tileLatLen });
    }
  }
  return tiles;
}

// ── Cleanup ───────────────────────────────────────────────────────────────

function disposeMaterial(material: Material | Material[]): void {
  if (Array.isArray(material)) {
    material.forEach(disposeMaterial);
    return;
  }
  const m = material as Material & { map?: { dispose: () => void } };
  if (m.map) m.map.dispose();
  m.dispose();
}

function deallocate(obj: Mesh | { geometry?: { dispose: () => void }; material?: Material | Material[]; children?: unknown[] }): void {
  const o = obj as Mesh;
  if (o.geometry) o.geometry.dispose();
  if (o.material) disposeMaterial(o.material);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((o as any).children) (o as any).children.forEach(deallocate);
}

function emptyObject(obj: Mesh): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  while ((obj as any).children?.length) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const child = (obj as any).children[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (obj as any).remove(child);
    deallocate(child);
  }
}

// ── Main class ────────────────────────────────────────────────────────────

// Caps are projection-aware: equirect packs 2× the tiles per level so we
// shave one level off both thresholds to keep memory comparable.
const MAX_LEVEL_TO_RENDER_ALL_TILES_MERCATOR = 6; // 4096 tiles
const MAX_LEVEL_TO_BUILD_LOOKUP_OCTREE_MERCATOR = 7; // 16384 tiles
const MAX_LEVEL_TO_RENDER_ALL_TILES_EQUIRECT = 5; // 2048 tiles
const MAX_LEVEL_TO_BUILD_LOOKUP_OCTREE_EQUIRECT = 6; // 8192 tiles

/**
 * Default texture binder — assigns `material.map = texture`. Correct for
 * MeshLambertMaterial / MeshBasicMaterial / MeshStandardMaterial etc.
 * Custom materials (like ShaderMaterial) should supply their own binder
 * via the `applyTexture` option on the constructor.
 */
function defaultApplyTexture(material: Material, texture: Texture): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mat = material as any;
  mat.map = texture;
  // Upstream three-slippy-map-globe sets color to null to ensure the diffuse
  // uniform doesn't tint. We replicate that here for behavioural parity.
  mat.color = null;
  mat.needsUpdate = true;
}
// Search radii are computed geometrically in #fetchNeededTiles — no constant needed.

export default class SlippyMapGlobe extends Group {
  // Public attributes (matching upstream API)
  minLevel: number;
  maxLevel: number;
  thresholds: number[] = [...new Array(30)].map((_, idx) => 8 / Math.pow(2, idx));
  /** Hysteresis fraction for the maxLevel transition. See SlippyMapOptions.maxLevelHysteresis. */
  maxLevelHysteresis = 0.05;
  /** Resolution of tile sphere subdivision in degrees. */
  curvatureResolution = 5;
  /** Tile shrink factor (0–1) — used to leave gaps between tiles for debugging. */
  tileMargin = 0;

  #radius: number;
  #isMercator: boolean;
  #tileUrl?: TileUrlFn;
  #materialFactory: () => Material;
  #applyTexture: (material: Material, texture: Texture) => void;
  #onTileLoaded?: (tile: Mesh) => void;
  #tileRenderOrder: number;
  #level?: number;
  #tilesMeta: Record<number, TileMetaLevel> = {};
  #isInView?: (d: TileMeta) => boolean;
  #camera?: Camera;
  #innerBackLayer: Mesh;
  #lastPovX = NaN;
  #lastPovY = NaN;
  #lastPovZ = NaN;
  #lastFetchAt = 0;
  #lastTileLoadedAt = 0;
  #frustumReady = false;

  constructor(radius: number, opts: SlippyMapOptions = {}) {
    super();
    const {
      tileUrl,
      minLevel = 0,
      maxLevel = 17,
      mercatorProjection = true,
      materialFactory = () => new MeshLambertMaterial(),
      applyTexture = defaultApplyTexture,
      onTileLoaded,
      tileRenderOrder = 0,
      maxLevelHysteresis = 0.05,
    } = opts;

    this.maxLevelHysteresis = maxLevelHysteresis;
    this.#radius = radius;
    this.#isMercator = mercatorProjection;
    this.#materialFactory = materialFactory;
    this.#applyTexture = applyTexture;
    this.#onTileLoaded = onTileLoaded;
    this.#tileRenderOrder = tileRenderOrder;
    this.minLevel = minLevel;
    this.maxLevel = maxLevel;
    this.tileUrl = tileUrl;
    this.level = 0;

    // Protective black sphere just below the surface, prevents depth-buffer
    // anomalies on level transitions.
    this.#innerBackLayer = new Mesh(
      new SphereGeometry(this.#radius * 0.99, 180, 90),
      new MeshBasicMaterial({ color: 0x0 }),
    );
    this.#innerBackLayer.visible = false;
    const backMat = this.#innerBackLayer.material as MeshBasicMaterial;
    backMat.polygonOffset = true;
    backMat.polygonOffsetUnits = 3;
    backMat.polygonOffsetFactor = 1;
    this.add(this.#innerBackLayer);
  }

  get tileUrl(): TileUrlFn | undefined {
    return this.#tileUrl;
  }
  set tileUrl(fn: TileUrlFn | undefined) {
    this.#tileUrl = fn;
    if (this.#camera) this.updatePov(this.#camera);
  }

  get level(): number {
    return this.#level ?? 0;
  }
  set level(level: number) {
    if (!this.#tilesMeta[level]) this.#buildMetaLevel(level);
    const prevLevel = this.#level;
    this.#level = level;
    if (level === prevLevel || prevLevel === undefined) return;

    if (prevLevel > level) {
      // Destroy tiles 2+ levels above the new level immediately, but retain
      // tiles one level above as visual fallback while new-level tiles load.
      // Retained tiles are culled by cullEngineTiles (invisible when behind
      // the camera) and evicted by the GlobeComponent 30s eviction timer.
      for (let l = level + 2; l <= Math.max(this.maxLevel, prevLevel); l++) {
        this.#tilesMeta[l]?.forEach((d) => {
          d.controller?.abort();
          if (d.obj) {
            this.remove(d.obj);
            deallocate(d.obj);
            delete d.obj;
          }
          delete d.failedAt;
          delete d.failCount;
        });
      }
      // Level+1: abort in-flight fetches but keep loaded tiles as visual fallback
      this.#tilesMeta[level + 1]?.forEach((d) => {
        d.controller?.abort();
        delete d.failedAt;
        delete d.failCount;
      });
    }
    this.#fetchNeededTiles(true);
  }

  clearTiles = (): void => {
    Object.values(this.#tilesMeta).forEach((l) => {
      l.forEach((d) => {
        d.controller?.abort();
        if (d.obj) {
          this.remove(d.obj);
          emptyObject(d.obj);
          delete d.obj;
        }
      });
    });
    this.#tilesMeta = {};
  };

  updatePov(camera: Camera, forceFetch = false): void {
    if (!camera || !(camera instanceof Camera)) return;
    this.#camera = camera;

    const cp = camera.position;
    const posUnchanged = Math.abs(cp.x - this.#lastPovX) < 0.001 &&
        Math.abs(cp.y - this.#lastPovY) < 0.001 &&
        Math.abs(cp.z - this.#lastPovZ) < 0.001;
    if (!posUnchanged) {
      this.#lastPovX = cp.x;
      this.#lastPovY = cp.y;
      this.#lastPovZ = cp.z;
    }

    this.#frustumReady = false;
    this.#isInView = (d: TileMeta): boolean => {
      if (!this.#frustumReady) {
        camera.updateMatrix();
        camera.updateMatrixWorld();
        _tmpFrustum.setFromProjectionMatrix(
          _tmpMat4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
        );
        this.#frustumReady = true;
      }
      if (d.tileRadius === undefined) {
        const { gx } = gridDims(this.level, this.#isMercator);
        const halfLngRad = (180 / gx) * Math.PI / 180;
        const halfLatRad = (d.latLen / 2) * Math.PI / 180;
        const halfDiag = Math.sqrt(halfLngRad * halfLngRad + halfLatRad * halfLatRad);
        // Exact chord from centroid to farthest corner: 2R·sin(θ/2).
        // R·sin(θ) underestimates by ~17% for level-2 tiles (halfDiag ≈ 1.1 rad).
        d.tileRadius = 2 * this.#radius * Math.sin(halfDiag / 2);
      }
      const c = d.centroid!;
      _tmpVec3A.set(c.x, c.y, c.z).applyMatrix4(this.matrixWorld);
      _tmpSphere.set(_tmpVec3A, d.tileRadius);
      return _tmpFrustum.intersectsSphere(_tmpSphere);
    };

    if (this.tileUrl) {
      if (!posUnchanged) {
        const pov = _tmpVec3B.copy(camera.position);
        const distToGlobeCenter = pov.distanceTo(this.getWorldPosition(_tmpVec3C));
        const cameraDistance = (distToGlobeCenter - this.#radius) / this.#radius;
        const rawIdx = this.thresholds.findIndex((t) => t && t <= cameraDistance);
        const rawLevel = Math.min(this.maxLevel, Math.max(this.minLevel, rawIdx < 0 ? this.thresholds.length : rawIdx));

        // Hysteresis: only switch levels when clearly past the threshold boundary.
        // Prevents thrashing when the camera hovers near a transition point, which
        // causes the level setter to evict and re-create tiles every frame.
        const LEVEL_HYSTERESIS = 0.05;
        const curLevel = this.#level ?? rawLevel;
        let targetLevel = rawLevel;
        if (rawLevel !== curLevel) {
          const isZoomingIn = rawLevel > curLevel;
          // The boundary lives at thresholds[curLevel] (zoom in) or thresholds[rawLevel] (zoom out).
          const boundaryIdx = isZoomingIn ? curLevel : rawLevel;
          const boundary = this.thresholds[boundaryIdx] ?? 0;
          // Max-level transitions use a wider gate so those tiles only load at the
          // very closest zoom and drop away on any deliberate zoom-out.
          const hysteresis = (rawLevel === this.maxLevel || curLevel === this.maxLevel)
            ? this.maxLevelHysteresis
            : LEVEL_HYSTERESIS;
          const shouldSwitch = isZoomingIn
            ? cameraDistance < boundary * (1 - hysteresis)
            : cameraDistance > boundary * (1 + hysteresis);
          if (!shouldSwitch) targetLevel = curLevel;
        }
        this.level = targetLevel;
      }
      this.#fetchNeededTiles(forceFetch);
    }
  }


  /** Count of tiles at the current level whose fetch is in-flight. Useful for detecting stuck state. */
  get loadingCount(): number {
    if (this.#level === undefined || !this.#tilesMeta[this.#level]) return 0;
    return this.#tilesMeta[this.#level].filter((d) => d.loading).length;
  }

  /**
   * Evict tiles matching `pred`. Aborts in-flight fetches, disposes
   * geometry/material/texture, removes from scene graph, and clears
   * the meta entry so the engine will refetch on demand.
   */
  evictTiles(pred: (tile: Mesh) => boolean): number {
    let count = 0;
    for (const levelTiles of Object.values(this.#tilesMeta)) {
      for (const d of levelTiles) {
        if (d.obj && pred(d.obj)) {
          d.controller?.abort();
          this.remove(d.obj);
          deallocate(d.obj);
          delete d.obj;
          delete d.loading;
          delete d.controller;
          delete d.failedAt;
          delete d.failCount;
          count++;
        }
      }
    }
    if (count > 0) this.#fetchNeededTiles(true);
    return count;
  }

  resetBackoff(): void {
    if (this.#level === undefined || !this.#tilesMeta[this.#level]) return;
    for (const d of this.#tilesMeta[this.#level]) {
      delete d.failedAt;
      delete d.failCount;
    }
    this.#fetchNeededTiles(true);
  }

  #buildMetaLevel(level: number): void {
    const octreeCap = this.#isMercator
      ? MAX_LEVEL_TO_BUILD_LOOKUP_OCTREE_MERCATOR
      : MAX_LEVEL_TO_BUILD_LOOKUP_OCTREE_EQUIRECT;
    if (level > octreeCap) {
      // Generate meta dynamically (octrees are too memory-heavy at high levels)
      this.#tilesMeta[level] = [] as TileMetaLevel;
      return;
    }
    const levelMeta = (this.#tilesMeta[level] = genTilesCoords(level, this.#isMercator) as TileMetaLevel);
    levelMeta.forEach((d) => {
      d.centroid = polar2Cartesian(d.lat, d.lng, this.#radius);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    levelMeta.octree = (octree() as any)
      .x((d: TileMeta) => d.centroid!.x)
      .y((d: TileMeta) => d.centroid!.y)
      .z((d: TileMeta) => d.centroid!.z)
      .addAll(levelMeta);
  }

  #fetchNeededTiles(force = false): void {
    if (!this.tileUrl || this.#level === undefined || !this.#tilesMeta[this.#level]) return;
    if (!force) {
      const now = performance.now();
      if (now - this.#lastFetchAt < 16) return;
      this.#lastFetchAt = now;
    } else {
      this.#lastFetchAt = performance.now();
    }
    const renderAllCap = this.#isMercator
      ? MAX_LEVEL_TO_RENDER_ALL_TILES_MERCATOR
      : MAX_LEVEL_TO_RENDER_ALL_TILES_EQUIRECT;
    if (!this.#isInView && this.#level > renderAllCap) return;

    let tiles: TileMeta[] = this.#tilesMeta[this.#level];

    if (this.#camera) {
      const povPos = this.worldToLocal(_tmpVec3B.copy(this.#camera.position));
      const fullLevel = this.#tilesMeta[this.#level];
      if (fullLevel.octree) {
        // Correct search radius: the farthest visible surface point is at the geometric horizon,
        // whose chord distance from the camera is sqrt(dist² - r²). The old formula D*3*r was
        // geometrically incorrect — it underestimates by 28-50% at level 6 and 5× at level 7,
        // causing entire sections of the visible hemisphere to be absent from the fetch queue.
        const dist = povPos.length();
        const searchRadius = Math.sqrt(dist * dist - this.#radius * this.#radius) * 1.1;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tiles = (fullLevel.octree as any).findAllWithinRadius(povPos.x, povPos.y, povPos.z, searchRadius);
      } else {
        // Tiles populated dynamically (high-level path)
        const povCoords = cartesian2Polar(povPos);
        // Correct angular search radius: the visible horizon is at arccos(r/dist) degrees.
        // The old formula D*90 is 5× too small at level 8 (D≈0.03), causing most visible tiles
        // to be absent from the fetch queue at maximum zoom.
        const horizonDeg = Math.acos(Math.min(1, this.#radius / povCoords.r)) * (180 / Math.PI);
        const searchRadiusLat = horizonDeg * 1.1; // 10% past horizon
        const searchRadiusLng = searchRadiusLat / Math.max(Math.cos(deg2Rad(povCoords.lat)), 0.01);
        const lngRange: [number, number] = [povCoords.lng - searchRadiusLng, povCoords.lng + searchRadiusLng];
        const latRange: [number, number] = [povCoords.lat + searchRadiusLat, povCoords.lat - searchRadiusLat];
        const [x0, y0] = findTileXY(this.#level, this.#isMercator, lngRange[0], latRange[0]);
        const [x1, y1] = findTileXY(this.#level, this.#isMercator, lngRange[1], latRange[1]);
        if (!fullLevel.record) fullLevel.record = {};
        const r = fullLevel.record;
        const midKey = `${Math.round((x0 + x1) / 2)}_${Math.round((y0 + y1) / 2)}`;
        if (!Object.prototype.hasOwnProperty.call(r, midKey)) {
          tiles = genTilesCoords(this.#level, this.#isMercator, x0, y0, x1, y1).map((d) => {
            const k = `${d.x}_${d.y}`;
            if (Object.prototype.hasOwnProperty.call(r, k)) return r[k];
            d.centroid = polar2Cartesian(d.lat, d.lng, this.#radius);
            r[k] = d;
            fullLevel.push(d);
            return d;
          });
        } else {
          const selTiles: TileMeta[] = [];
          for (let x = x0; x <= x1; x++) {
            for (let y = y0; y <= y1; y++) {
              const k = `${x}_${y}`;
              if (!Object.prototype.hasOwnProperty.call(r, k)) {
                r[k] = genTilesCoords(this.#level, this.#isMercator, x, y, x, y)[0];
                r[k].centroid = polar2Cartesian(r[k].lat, r[k].lng, this.#radius);
                fullLevel.push(r[k]);
              }
              selTiles.push(r[k]);
            }
          }
          tiles = selTiles;
        }

      }
    }

    // Cap concurrent in-flight fetches per engine. Prioritize tiles closest to screen
    // center so the most-visible tiles load first when multiple are queued.
    // 16 concurrent: GIBS and Trek use HTTP/2 (multiplexed streams), not HTTP/1.1's 6-per-origin limit.
    const MAX_CONCURRENT = 16;
    // Exclude aborted tiles: signal.aborted is synchronous, but d.loading stays true until the
    // async catch fires. Without this, freshly-aborted tiles block new fetches in the same frame.
    const inFlight = (this.#tilesMeta[this.#level] as TileMeta[])
      .filter((d) => d.loading && !d.controller?.signal.aborted).length;
    const slots = MAX_CONCURRENT - inFlight;
    if (slots <= 0) return;

    // Sort target: the point on the globe surface where the camera is actually
    // looking. Found via ray-sphere intersection of the camera look direction.
    // At close zoom with pitch, this differs significantly from the camera nadir
    // (the old heuristic used camPos+lookDir which collapsed to the nadir direction).
    let sortTarget: Vector3 | null = null;
    if (this.#camera) {
      const camLocal = this.worldToLocal(_tmpVec3B.copy(this.#camera.position));
      if ((this.#camera as any).quaternion) {
        const lookWorld = _tmpVec3A.set(0, 0, -1).applyQuaternion((this.#camera as any).quaternion);
        // Transform direction to local space (subtract origins to get pure direction)
        const lookLocal = this.worldToLocal(
          _tmpVec3C.copy(this.#camera.position).add(lookWorld)
        ).sub(camLocal).normalize();

        const bCoeff = 2 * camLocal.dot(lookLocal);
        const cCoeff = camLocal.dot(camLocal) - this.#radius * this.#radius;
        const disc = bCoeff * bCoeff - 4 * cCoeff;
        if (disc >= 0) {
          const t = (-bCoeff - Math.sqrt(disc)) / 2;
          if (t > 0) {
            sortTarget = camLocal.clone().addScaledVector(lookLocal, t).normalize();
          }
        }
      }
      if (!sortTarget) {
        sortTarget = camLocal.clone().normalize();
      }
    }

    const now = performance.now();
    const candidates = tiles
      .filter((d) => {
        if (d.loading) return false;
        if (d.obj && d.obj.parent) return false;
        if (d.failedAt !== undefined) {
          const backoff = Math.min(60_000, 2_000 * Math.pow(2, (d.failCount ?? 1) - 1));
          if (now - d.failedAt < backoff) return false;
        }
        return true;
      })
      .filter(this.#isInView ?? (() => true));

    if (sortTarget) {
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i].centroid;
        if (!c) { candidates[i]._sortDot = 0; continue; }
        const len = Math.sqrt(c.x * c.x + c.y * c.y + c.z * c.z);
        candidates[i]._sortDot = len > 0
          ? (c.x * sortTarget.x + c.y * sortTarget.y + c.z * sortTarget.z) / len
          : 0;
      }
      candidates.sort((a, b) => (b._sortDot ?? 0) - (a._sortDot ?? 0));
    }

    // Stuck-state recovery: if we have slots but zero candidates, check whether
    // all unloaded tiles are simply in backoff (not genuinely done). If so and
    // nothing has loaded in 20s, reset all backoffs and retry immediately.
    const STUCK_TIMEOUT_MS = 20_000;
    if (slots > 0 && candidates.length === 0) {
      const hasBackoffedTiles = tiles.some(
        (d) => !d.loading && !(d.obj && d.obj.parent) && d.failedAt !== undefined,
      );
      if (hasBackoffedTiles && performance.now() - this.#lastTileLoadedAt > STUCK_TIMEOUT_MS) {
        this.resetBackoff();
        return;
      }
    }

    candidates.slice(0, slots)
      .forEach((d) => {
        const { x, y, lng, lat, latLen } = d;
        const { gx } = gridDims(this.#level!, this.#isMercator);
        const lngLen = 360 / gx;
        if (!d.obj) {
          const width = lngLen * (1 - this.tileMargin);
          const height = latLen * (1 - this.tileMargin);
          const rotLng = deg2Rad(lng);
          const rotLat = deg2Rad(-lat);
          const tile = new Mesh(
            new SphereGeometry(
              this.#radius,
              Math.ceil(width / this.curvatureResolution),
              Math.ceil(height / this.curvatureResolution),
              deg2Rad(90 - width / 2) + rotLng,
              deg2Rad(width),
              deg2Rad(90 - height / 2) + rotLat,
              deg2Rad(height),
            ),
            this.#materialFactory(),
          );
          const tileMat = tile.material as Material;
          tile.renderOrder = this.#tileRenderOrder
            + (tileMat.transparent ? (this.#level ?? 0) : 0);
          if (this.#isMercator) {
            const yTop = 0.5 - (lat + latLen / 2) / 180;
            const yBot = 0.5 - (lat - latLen / 2) / 180;
            convertMercatorUV(tile.geometry.attributes.uv as BufferAttribute, yTop, yBot);
          }
          d.obj = tile;
          // Level-based depth priority: higher-level tiles pulled toward camera so they
          // win z-tests against lower-level fallback tiles at the same surface position.
          // Negative offset = toward camera in clip space. Level-N tile has factor=-N,
          // so level-3 beats level-0 (factor=0) wherever they overlap.
          const mat = tile.material as Material & {
            polygonOffset: boolean; polygonOffsetFactor: number; polygonOffsetUnits: number;
          };
          mat.polygonOffset = true;
          mat.polygonOffsetFactor = -(this.#level ?? 0);
          mat.polygonOffsetUnits = -(this.#level ?? 0);
        }

        d.loading = true;
        const ctrl = new AbortController();
        d.controller = ctrl;
        const timeoutId = setTimeout(() => {
          ctrl.abort();
          // createImageBitmap is not abortable. If d.loading is still set 2s after
          // the abort, the bitmap decode is hung — clean up so this tile can be retried.
          setTimeout(() => {
            if (d.loading && d.controller === ctrl) {
              if (d.obj) { deallocate(d.obj); delete d.obj; }
              d.loading = false;
              d.failedAt = performance.now();
              d.failCount = (d.failCount ?? 0) + 1;
              delete d.controller;
              this.#fetchNeededTiles();
            }
          }, 2_000);
        }, 15_000);
        const url = this.tileUrl!(x, y, this.#level!);
        const capturedLevel = this.#level!;

        fetch(url, { signal: ctrl.signal })
          .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.blob();
          })
          .then((blob) =>
            // Pre-flip so the bitmap has south at the top row. WebGL's UNPACK_FLIP_Y_WEBGL
            // does not apply to ImageBitmap (only to HTMLImageElement), so we must pre-flip
            // here and set texture.flipY=false to get the correct north-up orientation.
            createImageBitmap(blob, { imageOrientation: 'flipY' })
          )
          .then((bitmap) => {
            // Add to scene if level matches or tile is from a lower level (fallback).
            // Lower-level tiles that complete after a level jump serve as a visible backdrop
            // while the current level loads. Tiles from a higher level (user zoomed out) are
            // discarded — their level was already cleaned up by the level setter.
            clearTimeout(timeoutId);
            if (d.obj && capturedLevel <= (this.#level ?? 0)) {
              const texture = new Texture(bitmap as unknown as HTMLImageElement);
              texture.colorSpace = SRGBColorSpace;
              texture.flipY = false;  // bitmap is already oriented for WebGL; no second flip
              texture.needsUpdate = true;
              this.#applyTexture(d.obj.material as Material, texture);
              if (!d.obj.userData) d.obj.userData = {};
              (d.obj.userData as any).__lastVisibleAt = Date.now();
              this.add(d.obj);
              this.#lastTileLoadedAt = performance.now();
              this.#onTileLoaded?.(d.obj);
            }
            d.loading = false;
            delete d.controller;
            this.#fetchNeededTiles();
          })
          .catch((err) => {
            clearTimeout(timeoutId);
            if (err?.name === 'AbortError') {
              d.loading = false;
              delete d.controller;
            } else {
              if (d.obj) { deallocate(d.obj); delete d.obj; }
              d.loading = false;
              d.failedAt = performance.now();
              d.failCount = (d.failCount ?? 0) + 1;
              delete d.controller;
            }
            this.#fetchNeededTiles();
          });
      });
  }
}
