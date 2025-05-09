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
}

// LightningController - handles strike generation with improved timing
const LightningController = ({ detail = 1.0, speed = 1.0 }: LightningControllerProps) => {
  const { scene } = useThree();
  const strikeRef = useRef<LightningBoltEffect | null>(null);
  const timeRef = useRef<number>(0);
  const strikePending = useRef<boolean>(false);
  const currentSpeedRef = useRef<number>(speed);
  const startTimeRef = useRef<number>(0);

  // Current speed ref needs to be updated when the prop changes
  useEffect(() => {
    currentSpeedRef.current = speed;
    
    if (strikeRef.current) {
      strikeRef.current.updateSpeed(speed);
    }
  }, [speed]);

  // Create a lightning strike and coordinate with ground illumination
  const createNewStrike = () => {
    if (strikeRef.current) {
      strikeRef.current.terminateImmediately();
      strikeRef.current = null;
    }

    startTimeRef.current = performance.now() / 1000;

    const mockGlobeEl: MockGlobeEl = {
      getCoords: (lat: number, lng: number, alt: number) => {
        // This ensures the strike reaches the ground plane at y=-1.8
        const topY = 2;
        const bottomY = -1.8; // Ground level
        const y = alt * (topY - bottomY) + bottomY;
        return new THREE.Vector3(0, y, 0);
      }
    };

    const baseDuration = 1500; // baseDuration is used to synchronize strike and glow

    const config = {
      ...DEFAULT_LIGHTNING_BOLT_CONFIG,
      startAltitude: 1.0,
      resolution: detail,
      lineWidth: 3 * Math.max(0.5, detail),
      duration: baseDuration,
      speed: currentSpeedRef.current
    };

    const strike = new LightningBoltEffect(0, 0, config);
    strike.initialize(scene, mockGlobeEl);
    strikeRef.current = strike;

    strikeRef.current.setStartTime(startTimeRef.current);

    // Notify ground to light up with exact same start time
    window.dispatchEvent(new CustomEvent('lightning-strike', {
      detail: { 
        position: new THREE.Vector2(0, 0),
        speed: currentSpeedRef.current,
        startTime: startTimeRef.current // Pass exact start time for synchronization
      }
    }));

    // Reset flags - interval between strikes adjusted by speed
    strikePending.current = false;

    // Calculate next strike time - faster speed = shorter interval
    const baseInterval = 3500; // Base interval in milliseconds
    const randomVariation = 1500; // Random variation to add unpredictability
    timeRef.current = Date.now() + (baseInterval + Math.random() * randomVariation) / currentSpeedRef.current;
  };

  useEffect(() => {
    // Short delay before initial strike
    const timeout = setTimeout(createNewStrike, 500);

    return () => {
      clearTimeout(timeout);
      if (strikeRef.current) {
        strikeRef.current.terminateImmediately();
      }
    };
  }, []);

  // Animation updates
  useFrame(() => {
    const currentTime = Date.now();

    // Check if we should create a new strike
    if (currentTime > timeRef.current && !strikePending.current) {
      strikePending.current = true;
      setTimeout(createNewStrike, 100);
    }

    // Update existing strike with current speed
    if (strikeRef.current) {
      strikeRef.current.updateSpeed(currentSpeedRef.current);

      // Update the strike
      const isAlive = strikeRef.current.update(currentTime);

      // If strike is done and no new strike is pending, schedule a new one
      if (!isAlive && !strikePending.current) {
        strikePending.current = true;
        setTimeout(createNewStrike, 500 / currentSpeedRef.current);
      }
    }
  });

  return null;
};

export default LightningController;
