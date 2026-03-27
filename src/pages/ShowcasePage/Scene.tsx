import { useRef } from 'react';
import { OrbitControls } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import GroundPlane from './GroundPlane';
import LightningController from './LightningController';
import SkyDome from './SkyDome';

interface SceneProps {
  detail?: number;
  speed?: number;
  windSpeed?: number;
  showCharge?: boolean;
  showAtmospheric?: boolean;
  showMoisture?: boolean;
  showIonization?: boolean;
  orbit?: boolean;
}

const Scene = ({ detail = 1.0, speed = 1.0, windSpeed = 25, showCharge = true, showAtmospheric = true, showMoisture = true, showIonization = true, orbit = false }: SceneProps) => {
  const controlsRef = useRef<any>(null);

  // Lock camera to horizontal rotation + auto-orbit
  useFrame(() => {
    if (controlsRef.current) {
      const controls = controlsRef.current;
      if (controls.minPolarAngle !== undefined) {
        controls.minPolarAngle = Math.PI / 2;
        controls.maxPolarAngle = Math.PI / 2;
      }

      // Auto-rotate counterclockwise when orbit is enabled
      // autoRotateSpeed = 1 gives ~1 rotation per minute, negative = counterclockwise
      if (controls.autoRotate !== undefined) {
        controls.autoRotate = orbit;
        controls.autoRotateSpeed = -1;
      }
    }
  });

  return (
    <>
      <SkyDome />
      <ambientLight intensity={0.15} />

      {/* Rotated by 20 degrees around Y axis */}
      <group rotation={[0, Math.PI * 20 / 180, 0]}>
        <GroundPlane />
        <LightningController detail={detail} speed={speed} windSpeed={windSpeed} showCharge={showCharge} showAtmospheric={showAtmospheric} showMoisture={showMoisture} showIonization={showIonization} />
      </group>

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

export default Scene;
