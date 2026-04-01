import { useRef, useMemo, useEffect } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';

const CLOUD_SIZE = 18;

interface CloudPlaneConfig {
  y: number;
  noiseOffset: number;
  noiseScale: number;
  opacity: number;
  threshold: [number, number];
}

const CLOUD_LAYERS: CloudPlaneConfig[] = [
  { y: 1.8, noiseOffset: 50.0, noiseScale: 2.5, opacity: 0.45, threshold: [0.32, 0.55] },
  { y: 1.5, noiseOffset: 0.0, noiseScale: 3.0, opacity: 0.85, threshold: [0.25, 0.50] },
  { y: 1.2, noiseOffset: 200.0, noiseScale: 3.5, opacity: 0.35, threshold: [0.35, 0.58] },
];

const cloudFragmentShader = `
  precision highp float;

  uniform float time;
  uniform float flashIntensity;
  uniform vec2 flashPosition;
  uniform vec2 windDir;
  uniform float windSpeed;
  uniform float noiseOffset;
  uniform float noiseScale;
  uniform float maxOpacity;
  uniform vec2 thresholdRange;

  varying vec2 vUv;
  varying vec3 vWorldPosition;

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
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p = rot * p * 2.0 + vec2(100.0);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 uv = vUv;
    vec2 drift = windDir * windSpeed * time * 0.01;
    vec2 base = (uv - 0.5) * noiseScale + vec2(noiseOffset);

    float density = fbm(base + drift);
    density += fbm(base * 2.0 + drift * 1.5) * 0.3;

    float cloudMask = smoothstep(thresholdRange.x, thresholdRange.y, density);

    float edgeDist = length((uv - 0.5) * 2.0);
    float edgeFade = 1.0 - smoothstep(0.3, 0.8, edgeDist);
    cloudMask *= edgeFade;

    vec3 cloudColor = vec3(0.12, 0.12, 0.16);

    float detail = fbm(base * 2.7 + drift * 0.8);
    cloudColor += vec3(detail * 0.06);

    float underside = smoothstep(0.35, 0.5, density) * 0.05;
    cloudColor -= vec3(underside);

    float flashDist = distance(uv, flashPosition);
    float flashGlow = (1.0 - smoothstep(0.0, 0.5, flashDist)) * flashIntensity;
    float flashScatter = (1.0 - smoothstep(0.0, 0.8, flashDist)) * flashIntensity * 0.3;
    vec3 flashColor = vec3(0.8, 0.82, 1.0);
    cloudColor += flashColor * (flashGlow * 1.2 + flashScatter);

    cloudColor = min(cloudColor, vec3(0.7));

    float alpha = cloudMask * maxOpacity;

    if (alpha < 0.01) discard;

    gl_FragColor = vec4(cloudColor, alpha);
  }
`;

const cloudVertexShader = `
  varying vec2 vUv;
  varying vec3 vWorldPosition;
  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

function createCloudMaterial(config: CloudPlaneConfig): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0.0 },
      flashIntensity: { value: 0.0 },
      flashPosition: { value: new THREE.Vector2(0.5, 0.5) },
      windDir: { value: new THREE.Vector2(1.0, 0.0) },
      windSpeed: { value: 0.3 },
      noiseOffset: { value: config.noiseOffset },
      noiseScale: { value: config.noiseScale },
      maxOpacity: { value: config.opacity },
      thresholdRange: { value: new THREE.Vector2(config.threshold[0], config.threshold[1]) },
    },
    vertexShader: cloudVertexShader,
    fragmentShader: cloudFragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

const CloudLayer = () => {
  const materialsRef = useRef<THREE.ShaderMaterial[]>([]);

  const materials = useMemo(() => {
    return CLOUD_LAYERS.map(config => createCloudMaterial(config));
  }, []);

  useEffect(() => {
    materialsRef.current = materials;
  }, [materials]);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    for (const mat of materialsRef.current) {
      mat.uniforms.time.value = t;
    }
  });

  useEffect(() => {
    const handleGlowUpdate = (event: CustomEvent) => {
      const { intensity, position } = event.detail;
      for (const mat of materialsRef.current) {
        mat.uniforms.flashIntensity.value = intensity;
        if (position) {
          mat.uniforms.flashPosition.value.set(
            (position.x / CLOUD_SIZE) + 0.5,
            0.5 - (position.z / CLOUD_SIZE),
          );
        }
      }
    };

    window.addEventListener('lightning-glow-update', handleGlowUpdate as EventListener);
    return () => window.removeEventListener('lightning-glow-update', handleGlowUpdate as EventListener);
  }, []);

  return (
    <>
      {CLOUD_LAYERS.map((config, i) => (
        <mesh
          key={i}
          position={[0, config.y, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
        >
          <planeGeometry args={[CLOUD_SIZE, CLOUD_SIZE]} />
          <primitive object={materials[i]} attach="material" />
        </mesh>
      ))}
    </>
  );
};

export default CloudLayer;
