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

/**
 * Sphere impostor shaders for moisture and ionization fields.
 * Each cell is a camera-facing quad; the fragment shader does analytical
 * ray-sphere intersection to produce a true 3D sphere with directional lighting.
 */

// Vertex shader: billboard quad that always faces the camera
export const sphereImpostorVertexShader = `
uniform vec3 sphereCenter;
uniform float sphereRadius;

varying vec3 vWorldPosition;
varying vec3 vSphereCenter;
varying float vRadius;

void main() {
  // Billboard: use view matrix columns to get camera-aligned axes
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

  // position.xy is the quad corner (-1 to 1), scaled by radius
  vec3 worldPos = sphereCenter
    + camRight * position.x * sphereRadius * 1.3
    + camUp * position.y * sphereRadius * 1.3;

  vWorldPosition = worldPos;
  vSphereCenter = sphereCenter;
  vRadius = sphereRadius;

  gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
}
`;

export const sphereImpostorFragmentShader = `
precision highp float;

uniform vec3 baseColor;
uniform float opacity;
uniform float intensity;
uniform vec3 lightDir;

varying vec3 vWorldPosition;
varying vec3 vSphereCenter;
varying float vRadius;

void main() {
  vec3 rayOrigin = cameraPosition;
  vec3 rayDir = normalize(vWorldPosition - cameraPosition);

  // Analytical ray-sphere intersection
  vec3 oc = rayOrigin - vSphereCenter;
  float b = dot(oc, rayDir);
  float c = dot(oc, oc) - vRadius * vRadius;
  float discriminant = b * b - c;

  if (discriminant < 0.0) {
    discard;
  }

  float t = -b - sqrt(discriminant);
  vec3 hitPoint = rayOrigin + t * rayDir;
  vec3 normal = normalize(hitPoint - vSphereCenter);

  // Soft lighting with subtle directionality
  float diffuse = max(0.0, dot(normal, lightDir)) * 0.4 + 0.6;

  // Radial falloff: bright core, transparent edges
  float distFromCenter = length(hitPoint - vSphereCenter) / vRadius;
  float coreBright = 1.0 - distFromCenter * distFromCenter;

  // Subtle edge transparency (not a bright rim — just fades out at edges)
  float rim = 1.0 - max(0.0, dot(normal, -rayDir));
  float edgeFade = 1.0 - rim * rim;

  vec3 col = baseColor * diffuse * (0.5 + coreBright * 0.5);

  float alpha = (0.15 + coreBright * 0.2) * edgeFade * intensity * opacity;
  alpha = clamp(alpha, 0.0, 0.3);

  gl_FragColor = vec4(col, alpha);
}
`;

