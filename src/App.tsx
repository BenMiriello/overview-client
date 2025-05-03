import { useRef, useEffect, useState, useCallback } from 'react';
import Globe from 'react-globe.gl';
import * as THREE from 'three';
import './App.css';
import { LightningStrike } from './models/LightningStrike';
import { useWebSocketService } from './services/websocketService';
import { LightningManager } from './effects/LightningManager';
import { DEFAULT_LIGHTNING_CONFIG } from './effects/LightningEffect';

function App() {
  const globeEl = useRef<any>(null);
  const lightningManagerRef = useRef<LightningManager | null>(null);
  const [isGlobeReady, setIsGlobeReady] = useState(false);
  const [strikes, setStrikes] = useState<LightningStrike[]>([]);

  const handleGlobeReady = () => {
    setIsGlobeReady(true);
  };

  // Initialize lightning manager when globe is ready
  useEffect(() => {
    if (isGlobeReady && globeEl.current) {
      // Create lightning manager with enhanced settings
      const manager = new LightningManager({
        // Enhanced lightning configuration
        startAltitude: 0.05,      // Higher for more dramatic effect
        width: 4.5,               // Thicker lines for visibility
        segments: 10,             // More zigzag segments for complexity
        jitterAmount: 0.022,      // More randomness for natural look
        branchChance: 0.5,        // Higher chance of branches
        branchFactor: 0.8,        // Longer branches
        maxBranches: 5,           // More branches
        duration: 1000,           // Length of lightning animation
        fadeOutDuration: 300      // Fade out duration
      });
      
      manager.initialize(globeEl.current);
      lightningManagerRef.current = manager;
      
      // Set up animation loop
      const animate = () => {
        if (lightningManagerRef.current) {
          lightningManagerRef.current.update(Date.now());
        }
        requestAnimationFrame(animate);
      };
      
      animate();
    }
  }, [isGlobeReady]);

  // Handler for new strikes coming from WebSocket
  const handleNewStrike = useCallback((newStrike: LightningStrike) => {
    setStrikes(prev => {
      // Create a new strike and trigger lightning effect
      if (lightningManagerRef.current) {
        lightningManagerRef.current.createLightning(newStrike);
      }
      
      // Keep track of strikes
      return [newStrike, ...prev].slice(0, 1000);
    });
  }, []);

  // Connect to WebSocket service
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
          controls.autoRotate = true;
          controls.autoRotateSpeed = 0.067; // ISS orbital speed
          
          // Set min and max zoom distances
          // controls.minDistance = 130;
          controls.maxDistance = 500;
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
          onGlobeReady={handleGlobeReady}
          globeImageUrl="https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg"
          bumpImageUrl="https://unpkg.com/three-globe/example/img/earth-topology.png"
          backgroundImageUrl="https://unpkg.com/three-globe/example/img/night-sky.png"
        />
        {connected ? (
          <div className="status-bar">
            Connected | Strikes: {strikes.length} | Lightning Effects: {lightningManagerRef.current?.getActiveCount() || 0} | Last update: {lastUpdate}
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
