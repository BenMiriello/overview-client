import { useEffect, useRef, useMemo } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';

const PLANE_SIZE = 20;

function worldToGroundUV(worldX: number, worldZ: number): { x: number; y: number } {
  // Plane is rotated -90° around X, so local Y maps to -world Z
  return {
    x: (worldX / PLANE_SIZE) + 0.5,
    y: 0.5 - (worldZ / PLANE_SIZE)
  };
}

const GroundPlane = () => {
  const planeRef = useRef<THREE.Mesh | null>(null);
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        flashIntensity: { value: 0.0 },
        flashPosition: { value: new THREE.Vector2(0.5, 0.5) },
        time: { value: 0.0 }
      },
      vertexShader: `
        varying vec2 vUv;

        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float flashIntensity;
        uniform vec2 flashPosition;
        uniform float time;

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
          for (int i = 0; i < 4; i++) {
            v += a * noise(p);
            p = p * 2.0 + vec2(100.0);
            a *= 0.5;
          }
          return v;
        }

        void main() {
          float edgeDist = length((vUv - 0.5) * 2.0);
          float edgeFade = 1.0 - smoothstep(0.35, 0.9, edgeDist);

          // Multi-scale terrain noise
          float terrain = fbm(vUv * 6.0);
          float detail = noise(vUv * 24.0) * 0.15;

          // Dark earth tones with subtle variation
          vec3 darkEarth = vec3(0.025, 0.025, 0.03);
          vec3 lightEarth = vec3(0.045, 0.04, 0.035);
          vec3 groundColor = mix(darkEarth, lightEarth, terrain * 0.6 + detail);

          float groundAlpha = edgeFade * 0.7;

          // Lightning flash illumination
          float dist = distance(vUv, flashPosition);
          float glow = 1.0 - smoothstep(0.0, 0.25, dist);
          float scatter = (1.0 - smoothstep(0.0, 0.5, dist)) * 0.3;
          vec3 glowColor = vec3(0.8, 0.85, 1.0);
          float glowStrength = flashIntensity * (glow + scatter) * 0.8;

          // Flash also reveals ground terrain
          vec3 terrainReveal = groundColor * 3.0 * flashIntensity * (1.0 - smoothstep(0.0, 0.6, dist));

          vec3 finalColor = groundColor + glowColor * glowStrength * edgeFade + terrainReveal * edgeFade;
          // Cap brightness so ground flash doesn't trigger bloom
          finalColor = min(finalColor, vec3(0.7));
          float alpha = max(groundAlpha, glowStrength * edgeFade);

          gl_FragColor = vec4(finalColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false
    });
  }, []);

  if (material && !materialRef.current) {
    materialRef.current = material;
  }

  useFrame(({ clock }) => {
    if (materialRef.current) {
      materialRef.current.uniforms.time.value = clock.getElapsedTime();
    }
  });

  const lastLoggedPosRef = useRef<string | null>(null);

  useEffect(() => {
    const handleGlowUpdate = (event: CustomEvent) => {
      if (!materialRef.current) return;

      const { intensity, position } = event.detail;
      materialRef.current.uniforms.flashIntensity.value = intensity;

      if (position) {
        const uv = worldToGroundUV(position.x, position.z);
        materialRef.current.uniforms.flashPosition.value.set(uv.x, uv.y);

        // Debug: log position transform once per strike
        const posKey = `${position.x.toFixed(2)},${position.z.toFixed(2)}`;
        if (lastLoggedPosRef.current !== posKey) {
          lastLoggedPosRef.current = posKey;
          console.log('[GroundPlane] World pos:', position, '-> UV:', uv);
        }
      }
    };

    window.addEventListener('lightning-glow-update', handleGlowUpdate as EventListener);
    return () => window.removeEventListener('lightning-glow-update', handleGlowUpdate as EventListener);
  }, []);

  return (
    <mesh
      ref={planeRef}
      position={[0, -1.8, 0]}
      rotation={[-Math.PI / 2, 0, 0]}
      scale={[PLANE_SIZE, PLANE_SIZE, 1]}
    >
      <planeGeometry args={[1, 1, 1, 1]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
};

export default GroundPlane;
