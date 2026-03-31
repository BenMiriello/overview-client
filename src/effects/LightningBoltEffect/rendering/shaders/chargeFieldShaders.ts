/**
 * Clean isosurface shaders for charge field rendering.
 *
 * Flat planes (ceiling/ground): Clean anti-aliased contour lines with controlled inward fade.
 * Volumetric fields (atmospheric/moisture/ionization): Isosurface shell rendering with
 * Fresnel-based edge brightness - edges appear brighter when viewed at grazing angles.
 */

export const MAX_CELLS = 16;
export const MAX_VOLUMETRIC_CELLS = 8;

// Vertex shader for flat planes (ceiling/ground) - outputs world XZ for metaball computation
export const chargeFieldVertexShader = `
varying vec2 vWorldXZ;
varying vec2 vUv;

void main() {
  vUv = uv;
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldXZ = worldPos.xz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

export const chargeFieldFragmentShader = `
precision highp float;

#define MAX_CELLS 16

uniform vec2 cellCenters[MAX_CELLS];
uniform float cellIntensities[MAX_CELLS];
uniform float cellRadii[MAX_CELLS];
uniform int cellCount;
uniform vec3 baseColor;
uniform float opacity;
uniform vec2 windDir;
uniform float windSpeed;

varying vec2 vWorldXZ;
varying vec2 vUv;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));
  for (int i = 0; i < 3; i++) {
    v += a * noise(p);
    p = rot * p * 2.0 + vec2(100.0);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 perpDir = vec2(-windDir.y, windDir.x);
  float stretchFactor = 1.0 + windSpeed * 1.5;

  float totalField = 0.0;

  for (int i = 0; i < MAX_CELLS; i++) {
    if (i >= cellCount) break;

    vec2 d = vWorldXZ - cellCenters[i];

    // Noise warp: distort distance for irregular organic boundaries
    float noiseWarp = fbm(vWorldXZ * 3.5 + vec2(float(i) * 17.3, float(i) * 31.7));

    float alongWind = dot(d, windDir);
    float perpWind = dot(d, perpDir);
    float dist = sqrt((alongWind / stretchFactor) * (alongWind / stretchFactor) + perpWind * perpWind);
    dist *= (1.0 - 0.35 * noiseWarp);

    float r = cellRadii[i];
    if (dist < r) {
      float t = dist / r;
      float falloff = 1.0 - t * t;
      totalField += cellIntensities[i] * falloff;
    }
  }

  // Discard if no field contribution
  if (totalField < 0.01) {
    discard;
  }

  // Normalize field (max ~1.5 when cells overlap)
  float field = clamp(totalField / 1.2, 0.0, 1.0);

  // Soft atmospheric glow - very subtle, blends into environment
  float outerGlow = smoothstep(0.08, 0.35, field);
  float innerGlow = smoothstep(0.35, 0.7, field);
  float coreGlow = smoothstep(0.65, 1.0, field);

  vec3 col = baseColor * 0.3 * outerGlow;
  col += baseColor * 0.4 * innerGlow;
  col += mix(baseColor, vec3(1.0), 0.2) * coreGlow * 0.3;

  float alpha = outerGlow * 0.15 + innerGlow * 0.12 + coreGlow * 0.08;
  alpha = clamp(alpha * opacity, 0.0, 0.3);

  if (alpha < 0.01) {
    discard;
  }

  gl_FragColor = vec4(col, alpha);
}
`;

// Volumetric ray marching vertex shader - box geometry for volume bounds
export const volumetricVertexShader = `
varying vec3 vWorldPosition;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

// Volumetric field rendering — smooth, no jitter/grain
export const volumetricFragmentShader = `
precision highp float;

#define MAX_CELLS 8
#define MAX_STEPS 6

uniform vec3 cellCenters[MAX_CELLS];
uniform float cellIntensities[MAX_CELLS];
uniform float cellRadii[MAX_CELLS];
uniform int cellCount;
uniform vec3 baseColor;
uniform float opacity;
uniform vec3 volumeCenter;
uniform float volumeRadius;
uniform vec3 lightDir;
uniform vec2 windDir;
uniform float windSpeed;
uniform float radiusScale;

varying vec3 vWorldPosition;

float sampleField(vec3 p) {
  vec3 windDir3D = vec3(windDir.x, 0.0, windDir.y);
  vec3 perpDir = vec3(-windDir.y, 0.0, windDir.x);
  float stretchFactor = 1.0 + windSpeed * 1.5;

  float totalField = 0.0;

  for (int i = 0; i < MAX_CELLS; i++) {
    if (i >= cellCount) break;

    vec3 d = p - cellCenters[i];
    float alongWind = dot(d, windDir3D);
    float perpWind = dot(d, perpDir);
    float verticalDist = d.y;

    float dist = sqrt(
      (alongWind / stretchFactor) * (alongWind / stretchFactor) +
      perpWind * perpWind +
      verticalDist * verticalDist
    );

    float r = cellRadii[i] * radiusScale;
    if (dist < r) {
      float t = dist / r;
      float t2 = t * t;
      float falloff = 1.0 - t2 * (3.0 - 2.0 * t);
      totalField += cellIntensities[i] * falloff;
    }
  }

  return totalField;
}

// Sphere intersection: returns (tEntry, tExit), tEntry < 0 means inside sphere
vec2 intersectSphere(vec3 origin, vec3 dir, vec3 center, float radius) {
  vec3 oc = origin - center;
  float b = dot(oc, dir);
  float c = dot(oc, oc) - radius * radius;
  float h = b * b - c;
  if (h < 0.0) return vec2(-1.0);
  float sq = sqrt(h);
  return vec2(-b - sq, -b + sq);
}

void main() {
  vec3 rayDir = normalize(vWorldPosition - cameraPosition);

  vec2 tBounds = intersectSphere(cameraPosition, rayDir, volumeCenter, volumeRadius);
  float tMin = max(tBounds.x, 0.0);
  float tMax = tBounds.y;

  if (tMax < 0.0) {
    discard;
  }

  float stepSize = (tMax - tMin) / float(MAX_STEPS);
  vec3 accumulatedColor = vec3(0.0);
  float accumulatedAlpha = 0.0;

  for (int step = 0; step < MAX_STEPS; step++) {
    float t = tMin + (float(step) + 0.5) * stepSize;
    if (t > tMax) break;

    vec3 p = cameraPosition + rayDir * t;
    float field = sampleField(p);

    if (field > 0.01) {
      // Field value IS the density — no artificial boundary fade needed
      float softField = sqrt(field);
      float density = softField * 0.5 * stepSize;
      vec3 stepColor = baseColor * (0.6 + softField * 0.3);

      accumulatedColor += stepColor * density * (1.0 - accumulatedAlpha);
      accumulatedAlpha += density * (1.0 - accumulatedAlpha);

      if (accumulatedAlpha > 0.6) break;
    }
  }

  if (accumulatedAlpha < 0.005) {
    discard;
  }

  gl_FragColor = vec4(accumulatedColor, accumulatedAlpha * opacity);
}
`;

