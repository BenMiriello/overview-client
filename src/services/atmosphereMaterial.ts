import * as THREE from 'three';
import { sharedNightUniforms } from './dayNightMaterial';

// See client/docs/atmosphere.md for the physics and design rationale.

const PLANET_RADIUS = 100;
const ATMOSPHERE_HEIGHT = 0.025 * PLANET_RADIUS; // 2.5
const ATMOSPHERE_RADIUS = PLANET_RADIUS + ATMOSPHERE_HEIGHT; // 102.5
const SCALE_HEIGHT = 0.25 * ATMOSPHERE_HEIGHT; // 0.625

// Rayleigh coefficients in the canonical (R, G, B) ratio for 680/550/440 nm,
// scaled to scene units. Tuned visually; see atmosphere.md.
const RAYLEIGH_COEFF = new THREE.Vector3(0.058, 0.135, 0.331);

// Mie is approximately wavelength-independent (haze is white/gray), so the
// coefficient is grayscale. Magnitude tuned visually; see atmosphere.md.
const MIE_COEFF = new THREE.Vector3(0.021, 0.021, 0.021);

// Mie scale height is much shorter than Rayleigh's in real Earth (~1.2 km vs
// ~8.5 km). Aerosols hug the surface. Keep the same loose ratio in scene units.
const MIE_SCALE_HEIGHT = 0.25 * (0.025 * PLANET_RADIUS); // 0.25 of atmosphere height

// Henyey-Greenstein anisotropy parameter. Higher = sharper forward peak.
// 0.76 is a common Earth haze value.
const MIE_G = 0.76;

// Brightness multiplier on the final scattered color before additive blend.
const SUN_INTENSITY = 7.0;

const VIEW_SAMPLES = 10;
const SHADOW_SAMPLES = 4;

const vertexShader = /* glsl */ `
  varying vec3 vWorldPos;

  void main() {
    vec4 worldPos4 = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos4.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos4;
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  uniform vec3  uCameraPos;
  uniform vec3  uSunDir;
  uniform float uPlanetR;
  uniform float uAtmosphereR;
  uniform float uScaleHeight;
  uniform float uScaleHeightMie;
  uniform vec3  uRayleighCoeff;
  uniform vec3  uMieCoeff;
  uniform float uMieG;
  uniform float uSunIntensity;

  varying vec3 vWorldPos;

  // Returns (tNear, tFar) for ray vs sphere at origin radius r.
  // Returns (1.0, -1.0) when there is no intersection.
  vec2 raySphere(vec3 ro, vec3 rd, float r) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - r * r;
    float disc = b * b - c;
    if (disc < 0.0) return vec2(1.0, -1.0);
    float s = sqrt(disc);
    return vec2(-b - s, -b + s);
  }

  void main() {
    vec3 rd = normalize(vWorldPos - uCameraPos);
    vec3 ro = uCameraPos;

    vec2 atm = raySphere(ro, rd, uAtmosphereR);
    if (atm.y < 0.0) discard;

    float tNear = max(atm.x, 0.0);
    float tFar  = atm.y;

    // Clip the chord to the planet's near side if the view ray hits Earth.
    vec2 planet = raySphere(ro, rd, uPlanetR);
    if (planet.y > 0.0 && planet.x > 0.0) {
      tFar = min(tFar, planet.x);
    }
    if (tFar <= tNear) discard;

    float segLen = (tFar - tNear) / float(${VIEW_SAMPLES});
    vec3  rayleighSum = vec3(0.0);
    vec3  mieSum      = vec3(0.0);

    for (int i = 0; i < ${VIEW_SAMPLES}; i++) {
      float t = tNear + (float(i) + 0.5) * segLen;
      vec3 P  = ro + rd * t;
      float altitude = length(P) - uPlanetR;
      if (altitude < 0.0) continue;
      float densityR = exp(-altitude / uScaleHeight)    * segLen;
      float densityM = exp(-altitude / uScaleHeightMie) * segLen;

      // Ground-shadow test: is the sun visible from this sample point?
      // If the planet blocks it, this sample is in Earth's shadow.
      vec2 shadow = raySphere(P, uSunDir, uPlanetR);
      bool shadowed = (shadow.y > 0.0 && shadow.x > 0.0);
      if (shadowed) continue;

      // Light optical depth: integrate density along sun ray to top of atmosphere.
      vec2 lightAtm = raySphere(P, uSunDir, uAtmosphereR);
      float lightLen = lightAtm.y;
      if (lightLen <= 0.0) continue;
      float lightStep = lightLen / float(${SHADOW_SAMPLES});
      float lightDensityR = 0.0;
      float lightDensityM = 0.0;
      bool lightBlocked = false;
      for (int j = 0; j < ${SHADOW_SAMPLES}; j++) {
        vec3 Q = P + uSunDir * (float(j) + 0.5) * lightStep;
        float altQ = length(Q) - uPlanetR;
        if (altQ < 0.0) { lightBlocked = true; break; }
        lightDensityR += exp(-altQ / uScaleHeight)    * lightStep;
        lightDensityM += exp(-altQ / uScaleHeightMie) * lightStep;
      }
      if (lightBlocked) continue;

      vec3 tau =
        uRayleighCoeff * (densityR * 0.5 + lightDensityR) +
        uMieCoeff      * (densityM * 0.5 + lightDensityM);
      vec3 attenuation = exp(-tau);
      rayleighSum += densityR * attenuation;
      mieSum      += densityM * attenuation;
    }

    float mu = dot(rd, uSunDir);
    float mu2 = mu * mu;
    float phaseR = (3.0 / (16.0 * 3.14159265)) * (1.0 + mu2);

    float g  = uMieG;
    float g2 = g * g;
    float phaseM =
      (3.0 / (8.0 * 3.14159265)) *
      ((1.0 - g2) * (1.0 + mu2)) /
      ((2.0 + g2) * pow(max(0.0, 1.0 + g2 - 2.0 * g * mu), 1.5));

    vec3 color = uSunIntensity * (
      uRayleighCoeff * phaseR * rayleighSum +
      uMieCoeff      * phaseM * mieSum
    );
    gl_FragColor = vec4(color, 1.0);
  }
`;

export function createAtmosphereMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uCameraPos:      { value: new THREE.Vector3() },
      uSunDir:         sharedNightUniforms.sunDir, // shared reference; updated by updateSunDirection
      uPlanetR:        { value: PLANET_RADIUS },
      uAtmosphereR:    { value: ATMOSPHERE_RADIUS },
      uScaleHeight:    { value: SCALE_HEIGHT },
      uScaleHeightMie: { value: MIE_SCALE_HEIGHT },
      uRayleighCoeff:  { value: RAYLEIGH_COEFF.clone() },
      uMieCoeff:       { value: MIE_COEFF.clone() },
      uMieG:           { value: MIE_G },
      uSunIntensity:   { value: SUN_INTENSITY },
    },
    vertexShader,
    fragmentShader,
    // BackSide so the shell still draws when the camera is inside the
    // atmosphere (close mode). depthTest is OFF because the back face of the
    // shell is at radius > Earth and would otherwise be depth-clipped by
    // Earth on every pixel except the thin limb ring. The shader handles
    // planet occlusion analytically by clipping the integration interval at
    // the planet's near hit, so a depth test against the framebuffer is
    // redundant.
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
}

export const ATMOSPHERE_RADIUS_SCENE = ATMOSPHERE_RADIUS;
