import { useRef, useEffect, useState } from 'react';
import Globe from 'react-globe.gl';
import './App.css';

function App() {
  const globeEl = useRef<any>(null);
  const [isGlobeReady, setIsGlobeReady] = useState(false);

  const handleGlobeReady = () => {
    setIsGlobeReady(true);
  };

  useEffect(() => {
    if (isGlobeReady && globeEl.current) {
      try {
        const controls = globeEl.current.controls();
        if (controls) {
          controls.autoRotate = true;
          controls.autoRotateSpeed = 0.5;
        }
        
        globeEl.current.pointOfView({
          lat: 39.6,
          lng: -98.5,
          altitude: 2
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
      </div>
    </div>
  );
}

export default App;
