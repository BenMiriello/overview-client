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
 * Fragment stage samples the LRO WAC color mosaic for albedo and samples
 * the DEM a second time at four neighbouring texels to reconstruct a
 * per-pixel surface normal from the height gradient. Lighting uses that
 * bumped normal so crater rims show directional shadowing even though the
 * underlying mesh is only subdivided to ~0.5°. Vertex displacement still
 * carries the silhouette; per-fragment gradients carry the shading.
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
  varying vec3 vWorldPole;

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
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    // Forward the world-space moon pole so the fragment stage can build a
    // per-pixel (east, north) tangent basis. three.js raw ShaderMaterial
    // only injects modelMatrix into the vertex stage, not the fragment
    // stage, so we can't reconstruct this downstream.
    vWorldPole = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, 0.0));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displacedPos, 1.0);
  }
`;

// Sun shading is computed against a per-fragment normal reconstructed from
// the DEM gradient. The vertex mesh already deforms the silhouette; here we
// add the micro-shading that makes craters read as three-dimensional instead
// of a painted texture on a smooth sphere.
//
// Tangent basis: the moon's local +Y is its spin axis (north pole). The
// vertex stage rotates it into world space via modelMatrix (not available
// as a built-in uniform in the fragment stage here) and forwards it as
// vWorldPole. cross with the sphere normal yields east, cross again yields
// north. Signs match SphereGeometry's UV convention (+u = east) and the
// flipY-decoded tile orientation (+v = north) used by SlippyMapGlobe.
//
// Height gradient: 4-tap central difference in UV space. uDemTexelSize is
// 1/demDims (pixel-spacing in UV). uTileWorldUV is the world distance per
// UV unit along east (x) and north (y), precomputed per-tile on the CPU from
// tile level and latitude (horizontal scale shrinks with cos(lat)).
const MOON_COLOR_FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform sampler2D demMap;
  uniform bool uHasDem;
  uniform float uElevationRange;
  uniform float uDisplacementScale;
  uniform vec2 uDemTexelSize;
  uniform vec2 uTileWorldUV;
  uniform vec3 sunDir;
  uniform float uAmbient;
  uniform float uBrightness;
  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPole;

  void main() {
    vec3 N0 = normalize(vWorldNormal);
    vec3 n = N0;

    if (uHasDem) {
      vec3 east = cross(normalize(vWorldPole), N0);
      float eastLen = length(east);
      // Skip the bump perturbation at the exact poles where the tangent
      // basis is degenerate; N0 is a fine normal there.
      if (eastLen > 1e-4) {
        east /= eastLen;
        vec3 north = normalize(cross(N0, east));

        float fullRange = uElevationRange * uDisplacementScale;
        float hL = texture2D(demMap, vUv - vec2(uDemTexelSize.x, 0.0)).r;
        float hR = texture2D(demMap, vUv + vec2(uDemTexelSize.x, 0.0)).r;
        float hD = texture2D(demMap, vUv - vec2(0.0, uDemTexelSize.y)).r;
        float hU = texture2D(demMap, vUv + vec2(0.0, uDemTexelSize.y)).r;

        float dHdu = (hR - hL) * 0.5 / uDemTexelSize.x * fullRange;
        float dHdv = (hU - hD) * 0.5 / uDemTexelSize.y * fullRange;

        float slopeE = dHdu / uTileWorldUV.x;
        float slopeN = dHdv / uTileWorldUV.y;

        n = normalize(N0 - east * slopeE - north * slopeN);
      }
    }

    float macroLight = max(0.0, dot(n, sunDir));
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
      uDemTexelSize: { value: new THREE.Vector2(1 / 256, 1 / 256) },
      uTileWorldUV: { value: new THREE.Vector2(1, 1) },
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
 * uniform and record the tile's level. Also computes the per-tile
 * uniforms needed by the fragment-shader gradient normal mapping:
 *   - uDemTexelSize: UV step between adjacent DEM pixels.
 *   - uTileWorldUV: world-space distance per UV unit along east (x) and
 *       north (y). Horizontal scale shrinks with cos(latCenter) because
 *       this is an equirectangular projection.
 * All uniforms must be set before flipping uHasDem so neither shader stage
 * ever sees an inconsistent state.
 */
export function applyDemToMoonMaterial(
  material: THREE.ShaderMaterial,
  texture: THREE.Texture,
  tileLevel: number,
  tileY: number,
): void {
  texture.colorSpace = THREE.NoColorSpace;
  material.uniforms.demMap.value = texture;
  material.uniforms.uTileLevel.value = tileLevel;

  const img = texture.image as { width?: number; height?: number } | null;
  const demW = img?.width ?? 256;
  const demH = img?.height ?? 256;
  material.uniforms.uDemTexelSize.value.set(1 / demW, 1 / demH);

  // Equirectangular: 2·2^L columns × 2^L rows. Tile at row y spans
  // latSpan = π / 2^L radians, centered at latCenter.
  const gy = Math.pow(2, tileLevel);
  const lngSpanRad = Math.PI / gy;
  const latSpanRad = Math.PI / gy;
  const latCenterRad = Math.PI / 2 - (tileY + 0.5) * latSpanRad;
  // cos(lat) floor avoids a div-by-zero in the fragment shader for tiles
  // that straddle the geometric pole. Near-pole tiles are heavily distorted
  // by equirectangular already; a tiny floor is visually indistinguishable.
  const cosLat = Math.max(1e-4, Math.cos(latCenterRad));
  const uWorldWidth = MOON_RADIUS_SCENE * cosLat * lngSpanRad;
  const uWorldHeight = MOON_RADIUS_SCENE * latSpanRad;
  material.uniforms.uTileWorldUV.value.set(uWorldWidth, uWorldHeight);

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
