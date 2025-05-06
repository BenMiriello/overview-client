import { useRef, useEffect, useState, useCallback } from 'react';
import Globe from 'react-globe.gl';
import './App.css';
import { LightningStrike } from './models/LightningStrike';
import { useWebSocketService } from './services/websocketService';
import { LightningLayer, CloudLayer } from './layers';
import { GlobeLayerManager } from './managers';

function App() {
  const globeEl = useRef<any>(null);
  const layerManagerRef = useRef<GlobeLayerManager | null>(null);
  const [isGlobeReady, setIsGlobeReady] = useState(false);
  const [strikes, setStrikes] = useState<LightningStrike[]>([]);
  const maxDisplayedStrikes = 256;

  // Initialize layer manager and layers
  useEffect(() => {
    if (isGlobeReady && globeEl.current) {
      // Create layer manager if not exists
      if (!layerManagerRef.current) {
        const manager = new GlobeLayerManager();
        manager.initialize(globeEl.current);
        layerManagerRef.current = manager;
      } else {
        // Clean up existing layers before re-initialization
        layerManagerRef.current.clearAllLayers();
      }

      const manager = layerManagerRef.current;

      const cloudConfig = {
        altitude: 0.02,
        opacity: 0.6,
        size: 3.5,
        imagePath: '/clouds.png',  // Make sure this file exists in the public directory
        rotationSpeed: 0.002  // Counter-clockwise rotation speed (degrees per frame)
      };
      
      manager.createLayer<CloudLayer>('clouds', 'clouds', cloudConfig);

      const lightningConfig = {
        maxActiveAnimations: 10,
        maxDisplayedStrikes: maxDisplayedStrikes,
        showZigZag: true, // Enable lightning
        zigZagConfig: {
          startAltitude: cloudConfig.altitude,
          lineWidth: 3.5,
          lineSegments: 8,
          jitterAmount: 0.02,
          branchChance: 0.4,
          branchFactor: 0.7,
          maxBranches: 4,
          duration: 1000,
          fadeOutDuration: 300
        },
        markerConfig: {
          radius: 0.08,
          color: 0xffffff,
          opacity: 0.8
        }
      };

      // Create lightning layer and configure it to start from cloud layer
      const lightning = manager.createLayer<LightningLayer>('lightning', 'lightning', lightningConfig);
      if (lightning) {
        lightning.updateZigZagStartAltitude(cloudConfig.altitude);
      }

      // Clean up function for when component unmounts
      return () => {
        if (layerManagerRef.current) {
          layerManagerRef.current.dispose();
          layerManagerRef.current = null;
        }
      };
    }
  }, [isGlobeReady]);

  const handleNewStrike = useCallback((newStrike: LightningStrike) => {
    setStrikes(prev => {
      if (layerManagerRef.current) {
        const lightningLayer = layerManagerRef.current.getLayer<LightningLayer>('lightning');
        if (lightningLayer) {
          lightningLayer.addData(newStrike);
        }
      }

      return [newStrike, ...prev].slice(0, maxDisplayedStrikes);
    });
  }, []);

  const { connected, lastUpdate } = useWebSocketService({
    url: 'ws://localhost:3001',
    onNewStrike: handleNewStrike
  });

  // Set up globe controls
  useEffect(() => {
    if (isGlobeReady && globeEl.current) {
      try {
        const controls = globeEl.current.controls();
        if (controls) {
          // controls.autoRotate = true;
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
    }
  }, [isGlobeReady]);

  return (
    <div className="App">
      <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
        <Globe
          ref={globeEl}
          onGlobeReady={() => setIsGlobeReady(true)}
          globeImageUrl="https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg"
          bumpImageUrl="https://unpkg.com/three-globe/example/img/earth-topology.png"
          backgroundImageUrl="https://unpkg.com/three-globe/example/img/night-sky.png"
        />
        {connected ? (
          <div className="status-bar">
            Connected | Strikes: {strikes.length} | 
            Lightning Effects: {layerManagerRef.current?.getLayer<LightningLayer>('lightning')?.getActiveZigZagCount() || 0} | 
            Markers: {layerManagerRef.current?.getLayer<LightningLayer>('lightning')?.getMarkerCount() || 0} | 
            Last update: {lastUpdate}
          </div>
        ) : (
          <div className="status-bar error">
            Disconnected from server
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
