/**
 * Moon tile materials.
 *
 * Topography is rendered by real vertex displacement: each tile's sphere
 * patch is subdivided into a dense mesh and every vertex is pushed outward
 * (or inward) along its radial normal by the DEM sample. Crater silhouettes
 * become geometrically real — visible from any viewing angle.
 *
 * LOD-mixing handling: while zoomed in, lower-level fallback tiles stay
 * in the scene graph as visual backdrop. If those fallback tiles also
 * displaced using their own (coarse) DEM, they'd disagree geometrically
 * with the finer current-level tiles and cause z-fighting. Instead, any
 * tile whose level != the engine's current level is shifted inward by a
 * full elevation range — strictly beyond the deepest possible current-
 * level displacement — so fallback geometry is guaranteed to sit behind
 * every current-level vertex regardless of DEM value.
 *
 * Uniforms controlling displacement:
 *   - uHasDem: set once the tile's DEM texture has been bound.
 *   - uElevationRange: peak-to-trough elevation in scene units. Per-planet.
 *   - uDisplacementScale: exaggeration multiplier. 1.0 = physically accurate.
 *   - uDisplacementBias: DEM value that maps to zero displacement.
 *       For LOLA 8-bit DEMs, ~0.5 treats 128/255 as mean radius.
 *   - uTileLevel / uEngineLevel: tile's own level vs the engine's current
 *       level. Equal → full displacement. Unequal → inward shift only.
 *
 * Fragment stage samples the LRO WAC color mosaic. The DEM is used only
 * for geometric displacement (vertex stage); its values never appear in
 * the final pixel color. Lighting is a simple Lambertian sun dot against
 * the sphere normal — crater shadowing will improve once we add
 * per-fragment gradient normals in a follow-up.
 */

import * as THREE from 'three';
import { MOON_RADIUS_SCENE } from './astronomy';
import { sharedNightUniforms } from './dayNightMaterial';

const MOON_AMBIENT = 0.04;
const MOON_BRIGHTNESS = 1.7;
// Peak-to-trough elevation range on the Moon, in scene units. Derived from
// the ~20km physical range and the project's km→scene ratio.
const MOON_ELEVATION_RANGE_SCENE = MOON_RADIUS_SCENE * (20.0 / 1737.4);
// 1.0 = physically accurate (barely visible at typical viewing distance).
// Bump above 1.0 to exaggerate crater silhouettes.
const MOON_DISPLACEMENT_SCALE = 1.0;
const MOON_DISPLACEMENT_BIAS = 0.5;

/**
 * Shared uniform ref holding the moon engine's currently-active LOD level.
 * Every moon tile material reads this same object, so updating .value
 * propagates to all tiles in a single assignment. The moonMesh render
 * hook keeps it in sync with colorEngine.level each frame.
 */
export const moonEngineLevelRef = { value: 0 };

const MOON_VERTEX = /* glsl */ `
  uniform sampler2D demMap;
  uniform bool uHasDem;
  uniform float uElevationRange;
  uniform float uDisplacementScale;
  uniform float uDisplacementBias;
  uniform float uTileLevel;
  uniform float uEngineLevel;
  varying vec2 vUv;
  varying vec3 vWorldNormal;

  void main() {
    vUv = uv;
    vec3 displacedPos = position;
    if (uHasDem) {
      float h = texture2D(demMap, uv).r;
      float fullRange = uElevationRange * uDisplacementScale;
      float d;
      // Fallback tiles (not at current engine level) shift inward by one
      // full elevation range. A current-level tile's deepest possible
      // vertex reaches only -uDisplacementBias * fullRange (= -0.5 * fullRange
      // with default bias), so -fullRange leaves a 0.5*fullRange margin —
      // strictly behind anything a current-level tile could reach. No
      // z-fighting with the detailed current-level geometry.
      if (abs(uTileLevel - uEngineLevel) < 0.5) {
        d = (h - uDisplacementBias) * fullRange;
      } else {
        d = -fullRange;
      }
      displacedPos += normalize(position) * d;
    }
    // Sphere normal (pre-displacement) — fine for diagnostic shading.
    // Per-fragment gradient-based normals come in the next pass.
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displacedPos, 1.0);
  }
`;

const MOON_COLOR_FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 sunDir;
  uniform float uAmbient;
  uniform float uBrightness;
  varying vec2 vUv;
  varying vec3 vWorldNormal;

  void main() {
    float macroLight = max(0.0, dot(normalize(vWorldNormal), sunDir));
    float shade = uAmbient + (1.0 - uAmbient) * macroLight;
    vec4 tex = texture2D(map, vUv);
    vec3 rgb = tex.rgb * shade * uBrightness;
    gl_FragColor = linearToOutputTexel(vec4(rgb, 1.0));
  }
`;

export function createMoonColorMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: MOON_VERTEX,
    fragmentShader: MOON_COLOR_FRAGMENT,
    uniforms: {
      map: { value: null },
      demMap: { value: null },
      uHasDem: { value: false },
      uElevationRange: { value: MOON_ELEVATION_RANGE_SCENE },
      uDisplacementScale: { value: MOON_DISPLACEMENT_SCALE },
      uDisplacementBias: { value: MOON_DISPLACEMENT_BIAS },
      uTileLevel: { value: -1 },
      uEngineLevel: moonEngineLevelRef,
      sunDir: sharedNightUniforms.sunDir,
      uAmbient: { value: MOON_AMBIENT },
      uBrightness: { value: MOON_BRIGHTNESS },
    },
    // transparent:true is required so the moon renders in the transparent
    // pass *after* the atmosphere (which uses depthTest:false and needs
    // solid bodies to overdraw it — see renderLayers.ts). depthWrite and
    // depthTest stay on so the moon correctly occludes other geometry.
    transparent: true,
    depthWrite: true,
    depthTest: true,
  });
}

/**
 * Bind a loaded DEM tile texture into a moon color material's `demMap`
 * uniform and record the tile's level. Both must be set before flipping
 * uHasDem so the vertex shader never sees an inconsistent state.
 */
export function applyDemToMoonMaterial(
  material: THREE.ShaderMaterial,
  texture: THREE.Texture,
  tileLevel: number,
): void {
  texture.colorSpace = THREE.NoColorSpace;
  material.uniforms.demMap.value = texture;
  material.uniforms.uTileLevel.value = tileLevel;
  material.uniforms.uHasDem.value = true;
}

/**
 * Texture binder for moon color tiles. Used by SlippyMapGlobe's tile
 * loader to attach a freshly-loaded tile texture to the material's `map` uniform.
 */
export function applyMoonTileTexture(material: THREE.Material, texture: THREE.Texture): void {
  const mat = material as THREE.ShaderMaterial;
  mat.uniforms.map.value = texture;
}
