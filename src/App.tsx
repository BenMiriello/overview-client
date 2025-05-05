import { useRef, useEffect, useState, useCallback } from 'react';
import Globe from 'react-globe.gl';
import './App.css';
import { LightningStrike } from './models/LightningStrike';
import { useWebSocketService } from './services/websocketService';
import { LightningManager } from './effects/LightningManager';

function App() {
  const globeEl = useRef<any>(null);
  const lightningManagerRef = useRef<LightningManager | null>(null);
  const [isGlobeReady, setIsGlobeReady] = useState(false);
  const [strikes, setStrikes] = useState<LightningStrike[]>([]);
  const maxDisplayedStrikes = 20;

  // Initialize lightning manager
  useEffect(() => {
    if (isGlobeReady && globeEl.current) {
      const manager = new LightningManager({
        startAltitude: 0.1,
        lineWidth: 4.5,
        lineSegments: 10,
        jitterAmount: 0.022,
        branchChance: 0.5,
        branchFactor: 0.8,
        maxBranches: 5,
        duration: 1000,
        fadeOutDuration: 300
      });

      // Top-level switchbox to toggle these values:
      manager.maxActiveAnimations = 10;
      manager.showGlow = false;
      manager.showLightning = false;

      // Clear any lingering effects
      manager.clearAllLightningEffects();
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

  const handleNewStrike = useCallback((newStrike: LightningStrike) => {
    setStrikes(prev => {
      if (lightningManagerRef.current) {
        lightningManagerRef.current.createLightning(newStrike);
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
