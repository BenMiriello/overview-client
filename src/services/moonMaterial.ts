/**
 * Moon tile materials.
 *
 * The moon uses raw THREE.ShaderMaterial instances rather than patched
 * MeshLambertMaterial chunks because the chunk-replace approach was fragile
 * (output was passed through tonemapping/colorspace/scene-light accumulation
 * downstream of our override, washing out the day↔night terminator). The
 * legacy moon mesh used the same shader pattern and produced correct
 * lighting; we replicate it here per-tile.
 *
 *   - createMoonColorMaterial: opaque-looking color tile with a hard
 *     terminator from sharedNightUniforms.sunDir. Material is `transparent`
 *     so it lands in the transparent render pass after the (transparent)
 *     atmosphere shell — necessary for the moon to draw on top of the
 *     atmosphere shell when it's in front of Earth.
 *   - createMoonReliefMaterial: grayscale shaded relief blended over the
 *     color layer multiplicatively, faded on the night side so the dark
 *     hemisphere isn't lightened by the always-positive relief value.
 *
 * Both factories return the material AND a `bindTexture` function that
 * SlippyMapGlobe's loader uses to bind a freshly-loaded tile texture into
 * the material's `map` uniform.
 */

import * as THREE from 'three';
import { sharedNightUniforms } from './dayNightMaterial';

const MOON_AMBIENT = 0.04;
const RELIEF_STRENGTH = 0.55;
// The LRO WAC texture is calibrated to the moon's true reflectance (~0.12),
// which renders physically-correct but visually dim. Boost so the lit hemisphere
// reads at the brightness our eyes are used to.
const MOON_BRIGHTNESS = 1.7;

const MOON_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldNormal;
  void main() {
    vUv = uv;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Both fragment shaders sample an sRGB-encoded texture (the GPU returns
// linear values automatically when texture.colorSpace=SRGBColorSpace), do
// linear-space math, and pass the final color through `linearToOutputTexel`
// to encode it for the renderer's output color space. Three.js injects the
// `linearToOutputTexel` GLSL function into every ShaderMaterial fragment
// (it's part of the prefix string in WebGLProgram), so it's always callable.

const MOON_COLOR_FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 sunDir;
  uniform float uAmbient;
  uniform float uBrightness;
  varying vec2 vUv;
  varying vec3 vWorldNormal;

  void main() {
    vec4 tex = texture2D(map, vUv);
    float light = max(0.0, dot(vWorldNormal, sunDir));
    float shade = uAmbient + (1.0 - uAmbient) * light;
    vec3 lit = tex.rgb * shade * uBrightness;
    gl_FragColor = linearToOutputTexel(vec4(lit, 1.0));
  }
`;

const MOON_RELIEF_FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 sunDir;
  uniform float uStrength;
  varying vec2 vUv;
  varying vec3 vWorldNormal;

  void main() {
    vec4 relief = texture2D(map, vUv);
    float dayMask = smoothstep(-0.05, 0.15, dot(vWorldNormal, sunDir));
    vec3 factor = mix(vec3(1.0), relief.rgb, uStrength * dayMask);
    // Multiply blending — output is a per-channel multiplier in [0,1] applied
    // by the GPU against the framebuffer pixel below. The framebuffer is in
    // the renderer's output color space, so the multiplier must also be in
    // that space (no linear→sRGB encoding needed for a unitless multiplier).
    gl_FragColor = vec4(factor, 1.0);
  }
`;

export function createMoonColorMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: MOON_VERTEX,
    fragmentShader: MOON_COLOR_FRAGMENT,
    uniforms: {
      map: { value: null },
      sunDir: sharedNightUniforms.sunDir,
      uAmbient: { value: MOON_AMBIENT },
      uBrightness: { value: MOON_BRIGHTNESS },
    },
    // Transparent so the tile lands in the transparent render pass —
    // alongside (and after, via renderOrder) the atmosphere shell. The
    // shader always outputs alpha=1.0 so the tile is visually opaque.
    transparent: true,
    depthWrite: true,
    depthTest: true,
  });
}

export function createMoonReliefMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: MOON_VERTEX,
    fragmentShader: MOON_RELIEF_FRAGMENT,
    uniforms: {
      map: { value: null },
      sunDir: sharedNightUniforms.sunDir,
      uStrength: { value: RELIEF_STRENGTH },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.MultiplyBlending,
  });
}

/**
 * Texture binder for moon ShaderMaterials. Used by SlippyMapGlobe's tile
 * loader (via the `applyTexture` option) to attach a freshly-loaded tile
 * texture to the material's `map` uniform.
 */
export function applyMoonTileTexture(material: THREE.Material, texture: THREE.Texture): void {
  const mat = material as THREE.ShaderMaterial;
  mat.uniforms.map.value = texture;
}
