import React, { useRef, useEffect, useState } from 'react';
import Globe from 'react-globe.gl';
import { GlobeLayerManager } from '../managers';
import { easeInOutCubicShifted } from '../utils';

interface TargetPosition {
  lat: number;
  lng: number;
}

interface GlobeComponentProps {
  onGlobeReady: (globeEl: any) => void;
  onLayerManagerReady: (layerManager: GlobeLayerManager) => void;
  targetPosition?: TargetPosition | null;
}

const DEFAULT_TARGET = { lat: 20, lng: -55 };

const introCameraMovement = (
  globeEl: React.RefObject<any>,
  target: TargetPosition,
): { cancel: () => void } => {
  let startTime: number | null = null;
  let animationFrameId: number | null = null;
  let isCanceled = false;

  // Start offset from target so the swoop lands on it
  const initialAltitude = 4;
  const initialLat = target.lat - 10;
  const initialLng = target.lng + 33;

  globeEl.current.pointOfView({ lat: initialLat, lng: initialLng, altitude: initialAltitude }, 0);

  setTimeout(() => {
    if (isCanceled) return;

    const duration = 5000;
    const latDelta = target.lat - initialLat;
    const lngDelta = target.lng - initialLng;
    const altShift = -1;

    const animate = (timestamp: number) => {
      if (isCanceled) return;
      startTime ||= timestamp;
      const elapsed = timestamp - startTime;

      if (elapsed < duration) {
        const t = elapsed / duration;
        const progress = easeInOutCubicShifted(t, 1/4);

        globeEl.current.pointOfView({
          lat: initialLat + latDelta * progress,
          lng: initialLng + lngDelta * progress,
          altitude: initialAltitude + altShift * progress,
        }, 0);

        animationFrameId = requestAnimationFrame(animate);
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
  onLayerManagerReady,
  targetPosition,
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
          controls.minDistance = 100.1; // Very close surface zoom for max tile detail
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

        // Start the intro animation targeting the hotspot or default position
        const target = targetPosition ?? DEFAULT_TARGET;
        animationRef.current = introCameraMovement(globeEl, target);
      } catch (err) {
        console.error("Error setting up globe:", err);
      }

      // Enable progressive satellite tile loading.
      // react-globe.gl's ref only exposes a whitelist of methods, so globeTileEngineUrl
      // isn't on the ref directly. The underlying threeGlobe THREE.Group (from globe.gl's
      // fromKapsule wrapper) has it — find it by traversing the scene.
      const scene = globeEl.current.scene() as any;
      if (scene) {
        scene.traverse((obj: any) => {
          if (typeof obj.globeTileEngineUrl === 'function') {
            obj.globeTileEngineUrl(
              (x: number, y: number, level: number) =>
                `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${level}/${y}/${x}`
            );
            obj.globeTileEngineMaxLevel(17);
          }
        });
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
