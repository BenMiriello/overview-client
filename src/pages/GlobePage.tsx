import { useRef, useCallback, useEffect, useState } from 'react';
import { useLightningData } from '../services/dataStreams/hooks';
import { StatusBar, GlobeComponent, GlobeControls } from '../components';
import { NavigationIcons } from '../components/Navigation';
import { LightningLayer, CloudLayer } from '../layers';
import { GlobeLayerManager } from '../managers';
import { loadView, loadLegacyPrefer3D } from '../components/globeViewPersistence';

const restoredView = loadView();

interface Hotspot {
  lat: number;
  lng: number;
  count: number;
}

// Angular degrees between two lat/lng points (great-circle)
function angularDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 180) / Math.PI;
}

const GlobePage = () => {
  const globeEl = useRef<any>(null);
  const layerManagerRef = useRef<GlobeLayerManager | null>(null);

  // Initial hotspot (from HTTP fetch on mount, used for intro camera)
  const [hotspot, setHotspot] = useState<Hotspot | null>(null);
  const [hotspotReady, setHotspotReady] = useState(false);

  // Live hotspot pushed from server via WebSocket
  const [liveHotspot, setLiveHotspot] = useState<Hotspot | null>(null);
  const [hasNewHotspot, setHasNewHotspot] = useState(false);
  const [isViewingHotspot, setIsViewingHotspot] = useState(false);

  // Passed to GlobeComponent to trigger a cancellable fly-to animation
  const [flyTo, setFlyTo] = useState<{ lat: number; lng: number; altitude: number } | null>(null);

  const [is3D, setIs3D] = useState(() => {
    if (restoredView) return restoredView.is3D;
    const legacy = loadLegacyPrefer3D();
    return legacy ?? true;
  });
  const [isOrbiting, setIsOrbiting] = useState(() => restoredView?.isOrbiting ?? false);
  const [viewTarget, setViewTarget] = useState<'earth' | 'moon'>(() => restoredView?.viewTarget ?? 'earth');

  useEffect(() => {
    // Stored view rehydrates the camera directly — skip the intro fetch + animation.
    if (restoredView) {
      setHotspotReady(true);
      return;
    }
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

  const { connected, connectionStatus, lastUpdate, dataStream, subscribe } = useLightningData({
    url: 'ws://localhost:3001'
  });

  // Listen for server-pushed hotspot updates on the shared WS connection
  useEffect(() => {
    return subscribe((data: any) => {
      if (data.type === 'hotspot') {
        setLiveHotspot({ lat: data.lat, lng: data.lng, count: data.count });
        setHasNewHotspot(true);
      }
    });
  }, [subscribe]);

  // Poll whether the camera is currently over the active hotspot
  useEffect(() => {
    const activeHotspot = liveHotspot ?? hotspot;
    if (!activeHotspot) return;

    const id = setInterval(() => {
      if (!globeEl.current) return;
      const { lat, lng, altitude } = globeEl.current.pointOfView();
      // Threshold scales with zoom: farther out → wider acceptance
      const threshold = Math.max(20, altitude * 15);
      const viewing = angularDistance(lat, lng, activeHotspot.lat, activeHotspot.lng) < threshold;
      setIsViewingHotspot(viewing);
      if (viewing) setHasNewHotspot(false);
    }, 500);

    return () => clearInterval(id);
  }, [liveHotspot, hotspot]);

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
    setIs3D(v => !v);
  }, []);

  const handleToggleOrbit = useCallback(() => setIsOrbiting(v => !v), []);
  const handleToggleViewTarget = useCallback(() => setViewTarget(v => v === 'earth' ? 'moon' : 'earth'), []);

  const handleGoToHotspot = useCallback(() => {
    setHasNewHotspot(false);
    // Always re-fetch fresh hotspot — WS sends cached value on connect which can be stale
    fetch('http://localhost:3001/api/hotspot')
      .then(res => res.json())
      .then(data => {
        console.log('[hotspot] HTTP response:', data);
        if (data) {
          console.log(`[hotspot] flying to lat=${data.lat.toFixed(3)}, lng=${data.lng.toFixed(3)}`);
          setFlyTo({ lat: data.lat, lng: data.lng, altitude: 0.5 });
        } else {
          console.log('[hotspot] server returned null, liveHotspot=', liveHotspot, 'hotspot=', hotspot);
        }
      })
      .catch((err) => {
        console.error('[hotspot] fetch failed:', err, '— falling back to liveHotspot=', liveHotspot, 'hotspot=', hotspot);
        const spot = liveHotspot ?? hotspot;
        if (spot) setFlyTo({ lat: spot.lat, lng: spot.lng, altitude: 0.5 });
      });
  }, [liveHotspot, hotspot]);

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      <GlobeComponent
        onGlobeReady={handleGlobeReady}
        onLayerManagerReady={handleLayerManagerReady}
        targetPosition={hotspot}
        targetPositionReady={hotspotReady}
        flyTo={flyTo}
        is3D={is3D}
        onIs3DChange={setIs3D}
        isOrbiting={isOrbiting}
        onIsOrbitingChange={setIsOrbiting}
        viewTarget={viewTarget}
        restoredView={restoredView}
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
        hotspot={liveHotspot ?? hotspot}
        isViewingHotspot={isViewingHotspot}
        hasNewHotspot={hasNewHotspot}
        onGoToHotspot={handleGoToHotspot}
        viewTarget={viewTarget}
        onToggleViewTarget={handleToggleViewTarget}
      />
      <NavigationIcons currentPage="globe" />
    </div>
  );
};

export default GlobePage;
