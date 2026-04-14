// Phase 7+8 cloud shader. Single shell, normal-derived 3D relief shading from
// the matteason heightmap. See client/docs/clouds.md and the
// splendid-coalescing-river plan for the rationale; in short:
//
//   density   = base raster (matteason live cloud cover) modulated by a
//               high-frequency FBM detail noise so the source raster gains
//               sub-pixel structure when zoomed in. Tone-mapped via
//               smoothstep so wispy mid-tones are preserved instead of
//               crushed by a gamma curve.
//   relief    = 4-tap neighbor sample of the same raster as a heightmap.
//               The local gradient perturbs the sphere normal; the
//               perturbed normal is Lambertian-shaded against the sun
//               direction to give per-fragment 3D relief that does not
//               ghost (no view-direction parallax, no multi-shell stack).
//   shadow    = cloud shadows on the ground are handled by the surface
//               shader (dayNightMaterial), not the cloud shell.
//   day/night = same flat-normal sun-dot brightness ramp the phong patch
//               used in Phase 1, kept separate from the relief term so the
//               terminator stays smooth.
//   rim       = brightness boost where the flat sun-dot is near zero — the
//               sunset cloud-top crescent. Brightness only, no hue tint.

export const cloudVertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;

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
  uniform float uOpacity;
  uniform float uTime;
  uniform float uDetailStrength;
  uniform vec2  uDetailFreq;
  uniform float uFlashIntensity;
  uniform vec3  uFlashWorldPos;
  uniform float uFlashFalloff;
  uniform float uDetailFade;
  uniform float uDensityLo;
  uniform float uNightAmbient;
  uniform vec2  uTexelSize;
  uniform float uBumpStrength;
  uniform float uReliefAmount;

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;

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

  float sampleHeight(vec2 uv) {
    return texture2D(uMap, uv).a;
  }

  // Density signal: heightmap modulated by FBM micro-detail. The detail
  // term is camera-independent (no zoom-dependent frequency) so the noise
  // pattern is locked to world coordinates and doesn't flicker on zoom.
  float sampleDensity(vec2 uv) {
    float base = sampleHeight(uv);
    float ds = uDetailStrength * uDetailFade;
    float detail = fbm(uv * uDetailFreq + vec2(uTime * 0.0008, 0.0));
    return base * mix(1.0 - ds, 1.0 + ds, detail);
  }

  void main() {
    vec3 n = normalize(vWorldNormal);
    vec3 toCamera = normalize(cameraPosition - vWorldPos);

    if (!gl_FrontFacing) {
      // Only render the inner cloud surface when the camera is inside the shell.
      if (length(cameraPosition) > length(vWorldPos) + 1.0) discard;
      // Discard back-face fragments below the camera's visual horizon — where the
      // Earth would occlude them. depthTest:false means we can't rely on the depth
      // buffer, so we replicate the occlusion geometrically.
      //
      // The horizon from a camera at distance D is the cone of directions where
      // dot(camUp, dir) = -sqrt(1 - R²/D²)  (tangent to the Earth sphere).
      // Directions with dot < that threshold go below the horizon into the Earth.
      float camDist = length(cameraPosition);
      vec3 toFrag = normalize(vWorldPos - cameraPosition);
      float horizonDot = -sqrt(max(0.0, 1.0 - (100.0 * 100.0) / (camDist * camDist)));
      if (dot(normalize(cameraPosition), toFrag) < horizonDot) discard;
    } else {
      // Front faces: discard back-hemisphere fragments (behind the earth).
      if (dot(n, toCamera) < -0.05) discard;
    }

    // Equirectangular cloud texture is aligned 90° east of the globe surface UVs.
    vec2 cloudUV = vec2(vUv.x + 0.25, vUv.y);

    // Linear floor remap. We deliberately do NOT use smoothstep on the dense end:
    // a sigmoid there saturates plateaus and kills relief gradients. Linear remap
    // preserves the source's natural gradient across the whole range.
    float rawDensity = sampleDensity(cloudUV);
    float density = clamp((rawDensity - uDensityLo) / (1.0 - uDensityLo), 0.0, 1.0);
    // Smooth onset at cloud edges: fades from zero over [0, uDensityLo + 0.08] so
    // the hard contour at the floor threshold becomes a gradual feather.
    float edgeFactor = smoothstep(0.0, uDensityLo + 0.08, rawDensity);

    // Local east/north tangent basis at this fragment, used for the
    // relief gradient.
    vec3 east  = normalize(cross(vec3(0.0, 1.0, 0.0), n));
    vec3 north = cross(n, east);

    // 4-tap neighbor heights for the gradient. We sample at a multi-texel
    // stride so the gradient captures cloud-feature scale (~20–40 km), not
    // pixel-level satellite noise that would otherwise produce spiky
    // jagged relief. v=0 is the north pole in three-globe equirectangular
    // convention, so 'north' direction → -dv.
    vec2 stride = uTexelSize * 3.0;
    float hE = sampleHeight(cloudUV + vec2(stride.x, 0.0));
    float hW = sampleHeight(cloudUV - vec2(stride.x, 0.0));
    float hN = sampleHeight(cloudUV - vec2(0.0, stride.y));
    float hS = sampleHeight(cloudUV + vec2(0.0, stride.y));

    float dHdE = (hE - hW);
    float dHdN = (hN - hS);

    // Heightfield normal in tangent basis (east, north, up=sphereNormal):
    //   normalize(-dh/dx, -dh/dy, 1)
    vec3 perturbedNormal = normalize(
      n - (east * dHdE + north * dHdN) * uBumpStrength
    );

    float flatDot = dot(n, uSunDir);
    float bumpDot = dot(perturbedNormal, uSunDir);

    float dayFactor = smoothstep(-0.15, 0.15, flatDot);

    // Relief modulates brightness around 1.0. Subtracting flatDot isolates
    // the local relief contribution from the global sun angle so the
    // terminator stays driven by the flat normal.
    float relief = 1.0 + (bumpDot - flatDot) * uReliefAmount;
    relief = clamp(relief, 0.7, 1.3);

    float brightness = mix(uNightAmbient, 1.15, dayFactor) * relief;

    // Rim light at the terminator: bright sunset cloud-top crescent.
    // Brightness only, no hue change (color tinting deferred). Gated by
    // density > 0.4 so it only fires on substantial clouds, not on
    // faint daylight wisps.
    float rim = (1.0 - abs(flatDot)) * smoothstep(-0.05, 0.15, flatDot);
    brightness += rim * 0.35 * smoothstep(0.4, 0.7, density);

    // Positional lightning flash: localized glow around the strike point.
    // Use angular distance (dot product) to avoid the ~3-unit altitude offset
    // between the surface flash pos and the cloud shell dominating Euclidean distance.
    // Gaussian gives bright center that diffuses out rather than a sharp ring.
    float cosAngle = dot(normalize(vWorldPos), normalize(uFlashWorldPos));
    float flashGlow = uFlashIntensity * exp(-max(0.0, 1.0 - cosAngle) * uFlashFalloff);

    // Drive all cloud fragments toward full brightness before tinting — this flattens relief
    // and ensures the subsequent cool tint is visible even on already-white day clouds.
    brightness = clamp(brightness + flashGlow * 2.0, 0.0, 1.0);

    vec3 color = vec3(brightness);
    // Cool tint: with brightness at 1.0, mixing toward (0.82, 0.9, 1.0) pulls R and G
    // slightly below white → perceptible blue-white hue shift rather than invisible brightening.
    vec3 flashTint = vec3(0.82, 0.9, 1.0);
    color = mix(color, flashTint, clamp(flashGlow * 0.5, 0.0, 0.65));

    // WISPY_SCALE: opacity of the sparsest clouds relative to the densest.
    // The smoothstep blend from WISPY_SCALE → 1.0 gives the density response curve:
    // thin cirrus stays transparent, thick systems go fully opaque.
    const float WISPY_SCALE = 0.65;
    float denseBlend = smoothstep(0.4, 0.8, density);
    float shapedAlpha = edgeFactor * mix(density * WISPY_SCALE, density, denseBlend);

    // uOpacity is a uniform scalar over all clouds. At 1.0 dense clouds reach full
    // opacity; lower values dim all clouds proportionally without altering the
    // wispy/dense contrast ratio.
    float alpha = clamp(shapedAlpha * uOpacity + flashGlow * 0.4 * density, 0.0, 1.0);
    if (alpha < 0.005) discard;

    gl_FragColor = vec4(color, alpha);
  }
`;
