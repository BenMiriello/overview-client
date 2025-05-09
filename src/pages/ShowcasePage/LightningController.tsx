import { useRef, useEffect } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { LightningBoltEffect, DEFAULT_LIGHTNING_BOLT_CONFIG } from '../../effects/LightningBoltEffect';

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

export default LightningController;
