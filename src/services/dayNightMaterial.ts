import * as THREE from 'three';
import SlippyMap from 'three-slippy-map-globe';
import { getSunLatLng } from './astronomy';

const DAY_PATCH_FLAG = '__dayNightPatched';
const NIGHT_PATCH_FLAG = '__nightTilePatched';

export const sharedNightUniforms = {
  sunDir: { value: new THREE.Vector3(0, 1, 0) },
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
        float darkness = 0.88 * nightFactor;
        diffuseColor.rgb *= (1.0 - darkness);
      }`,
    );
  };

  material.customProgramCacheKey = () => 'daynight-day-v1';
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
 * Creates a standalone SlippyMap tile engine for GIBS Black Marble night tiles.
 */
export function createNightTileEngine(radius: number): InstanceType<typeof SlippyMap> {
  const engine = new SlippyMap(radius, {
    tileUrl: GIBS_URL,
    maxLevel: 8,
  });

  // Hide the inner black sphere created by SlippyMap
  engine.children.forEach((child: any) => {
    if (child.isMesh && child.material?.isMeshBasicMaterial) {
      child.visible = false;
    }
  });

  // Patch tiles the instant they're added — prevents 1-frame unpatched flash
  const originalAdd = engine.add.bind(engine);
  engine.add = (...objects: any[]) => {
    for (const obj of objects) {
      if (obj.isMesh && obj.material?.isMeshLambertMaterial) {
        patchNightTileMaterial(obj.material);
      }
      if (obj.isMesh && obj.material?.isMeshBasicMaterial) {
        obj.visible = false;
      }
    }
    return originalAdd(...objects);
  };

  return engine;
}
