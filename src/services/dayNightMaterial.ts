import * as THREE from 'three';
import SlippyMapGlobe from '../vendor/SlippyMapGlobe';
import { createTiledPlanetEngine } from './tiledPlanetEngine';
import { getSunLatLng } from './astronomy';

const DAY_PATCH_FLAG = '__dayNightPatched';
const NIGHT_PATCH_FLAG = '__nightTilePatched';

export const sharedNightUniforms = {
  sunDir: { value: new THREE.Vector3(0, 1, 0) },
  cloudTex: { value: null as THREE.Texture | null },
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
 * Patches a day tile's MeshLambertMaterial to darken the night side.
 */
export function patchTileMaterial(material: THREE.MeshLambertMaterial): void {
  if (material.userData?.[DAY_PATCH_FLAG]) return;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.sunDir = sharedNightUniforms.sunDir;
    shader.uniforms.cloudTex = sharedNightUniforms.cloudTex;

    shader.vertexShader = 'varying vec3 vWorldPosition;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
      vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
    );

    shader.fragmentShader =
      `varying vec3 vWorldPosition;
      uniform vec3 sunDir;
      uniform sampler2D cloudTex;\n` + shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      {
        ${NIGHT_FRAG_COMMON}
        float darkness = 0.88 * nightFactor;
        diffuseColor.rgb *= (1.0 - darkness);

        vec3 nPos = normalize(vWorldPosition);
        float lat = asin(clamp(nPos.y, -1.0, 1.0));
        float lng = atan(nPos.x, nPos.z);
        vec2 cloudUv = vec2(lng / 6.2831853 + 0.5, 0.5 - lat / 3.1415927);
        float cloudAlpha = texture2D(cloudTex, cloudUv).a;
        float shadowDarken = cloudAlpha * 0.35 * (1.0 - nightFactor);
        diffuseColor.rgb *= (1.0 - shadowDarken);
      }`,
    );
  };

  material.customProgramCacheKey = () => 'daynight-day-v2';
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

const GIBS_URL = (x: number, y: number, level: number) =>
  `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/${level}/${y}/${x}.png`;

/**
 * Creates a tile engine for GIBS Black Marble night tiles. Tiles are patched
 * with the night-side fade shader at material creation time so there is no
 * unpatched-flash on the first frame after a tile loads.
 */
export function createNightTileEngine(radius: number): SlippyMapGlobe {
  return createTiledPlanetEngine({
    radius,
    tileUrl: GIBS_URL,
    maxLevel: 8,
    projection: 'mercator',
    patchMaterial: patchNightTileMaterial,
  });
}
