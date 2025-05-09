import { useRef, useEffect } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { LightningBoltEffect, DEFAULT_LIGHTNING_BOLT_CONFIG } from '../../effects/LightningBoltEffect';

interface LightningControllerProps {
  detail?: number;
  speed?: number;
}

interface MockGlobeEl {
  getCoords: (lat: number, lng: number, alt: number) => THREE.Vector3;
  _mainSphere: {
    geometry: {
      parameters: { radius: number }
    }
  };
}

// LightningController - handles strike generation with improved timing
const LightningController = ({ detail = 1.0, speed = 1.0 }: LightningControllerProps) => {
  const { scene } = useThree();
  const strikeRef = useRef<LightningBoltEffect | null>(null);
  const timeRef = useRef<number>(0);
  const strikePending = useRef<boolean>(false);

  // Create a lightning strike and coordinate with ground illumination
  const createNewStrike = () => {
    // Clean up previous strike if it exists
    if (strikeRef.current) {
      strikeRef.current.terminateImmediately();
      strikeRef.current = null;
    }

    // Mock globe element - adjusted to bring strike closer
    const mockGlobeEl: MockGlobeEl = {
      getCoords: (lat: number, lng: number, alt: number) => {
        // Scale to fit properly in scene - adjusted height
        const y = alt * 3.0 - 1.5; // Brought 25% closer again
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
      duration: 1800, // Slightly longer duration to match grid fade
    };

    // Create centered strike
    const strike = new LightningBoltEffect(0, 0, config);
    strike.initialize(scene, mockGlobeEl);
    strikeRef.current = strike;

    // Notify ground to light up - at exactly the same time
    window.dispatchEvent(new CustomEvent('lightning-strike', {
      detail: { 
        position: new THREE.Vector2(0, 0),
        speed: speed
      }
    }));

    // Reset flags - interval between strikes adjusted by speed
    strikePending.current = false;
    timeRef.current = Date.now() + (3000 + Math.random() * 2000) / speed;
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
  }, []);  // Only run on mount

  // Animation updates
  useFrame(() => {
    const currentTime = Date.now();
    
    // Check if we should create a new strike
    if (currentTime > timeRef.current && !strikePending.current) {
      strikePending.current = true;
      setTimeout(createNewStrike, 100);
    }
    
    // Update existing strike if present
    if (strikeRef.current) {
      const isAlive = strikeRef.current.update(currentTime);
      
      // If strike is done and no new strike is pending, schedule a new one
      if (!isAlive && !strikePending.current) {
        strikePending.current = true;
        setTimeout(createNewStrike, 500);
      }
    }
  });

  return null;
};

export default LightningController;
