import * as THREE from 'three';
import { MOON_RADIUS_SCENE, getMoonPosition, getMoonLibration, CELESTIAL_NORTH_SCENE } from './astronomy';
import SlippyMapGlobe from '../vendor/SlippyMapGlobe';
import { createTiledPlanetEngine } from './tiledPlanetEngine';
import {
  createMoonColorMaterial,
  createMoonReliefMaterial,
  applyMoonTileTexture,
} from './moonMaterial';
import { LAYERS } from './renderLayers';

const RELIEF_OFFSET = 1.0008;

// NASA Moon Trek WMTS — equirectangular projection.
// LRO WAC global mosaic, 303ppd v02 (color/grayscale photographic).
const MOON_COLOR_URL = (x: number, y: number, level: number): string =>
  `https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/${level}/${y}/${x}.jpg`;

// LRO LOLA global shaded relief, 128ppd v04 — high-frequency surface detail
// for crater rims, multiplied over the color layer.
const MOON_RELIEF_URL = (x: number, y: number, level: number): string =>
  `https://trek.nasa.gov/tiles/Moon/EQ/LRO_LOLA_Shade_Global_128ppd_v04/1.0.0/default/default028mm/${level}/${y}/${x}.jpg`;

const MOON_COLOR_MAX_LEVEL = 7;
const MOON_RELIEF_MAX_LEVEL = 6;

export interface MoonGroup extends THREE.Group {
  colorEngine: SlippyMapGlobe;
  reliefEngine: SlippyMapGlobe;
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
  });
  group.add(colorEngine);

  const reliefEngine = createTiledPlanetEngine({
    radius: MOON_RADIUS_SCENE,
    tileUrl: MOON_RELIEF_URL,
    maxLevel: MOON_RELIEF_MAX_LEVEL,
    projection: 'equirectangular',
    materialFactory: createMoonReliefMaterial,
    applyTexture: applyMoonTileTexture,
    tileRenderOrder: LAYERS.MOON_RELIEF,
  });
  // Offset slightly outward to avoid z-fighting with the color sphere.
  reliefEngine.scale.setScalar(RELIEF_OFFSET);
  group.add(reliefEngine);

  group.colorEngine = colorEngine;
  group.reliefEngine = reliefEngine;
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
  // Base orientation: look from moon center toward Earth (origin), so local +Z
  // ends up pointing at Earth. SlippyMapGlobe's polar2Cartesian convention
  // puts lng=0,lat=0 at +Z, so this is exactly the sub-earth point we want.
  _tmpEye.copy(mesh.position);
  _tmpM.lookAt(new THREE.Vector3(0, 0, 0), _tmpEye, CELESTIAL_NORTH_SCENE);
  mesh.quaternion.setFromRotationMatrix(_tmpM);

  // Libration: rotate by the negative wobble so the offset sub-earth point
  // ends up coincident with the +Z axis from Earth's perspective.
  const { elon, elat } = getMoonLibration(date);
  const lonRad = -elon * Math.PI / 180;
  const latRad = -elat * Math.PI / 180;
  _tmpLibQuat.setFromAxisAngle(_tmpAxisY, lonRad);
  mesh.quaternion.multiply(_tmpLibQuat);
  _tmpLibQuat.setFromAxisAngle(_tmpAxisX, latRad);
  mesh.quaternion.multiply(_tmpLibQuat);
}
