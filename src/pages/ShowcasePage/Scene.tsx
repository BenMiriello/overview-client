import { useRef } from 'react';
import { OrbitControls } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import GroundPlane from './GroundPlane';
import CloudGrid from './CloudGrid';
import LightningController from './LightningController';

const Scene = ({ detail }: { detail: number | undefined }) => {
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
      <GroundPlane />
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

export default Scene;
