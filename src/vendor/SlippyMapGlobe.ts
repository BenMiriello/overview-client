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
  TextureLoader,
  SRGBColorSpace,
  Material,
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
  /** Optional callback fired after a tile's texture loads and it joins the scene graph. */
  onTileLoaded?: (tile: Mesh) => void;
  /** Render order assigned to every tile mesh as it's created. Defaults to 0. */
  tileRenderOrder?: number;
}

interface TileMeta {
  x: number;
  y: number;
  lng: number;
  lat: number;
  latLen: number;
  centroid?: { x: number; y: number; z: number };
  hullPnts?: Vector3[];
  obj?: Mesh;
  loading?: boolean;
}

interface TileMetaLevel extends Array<TileMeta> {
  octree?: ReturnType<typeof octree>;
  record?: Record<string, TileMeta>;
}

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
const TILE_SEARCH_RADIUS_CAMERA_DISTANCE = 3;
const TILE_SEARCH_RADIUS_SURFACE_DISTANCE = 90;

export default class SlippyMapGlobe extends Group {
  // Public attributes (matching upstream API)
  minLevel: number;
  maxLevel: number;
  thresholds: number[] = [...new Array(30)].map((_, idx) => 8 / Math.pow(2, idx));
  /** Resolution of tile sphere subdivision in degrees. */
  curvatureResolution = 5;
  /** Tile shrink factor (0–1) — used to leave gaps between tiles for debugging. */
  tileMargin = 0;

  #radius: number;
  #isMercator: boolean;
  #tileUrl?: TileUrlFn;
  #materialFactory: () => Material;
  #onTileLoaded?: (tile: Mesh) => void;
  #tileRenderOrder: number;
  #level?: number;
  #tilesMeta: Record<number, TileMetaLevel> = {};
  #isInView?: (d: TileMeta) => boolean;
  #camera?: Camera;
  #innerBackLayer: Mesh;

