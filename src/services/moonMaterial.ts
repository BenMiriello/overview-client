/**
 * Material patches for moon tile layers.
 *
 *   - patchMoonColorTileMaterial: hard-terminator Lambertian shading using
 *     the real-time sun direction (matches the legacy moon shader). Bypasses
 *     the stock MeshLambertMaterial lighting accumulation.
 *   - patchMoonReliefTileMaterial: multiplicative overlay so LRO LOLA shaded
 *     relief darkens crater walls atop the color layer. Strength is muted
 *     so the bake's fixed-sun direction is not jarring.
 *
 * Both patches replace `vec3 outgoingLight = ...` rather than overriding the
 * `<opaque_fragment>` chunk, so the standard tonemapping/colorspace chain
 * still runs after our value. Materials also disable tone mapping so the
 * day↔night dynamic range is preserved through the output transform.
 */

import * as THREE from 'three';
import { sharedNightUniforms } from './dayNightMaterial';

const COLOR_PATCH_FLAG = '__moonColorPatched';
const RELIEF_PATCH_FLAG = '__moonReliefPatched';

const MOON_AMBIENT = 0.04;
const RELIEF_STRENGTH = 0.55;

const OUTGOING_LIGHT_LINE =
  'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;';

/**
 * Color tile: hard-terminator lighting from sharedNightUniforms.sunDir.
 * Tiles are children of the moon Group (which is rotated for tidal locking +
 * libration), so the world-space normal already incorporates that orientation.
 */
export function patchMoonColorTileMaterial(material: THREE.MeshLambertMaterial): void {
  if (material.userData?.[COLOR_PATCH_FLAG]) return;

  material.toneMapped = false;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.sunDir = sharedNightUniforms.sunDir;
    shader.uniforms.uMoonAmbient = { value: MOON_AMBIENT };

    shader.vertexShader = 'varying vec3 vMoonNormal;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>
      vMoonNormal = normalize(mat3(modelMatrix) * normal);`,
    );

    shader.fragmentShader =
      `varying vec3 vMoonNormal;
      uniform vec3 sunDir;
      uniform float uMoonAmbient;\n` + shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace(
      OUTGOING_LIGHT_LINE,
      `float moonLight = max(0.0, dot(vMoonNormal, sunDir));
       float moonShade = uMoonAmbient + (1.0 - uMoonAmbient) * moonLight;
       vec3 outgoingLight = diffuseColor.rgb * moonShade;`,
    );
  };

  material.customProgramCacheKey = () => 'moon-color-v2';
  if (!material.userData) material.userData = {};
  material.userData[COLOR_PATCH_FLAG] = true;
  material.needsUpdate = true;
}

/**
 * Relief tile: multiplicative overlay. The shaded relief is grayscale, so we
 * use it as a darkening factor. We also fade the relief strength on the
 * night side so the multiplicative tile doesn't lighten the dark hemisphere.
 *
 * The relief engine is rendered on a slightly larger sphere (see moonMesh.ts)
 * to avoid z-fighting with the color layer — no polygonOffset needed.
 */
export function patchMoonReliefTileMaterial(material: THREE.MeshLambertMaterial): void {
  if (material.userData?.[RELIEF_PATCH_FLAG]) return;

  material.toneMapped = false;
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.MultiplyBlending;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.sunDir = sharedNightUniforms.sunDir;
    shader.uniforms.uReliefStrength = { value: RELIEF_STRENGTH };

    shader.vertexShader = 'varying vec3 vMoonNormal;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>
      vMoonNormal = normalize(mat3(modelMatrix) * normal);`,
    );

    shader.fragmentShader =
      `varying vec3 vMoonNormal;
      uniform vec3 sunDir;
      uniform float uReliefStrength;\n` + shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace(
      OUTGOING_LIGHT_LINE,
      `float reliefSunDot = dot(vMoonNormal, sunDir);
       float reliefDayMask = smoothstep(-0.05, 0.15, reliefSunDot);
       vec3 reliefFactor = mix(vec3(1.0), diffuseColor.rgb, uReliefStrength * reliefDayMask);
       vec3 outgoingLight = reliefFactor;`,
    );
  };

  material.customProgramCacheKey = () => 'moon-relief-v2';
  if (!material.userData) material.userData = {};
  material.userData[RELIEF_PATCH_FLAG] = true;
  material.needsUpdate = true;
}
