import { useRef, useEffect, useState } from 'react';
import Globe from 'react-globe.gl';
import { scaleSequentialSqrt } from 'd3-scale';
import { interpolateYlOrRd } from 'd3-scale-chromatic';
import './App.css';
import Strike from './types/strike';

function App() {
  const globeEl = useRef<any>(null);
  const [isGlobeReady, setIsGlobeReady] = useState(false);
  const [strikes, setStrikes] = useState<Strike[]>([])
  const [connected, setConnected] = useState(false)
  const [lastUpdate, setLastUpdate] = useState('')

  const handleGlobeReady = () => {
    setIsGlobeReady(true);
  };

  useEffect(() => {
    if (isGlobeReady && globeEl.current) {
      try {
        const controls = globeEl.current.controls();
        if (controls) {
          // controls.autoRotate = true;
          // controls.autoRotateSpeed = 0.5;
        }

        globeEl.current.pointOfView({
          lat: 0,
          lng: -33,
          altitude: 2 // 3
        });
      } catch (err) {
        console.error("Error setting up globe:", err);
      }
    }
  }, [isGlobeReady]);

  useEffect(() => {
    console.log(strikes)
  }, [strikes])

  useEffect(() => {
    // Connect to the WebSocket server
    const serverUrl = 'ws://localhost:3001'
    console.log('Connecting to WebSocket server at:', serverUrl)
    const ws = new WebSocket(serverUrl)
    
    ws.onopen = () => {
      console.log('Connected to server')
      setConnected(true)
    }

    ws.onclose = () => {
      console.log('Disconnected from server')
      setConnected(false)
    }

    ws.onerror = (error) => {
      console.error('WebSocket error:', error)
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        console.log('Received data:', data)

        // Handle initial data with multiple strikes
        if (data.type === 'initial' && Array.isArray(data.strikes)) {
          console.log(`Received initial data with ${data.strikes.length} strikes`)
          setStrikes(data.strikes)
        }
        // Handle single strike updates
        else if (data.id && data.lat !== undefined && data.lon !== undefined) {
          console.log('Received new strike:', data)
          setStrikes(prev => [data, ...prev].slice(0, 100)) // Keep only latest 100
        }

        setLastUpdate(new Date().toLocaleTimeString())
      } catch (error) {
        console.error('Error parsing data:', error)
      }
    }

    return () => {
      console.log('Closing WebSocket connection')
      ws.close()
    }
  }, [])

  const weightColor = scaleSequentialSqrt(interpolateYlOrRd)
    .domain([0, 1e7]);

  return (
    <div className="App">
      <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
        <Globe
          ref={globeEl}
          onGlobeReady={handleGlobeReady}
          globeImageUrl="https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg"
          bumpImageUrl="https://unpkg.com/three-globe/example/img/earth-topology.png"
          backgroundImageUrl="https://unpkg.com/three-globe/example/img/night-sky.png"

          hexBinPointsData={strikes}
          hexBinPointWeight="mcg"
          hexAltitude={d => d.sumWeight * 6e-5}
          hexBinResolution={4}
          hexTopColor={d => weightColor(d.sumWeight)}
          hexSideColor={d => weightColor(d.sumWeight)}
          hexBinMerge={true}
        />
      </div>
    </div>
  );
}

export default App;
