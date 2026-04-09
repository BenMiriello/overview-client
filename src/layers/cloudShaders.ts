// Phase 2 cloud shader. See client/docs/clouds.md and the splendid-coalescing-river
// plan for the rationale; in short:
//
//   density   = base raster (matteason live cloud cover) modulated by a high-
//               frequency FBM detail noise so the 20 km/pixel raster gains
//               sub-pixel structure when zoomed in.
//   parallax  = step the view ray inward across N samples in tangent UV
//               space, Beer's-law accumulating transmittance. At grazing
//               angles the tangent component of the view direction is large,
//               so the ray sweeps a long path through the density field and
//               silhouettes thicken naturally.
//   shadow    = one density tap offset toward the sun direction (also in
//               tangent UV space) → Beer's-law self-shadow term. Sells the
//               3D effect more than parallax does on its own.
//   day/night = same sun-dot brightness ramp the phong patch used in Phase 1.
//
// The view-dir → equirectangular UV mapping uses the local east/north tangent
// frame at each fragment; the cosLat clamp keeps the poles from blowing up.

export const cloudVertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

export const cloudFragmentShader = /* glsl */ `
  precision highp float;

  uniform sampler2D uMap;
  uniform vec3  uSunDir;
  uniform vec3  uCameraPos;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uDetailStrength;
  uniform vec2  uDetailFreq;
  uniform float uThickness;
  uniform float uShadowStrength;
  uniform float uFlashIntensity;
  uniform float uDetailFade;
  uniform float uParallaxFade;
  uniform float uDensityGamma;
  uniform float uNightAmbient;
  uniform sampler2D uLayerTex;
  uniform float uLayerChannel;

  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i),               hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
      v += a * vnoise(p);
      p = p * 2.03 + vec2(17.0, 31.0);
      a *= 0.5;
    }
    return v;
  }

  // Project a world-space direction onto the local equirectangular UV plane
  // at this fragment. East/north basis is built from the world up axis and the
  // surface normal. The cosLat clamp avoids singularities at the poles.
  vec2 worldDirToUv(vec3 dir, vec3 n) {
    vec3 east  = normalize(cross(vec3(0.0, 1.0, 0.0), n));
    vec3 north = cross(n, east);
    float dE = dot(dir, east);
    float dN = dot(dir, north);
    float cosLat = max(0.08, sqrt(max(0.0, 1.0 - n.y * n.y)));
    // u = lon / 2π, v = lat / π. Negative dN because v=0 is the north pole in
    // three-globe / matteason equirectangular convention.
    return vec2(dE / (cosLat * 6.2831853), -dN / 3.1415927);
  }

  float getLayerMask(vec2 uv) {
    vec4 lc = texture2D(uLayerTex, uv);
    if (uLayerChannel < 0.5) return lc.r;
    if (uLayerChannel < 1.5) return lc.g;
    return lc.b;
  }

  float sampleDensity(vec2 uv) {
    float base = texture2D(uMap, uv).a;
    float ds = uDetailStrength * uDetailFade;
    float detail = fbm(uv * uDetailFreq + vec2(uTime * 0.0008, 0.0));
    return base * mix(1.0 - ds, 1.0 + ds, detail);
  }

  void main() {
    vec3 n = normalize(vWorldNormal);
    vec3 viewDir = normalize(vWorldPos - uCameraPos);

    // Compute day/night early — used to gate expensive work on the night side.
    float sunDot = dot(n, uSunDir);
    float dayFactor = smoothstep(-0.15, 0.15, sunDot);

    float density = sampleDensity(vUv);

    // Parallax only on the low layer when zoomed in close enough to matter.
    if (uLayerChannel < 0.5 && uParallaxFade > 0.01) {
      vec2 viewUvStep = worldDirToUv(viewDir, n) * uThickness * uParallaxFade;
      float transmittance = 1.0;
      const int PARALLAX_STEPS = 4;
      for (int i = 1; i <= PARALLAX_STEPS; i++) {
        vec2 uvi = vUv + viewUvStep * float(i);
        float di = sampleDensity(uvi);
        transmittance *= exp(-di * 0.55);
      }
      float thickAlpha = 1.0 - transmittance;
      float grazing = 1.0 - abs(dot(viewDir, n));
      density = mix(density, max(density, thickAlpha), grazing * uParallaxFade);
    }

    density = pow(clamp(density, 0.0, 1.0), uDensityGamma);
    density *= getLayerMask(vUv);

    // Self-shadow only on low layer, only on day side (night side brightness
    // is near-zero so shadow produces no visible change).
    float selfShadow = 1.0;
    if (uLayerChannel < 0.5 && uParallaxFade > 0.01 && dayFactor > 0.05) {
      vec2 sunUvOffset = worldDirToUv(uSunDir, n) * 0.025 * uDetailFade;
      float densityTowardSun = sampleDensity(vUv + sunUvOffset);
      selfShadow = exp(-densityTowardSun * uShadowStrength);
    }

    float brightness = mix(uNightAmbient, 1.6, dayFactor);
    // Self-shadow only meaningfully darkens the lit hemisphere; on the night
    // side the day factor already drives brightness to ~0.
    brightness *= mix(0.55, 1.0, selfShadow);

    // Global lightning flash: brief additive bump driven by the lightning-flash
    // event listener in CloudLayer.ts.
    brightness += uFlashIntensity * 0.4;

    // Dense clouds scatter more sunlight → appear whiter. Thin clouds
    // appear slightly grayer. Gives visible dynamic range in "whiteness."
    brightness *= mix(0.6, 1.0, density);

    vec3 color = vec3(brightness);
    float alpha = density * uOpacity;
    if (alpha < 0.005) discard;

    gl_FragColor = vec4(color, alpha);
  }
`;
