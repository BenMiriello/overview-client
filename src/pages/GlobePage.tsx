import { useRef, useCallback, useEffect, useState } from 'react';
import { useLightningData } from '../services/dataStreams/hooks';
import { StatusBar, GlobeComponent, GlobeControls } from '../components';
import { NavigationIcons } from '../components/Navigation';
import { LightningLayer, CloudLayer } from '../layers';
import { GlobeLayerManager } from '../managers';

interface Hotspot {
  lat: number;
  lng: number;
  count: number;
}

const GlobePage = () => {
  const globeEl = useRef<any>(null);
  const layerManagerRef = useRef<GlobeLayerManager | null>(null);
  const [hotspot, setHotspot] = useState<Hotspot | null>(null);
  const [hotspotReady, setHotspotReady] = useState(false);
  const [is3D, setIs3D] = useState(() => localStorage.getItem('globe_prefer3D') !== 'false');
  const [isOrbiting, setIsOrbiting] = useState(false);

  useEffect(() => {
    fetch('http://localhost:3001/api/hotspot')
      .then(res => res.json())
      .then(data => {
        if (data) {
          console.log(`[GlobePage] hotspot: ${data.count} strikes at lat=${data.lat.toFixed(2)}, lng=${data.lng.toFixed(2)}`);
          setHotspot(data);
        } else {
          console.log('[GlobePage] hotspot: no recent data, will use default');
        }
      })
      .catch(() => console.log('[GlobePage] hotspot fetch failed, will use default'))
      .finally(() => setHotspotReady(true));
  }, []);

  const { connected, connectionStatus, lastUpdate, dataStream } = useLightningData({
    url: 'ws://localhost:3001'
  });

  const handleGlobeReady = useCallback((globe: any) => {
    globeEl.current = globe;
  }, []);

  const handleLayerManagerReady = useCallback((manager: GlobeLayerManager) => {
    layerManagerRef.current = manager;
    manager.createLayer<CloudLayer>('clouds', 'clouds');
    const lightningLayer = manager.createLayer<LightningLayer>('lightning', 'lightning');
    if (lightningLayer) {
      lightningLayer.setDataStream(dataStream);
    }
  }, [dataStream]);

  const handleToggle3D = useCallback(() => {
    setIs3D(v => {
      const next = !v;
      localStorage.setItem('globe_prefer3D', String(next));
      return next;
    });
  }, []);
  const handleToggleOrbit = useCallback(() => setIsOrbiting(v => !v), []);

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      <GlobeComponent
        onGlobeReady={handleGlobeReady}
        onLayerManagerReady={handleLayerManagerReady}
        targetPosition={hotspot}
        targetPositionReady={hotspotReady}
        is3D={is3D}
        isOrbiting={isOrbiting}
        onIsOrbitingChange={setIsOrbiting}
      />
      <StatusBar
        connected={connected}
        connectionStatus={connectionStatus}
        lastUpdate={lastUpdate}
        lightningLayer={layerManagerRef.current?.getLayer<LightningLayer>('lightning') || null}
      />
      <GlobeControls
        is3D={is3D}
        isOrbiting={isOrbiting}
        onToggle3D={handleToggle3D}
        onToggleOrbit={handleToggleOrbit}
      />
      <NavigationIcons currentPage="globe" />
    </div>
  );
};

export default GlobePage;
