import { useEffect, useRef, useState, useMemo } from 'react';
import * as THREE from 'three';
import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { LightningBoltEffect, DEFAULT_LIGHTNING_BOLT_CONFIG } from '../../effects/LightningBoltEffect';
import { NavigationIcons } from '../../components/Navigation';
import './ShowcasePage.css';

// Custom ground with localized illumination
const Ground = () => {
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

// Cloud grid - simpler and more subtle
const CloudGrid = () => (
  <gridHelper 
    args={[8, 16, 0x444444, 0x222222]} 
    position={[0, 1.5, 0]} 
  >
    <meshBasicMaterial transparent opacity={0.25} />
  </gridHelper>
);

// LightningController - handles strike generation with improved timing
const LightningController = ({ detail = 1.0 }) => {
  const { scene } = useThree();
  const strikeRef = useRef(null);
  const timeRef = useRef(0);
  const strikePending = useRef(false);

  // Create a lightning strike and coordinate with ground illumination
  const createNewStrike = () => {
    // Clean up previous strike
    if (strikeRef.current) {
      strikeRef.current.terminateImmediately();
      strikeRef.current = null;
    }

    // Mock globe element - adjusted to bring strike closer
    const mockGlobeEl = {
      getCoords: (lat, lng, alt) => {
        // Scale to fit properly in scene - adjusted height
        const y = alt * 3.3 - 1.8; // Brought 25% closer
        return new THREE.Vector3(0, y, 0);
      },
      _mainSphere: {
        geometry: {
          parameters: { radius: 3 }
        }
      }
    };

    // Create strike config
    const config = {
      ...DEFAULT_LIGHTNING_BOLT_CONFIG,
      startAltitude: 1.0,
      endAltitude: 0.0,
      lineSegments: Math.floor(10 * detail),
      lineWidth: 3 * detail,
      jitterAmount: 0.008 * detail,
      branchChance: 0.4 * detail,
      maxBranches: Math.floor(4 * detail),
      duration: 1500, // Match duration to our shader fade rate
    };

    // Create centered strike
    const strike = new LightningBoltEffect(0, 0, config);
    strike.initialize(scene, mockGlobeEl);
    strikeRef.current = strike;

    // Notify ground to light up - at exactly the same time
    window.dispatchEvent(new CustomEvent('lightning-strike', {
      detail: { position: new THREE.Vector2(0, 0) }
    }));

    // Reset flags
    strikePending.current = false;
    timeRef.current = Date.now() + 2000 + Math.random() * 2000;
  };

  useEffect(() => {
    // Initial strike after a short delay
    const timeout = setTimeout(createNewStrike, 500);

    return () => {
      clearTimeout(timeout);
      if (strikeRef.current) {
        strikeRef.current.terminateImmediately();
      }
    };
  }, [scene, detail]);

  // Animation updates
  useFrame(() => {
    const currentTime = Date.now();

    // Create new strike when needed, but don't queue multiple
    if (currentTime > timeRef.current && !strikePending.current && 
        (!strikeRef.current || !strikeRef.current.update(currentTime))) {
      strikePending.current = true;
      setTimeout(createNewStrike, 100);
    } else if (strikeRef.current) {
      strikeRef.current.update(currentTime);
    }
  });

  return null;
};

// Main scene setup
const Scene = ({ detail }) => {
  const controlsRef = useRef();

  // Lock camera to horizontal rotation
  useFrame(() => {
    if (controlsRef.current) {
      controlsRef.current.setPolarAngle(Math.PI / 2);
    }
  });

  return (
    <>
      <ambientLight intensity={0.15} />
      <Ground />
      <CloudGrid />
      <LightningController detail={detail} />
      <OrbitControls 
        ref={controlsRef}
        enableZoom={false}
        enablePan={false}
        minPolarAngle={Math.PI / 2}
        maxPolarAngle={Math.PI / 2}
        dampingFactor={0.05}
        rotateSpeed={0.5}
      />
    </>
  );
};

const ShowcasePage = () => {
  const [detail, setDetail] = useState(1.0);

  return (
    <div className="showcase-page">
      <Canvas 
        camera={{ position: [0, 0, 8], fov: 50 }}
        style={{ background: '#000' }}
      >
        <Scene detail={detail} />
      </Canvas>

      <NavigationIcons currentPage="lightning" />

      <div className="controls">
        <div className="slider-container">
          <label htmlFor="detail-slider">Detail:</label>
          <input
            id="detail-slider"
            type="range"
            min="0.2"
            max="2"
            step="0.1"
            value={detail}
            onChange={(e) => setDetail(parseFloat(e.target.value))}
          />
          <span>{detail.toFixed(1)}</span>
        </div>
      </div>
    </div>
  );
};

export default ShowcasePage;
