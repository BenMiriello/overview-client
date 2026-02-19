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

  vec3 col = vec3(0.0);
  float alpha = 0.0;

  // Clean contour lines at 4 thresholds
  float thresholds[4];
  thresholds[0] = 0.2;
  thresholds[1] = 0.4;
  thresholds[2] = 0.6;
  thresholds[3] = 0.8;

  // Anti-aliasing width based on screen-space derivatives
  float aa = fwidth(field) * 1.5;
  float lineWidth = 0.015;
  float fadeWidth = 0.06;

  for (int i = 0; i < 4; i++) {
    float t = thresholds[i];
    float distFromLine = abs(field - t);

    // Sharp anti-aliased contour line
    float line = 1.0 - smoothstep(lineWidth - aa, lineWidth + aa, distFromLine);

    // Inward fade: visible only where field > threshold, fades out further in
    float inwardFade = smoothstep(t, t + fadeWidth, field) *
                       (1.0 - smoothstep(t + fadeWidth, t + fadeWidth * 2.0, field));

    // Combine line and fade
    float contour = max(line, inwardFade * 0.4);

    // Depth-based brightness: inner contours brighter
    float depth = float(i) / 3.0;
    float brightness = 0.3 + depth * 0.7;

    // Color: outer contours dim, inner contours glow
    vec3 contourColor = mix(baseColor * 0.5, baseColor * 1.3, depth);
    contourColor = mix(contourColor, vec3(1.0), depth * 0.4);

    col += contourColor * contour * brightness;
    alpha += contour * brightness * 0.5;
  }

  // Subtle center glow for depth
  float centerGlow = pow(field, 2.5) * 0.25;
  col += baseColor * 1.1 * centerGlow;
  alpha += centerGlow * 0.3;

  alpha = clamp(alpha * opacity, 0.0, 0.85);

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
#define PI 3.14159265359

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
      // Cosine falloff to match VoronoiField
      float falloff = (cos(t * PI) + 1.0) * 0.5;
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

