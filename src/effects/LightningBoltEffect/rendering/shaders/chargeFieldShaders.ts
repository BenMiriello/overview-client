/**
 * Clean isosurface shaders for charge field rendering.
 *
 * Flat planes (ceiling/ground): Clean anti-aliased contour lines with controlled inward fade.
 * Volumetric fields (atmospheric/moisture/ionization): Isosurface shell rendering with
 * Fresnel-based edge brightness - edges appear brighter when viewed at grazing angles.
 */

export const MAX_CELLS = 16;

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

void main() {
  // Compute perpendicular to wind direction
  vec2 perpDir = vec2(-windDir.y, windDir.x);

  // Wind stretch factor (1.0 to 2.5 based on wind speed)
  float stretchFactor = 1.0 + windSpeed * 1.5;

  // Sum field contributions from all cells (metaball technique)
  float totalField = 0.0;

  for (int i = 0; i < MAX_CELLS; i++) {
    if (i >= cellCount) break;

    vec2 d = vWorldXZ - cellCenters[i];

    // Wind deformation: elliptical stretch in wind direction
    float alongWind = dot(d, windDir);
    float perpWind = dot(d, perpDir);
    float dist = sqrt((alongWind / stretchFactor) * (alongWind / stretchFactor) + perpWind * perpWind);

    float r = cellRadii[i];
    if (dist < r) {
      float t = dist / r;
      // Smooth falloff for metaball merging
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

  // Smooth organic glow: field strength directly drives color and alpha
  // Outer regions dim, inner regions bright and saturated
  float outerGlow = smoothstep(0.05, 0.3, field);
  float innerGlow = smoothstep(0.3, 0.7, field);
  float coreGlow = smoothstep(0.6, 1.0, field);

  // Color: dim edges -> baseColor -> brighter core
  vec3 col = baseColor * 0.5 * outerGlow;
  col += baseColor * 0.6 * innerGlow;
  col += mix(baseColor, vec3(1.0), 0.3) * coreGlow * 0.4;

  // Subtle edge highlight at the boundary
  float edgeHighlight = smoothstep(0.08, 0.15, field) * (1.0 - smoothstep(0.15, 0.25, field));
  col += baseColor * 0.8 * edgeHighlight;

  float alpha = outerGlow * 0.25 + innerGlow * 0.2 + coreGlow * 0.12;
  alpha = clamp(alpha * opacity, 0.0, 0.45);

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

// Volumetric layered rendering - solid regions with stepped intensity
export const volumetricFragmentShader = `
precision highp float;

#define MAX_CELLS 16
#define MAX_STEPS 24

uniform vec3 cellCenters[MAX_CELLS];
uniform float cellIntensities[MAX_CELLS];
uniform float cellRadii[MAX_CELLS];
uniform int cellCount;
uniform vec3 baseColor;
uniform float opacity;
uniform vec3 boundMin;
uniform vec3 boundMax;
uniform vec3 lightDir;
uniform vec2 windDir;
uniform float windSpeed;
uniform float radiusScale;

varying vec3 vWorldPosition;

float hash3D(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

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
      // Cubic approximation of cosine falloff (smoothstep-like, ~15% faster)
      float t2 = t * t;
      float falloff = 1.0 - t2 * (3.0 - 2.0 * t);
      totalField += cellIntensities[i] * falloff;
    }
  }

  return totalField;
}

vec2 intersectBox(vec3 origin, vec3 dir, vec3 bmin, vec3 bmax) {
  vec3 invDir = 1.0 / dir;
  vec3 t0s = (bmin - origin) * invDir;
  vec3 t1s = (bmax - origin) * invDir;
  vec3 tsmaller = min(t0s, t1s);
  vec3 tbigger = max(t0s, t1s);
  float tmin = max(max(tsmaller.x, tsmaller.y), tsmaller.z);
  float tmax = min(min(tbigger.x, tbigger.y), tbigger.z);
  return vec2(max(tmin, 0.0), tmax);
}

void main() {
  vec3 rayDir = normalize(vWorldPosition - cameraPosition);

  vec2 tBounds = intersectBox(cameraPosition, rayDir, boundMin, boundMax);
  float tMin = tBounds.x;
  float tMax = tBounds.y;

  if (tMax < tMin || tMax < 0.0) {
    discard;
  }

  float stepSize = (tMax - tMin) / float(MAX_STEPS);
  vec3 accumulatedColor = vec3(0.0);
  float accumulatedAlpha = 0.0;

  float jitter = hash3D(vWorldPosition * 100.0) * stepSize;
  float prevField = 0.0;

  for (int step = 0; step < MAX_STEPS; step++) {
    float t = tMin + jitter + float(step) * stepSize;
    if (t > tMax || accumulatedAlpha > 0.95) break;

    vec3 p = cameraPosition + rayDir * t;
    float field = sampleField(p);

    if (field > 0.05) {
      // Determine layer (0-3) based on field value
      int layer = 0;
      if (field > 0.6) layer = 3;
      else if (field > 0.4) layer = 2;
      else if (field > 0.2) layer = 1;

      // Previous layer for boundary detection
      int prevLayer = 0;
      if (prevField > 0.6) prevLayer = 3;
      else if (prevField > 0.4) prevLayer = 2;
      else if (prevField > 0.2) prevLayer = 1;

      // Layer-based brightness (inner = brighter)
      float layerBrightness = 0.6 + float(layer) * 0.15;
      vec3 layerColor = baseColor * layerBrightness;
      layerColor = mix(layerColor, vec3(1.0), float(layer) * 0.1);

      // Boundary emphasis when crossing layers
      float boundaryBoost = (layer != prevLayer && step > 0) ? 2.5 : 1.0;

      // Alpha per step
      float alpha = 0.12 * boundaryBoost * stepSize * 4.0;

      accumulatedColor += layerColor * alpha * (1.0 - accumulatedAlpha);
      accumulatedAlpha += alpha * (1.0 - accumulatedAlpha);
    }

    prevField = field;
  }

  if (accumulatedAlpha < 0.01) {
    discard;
  }

  gl_FragColor = vec4(accumulatedColor, accumulatedAlpha * opacity);
}
`;

