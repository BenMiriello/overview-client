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

        void main() {
          float edgeDist = length((vUv - 0.5) * 2.0);
          float edgeFade = 1.0 - smoothstep(0.3, 0.85, edgeDist);

          // Subtle terrain noise for ground texture
          float n = noise(vUv * 8.0) * 0.4 + noise(vUv * 16.0) * 0.2;
          vec3 groundColor = vec3(0.03, 0.03, 0.04) + vec3(n * 0.02);
          float groundAlpha = edgeFade * 0.6;

          // Flash glow on top of base ground
          float dist = distance(vUv, flashPosition);
          float glow = 1.0 - smoothstep(0.0, 0.2, dist);
          vec3 glowColor = vec3(0.85, 0.9, 1.0);
          float glowStrength = flashIntensity * glow * 0.9;

          vec3 finalColor = groundColor + glowColor * glowStrength * edgeFade;
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
