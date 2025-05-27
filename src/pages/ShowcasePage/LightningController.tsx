import { useRef, useEffect } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { LightningBoltEffect, LightningBoltEffectConfig } from '../../effects/LightningBoltEffect';

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

// Mock globe element for showcase
const mockGlobeEl: MockGlobeEl = {
  getCoords: (lat: number, lng: number, alt: number) => {
    // Map normalized altitude (0-1) to Y position in showcase scene
    const groundY = -1.8;
    const cloudY = 1.5;

    const y = groundY + (cloudY - groundY) * alt;

    // Add horizontal spread based on lat/lng
    const spreadRadius = 0.5;
    const x = lat * spreadRadius;
    const z = lng * spreadRadius;

    return new THREE.Vector3(x, y, z);
  },
  _mainSphere: {
    geometry: {
      parameters: { radius: 3 }
    }
  }
};

// LightningController - handles strike generation with improved timing
const LightningController = ({ detail = 1.0, speed = 1.0 }: LightningControllerProps) => {
  const { scene } = useThree();
  const strikeRef = useRef<LightningBoltEffect | null>(null);
  const timeRef = useRef<number>(0);
  const strikePending = useRef<boolean>(false);
  const currentSpeedRef = useRef<number>(speed);
  const startTimeRef = useRef<number>(0);

  // Update existing strike speed if one exists
  useEffect(() => {
    currentSpeedRef.current = speed;
  }, [speed]);

  // Create a lightning strike with random position
  const createNewStrike = () => {
    // Clean up previous strike if it exists
    if (strikeRef.current) {
      strikeRef.current.terminate();
      strikeRef.current = null;
    }

    // Store exact start time for synchronization
    startTimeRef.current = performance.now() / 1000;

    // Base duration - same for all animations for synchronization
    const baseDuration = 1500; // milliseconds

    // Random position within reasonable bounds
    const randomLat = (Math.random() - 0.5) * 2; // -1 to 1
    const randomLng = (Math.random() - 0.5) * 2; // -1 to 1

    const config: LightningBoltEffectConfig = {
      lat: randomLat,
      lng: randomLng,
      startAltitude: 1.0,  // Normalized altitude (1.0 = cloud level)
      groundAltitude: 0,   // Normalized altitude (0 = ground)
      resolution: detail,
      seed: Math.random() * 10000,
      enableScreenFlash: true,
      duration: baseDuration / 1000,
      fadeTime: 0.3
    };

    // Create centered strike
    const strike = new LightningBoltEffect(scene, mockGlobeEl, config);
    strikeRef.current = strike;

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
    // Initial strike after a short delay
    const timeout = setTimeout(createNewStrike, 500);

    return () => {
      clearTimeout(timeout);
      if (strikeRef.current) {
        strikeRef.current.terminate();
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

    // Update existing strike with current speed
    if (strikeRef.current) {
      strikeRef.current.update(currentTime);
      const isAlive = !strikeRef.current.isComplete();

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
