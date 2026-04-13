import * as THREE from 'three';
import { sharedNightUniforms } from './dayNightMaterial';

// See client/docs/atmosphere.md for the physics and design rationale.

const PLANET_RADIUS = 100;

// Geometry sphere is fixed at the maximum possible atmosphere radius (far zoom,
// cloudAlt=0.03, atmosphere=2x clouds → 100*(1+0.06)=106). uAtmosphereR and
// uScaleHeight are updated each frame to track current cloud altitude.
export const ATMOSPHERE_RADIUS_SCENE = 106;

// Base scale height at far zoom (cloudAlt=0.03). Scaled proportionally to
// cloudAlt each frame so the atmosphere always extends above the cloud shell
// regardless of zoom level.
const BASE_SCALE_HEIGHT = 0.625;

const MIE_SCALE_HEIGHT_BASE = 0.5;

// Rayleigh coefficients in the canonical (R, G, B) ratio for 680/550/440 nm,
// scaled to scene units. Tuned visually against SUN_INTENSITY to keep the
// day-disk inside LDR while leaving enough optical-depth differential to
// reveal a visible reddening at the terminator.
const RAYLEIGH_COEFF = new THREE.Vector3(0.116, 0.270, 0.662);

// Mie is approximately wavelength-independent (haze is white/gray).
const MIE_COEFF = new THREE.Vector3(0.021, 0.021, 0.021);
const MIE_G = 0.76;

const SUN_INTENSITY = 5.0;

// Night-side path-length haze. NOT multiplied by RAYLEIGH_COEFF — kept dark
// and neutral so it reads as opacity/presence, not a glow.
const AMBIENT_INTENSITY = 0.006;

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
  uniform float uAmbientIntensity;

  varying vec3 vWorldPos;

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

    vec2 planet = raySphere(ro, rd, uPlanetR);
    if (planet.y > 0.0 && planet.x > 0.0) {
      tFar = min(tFar, planet.x);
    }
    if (tFar <= tNear) discard;

    float segLen = (tFar - tNear) / float(${VIEW_SAMPLES});
    vec3  rayleighSum = vec3(0.0);
    vec3  mieSum      = vec3(0.0);
    float ambientSum  = 0.0;

    for (int i = 0; i < ${VIEW_SAMPLES}; i++) {
      float t = tNear + (float(i) + 0.5) * segLen;
      vec3 P  = ro + rd * t;
      float altitude = length(P) - uPlanetR;
      if (altitude < 0.0) continue;
      float densityR = exp(-altitude / uScaleHeight)    * segLen;
      float densityM = exp(-altitude / uScaleHeightMie) * segLen;

      // Path-length integral for night-side limb visibility (no sun dependency).
      ambientSum += densityR;

      vec2 shadow = raySphere(P, uSunDir, uPlanetR);
      float shadowFactor = 1.0;
      if (shadow.y > 0.0 && shadow.x > 0.0) {
        float tClosest = -dot(P, uSunDir);
        vec3 closestPt = P + uSunDir * tClosest;
        float closest = length(closestPt);
        shadowFactor = smoothstep(uPlanetR - 0.5, uPlanetR + 0.5, closest);
      }
      if (shadowFactor <= 0.0) continue;

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
        uRayleighCoeff * (densityR * shadowFactor * 0.5 + lightDensityR) +
        uMieCoeff      * (densityM * shadowFactor * 0.5 + lightDensityM);
      vec3 attenuation = exp(-tau);
      rayleighSum += densityR * shadowFactor * attenuation;
      mieSum      += densityM * shadowFactor * attenuation;
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

    // Night ambient: neutral dark haze (not blue) proportional to path length.
    // Gives the atmosphere limb presence without adding a colored glow.
    vec3 nightHaze = uAmbientIntensity * vec3(0.15, 0.2, 0.35) * ambientSum;

    vec3 color = nightHaze + uSunIntensity * (
      uRayleighCoeff * phaseR * rayleighSum +
      uMieCoeff      * phaseM * mieSum
    );

    gl_FragColor = vec4(color, 1.0);
  }
`;

export function createAtmosphereMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uCameraPos:        { value: new THREE.Vector3() },
      uSunDir:           sharedNightUniforms.sunDir,
      uPlanetR:          { value: PLANET_RADIUS },
      uAtmosphereR:      { value: ATMOSPHERE_RADIUS_SCENE },
      uScaleHeight:      { value: BASE_SCALE_HEIGHT },
      uScaleHeightMie:   { value: MIE_SCALE_HEIGHT_BASE },
      uRayleighCoeff:    { value: RAYLEIGH_COEFF.clone() },
      uMieCoeff:         { value: MIE_COEFF.clone() },
      uMieG:             { value: MIE_G },
      uSunIntensity:     { value: SUN_INTENSITY },
      uAmbientIntensity: { value: AMBIENT_INTENSITY },
    },
    vertexShader,
    fragmentShader,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
}

export const BASE_CLOUD_ALT_FAR = 0.03;
export { BASE_SCALE_HEIGHT, MIE_SCALE_HEIGHT_BASE };
