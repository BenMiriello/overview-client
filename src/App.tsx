import { useRef, useEffect, useState, useCallback } from 'react';
import Globe from 'react-globe.gl';
import * as THREE from 'three';
import './App.css';
import { 
  LightningStrike,
  getLineLength,
  getCircleSize,
  getCircleOpacity,
  getLineOpacity,
  getStrikeAltitude,
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

  // Custom Three.js object for lightning strikes
  const createLightningObjectFn: CustomThreeObjectFn = useCallback((d) => {
    const strike = d as LightningStrike;
    const group = new THREE.Group();

    // 1. Add the lightning bolt line 
    const lineGeometry = new THREE.BufferGeometry();
    // Will be updated in the update function
    const lineVertices = new Float32Array(6); // 2 points x 3 components (x,y,z)
    lineGeometry.setAttribute('position', new THREE.BufferAttribute(lineVertices, 3));

    const lineMaterial = new THREE.LineBasicMaterial({ 
      color: 0xffffc0,
      transparent: true,
      opacity: 1.0,
      linewidth: 4.5 // 3x thicker line
    });

    const line = new THREE.Line(lineGeometry, lineMaterial);
    group.add(line);

    // 2. Add circle (will appear on impact)
    const circle = new THREE.Mesh(
      new THREE.CircleGeometry(1, 32),
      new THREE.MeshBasicMaterial({ 
        color: 0xffffff,
        transparent: true,
        opacity: 0.0, // Start invisible
        side: THREE.DoubleSide
      })
    );
    group.add(circle);

    // Store reference data
    group.userData = {
      strikeId: strike.id,
      createdAt: strike.createdAt
    };

    return group;
  }, []);

  // Update function for lightning objects
  const updateLightningObjectFn: CustomThreeObjectUpdateFn = useCallback((obj, d) => {
    if (!globeEl.current) return;

    const group = obj as THREE.Group;
    const strike = d as LightningStrike;
    const currentTime = Date.now();

    // Get altitude for z-indexing
    const altitude = getStrikeAltitude(strike, currentTime);

    // 1. Update the lightning line vertices
    const surfaceCoords = globeEl.current.getCoords(strike.lat, strike.lng, altitude);

    // Fix: Keep line starting point fixed in the sky
    const skyCoords = globeEl.current.getCoords(
      strike.lat, 
      strike.lng, 
      LIGHTNING_CONSTANTS.LINE_START_ALTITUDE
    );

    // Calculate the line length based on the phase (0-1)
    const lineLength = getLineLength(strike, currentTime);

    // If there's no line, hide it
    if (lineLength <= 0) {
      (group.children[0] as THREE.Line).visible = false;
    } else {
      (group.children[0] as THREE.Line).visible = true;

      // Calculate the current endpoint of the line
      const vectorFromSurfaceToSky = new THREE.Vector3()
        .subVectors(skyCoords, surfaceCoords);

      // The bottom endpoint is always at the surface
      const bottomPoint = surfaceCoords;

      // The top endpoint starts at the sky position and moves down
      // This fixes the issue where the line was moving up
      const lineVector = vectorFromSurfaceToSky.clone().multiplyScalar(1 - lineLength);
      const topPoint = new THREE.Vector3().addVectors(skyCoords, lineVector.negate());

      // Update line vertices
      const lineGeo = (group.children[0] as THREE.Line).geometry;
      const positions = lineGeo.attributes.position.array as Float32Array;

      // Set the top point (sky)
      positions[0] = topPoint.x;
      positions[1] = topPoint.y;
      positions[2] = topPoint.z;

      // Set the bottom point (surface)
      positions[3] = bottomPoint.x;
      positions[4] = bottomPoint.y;
      positions[5] = bottomPoint.z;

      lineGeo.attributes.position.needsUpdate = true;

      // Update line opacity
      const lineMaterial = (group.children[0] as THREE.Line).material as THREE.LineBasicMaterial;
      lineMaterial.opacity = getLineOpacity(strike, currentTime);
    }

    // 2. Update the circle
    const circleMesh = group.children[1] as THREE.Mesh;
    const circleMaterial = circleMesh.material as THREE.MeshBasicMaterial;

    // Place circle at surface position
    Object.assign(circleMesh.position, surfaceCoords);

    // Calculate size and opacity
    const circleSize = getCircleSize(strike, currentTime);
    const circleOpacity = getCircleOpacity(strike, currentTime);

    // Update the mesh
    circleMesh.scale.set(circleSize, circleSize, circleSize);
    circleMaterial.opacity = circleOpacity;

    // If no circle, hide the mesh
    circleMesh.visible = circleSize > 0 && circleOpacity > 0;

    // Make circles lie flat on the globe surface
    // Calculate the normal vector (pointing outward from globe center)
    const globeCenter = new THREE.Vector3(0, 0, 0);
    const normal = new THREE.Vector3()
      .subVectors(circleMesh.position, globeCenter)
      .normalize();

    // Create a quaternion rotation that aligns the circle with the surface
    circleMesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1), // Default circle normal (z-axis)
      normal                      // Target direction (surface normal)
    );
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
          controls.autoRotateSpeed = 0.067; // ISS simulation speed
          
          // Set min distance (closest zoom) to prevent zooming too close
          controls.minDistance = 130; // Adjust this value to set your minimum zoom
          
          // Set max distance (furthest zoom) to limit how far away users can zoom
          controls.maxDistance = 500; // Adjust this value to set your maximum zoom
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
