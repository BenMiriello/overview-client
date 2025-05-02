import { useRef, useEffect, useState, useCallback } from 'react';
import Globe from 'react-globe.gl';
import * as THREE from 'three';
import './App.css';
import { 
  LightningStrike, 
  getStrikeSize, 
  getStrikeOpacity,
  getGlowOpacity,
  isStrikeExpired,
  LIGHTNING_CONSTANTS
} from './models/LightningStrike';
import { useWebSocketService } from './services/websocketService';

// Define proper types that match the Globe component expectations
type CustomThreeObjectFn = (d: object) => THREE.Object3D;
type CustomThreeObjectUpdateFn = (obj: THREE.Object3D, d: object) => void;

function App() {
  const globeEl = useRef<any>(null);
  const [isGlobeReady, setIsGlobeReady] = useState(false);
  const [strikes, setStrikes] = useState<LightningStrike[]>([]);

  const handleGlobeReady = () => {
    setIsGlobeReady(true);
  };

  // Handler for new strikes coming from WebSocket
  const handleNewStrike = useCallback((newStrike: LightningStrike) => {
    setStrikes(prev => [newStrike, ...prev].slice(0, LIGHTNING_CONSTANTS.MAX_STRIKES));
  }, []);

  // Connect to WebSocket service
  const { connected, lastUpdate } = useWebSocketService({
    url: 'ws://localhost:3001',
    onNewStrike: handleNewStrike
  });

  // Custom Three.js object for lightning strikes - with proper typing
  const createLightningObjectFn: CustomThreeObjectFn = useCallback((d) => {
    const strike = d as LightningStrike;

    // Create a group to hold both the core and glow
    const group = new THREE.Group();

    // Add the core (white sphere)
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 12),
      new THREE.MeshBasicMaterial({ 
        color: 0xffffff,
        transparent: true,
        opacity: 1.0
      })
    );
    group.add(core);

    // Add the glow (larger yellowish sphere)
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(1.5, 12, 12),
      new THREE.MeshBasicMaterial({ 
        color: 0xffffa0, 
        transparent: true,
        opacity: 0.5
      })
    );
    group.add(glow);

    // Store reference data
    group.userData = {
      strikeId: strike.id,
      createdAt: strike.createdAt
    };

    return group;
  }, []);

  // Update function for lightning objects - with proper typing
  const updateLightningObjectFn: CustomThreeObjectUpdateFn = useCallback((obj, d) => {
    if (!globeEl.current) return;

    const group = obj as THREE.Group;
    const strike = d as LightningStrike;
    const currentTime = Date.now();

    // Position the object at the correct lat/lng/altitude
    const coords = globeEl.current.getCoords(strike.lat, strike.lng, 0.01);
    Object.assign(group.position, coords);

    // Calculate size based on age
    const size = getStrikeSize(strike, currentTime);
    group.scale.set(size, size, size);

    // Calculate opacities based on age
    const coreOpacity = getStrikeOpacity(strike, currentTime);
    const glowOpacity = getGlowOpacity(strike, currentTime);

    // Update materials
    const coreMaterial = (group.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    coreMaterial.opacity = coreOpacity;

    const glowMaterial = (group.children[1] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    glowMaterial.opacity = glowOpacity;
  }, []);

  // Animation loop to update strikes
  useEffect(() => {
    if (!strikes.length) return;

    const animateStrikes = () => {
      const currentTime = Date.now();

      // Filter out expired strikes
      setStrikes(prevStrikes => 
        prevStrikes.filter(strike => !isStrikeExpired(strike, currentTime))
      );

      // Continue animation loop
      requestAnimationFrame(animateStrikes);
    };

    const animationId = requestAnimationFrame(animateStrikes);
    return () => cancelAnimationFrame(animationId);
  }, [strikes]);

  useEffect(() => {
    if (isGlobeReady && globeEl.current) {
      try {
        const controls = globeEl.current.controls();
        if (controls) {
          controls.autoRotate = true;
          controls.autoRotateSpeed = 0.25;
        }

        globeEl.current.pointOfView({
          lat: 10,
          lng: -33,
          altitude: 4
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

          customLayerData={strikes}
          customThreeObject={createLightningObjectFn}
          customThreeObjectUpdate={updateLightningObjectFn}
        />
        {connected ? (
          <div className="status-bar">
            Connected | Strikes: {strikes.length} | Last update: {lastUpdate}
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
