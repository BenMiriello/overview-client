import { useEffect, useRef, useMemo } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';

interface GroundPlaneProps {
  speed?: number;
}

interface FlashData {
  active: boolean;
  intensity: number;
  position: THREE.Vector2;
  speed: number;
}

// Custom ground with localized illumination
const GroundPlane = ({ speed = 1.0 }: GroundPlaneProps) => {
  const planeRef = useRef<THREE.Mesh | null>(null);
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);
  const flashData = useRef<FlashData>({ 
    active: false, 
    intensity: 0, 
    position: new THREE.Vector2(0, 0),
    speed: speed
  });

  // Custom shader material for the ground
  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        flashIntensity: { value: 0.0 },
        flashPosition: { value: new THREE.Vector2(0, 0) },
        gridScale: { value: 20.0 },
        falloffRadius: { value: 7.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vPos;

        void main() {
          vUv = uv;
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float flashIntensity;
        uniform vec2 flashPosition;
        uniform float gridScale;
        uniform float falloffRadius;

        varying vec2 vUv;
        varying vec3 vPos;

        float getGrid(vec2 uv, float size) {
          vec2 g = abs(fract(uv * size - 0.5) - 0.5) / fwidth(uv * size);
          // Make lines thicker by adjusting the threshold
          float thickness = 0.8; // Higher values = thicker lines (0.0-1.0)
          return 1.0 - min(min(g.x, g.y) * thickness, 1.0);
        }

        void main() {
          // Transform UV from [0,1] to center-based coordinates
          vec2 centeredUv = vUv * 2.0 - 1.0; // Now goes from -1 to 1
          
          // Distance from center for overall fade
          float distFromCenter = length(centeredUv);
          
          // Transform UV for grid patterns
          vec2 gridUv = (vUv - 0.5) * 30.0; // Larger scale for grid pattern
          
          // Calculate distance from flash center for illumination falloff
          float distFromFlash = length(gridUv - flashPosition);
          
          // Calculate light falloff - stronger toward center
          float falloff = 1.0 / (1.0 + distFromFlash * distFromFlash / (falloffRadius * falloffRadius));
          
          // Create grid pattern with primary and secondary lines
          float primaryGrid = getGrid(vUv, 2.0) * 0.7;  // Thicker primary lines
          float secondaryGrid = getGrid(vUv, 15.0) * 0.9;  // Thinner secondary lines
          float grid = max(primaryGrid, secondaryGrid);
          
          // Base (unlit) grid is black background with white lines
          vec3 baseColor = vec3(0.0, 0.0, 0.0);
          vec3 gridLineColor = vec3(0.85, 0.85, 0.85); // Brighter white grid lines
          vec3 gridColor = mix(baseColor, gridLineColor, grid * 0.9); // Increased mixing
          
          // Illuminated color - pure white
          vec3 flashColor = vec3(1.0, 1.0, 1.0);
          float localFlashIntensity = flashIntensity * falloff * 0.5; // Reduced intensity by 50%
          
          // Mix base grid with illumination
          gridColor = mix(gridColor, flashColor, localFlashIntensity);
          
          // Radial fade to black from center
          float edgeFade = 1.0 - smoothstep(0.4, 0.95, distFromCenter);
          
          // Apply fade to both color and alpha
          vec3 finalColor = gridColor * edgeFade;
          float alpha = edgeFade * (grid * 0.9 + localFlashIntensity);
          
          gl_FragColor = vec4(finalColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false // Helps with transparency issues
    });
  }, []);

  // Store material reference
  if (material && !materialRef.current) {
    materialRef.current = material;
  }

  // Update material when lightning strikes
  useFrame(() => {
    if (flashData.current.active && materialRef.current) {
      // Fade the flash intensity - adjusted by speed
      // Slower fade to match the lightning fade
      flashData.current.intensity *= Math.pow(0.94, flashData.current.speed); // Slower decay
      materialRef.current.uniforms.flashIntensity.value = flashData.current.intensity;

      if (flashData.current.intensity < 0.01) {
        flashData.current.active = false;
      }
    }
  });

  // Listen for lightning strikes
  useEffect(() => {
    const handleLightning = (event: CustomEvent) => {
      // Start at lower intensity to match fade-in of lightning
      flashData.current = {
        active: true,
        intensity: 0.5, // Start at half intensity to match lightning fade-in
        position: event.detail?.position || new THREE.Vector2(0, 0),
        speed: event.detail?.speed || speed
      };

      if (materialRef.current) {
        materialRef.current.uniforms.flashIntensity.value = flashData.current.intensity;
        materialRef.current.uniforms.flashPosition.value = flashData.current.position;
      }
    };

    // Listen for custom lightning strike events
    window.addEventListener('lightning-strike', handleLightning as EventListener);
    
    return () => {
      window.removeEventListener('lightning-strike', handleLightning as EventListener);
    };
  }, []);  // Only run on mount

  return (
    <mesh 
      ref={planeRef}
      position={[0, -1.8, 0]} 
      rotation={[-Math.PI / 2, 0, 0]}
      scale={[20, 20, 1]}
    >
      <planeGeometry args={[1, 1, 1, 1]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
};

export default GroundPlane;
