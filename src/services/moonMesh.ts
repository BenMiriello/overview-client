import * as THREE from 'three';
import { MOON_RADIUS_SCENE, getMoonPosition, getMoonLibration, CELESTIAL_NORTH_SCENE } from './astronomy';
import SlippyMapGlobe from '../vendor/SlippyMapGlobe';
import { createTiledPlanetEngine } from './tiledPlanetEngine';
import {
  createMoonColorMaterial,
  applyMoonTileTexture,
  applyDemToMoonMaterial,
  moonEngineLevelRef,
} from './moonMaterial';
import { LAYERS } from './renderLayers';

// NASA Moon Trek WMTS — equirectangular projection.
const MOON_COLOR_URL = (x: number, y: number, level: number): string =>
  `https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/${level}/${y}/${x}.jpg`;

const MOON_DEM_URL = (x: number, y: number, level: number): string =>
  `https://trek.nasa.gov/tiles/Moon/EQ/LRO_LOLA_DEM_Global_128ppd_v04/1.0.0/default/default028mm/${level}/${y}/${x}.png`;

// DIAGNOSTIC: color max temporarily lowered to match DEM max so the zoom
// level can't exceed where DEM data exists. Lets the user evaluate whether
// level-5 LOLA DEM (~660m/texel) has enough fidelity to resolve real
// topography before we invest in a rendering approach.
const MOON_COLOR_MAX_LEVEL = 5;
const MOON_DEM_MAX_LEVEL = 5;

export interface MoonGroup extends THREE.Group {
  colorEngine: SlippyMapGlobe;
}

/**
 * Fetch the DEM tile corresponding to a color tile and bind it to the
 * tile's material. For color levels above the DEM max, no DEM is loaded
 * (the shader falls back to flat shading via the uHasDem guard).
 */
function fetchDemForTile(tile: THREE.Mesh): void {
  const ud = tile.userData as Record<string, number>;
  const level = ud.__tileLevel;
  const x = ud.__tileX;
  const y = ud.__tileY;
  if (level == null || level > MOON_DEM_MAX_LEVEL) return;

  const url = MOON_DEM_URL(x, y, level);
  fetch(url)
    .then(r => {
      if (!r.ok) throw new Error(`DEM ${r.status}`);
      return r.blob();
    })
    .then(blob => createImageBitmap(blob, { imageOrientation: 'flipY' }))
    .then(bitmap => {
      const texture = new THREE.Texture(bitmap as unknown as HTMLImageElement);
      texture.flipY = false;
      texture.needsUpdate = true;
      applyDemToMoonMaterial(tile.material as THREE.ShaderMaterial, texture, level, y);
      console.log(`[DEM] bound tile ${level}/${y}/${x}`);
    })
    .catch((err) => { console.warn(`[DEM] failed ${level}/${y}/${x}:`, err); });
}

export function createMoonMesh(): MoonGroup {
  const group = new THREE.Group() as MoonGroup;
  group.name = 'moon';
  group.renderOrder = LAYERS.MOON_SURFACE;

  const colorEngine = createTiledPlanetEngine({
    radius: MOON_RADIUS_SCENE,
    tileUrl: MOON_COLOR_URL,
    maxLevel: MOON_COLOR_MAX_LEVEL,
    projection: 'equirectangular',
    materialFactory: createMoonColorMaterial,
    applyTexture: applyMoonTileTexture,
    tileRenderOrder: LAYERS.MOON_SURFACE,
    onTileLoaded: fetchDemForTile,
  });
  // Finer tile subdivision than the 5° default: vertex displacement needs
  // enough vertices per tile for crater-scale features to deform the
  // silhouette. At 0.5° a level-5 tile (≈5.6° span) gets ~12 segments
  // per edge, which resolves large craters cleanly without blowing up
  // total vertex count.
  colorEngine.curvatureResolution = 0.5;
  // Keep the shared uniform in sync with the engine's current LOD level.
  // Non-current tiles read this to know they're fallbacks and should shift
  // inward instead of displacing. We can't use onBeforeRender here —
  // SlippyMapGlobe extends THREE.Group, and three.js only dispatches
  // onBeforeRender on renderable objects (Mesh/Line/Points/Sprite). Wrap
  // updatePov instead: it's called every frame from the main tick loop and
  // is the canonical entry point through which `level` changes.
  const origUpdatePov = colorEngine.updatePov.bind(colorEngine);
  colorEngine.updatePov = (camera, forceFetch) => {
    origUpdatePov(camera, forceFetch);
    moonEngineLevelRef.value = colorEngine.level;
  };
  group.add(colorEngine);

  group.colorEngine = colorEngine;
  return group;
}

export function updateMoonPosition(mesh: THREE.Object3D, date: Date): void {
  const pos = getMoonPosition(date);
  mesh.position.copy(pos);
}

/**
 * Orient the moon so its near side faces Earth (tidal locking), with libration
 * wobble applied. Earth is at scene origin. NASA Trek's equirectangular tiling
 * places lng=0 along the mesh's local +Z axis (per polar2Cartesian convention
 * inside SlippyMapGlobe), so the prime meridian — and the center of the
 * Earth-facing near side — should end up pointing toward Earth.
 */
const _tmpM = new THREE.Matrix4();
const _tmpEye = new THREE.Vector3();
const _tmpLibQuat = new THREE.Quaternion();
const _tmpAxisY = new THREE.Vector3(0, 1, 0);
const _tmpAxisX = new THREE.Vector3(1, 0, 0);

export function updateMoonOrientation(mesh: THREE.Object3D, date: Date): void {
  _tmpEye.copy(mesh.position);
  _tmpM.lookAt(new THREE.Vector3(0, 0, 0), _tmpEye, CELESTIAL_NORTH_SCENE);
  mesh.quaternion.setFromRotationMatrix(_tmpM);

  const { elon, elat } = getMoonLibration(date);
  const lonRad = -elon * Math.PI / 180;
  const latRad = -elat * Math.PI / 180;
  _tmpLibQuat.setFromAxisAngle(_tmpAxisY, lonRad);
  mesh.quaternion.multiply(_tmpLibQuat);
  _tmpLibQuat.setFromAxisAngle(_tmpAxisX, latRad);
  mesh.quaternion.multiply(_tmpLibQuat);
}
