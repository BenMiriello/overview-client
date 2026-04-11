import * as THREE from 'three';
import { sharedNightUniforms } from './dayNightMaterial';

// See client/docs/atmosphere.md for the physics and design rationale.

const PLANET_RADIUS = 100;
const ATMOSPHERE_HEIGHT = 4.0; // extends to r=104, above cloud far-zoom max of 103
const ATMOSPHERE_RADIUS = PLANET_RADIUS + ATMOSPHERE_HEIGHT; // 104
const SCALE_HEIGHT = 0.625; // fixed exponential scale height; decoupled from shell top

// Rayleigh coefficients in the canonical (R, G, B) ratio for 680/550/440 nm,
// scaled to scene units. Tuned visually against SUN_INTENSITY to keep the
// day-disk inside LDR while leaving enough optical-depth differential to
// reveal a visible reddening at the terminator.
const RAYLEIGH_COEFF = new THREE.Vector3(0.116, 0.270, 0.662);

// Mie is approximately wavelength-independent (haze is white/gray), so the
// coefficient is grayscale. Magnitude tuned visually; see atmosphere.md.
const MIE_COEFF = new THREE.Vector3(0.021, 0.021, 0.021);

// Mie scale height is much shorter than Rayleigh's in real Earth (~1.2 km vs
// ~8.5 km). Aerosols hug the surface. Keep the same loose ratio in scene units.
const MIE_SCALE_HEIGHT = 0.625; // fixed; aerosols hug surface, same as Rayleigh scale height

// Henyey-Greenstein anisotropy parameter. Higher = sharper forward peak.
// 0.76 is a common Earth haze value.
const MIE_G = 0.76;

// Brightness multiplier on the final scattered color before additive blend.
// Lowered alongside doubling RAYLEIGH_COEFF: net mid-disk brightness is
// similar but the dynamic range shifts down so reddening at the terminator
// becomes visible before the day disk clips to white in LDR.
const SUN_INTENSITY = 5.0;

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

      // Soft ground-shadow factor: a binary "ray hits Earth = contribute 0"
      // test snaps a sample's contribution to zero across one frame's worth
      // of motion at the terminator, killing the dusk gradient. Instead,
      // measure the sun ray's closest approach to Earth's center and smooth
      // the transition over a narrow band centered on the surface so dusk
      // samples contribute partially.
      vec2 shadow = raySphere(P, uSunDir, uPlanetR);
      float shadowFactor = 1.0;
      if (shadow.y > 0.0 && shadow.x > 0.0) {
        float tClosest = -dot(P, uSunDir);
        vec3 closestPt = P + uSunDir * tClosest;
        float closest = length(closestPt);
        shadowFactor = smoothstep(uPlanetR - 0.5, uPlanetR + 0.5, closest);
      }
      // Ambient floor: indirect sky light (earthshine, starlight) means the
      // night-side limb should show faint blue scatter at grazing angles.
      // 0.012 keeps it well below day brightness; Rayleigh wavelength-dependence
      // naturally makes it blue.
      shadowFactor = max(0.012, shadowFactor);
      densityR *= shadowFactor;
      densityM *= shadowFactor;

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
