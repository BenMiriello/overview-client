import * as THREE from 'three';
import SlippyMapGlobe from '../vendor/SlippyMapGlobe';
import { createTiledPlanetEngine } from './tiledPlanetEngine';
import { getSunLatLng } from './astronomy';

const DAY_PATCH_FLAG = '__dayNightPatched';
const NIGHT_PATCH_FLAG = '__nightTilePatched';

export const sharedNightUniforms = {
  sunDir: { value: new THREE.Vector3(0, 1, 0) },
  cloudTex: { value: null as THREE.Texture | null },
  flashIntensity: { value: 0 },
  flashWorldPos: { value: new THREE.Vector3() },
  flashFalloff: { value: 15.0 },
};

/**
 * Updates the sun direction uniform using three-globe's polar2Cartesian convention.
 * +Z = lng=0 (prime meridian), +X = lng=90, y = up (north pole).
 */
export function updateSunDirection(date: Date): void {
  const [lng, lat] = getSunLatLng(date);
  const phi = (90 - lat) * Math.PI / 180;
  const theta = (90 - lng) * Math.PI / 180;
  sharedNightUniforms.sunDir.value.set(
    Math.sin(phi) * Math.cos(theta),
    Math.cos(phi),
    Math.sin(phi) * Math.sin(theta),
  ).normalize();
}

const NIGHT_FRAG_COMMON = `
  #define NIGHT_PI 3.141592653589793
  vec3 wp = normalize(vWorldPosition);
  float sunDot = dot(wp, sunDir);
  float nightFactor = 1.0 - smoothstep(-0.15, 0.1, sunDot);
`;

/**
 * Patches a day tile's material to darken the night side.
 * Works with MeshLambertMaterial and MeshPhongMaterial (both use the same
 * shader include hooks: worldpos_vertex and map_fragment).
 */
export function patchTileMaterial(material: THREE.Material): void {
  if (material.userData?.[DAY_PATCH_FLAG]) return;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.sunDir = sharedNightUniforms.sunDir;
    shader.uniforms.cloudTex = sharedNightUniforms.cloudTex;
    shader.uniforms.flashIntensity = sharedNightUniforms.flashIntensity;
    shader.uniforms.flashWorldPos = sharedNightUniforms.flashWorldPos;
    shader.uniforms.flashFalloff = sharedNightUniforms.flashFalloff;

    shader.vertexShader = 'varying vec3 vWorldPosition;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
      vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
    );

    shader.fragmentShader =
      `varying vec3 vWorldPosition;
      uniform vec3 sunDir;
      uniform sampler2D cloudTex;
      uniform float flashIntensity;
      uniform vec3 flashWorldPos;
      uniform float flashFalloff;\n` + shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      {
        ${NIGHT_FRAG_COMMON}
        float darkness = 0.88 * nightFactor;
        diffuseColor.rgb *= (1.0 - darkness);

        vec3 nPos = normalize(vWorldPosition);
        float lat = asin(clamp(nPos.y, -1.0, 1.0));
        vec2 cloudUv = vec2(
          fract(atan(nPos.z, -nPos.x) / 6.2831853),
          0.5 + lat / 3.1415927
        );

        vec3 cEastRaw = cross(vec3(0.0, 1.0, 0.0), nPos);
        float cEastLen = length(cEastRaw);
        vec3 cEast  = cEastLen > 0.001 ? cEastRaw / cEastLen : vec3(1.0, 0.0, 0.0);
        vec3 cNorth = cross(nPos, cEast);
        float cosLat = max(0.08, cEastLen);
        float sunE = dot(sunDir, cEast);
        float sunN = dot(sunDir, cNorth);
        vec2 sunUvOff = vec2(sunE / (cosLat * 6.2831853), sunN / 3.1415927) * 0.008;
        float cloudAlpha = texture2D(cloudTex, cloudUv + sunUvOff).a;
        float shadowDarken = cloudAlpha * 0.7 * (1.0 - nightFactor);
        diffuseColor.rgb *= (1.0 - shadowDarken);

        float flashDist = length(vWorldPosition - flashWorldPos);
        float groundFlash = flashIntensity * exp(-flashDist * flashDist * flashFalloff);
        diffuseColor.rgb += vec3(0.8, 0.85, 1.0) * groundFlash * 0.7;
      }`,
    );
  };

  const matType = (material as any).isMeshPhongMaterial ? 'phong' : 'lambert';
  material.customProgramCacheKey = () => `daynight-day-${matType}-v4`;
  if (!material.userData) material.userData = {};
  material.userData[DAY_PATCH_FLAG] = true;
  material.needsUpdate = true;
}

/**
 * Patches a GIBS night tile's MeshLambertMaterial to fade on the day side.
 * Material is also set to additive blending + no depth write.
 */
export function patchNightTileMaterial(material: THREE.MeshLambertMaterial): void {
  if (material.userData?.[NIGHT_PATCH_FLAG]) return;

  material.depthWrite = false;
  material.depthTest = false;
  material.transparent = true;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.sunDir = sharedNightUniforms.sunDir;

    shader.vertexShader = 'varying vec3 vWorldPosition;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
      vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
    );

    shader.fragmentShader =
      `varying vec3 vWorldPosition;
      uniform vec3 sunDir;\n` + shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      {
        ${NIGHT_FRAG_COMMON}
        diffuseColor.a *= nightFactor;
      }`,
    );
  };

  material.customProgramCacheKey = () => 'daynight-night-v1';
  if (!material.userData) material.userData = {};
  material.userData[NIGHT_PATCH_FLAG] = true;
  material.needsUpdate = true;
}

const ARCGIS_URL = (x: number, y: number, level: number) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${level}/${y}/${x}`;

const GIBS_URL = (x: number, y: number, level: number) =>
  `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/${level}/${y}/${x}.png`;

/**
 * Creates a tile engine for ArcGIS day tiles. Tiles are patched with the
 * day/night darkening shader at material creation time — no 1-frame flash.
 */
// Threshold table targeting ~85% of pixel-matched resolution for FOV=50, 1080p.
// The upstream default (8/2^i) is ~3.5x too conservative, yielding tiles 2 levels
// below what the screen can display.
const TILE_THRESHOLDS = [...new Array(30)].map((_, i) => 24 / Math.pow(2, i));

export function createDayTileEngine(radius: number): SlippyMapGlobe {
  const engine = createTiledPlanetEngine({
    radius,
    tileUrl: ARCGIS_URL,
    maxLevel: 17,
    projection: 'mercator',
    patchMaterial: patchTileMaterial,
  });
  engine.thresholds = TILE_THRESHOLDS;
  // Show the inner back layer (black sphere at 0.99*radius). The factory hides
  // it, but the day engine is the only visible surface — gaps between tile patches
  // must show black, not transparent (which would reveal the scene background).
  engine.children.forEach((child) => {
    const m = child as THREE.Mesh;
    if (m.isMesh && (m.material as THREE.Material & { isMeshBasicMaterial?: boolean })?.isMeshBasicMaterial) {
      m.visible = true;
    }
  });
  return engine;
}

/**
 * Creates a tile engine for GIBS Black Marble night tiles. Tiles are patched
 * with the night-side fade shader at material creation time so there is no
 * unpatched-flash on the first frame after a tile loads.
 */
export function createNightTileEngine(radius: number): SlippyMapGlobe {
  const engine = createTiledPlanetEngine({
    radius,
    tileUrl: GIBS_URL,
    maxLevel: 8,
    projection: 'mercator',
    patchMaterial: patchNightTileMaterial,
  });
  engine.thresholds = TILE_THRESHOLDS;
  return engine;
}
