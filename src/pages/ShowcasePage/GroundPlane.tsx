import { useEffect, useRef, useMemo } from 'react';
import * as THREE from 'three';
import { useFrame, } from '@react-three/fiber';

// Custom ground with localized illumination
const GroundPlane = () => {
  const planeRef = useRef();
  const materialRef = useRef();
  const flashData = useRef({ active: false, intensity: 0, position: new THREE.Vector2(0, 0) });

  // Custom shader material for the ground
  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        flashIntensity: { value: 0.0 },
        flashPosition: { value: new THREE.Vector2(0, 0) },
        gridScale: { value: 20.0 },
        falloffRadius: { value: 5.0 }
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
        uniform float gridScale;
        uniform float falloffRadius;

        varying vec2 vUv;

        float getGrid(vec2 uv, float size) {
          vec2 g = abs(fract(uv * size - 0.5) - 0.5) / fwidth(uv * size);
          return 1.0 - min(min(g.x, g.y), 1.0);
        }

        void main() {
          // Transform UV from [0,1] to [-10,10] for a 20x20 grid
          vec2 gridUv = (vUv - 0.5) * 20.0;

          // Calculate distance from flash position for falloff
          float dist = length(gridUv - flashPosition);

          // Calculate light falloff - stronger toward center
          float falloff = 1.0 / (1.0 + dist * dist / (falloffRadius * falloffRadius));

          // Create grid pattern with primary and secondary lines
          float primaryGrid = getGrid(vUv, 2.0) * 0.15;
          float secondaryGrid = getGrid(vUv, 20.0) * 0.3;
          float grid = max(primaryGrid, secondaryGrid);

          // Calculate light color - brighter at center of flash
          float localFlashIntensity = flashIntensity * falloff;
          vec3 baseColor = vec3(0.15, 0.15, 0.15);
          vec3 flashColor = vec3(0.7, 0.7, 0.7);
          vec3 gridColor = mix(baseColor, flashColor, localFlashIntensity);

          // Darken grid lines
          gridColor = mix(gridColor, vec3(0.0, 0.0, 0.0), grid);

          // Add radial fade to black
          float fadeToBlack = 1.0 - smoothstep(0.4, 0.8, length(vUv - 0.5));
          gridColor *= fadeToBlack;

          gl_FragColor = vec4(gridColor, 1.0);
        }
      `,
      transparent: true
    });
  }, []);

  materialRef.current = material;

  // Update material when lightning strikes
  useFrame(() => {
    if (flashData.current.active && materialRef.current) {
      // Fade the flash intensity
      flashData.current.intensity *= 0.97;
      materialRef.current.uniforms.flashIntensity.value = flashData.current.intensity;

      if (flashData.current.intensity < 0.01) {
        flashData.current.active = false;
      }
    }
  });

  // Listen for lightning strikes
  useEffect(() => {
    const handleLightning = (event) => {
      flashData.current = {
        active: true,
        intensity: 1.0,
        position: event.detail?.position || new THREE.Vector2(0, 0)
      };

      if (materialRef.current) {
        materialRef.current.uniforms.flashIntensity.value = flashData.current.intensity;
        materialRef.current.uniforms.flashPosition.value = flashData.current.position;
      }
    };

    window.addEventListener('lightning-strike', handleLightning);
    return () => window.removeEventListener('lightning-strike', handleLightning);
  }, []);

  return (
    <mesh 
      ref={planeRef}
      position={[0, -1.8, 0]} 
      rotation={[-Math.PI / 2, 0, 0]}
      scale={[10, 10, 1]}
    >
      <planeGeometry args={[1, 1, 1, 1]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
};

export default GroundPlane;
