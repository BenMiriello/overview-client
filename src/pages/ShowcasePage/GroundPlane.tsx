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
  startTime: number;
  duration: number;
}

// Custom ground with localized illumination
const GroundPlane = ({ speed = 1.0 }: GroundPlaneProps) => {
  const planeRef = useRef<THREE.Mesh | null>(null);
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);
  const flashData = useRef<FlashData>({ 
    active: false, 
    intensity: 0, 
    position: new THREE.Vector2(0, 0),
    speed: speed,
    startTime: 0,
    duration: 1500 // Default duration in ms
  });

  // Custom shader material for the ground with improved grid and glow
  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        flashIntensity: { value: 0.0 },
        flashPosition: { value: new THREE.Vector2(0, 0) },
        gridScale: { value: 20.0 },
        falloffRadius: { value: 6.0 }
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

        // Improved grid function with increased thickness
        float getGrid(vec2 uv, float size) {
          // Calculate grid cell boundaries with increased thickness
          vec2 cell = abs(fract(uv * size - 0.5) - 0.5);

          // Create thicker lines by reducing the fwidth multiplier
          // Lower values = thicker lines
          vec2 fw = fwidth(uv * size) * 0.5; // Changed from 0.7 to 0.5 for thicker lines

          // Calculate falloff from grid lines
          vec2 grid = smoothstep(vec2(0.0), fw, cell);

          // Combine x and y components
          return 1.0 - min(grid.x, grid.y);
        }

        void main() {
          // All grid lines should be exactly the same color and thickness
          float primaryGrid = getGrid(vUv, 2.0);
          float secondaryGrid = getGrid(vUv, 16.0);

          // Use the same coefficient for both grids to ensure consistency
          float grid = max(primaryGrid, secondaryGrid);

          // Base grid color - pure white for all lines
          vec3 baseColor = vec3(0.0);
          vec3 gridLineColor = vec3(1.0); // Pure white for all lines
          vec3 gridColor = mix(baseColor, gridLineColor, grid);

          // Calculate distance from center (the strike position) for the glow effect
          // Use center position (0,0) which is where the strike is happening
          vec2 centeredPosition = vec2(0.0, 0.0);
          float dist = length((vUv - 0.5) * 2.0 - centeredPosition);

          // Create a radial falloff for the glow effect
          // This places the glow directly under the strike
          float glowFalloff = 1.0 - smoothstep(0.0, 0.5, dist);

          // Combine with flash intensity for final glow effect
          float glowStrength = flashIntensity * glowFalloff * 0.5;

          // Glow color - slight blue tint for lightning effect
          vec3 glowColor = vec3(0.9, 0.95, 1.0);

          // Apply glow to both grid lines and spaces between
          vec3 finalColor = mix(gridColor, glowColor, glowStrength);

          // Fade out at edges
          float edgeFade = 1.0 - smoothstep(0.4, 0.95, length((vUv - 0.5) * 2.0));
          finalColor *= edgeFade;

          // Calculate alpha - make grid lines fully visible and add glow
          float alpha = min(1.0, grid + glowStrength * 0.7) * edgeFade;

          gl_FragColor = vec4(finalColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false
    });
  }, []);

  // Store material reference
  if (material && !materialRef.current) {
    materialRef.current = material;
  }

  // Synchronized animation update with exact timing to match lightning
  useFrame(() => {
    if (flashData.current.active && materialRef.current) {
      const currentTime = Date.now();
      const elapsed = currentTime - flashData.current.startTime;
      const duration = flashData.current.duration;

      // Match the exact animation phases of the lightning effect
      if (elapsed < duration) {
        const phaseRatio = elapsed / duration;

        // First third: fade in
        if (phaseRatio < 0.33) {
          const fadeInProgress = phaseRatio / 0.33;
          flashData.current.intensity = Math.min(1.0, fadeInProgress);
        } 
        // Second third: full brightness
        else if (phaseRatio < 0.66) {
          flashData.current.intensity = 1.0;
        } 
        // Final third: fade out
        else {
          const fadeOutProgress = (phaseRatio - 0.66) / 0.34;
          flashData.current.intensity = Math.max(0.0, 1.0 - fadeOutProgress);
        }

        // Update material uniform
        materialRef.current.uniforms.flashIntensity.value = flashData.current.intensity;
      } else {
        // Animation complete
        flashData.current.active = false;
        flashData.current.intensity = 0;
        materialRef.current.uniforms.flashIntensity.value = 0;
      }
    }
  });

  // Listen for lightning strikes
  useEffect(() => {
    const handleLightning = (event: CustomEvent) => {
      const strikeSpeed = event.detail?.speed || speed;

      // Calculate duration to match the lightning strike exactly
      // This ensures the ground glow fades out with the lightning
      const baseDuration = 1500; // ms - should match lightning duration
      const duration = baseDuration / strikeSpeed;

      // Always use centered position for the glow
      const position = new THREE.Vector2(0, 0);

      // Configure flash data with precise timing
      flashData.current = {
        active: true,
        intensity: 0.0, // Start at zero and follow the animation curve
        position: position,
        speed: strikeSpeed,
        startTime: Date.now(),
        duration: duration
      };

      // Update material uniforms
      if (materialRef.current) {
        materialRef.current.uniforms.flashPosition.value = position;
        materialRef.current.uniforms.flashIntensity.value = 0;
      }
    };

    // Listen for custom lightning strike events
    window.addEventListener('lightning-strike', handleLightning as EventListener);

    return () => {
      window.removeEventListener('lightning-strike', handleLightning as EventListener);
    };
  }, [speed]);

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
