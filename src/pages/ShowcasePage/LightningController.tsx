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
  const currentSpeedRef = useRef<number>(speed);

  // Update the current speed ref when the prop changes
  useEffect(() => {
    currentSpeedRef.current = speed;
  }, [speed]);

  // Create a lightning strike and coordinate with ground illumination
  const createNewStrike = () => {
    // Clean up previous strike if it exists
    if (strikeRef.current) {
      strikeRef.current.terminateImmediately();
      strikeRef.current = null;
    }

    // Mock globe element - adjusted to ensure strike reaches ground
    const mockGlobeEl: MockGlobeEl = {
      getCoords: (lat: number, lng: number, alt: number) => {
        // Make sure the strike extends all the way to the ground plane at y=-1.8
        const y = alt * 3.0 - 1.5;
        return new THREE.Vector3(0, y, 0);
      },
      _mainSphere: {
        geometry: {
          parameters: { radius: 3 }
        }
      }
    };

    // Create strike config with speed-adjusted durations
    // Base duration scaled inversely by speed (faster speed = shorter duration)
    const baseDuration = 1500; // Match this with ground plane animation
    const duration = Math.round(baseDuration / currentSpeedRef.current);
    
    const config = {
      ...DEFAULT_LIGHTNING_BOLT_CONFIG,
      startAltitude: 1.0,
      endAltitude: -0.1, // Ensure it reaches below ground level (-1.8)
      lineSegments: Math.floor(10 * detail),
      lineWidth: 3 * detail,
      jitterAmount: 0.008 * detail,
      branchChance: 0.4 * detail,
      maxBranches: Math.floor(4 * detail),
      duration: duration, // Speed-adjusted duration
      speed: currentSpeedRef.current // Pass speed directly to the effect
    };

    // Create centered strike
    const strike = new LightningBoltEffect(0, 0, config);
    strike.initialize(scene, mockGlobeEl);
    strikeRef.current = strike;

    // Notify ground to light up - trigger the event exactly when lightning starts
    // The ground plane will handle timing synchronization
    window.dispatchEvent(new CustomEvent('lightning-strike', {
      detail: { 
        position: new THREE.Vector2(0, 0), // Center position
        speed: currentSpeedRef.current,
        duration: duration // Pass duration to ensure synchronization
      }
    }));

    // Reset flags - interval between strikes adjusted by speed
    strikePending.current = false;
    // Faster speed = shorter interval between strikes
    const baseInterval = 3500; // Base interval in milliseconds
    const randomVariation = 1500; // Random variation to add unpredictability
    timeRef.current = Date.now() + (baseInterval + Math.random() * randomVariation) / currentSpeedRef.current;
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
        // Faster speed = shorter interval between strikes
        const waitTime = 500 / currentSpeedRef.current;
        setTimeout(createNewStrike, waitTime);
      }
    }
  });

  return null;
};

export default LightningController;
