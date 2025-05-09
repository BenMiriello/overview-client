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
  currentSpeed: number; // Track current speed for immediate updates
  startTime: number;
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
    currentSpeed: speed,
    startTime: 0
  });

  // Update speed reference when prop changes
  useEffect(() => {
    flashData.current.currentSpeed = speed;
  }, [speed]);

  // Custom shader material for the ground with improved grid and glow
  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        flashIntensity: { value: 0.0 },
        flashPosition: { value: new THREE.Vector2(0, 0) },
        time: { value: 0.0 }
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
        uniform float time;

        varying vec2 vUv;
        varying vec3 vPos;

        // Improved grid function that creates thick, consistent lines
        float getGrid(vec2 uv, float size) {
          // Calculate distance to nearest grid line 
          vec2 grid = abs(fract(uv * size - 0.5) - 0.5);
          
          // Calculate wider lines with a fixed pixel width 
          // 0.2 = thicker lines, 0.4 = thinner lines
          vec2 pixelWidth = fwidth(uv * size) * 0.25;
          
          // Create smooth falloff to prevent aliasing
          return 1.0 - smoothstep(0.0, pixelWidth.x, grid.x) * smoothstep(0.0, pixelWidth.y, grid.y);
        }

        void main() {
          // Calculate consistent grid with dimmer color
          float primaryGrid = getGrid(vUv, 2.0);
          float secondaryGrid = getGrid(vUv, 16.0);
          
          // Combine grids with same brightness
          float grid = max(primaryGrid, secondaryGrid);
          
          // Create consistent grid color (dimmer white/gray)
          vec3 baseColor = vec3(0.0);
          vec3 gridLineColor = vec3(0.7, 0.7, 0.7); // Less bright, consistent gray for all lines
          vec3 gridColor = mix(baseColor, gridLineColor, grid);
          
          // Centered glow effect
          float dist = distance((vUv - 0.5) * 2.0, vec2(0.0));
          float glow = 1.0 - smoothstep(0.0, 0.5, dist); // Radial glow centered at origin
          
          // Glow effect controlled by flashIntensity - slightly blue-white
          vec3 glowColor = vec3(0.9, 0.95, 1.0);
          
          // Create grid with glow effect - applied to both grid lines and spaces between
          float glowStrength = flashIntensity * glow * 0.7; // Reduced brightness
          
          // Combine grid with glow 
          vec3 finalColor = mix(gridColor, glowColor, glowStrength);
          
          // Fade out at edges
          float edgeFade = 1.0 - smoothstep(0.4, 0.95, length((vUv - 0.5) * 2.0));
          finalColor *= edgeFade;
          
          // Calculate alpha for grid lines and glow
          float alpha = (grid * 0.7 + glowStrength * 0.5) * edgeFade;
          
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

  // Handle flash animation with sync to lightning strike
  useFrame(({ clock }) => {
    // Immediately apply current speed when it changes
    if (materialRef.current && flashData.current.active) {
      const elapsedTime = (clock.getElapsedTime() - flashData.current.startTime);
      const currentSpeed = flashData.current.currentSpeed;
      
      // Scale time by speed to make animation faster/slower immediately when speed changes
      const scaledTime = elapsedTime * currentSpeed;
      const totalDuration = 1.5; // seconds
      
      if (scaledTime <= totalDuration) {
        // Animation phases to match lightning
        if (scaledTime < 0.5) {
          // Fade in (0-0.5s scaled)
          const fadeProgress = scaledTime / 0.5;
          flashData.current.intensity = fadeProgress;
        } 
        else if (scaledTime < 1.0) {
          // Full brightness (0.5-1.0s scaled)
          flashData.current.intensity = 1.0;
        } 
        else {
          // Fade out (1.0-1.5s scaled)
          const fadeProgress = (scaledTime - 1.0) / 0.5;
          flashData.current.intensity = Math.max(0, 1.0 - fadeProgress);
        }
        
        // Update material
        materialRef.current.uniforms.flashIntensity.value = flashData.current.intensity;
      } else {
        // End animation
        flashData.current.active = false;
        flashData.current.intensity = 0;
        materialRef.current.uniforms.flashIntensity.value = 0;
      }
    }
    
    // Update time uniform
    if (materialRef.current) {
      materialRef.current.uniforms.time.value = clock.getElapsedTime();
    }
  });

  // Listen for lightning strikes
  useEffect(() => {
    const handleLightning = (event: CustomEvent) => {
      // Update speed immediately when strike happens
      const strikeSpeed = event.detail?.speed || speed;
      
      // Reset flash data with current time
      flashData.current = {
        active: true,
        intensity: 0.0, // Start at zero and animate up
        position: new THREE.Vector2(0, 0), // Always centered
        speed: strikeSpeed,
        currentSpeed: strikeSpeed, // Track current speed
        startTime: performance.now() / 1000 // Convert to seconds
      };

      // Update material uniforms
      if (materialRef.current) {
        materialRef.current.uniforms.flashPosition.value = new THREE.Vector2(0, 0);
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