  constructor(radius: number, opts: SlippyMapOptions = {}) {
    super();
    const {
      tileUrl,
      minLevel = 0,
      maxLevel = 17,
      mercatorProjection = true,
      materialFactory = () => new MeshLambertMaterial(),
      onTileLoaded,
      tileRenderOrder = 0,
    } = opts;

    this.#radius = radius;
    this.#isMercator = mercatorProjection;
    this.#materialFactory = materialFactory;
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

    this.#innerBackLayer.visible = level > 0;

    // Bring active layer to front
    this.#tilesMeta[level].forEach((d) => {
      if (d.obj) (d.obj.material as Material & { depthWrite: boolean }).depthWrite = true;
    });
    // Push lower layers to background
    if (prevLevel < level) {
      this.#tilesMeta[prevLevel].forEach((d) => {
        if (d.obj) (d.obj.material as Material & { depthWrite: boolean }).depthWrite = false;
      });
    }
    // Remove upper layers
    if (prevLevel > level) {
      for (let l = level + 1; l <= prevLevel; l++) {
        this.#tilesMeta[l]?.forEach((d) => {
          if (d.obj) {
            this.remove(d.obj);
            emptyObject(d.obj);
            delete d.obj;
          }
        });
      }
    }
    this.#fetchNeededTiles();
  }

  clearTiles = (): void => {
    Object.values(this.#tilesMeta).forEach((l) => {
      l.forEach((d) => {
        if (d.obj) {
          this.remove(d.obj);
          emptyObject(d.obj);
          delete d.obj;
        }
      });
    });
    this.#tilesMeta = {};
  };

  updatePov(camera: Camera): void {
    if (!camera || !(camera instanceof Camera)) return;
    this.#camera = camera;

    let frustum: Frustum | undefined;
    this.#isInView = (d: TileMeta): boolean => {
      if (!d.hullPnts) {
        const { gx } = gridDims(this.level, this.#isMercator);
        const lngLen = 360 / gx;
        const { lng, lat, latLen } = d;
        const lng0 = lng - lngLen / 2;
        const lng1 = lng + lngLen / 2;
        const lat0 = lat - latLen / 2;
        const lat1 = lat + latLen / 2;
        d.hullPnts = ([
          [lat, lng],
          [lat0, lng0],
          [lat1, lng0],
          [lat0, lng1],
          [lat1, lng1],
        ] as [number, number][])
          .map(([la, ln]) => polar2Cartesian(la, ln, this.#radius))
          .map(({ x, y, z }) => new Vector3(x, y, z));
      }
      if (!frustum) {
        frustum = new Frustum();
        camera.updateMatrix();
        camera.updateMatrixWorld();
        frustum.setFromProjectionMatrix(
          new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
        );
      }
      return d.hullPnts.some((pos) => frustum!.containsPoint(pos.clone().applyMatrix4(this.matrixWorld)));
    };

    if (this.tileUrl) {
      const pov = camera.position.clone();
      const distToGlobeCenter = pov.distanceTo(this.getWorldPosition(new Vector3()));
      const cameraDistance = (distToGlobeCenter - this.#radius) / this.#radius;
      const idx = this.thresholds.findIndex((t) => t && t <= cameraDistance);
      this.level = Math.min(this.maxLevel, Math.max(this.minLevel, idx < 0 ? this.thresholds.length : idx));
      this.#fetchNeededTiles();
    }
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

  #fetchNeededTiles(): void {
    if (!this.tileUrl || this.#level === undefined || !this.#tilesMeta[this.#level]) return;
    const renderAllCap = this.#isMercator
      ? MAX_LEVEL_TO_RENDER_ALL_TILES_MERCATOR
      : MAX_LEVEL_TO_RENDER_ALL_TILES_EQUIRECT;
    if (!this.#isInView && this.#level > renderAllCap) return;

    let tiles: TileMeta[] = this.#tilesMeta[this.#level];

    if (this.#camera) {
      const povPos = this.worldToLocal(this.#camera.position.clone());
      const fullLevel = this.#tilesMeta[this.#level];
      if (fullLevel.octree) {
        const searchRadius = (povPos.length() - this.#radius) * TILE_SEARCH_RADIUS_CAMERA_DISTANCE;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tiles = (fullLevel.octree as any).findAllWithinRadius(povPos.x, povPos.y, povPos.z, searchRadius);
      } else {
        // Tiles populated dynamically (high-level path)
        const povCoords = cartesian2Polar(povPos);
        const searchRadiusLat = (povCoords.r / this.#radius - 1) * TILE_SEARCH_RADIUS_SURFACE_DISTANCE;
        const searchRadiusLng = searchRadiusLat / Math.cos(deg2Rad(povCoords.lat));
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
                fullLevel.push(r[k]);
              }
              selTiles.push(r[k]);
            }
          }
          tiles = selTiles;
        }
      }
    }

    tiles
      .filter((d) => !d.obj)
      .filter(this.#isInView ?? (() => true))
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
          tile.renderOrder = this.#tileRenderOrder;
          if (this.#isMercator) {
            const yTop = 0.5 - (lat + latLen / 2) / 180;
            const yBot = 0.5 - (lat - latLen / 2) / 180;
            convertMercatorUV(tile.geometry.attributes.uv as BufferAttribute, yTop, yBot);
          }
          d.obj = tile;
        }
        if (!d.loading) {
          d.loading = true;
          new TextureLoader().load(this.tileUrl!(x, y, this.#level!), (texture) => {
            const tile = d.obj;
            if (tile) {
              texture.colorSpace = SRGBColorSpace;
              const mat = tile.material as Material & {
                map?: typeof texture;
                color?: unknown;
                needsUpdate: boolean;
              };
              mat.map = texture;
              mat.color = null;
              mat.needsUpdate = true;
              this.add(tile);
              this.#onTileLoaded?.(tile);
            }
            d.loading = false;
          });
        }
      });
  }
}
