import React, { useRef, useEffect, useState } from 'react';
import Globe from 'react-globe.gl';
import { GlobeLayerManager } from '../managers';

interface GlobeComponentProps {
  onGlobeReady: (globeEl: any) => void;
  onLayerManagerReady: (layerManager: GlobeLayerManager) => void;
}

export const GlobeComponent: React.FC<GlobeComponentProps> = ({
  onGlobeReady,
  onLayerManagerReady
}) => {
  const globeEl = useRef<any>(null);
  const layerManagerRef = useRef<GlobeLayerManager | null>(null);
  const [isGlobeReady, setIsGlobeReady] = useState(false);

  // Initialize layer manager and globe controls
  useEffect(() => {
    if (isGlobeReady && globeEl.current) {
      // Set up globe controls
      try {
        const controls = globeEl.current.controls();
        if (controls) {
          controls.autoRotateSpeed = 0.067; // ISS orbital speed
          controls.minDistance = 120; // Zoom in limit
          controls.maxDistance = 10000; // Zoom out limit
        }

        globeEl.current.pointOfView({
          lat: 10,
          lng: -33,
          altitude: 2.5
        });
      } catch (err) {
        console.error("Error setting up globe:", err);
      }

      // Initialize layer manager
      if (!layerManagerRef.current) {
        const manager = new GlobeLayerManager();
        manager.initialize(globeEl.current);
        layerManagerRef.current = manager;
        onLayerManagerReady(manager);
      }

      // Signal that globe is ready
      onGlobeReady(globeEl.current);
    }
  }, [isGlobeReady, onGlobeReady, onLayerManagerReady]);

  // Cleanup on unmount
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
    />
  );
};
