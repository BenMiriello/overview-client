import { useRef } from 'react';
import { OrbitControls } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import GroundPlane from './GroundPlane';
import LightningController from './LightningController';

interface SceneProps {
  detail?: number;
  speed?: number;
}

const Scene = ({ detail = 1.0, speed = 1.0 }: SceneProps) => {
  // Use object type instead of null
  const controlsRef = useRef<any>();

  // Lock camera to horizontal rotation
  useFrame(() => {
    if (controlsRef.current) {
      // Access controls object properties safely
      const controls = controlsRef.current;
      if (controls.minPolarAngle !== undefined) {
        controls.minPolarAngle = Math.PI / 2;
        controls.maxPolarAngle = Math.PI / 2;
      }
    }
  });

  return (
    <>
      <ambientLight intensity={0.15} />
      
      {/* Rotated by 20 degrees around Y axis */}
      <group rotation={[0, Math.PI * 20 / 180, 0]}>
        <GroundPlane speed={speed} />
        <LightningController detail={detail} speed={speed} />
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
