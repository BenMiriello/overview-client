import { useRef, useEffect, useState, useCallback } from 'react';
import Globe from 'react-globe.gl';
import './App.css';
import { LightningStrike } from './models/LightningStrike';
import { useWebSocketService } from './services/websocketService';
import { LightningLayer, CloudLayer } from './layers';
import { GlobeLayerManager } from './managers';
import { getConfig } from './config';

function App() {
  const globeEl = useRef<any>(null);
  const layerManagerRef = useRef<GlobeLayerManager | null>(null);
  const [isGlobeReady, setIsGlobeReady] = useState(false);
  const [strikes, setStrikes] = useState<LightningStrike[]>([]);

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

      manager.createLayer<CloudLayer>('clouds', 'clouds');

      manager.createLayer<LightningLayer>('lightning', 'lightning');
      
      // // Ensure lightning starts from the cloud layer
      // if (lightning) {
      //   const cloudAltitude = getConfig<number>('layers.clouds.altitude') ?? 0.02;
      //   lightning.updateZigZagStartAltitude(cloudAltitude);
      // }

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

      const maxDisplayedStrikes = getConfig<number>('layers.lightning.maxDisplayedStrikes') ?? 256;
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
