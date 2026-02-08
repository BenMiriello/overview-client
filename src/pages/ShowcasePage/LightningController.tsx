import { useRef, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { LightningBoltEffect, LightningBoltEffectConfig, DetailLevel } from '../../effects/LightningBoltEffect';

interface LightningControllerProps {
  detail?: number;
  speed?: number;
}

const SHOWCASE_START = { x: 0, y: 1.5, z: 0 };
const SHOWCASE_END = { x: 0, y: -1.8, z: 0 };

const LightningController = ({ detail = 1.0, speed = 1.0 }: LightningControllerProps) => {
  const { scene, size } = useThree();
  const strikeRef = useRef<LightningBoltEffect | null>(null);
  const nextStrikeTime = useRef<number>(0);
  const speedRef = useRef(speed);

  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  const createNewStrike = useCallback(() => {
    if (strikeRef.current) {
      strikeRef.current.terminate();
      strikeRef.current = null;
    }

    const spread = 0.3;
    const offsetX = (Math.random() - 0.5) * spread;
    const offsetZ = (Math.random() - 0.5) * spread;

    const config: LightningBoltEffectConfig = {
      lat: 0,
      lng: 0,
      startAltitude: 1.0,
      groundAltitude: 0,
      resolution: detail,
      seed: Math.random() * 0xFFFFFFFF,
      enableScreenFlash: true,
      duration: 1.5,
      fadeTime: 0.3,
      detailLevel: DetailLevel.SHOWCASE,
      worldStart: { x: offsetX, y: SHOWCASE_START.y, z: offsetZ },
      worldEnd: { x: offsetX * 0.3, y: SHOWCASE_END.y, z: offsetZ * 0.3 },
    };

    const strike = new LightningBoltEffect(scene, null, config);
    strike.updateResolution(size.width, size.height);
    strikeRef.current = strike;

    window.dispatchEvent(new CustomEvent('lightning-strike', {
      detail: {
        position: new THREE.Vector2(0, 0),
        speed: speedRef.current,
        startTime: performance.now() / 1000,
      }
    }));

    const baseInterval = 3500;
    const randomVariation = 1500;
    nextStrikeTime.current = performance.now() + (baseInterval + Math.random() * randomVariation) / speedRef.current;
  }, [scene, size.width, size.height, detail]);

  // Resolution updates
  useEffect(() => {
    if (strikeRef.current) {
      strikeRef.current.updateResolution(size.width, size.height);
    }
  }, [size.width, size.height]);

  // Initial strike
  useEffect(() => {
    const timer = setTimeout(createNewStrike, 500);
    return () => {
      clearTimeout(timer);
      if (strikeRef.current) {
        strikeRef.current.terminate();
        strikeRef.current = null;
      }
    };
  }, []);

  useFrame(() => {
    const now = performance.now();

    if (strikeRef.current) {
      strikeRef.current.update(now);

      if (strikeRef.current.isComplete()) {
        strikeRef.current.terminate();
        strikeRef.current = null;
        nextStrikeTime.current = now + 500 / speedRef.current;
      }
    }

    if (!strikeRef.current && now > nextStrikeTime.current) {
      createNewStrike();
    }
  });

  return null;
};

export default LightningController;
