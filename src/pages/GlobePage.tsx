import { useRef, useCallback } from 'react';
import { useLightningData } from '../services/dataStreams/hooks';
import { StatusBar, GlobeComponent } from '../components';
import { LightningLayer, CloudLayer } from '../layers';
import { GlobeLayerManager } from '../managers';

const GlobePage = () => {
  const globeEl = useRef<any>(null);
  const layerManagerRef = useRef<GlobeLayerManager | null>(null);

  const { connected, lastUpdate, dataStream } = useLightningData({
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
      />
      <StatusBar 
        connected={connected}
        lastUpdate={lastUpdate}
        lightningLayer={layerManagerRef.current?.getLayer<LightningLayer>('lightning') || null}
      />
    </div>
  )
}

export default GlobePage;
