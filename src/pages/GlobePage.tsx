import { useRef, useCallback, useEffect, useState } from 'react';
import { useLightningData } from '../services/dataStreams/hooks';
import { StatusBar, GlobeComponent } from '../components';
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

  useEffect(() => {
    fetch('http://localhost:3001/api/hotspot')
      .then(res => res.json())
      .then(data => { if (data) setHotspot(data); })
      .catch(() => {});
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

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      <GlobeComponent
        onGlobeReady={handleGlobeReady}
        onLayerManagerReady={handleLayerManagerReady}
        targetPosition={hotspot}
      />
      <StatusBar
        connected={connected}
        connectionStatus={connectionStatus}
        lastUpdate={lastUpdate}
        lightningLayer={layerManagerRef.current?.getLayer<LightningLayer>('lightning') || null}
      />
      <NavigationIcons currentPage="globe" />
    </div>
  );
};

export default GlobePage;
