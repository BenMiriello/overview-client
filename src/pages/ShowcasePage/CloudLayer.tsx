import { useRef, useMemo, useEffect } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';

const CLOUD_Y = 1.5;
const CLOUD_SIZE = 12;

const CloudLayer = () => {
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0.0 },
        flashIntensity: { value: 0.0 },
        flashPosition: { value: new THREE.Vector2(0.5, 0.5) },
        windDir: { value: new THREE.Vector2(1.0, 0.0) },
        windSpeed: { value: 0.3 },
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vWorldPosition;
        void main() {
          vUv = uv;
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPos.xyz;
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: `
        precision highp float;

        uniform float time;
        uniform float flashIntensity;
        uniform vec2 flashPosition;
        uniform vec2 windDir;
        uniform float windSpeed;

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

          // Wind drift
          vec2 drift = windDir * windSpeed * time * 0.01;

          // Multi-octave cloud density
          float density = fbm((uv - 0.5) * 3.0 + drift);
          density += fbm((uv - 0.5) * 6.0 + drift * 1.5) * 0.3;

          // Shape clouds with threshold - lower threshold = more coverage
          float cloudMask = smoothstep(0.25, 0.50, density);

          // Edge fade
          float edgeDist = length((uv - 0.5) * 2.0);
          float edgeFade = 1.0 - smoothstep(0.5, 0.95, edgeDist);
          cloudMask *= edgeFade;

          // Base cloud color: visible dark gray against navy sky
          vec3 cloudColor = vec3(0.12, 0.12, 0.16);

          // Internal variation - darker and lighter patches
          float detail = fbm((uv - 0.5) * 8.0 + drift * 0.8);
          cloudColor += vec3(detail * 0.06);

          // Darker undersides (viewer looks up at cloud base)
          float underside = smoothstep(0.35, 0.5, density) * 0.05;
          cloudColor -= vec3(underside);

          // Lightning illumination from below
          float flashDist = distance(uv, flashPosition);
          float flashGlow = (1.0 - smoothstep(0.0, 0.4, flashDist)) * flashIntensity;
          vec3 flashColor = vec3(0.7, 0.75, 0.9);
          cloudColor += flashColor * flashGlow * 0.6;

          float alpha = cloudMask * 0.85;

          if (alpha < 0.01) discard;

          gl_FragColor = vec4(cloudColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }, []);

  useEffect(() => {
    materialRef.current = material;
  }, [material]);

  useFrame(({ clock }) => {
    if (materialRef.current) {
      materialRef.current.uniforms.time.value = clock.getElapsedTime();
    }
  });

  // Listen for lightning flash events to illuminate clouds
  useEffect(() => {
    const handleGlowUpdate = (event: CustomEvent) => {
      if (!materialRef.current) return;
      const { intensity, position } = event.detail;
      materialRef.current.uniforms.flashIntensity.value = intensity;
      if (position) {
        const uv = {
          x: (position.x / CLOUD_SIZE) + 0.5,
          y: 0.5 - (position.z / CLOUD_SIZE),
        };
        materialRef.current.uniforms.flashPosition.value.set(uv.x, uv.y);
      }
    };

    window.addEventListener('lightning-glow-update', handleGlowUpdate as EventListener);
    return () => window.removeEventListener('lightning-glow-update', handleGlowUpdate as EventListener);
  }, []);

  return (
    <mesh
      position={[0, CLOUD_Y, 0]}
      rotation={[-Math.PI / 2, 0, 0]}
    >
      <planeGeometry args={[CLOUD_SIZE, CLOUD_SIZE]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
};

export default CloudLayer;
