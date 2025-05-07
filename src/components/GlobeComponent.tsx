import React, { useRef, useEffect, useState } from 'react';
import Globe from 'react-globe.gl';
import { GlobeLayerManager } from '../managers';
import { easeInOutCubicShifted } from '../utils';

interface GlobeComponentProps {
  onGlobeReady: (globeEl: any) => void;
  onLayerManagerReady: (layerManager: GlobeLayerManager) => void;
}

const introCameraMovement = (globeEl: React.RefObject<any>): { cancel: () => void } => {
  let startTime: number | null = null;
  let animationFrameId: number | null = null;
  let isCanceled = false;

  const initialLat = 10;
  const initialLng = -22;
  const initialAltitude = 4;

  globeEl.current.pointOfView({ lat: initialLat, lng: initialLng, altitude: initialAltitude }, 0);

  // Wrapped in a timeout to prevent conflicts with built-in animations
  setTimeout(() => {
    if (isCanceled) return;

    const duration = 5000;
    const longitudinalRotation = 33; // degrees
    const lateralRotation = 10; // degrees
    const altShift = -1;

    const animate = (timestamp: number) => {
      if (isCanceled) return;
      startTime ||= timestamp;
      const elapsed = timestamp - startTime;

      if (elapsed < duration) {
        const t = elapsed / duration;
        const progress = easeInOutCubicShifted(t, 1/4);

        const newLng = initialLng - (longitudinalRotation * progress);
        const newLat = initialLat + (lateralRotation * progress);
        const newAlt = initialAltitude + (altShift * progress);

        globeEl.current.pointOfView({ lat: newLat, lng: newLng, altitude: newAlt }, 0);

        animationFrameId = requestAnimationFrame(animate);

      // } else {
      //   // Note: Auto-rotate is disabled for now since I can't get a smooth transition to it coming
      //   //   ... out of the zoom in camera movement. So for now we can only have one or the other.

      //   const controls = globeEl.current.controls();
      //   controls.autoRotate = true;
      }
    };

    animationFrameId = requestAnimationFrame(animate);
  }, 0);

  return {
    cancel: () => {
      isCanceled = true;
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
    }
  };
};



export const GlobeComponent: React.FC<GlobeComponentProps> = ({
  onGlobeReady,
  onLayerManagerReady
}) => {
  const globeEl = useRef<any>(null);
  const layerManagerRef = useRef<GlobeLayerManager | null>(null);
  const [isGlobeReady, setIsGlobeReady] = useState(false);
  const animationRef = useRef<{ cancel: () => void } | null>(null);

  useEffect(() => {
    if (isGlobeReady && globeEl.current) {
      try {
        const controls = globeEl.current.controls();
        if (controls) {
          // Auto-rotation will be initiated conditionally by introCameraMovement
          controls.autoRotateSpeed = 0.067; // 0.067 ISS orbital speed
          controls.minDistance = 105; // Zoom in limit
          controls.maxDistance = 10000; // Zoom out limit

          const stopCameraMovement = () => {
            if (animationRef.current) {
              animationRef.current.cancel();
              animationRef.current = null;
            }
            controls.autoRotate = false;
          };

          // Event listeners to detect user interaction
          controls.domElement.addEventListener('mousedown', stopCameraMovement);
          controls.domElement.addEventListener('wheel', stopCameraMovement);
          controls.domElement.addEventListener('touchstart', stopCameraMovement);
        }

        // Start the intro animation and store the cancellation function
        animationRef.current = introCameraMovement(globeEl);
      } catch (err) {
        console.error("Error setting up globe:", err);
      }

      if (!layerManagerRef.current) {
        const manager = new GlobeLayerManager();
        manager.initialize(globeEl.current);
        layerManagerRef.current = manager;
        onLayerManagerReady(manager);
      }

      onGlobeReady(globeEl.current);

      return () => {
        try {
          if (globeEl.current) {
            const controls = globeEl.current.controls();
            if (controls && controls.domElement) {
              // Remove all event listeners
              const clone = controls.domElement.cloneNode(true);
              if (controls.domElement.parentNode) {
                controls.domElement.parentNode.replaceChild(clone, controls.domElement);
              }
            }
          }

          if (animationRef.current) {
            animationRef.current.cancel();
            animationRef.current = null;
          }
        } catch (err) {
          console.error("Error cleaning up event listeners:", err);
        }
      };
    }
  }, [isGlobeReady, onGlobeReady, onLayerManagerReady]);

  useEffect(() => {
    return () => {
      if (layerManagerRef.current) {
        layerManagerRef.current.dispose();
        layerManagerRef.current = null;
      }
    };
  }, []);

  return (
    <Globe
      ref={globeEl}
      onGlobeReady={() => setIsGlobeReady(true)}
      globeImageUrl="https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg"
      bumpImageUrl="https://unpkg.com/three-globe/example/img/earth-topology.png"
      backgroundImageUrl="https://unpkg.com/three-globe/example/img/night-sky.png"
      animateIn={false}
    />
  );
};
