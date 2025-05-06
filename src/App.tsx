import { useRef, useState, useCallback } from 'react';
import './App.css';
import { LightningStrike } from './models/LightningStrike';
import { useLightningDataStream } from './services/dataStreams';
import { StatusBar, GlobeComponent } from './components';
import { LightningLayer, CloudLayer } from './layers';
import { GlobeLayerManager } from './managers';
import { getConfig } from './config';

function App() {
  const globeEl = useRef<any>(null);
  const layerManagerRef = useRef<GlobeLayerManager | null>(null);
  const [strikes, setStrikes] = useState<LightningStrike[]>([]);

  const handleGlobeReady = useCallback((globe: any) => {
    globeEl.current = globe;
  }, []);

  const handleLayerManagerReady = useCallback((manager: GlobeLayerManager) => {
    layerManagerRef.current = manager;
    manager.createLayer<CloudLayer>('clouds', 'clouds');
    manager.createLayer<LightningLayer>('lightning', 'lightning');
  }, []);

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

  const { connected, lastUpdate } = useLightningDataStream({
    url: 'ws://localhost:3001',
    onNewStrike: handleNewStrike
  });

  return (
    <div className="App">
      <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
        <GlobeComponent 
          onGlobeReady={handleGlobeReady}
          onLayerManagerReady={handleLayerManagerReady}
        />
        <StatusBar 
          connected={connected}
          strikesCount={strikes.length}
          lastUpdate={lastUpdate}
          lightningLayer={layerManagerRef.current?.getLayer<LightningLayer>('lightning') || null}
        />
      </div>
    </div>
  );
}

export default App;
