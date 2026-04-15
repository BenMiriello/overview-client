import { useRef, useCallback, useEffect, useState } from 'react';
import { useLightningData } from '../services/dataStreams/hooks';
import { GlobeComponent, GlobeControls, TemperatureLegend, PrecipitationLegend, PrecipitationTimeline } from '../components';
import { TemperatureCursor, TemperatureCursorHandle } from '../components/TemperatureCursor';
import { PrecipitationCursor, PrecipitationCursorHandle } from '../components/PrecipitationCursor';
import { NavigationIcons } from '../components/Navigation';
import { LightningLayer, CloudLayer, TemperatureLayer, PrecipitationLayer } from '../layers';
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

  // Hotspot fly-to deferred until the moon→earth transition finishes
  const pendingFlyAfterEarthRef = useRef<{ lat: number; lng: number } | null>(null);

  // Camera ground target in close mode — updated every frame by GlobeComponent.
  // Use this instead of pointOfView() which returns nadir offset by pitch.
  const cameraTargetRef = useRef<{ lat: number; lng: number } | null>(null);

  const [is3D, setIs3D] = useState(() => {
    if (restoredView) return restoredView.is3D;
    const legacy = loadLegacyPrefer3D();
    return legacy ?? true;
  });
  const [isOrbiting, setIsOrbiting] = useState(() => restoredView?.isOrbiting ?? false);
  const [viewTarget, setViewTarget] = useState<'earth' | 'moon'>(() => restoredView?.viewTarget ?? 'earth');
  const [cloudsEnabled, setCloudsEnabled] = useState(() => restoredView?.cloudsEnabled ?? true);
  const [cloudOpacity, setCloudOpacity] = useState<number>(() => {
    const stored = localStorage.getItem('lightning-cloud-opacity');
    return stored ? parseFloat(stored) : 1.0;
  });
  const cloudOpacityRef = useRef(cloudOpacity);
  cloudOpacityRef.current = cloudOpacity;
  const prevCloudOpacityRef = useRef<number>(cloudOpacity);
  const [lightningEnabled, setLightningEnabled] = useState(() => restoredView?.lightningEnabled ?? true);
  const [temperatureEnabled, setTemperatureEnabled] = useState(() => restoredView?.temperatureEnabled ?? false);
  const [precipitationEnabled, setPrecipitationEnabled] = useState(() => restoredView?.precipitationEnabled ?? false);
  const [tempUnit, setTempUnit] = useState<'C' | 'F'>('C');
  const cursorRef = useRef<TemperatureCursorHandle>(null);
  const precipCursorRef = useRef<PrecipitationCursorHandle>(null);
  const [precipFrames, setPrecipFrames] = useState<{ runId: string; timestamp: number }[]>([]);
  const [precipCurrentFrameId, setPrecipCurrentFrameId] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem('lightning-cloud-opacity', String(cloudOpacity));
  }, [cloudOpacity]);

  useEffect(() => {
    // Stored view rehydrates the camera directly — skip the intro fetch + animation.
    if (restoredView) {
      setHotspotReady(true);
      return;
    }
    fetch(`${import.meta.env.VITE_SERVER_URL}/api/hotspot`)
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

  const { connectionStatus, lastUpdate, dataStream, subscribe } = useLightningData({
    url: import.meta.env.VITE_SERVER_URL.replace(/^http/, 'ws')
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
      const pov = globeEl.current.pointOfView();
      // In close mode (3D/pitched), pointOfView() returns the camera nadir which
      // is offset from the ground target by the pitch angle. Use cameraTargetRef
      // (the actual look-at ground point) when available; fall back to pov in far mode.
      const camLat = cameraTargetRef.current?.lat ?? pov.lat;
      const camLng = cameraTargetRef.current?.lng ?? pov.lng;
      const threshold = Math.max(3, Math.min(30, pov.altitude * 15));
      const viewing = angularDistance(camLat, camLng, activeHotspot.lat, activeHotspot.lng) < threshold;
      setIsViewingHotspot(viewing);
      if (viewing) setHasNewHotspot(false);
    }, 500);

    return () => clearInterval(id);
  }, [liveHotspot, hotspot]);

  const handleGlobeReady = useCallback((globe: any) => {
    globeEl.current = globe;
  }, []);

  const cloudsEnabledRef = useRef(cloudsEnabled);
  cloudsEnabledRef.current = cloudsEnabled;

  const lightningEnabledRef = useRef(lightningEnabled);
  lightningEnabledRef.current = lightningEnabled;
  const temperatureEnabledRef = useRef(temperatureEnabled);
  temperatureEnabledRef.current = temperatureEnabled;
  const precipitationEnabledRef = useRef(precipitationEnabled);
  precipitationEnabledRef.current = precipitationEnabled;

  const handleLayerManagerReady = useCallback((manager: GlobeLayerManager) => {
    layerManagerRef.current = manager;
    const cloudLayer = manager.createLayer<CloudLayer>('clouds', 'clouds');
    if (cloudLayer) {
      cloudLayer.setCloudsEnabled(cloudsEnabledRef.current);
      cloudLayer.setUserOpacity(cloudOpacityRef.current);
      cloudLayer.setTemperatureEnabled(temperatureEnabledRef.current);
    }
    const lightningLayer = manager.createLayer<LightningLayer>('lightning', 'lightning');
    if (lightningLayer) {
      lightningLayer.setDataStream(dataStream);
      if (!lightningEnabledRef.current) lightningLayer.hide();
    }
    const temperatureLayer = manager.createLayer<TemperatureLayer>('temperature', 'temperature');
    if (temperatureLayer) {
      temperatureEnabledRef.current ? temperatureLayer.show() : temperatureLayer.hide();
    }
    const precipitationLayer = manager.createLayer<PrecipitationLayer>('precipitation', 'precipitation');
    if (precipitationLayer) {
      precipitationEnabledRef.current ? precipitationLayer.show() : precipitationLayer.hide();
      precipitationLayer.setOnFrameListChange(frames => {
        setPrecipFrames(frames);
        if (frames.length > 0 && !precipitationLayer.getCurrentFrameId()) {
          setPrecipCurrentFrameId(frames[frames.length - 1].runId);
        } else {
          setPrecipCurrentFrameId(precipitationLayer.getCurrentFrameId());
        }
        precipitationLayer.prefetchAllFrames();
      });
    }
  }, [dataStream]);

  const handleToggle3D = useCallback(() => {
    setIs3D(v => !v);
  }, []);

  const handleToggleOrbit = useCallback(() => setIsOrbiting(v => !v), []);
  const handleToggleViewTarget = useCallback(() => setViewTarget(v => v === 'earth' ? 'moon' : 'earth'), []);

  const handleToggleClouds = useCallback(() => {
    setCloudsEnabled(v => {
      const next = !v;
      const cloudLayer = layerManagerRef.current?.getLayer<CloudLayer>('clouds');
      if (next) {
        const restore = prevCloudOpacityRef.current;
        setCloudOpacity(restore);
        cloudLayer?.setUserOpacity(restore);
      } else {
        prevCloudOpacityRef.current = cloudOpacityRef.current;
      }
      cloudLayer?.setCloudsEnabled(next);
      return next;
    });
  }, []);

  const handleCloudOpacityChange = useCallback((opacity: number) => {
    setCloudOpacity(opacity);
    layerManagerRef.current?.getLayer<CloudLayer>('clouds')?.setUserOpacity(opacity);
  }, []);

  const handleToggleLightning = useCallback(() => {
    setLightningEnabled(v => {
      const next = !v;
      const layer = layerManagerRef.current?.getLayer<LightningLayer>('lightning');
      next ? layer?.show() : layer?.hide();
      return next;
    });
  }, []);

  const handleToggleTemperature = useCallback(() => {
    setTemperatureEnabled(v => {
      const next = !v;
      const layer = layerManagerRef.current?.getLayer<TemperatureLayer>('temperature');
      next ? layer?.show() : layer?.hide();
      layerManagerRef.current?.getLayer<CloudLayer>('clouds')?.setTemperatureEnabled(next);
      if (next && precipitationEnabled) {
        setPrecipitationEnabled(false);
        layerManagerRef.current?.getLayer<PrecipitationLayer>('precipitation')?.hide();
      }
      return next;
    });
  }, [precipitationEnabled]);

  const handleTogglePrecipitation = useCallback(() => {
    setPrecipitationEnabled(v => {
      const next = !v;
      const layer = layerManagerRef.current?.getLayer<PrecipitationLayer>('precipitation');
      next ? layer?.show() : layer?.hide();
      if (next && temperatureEnabled) {
        setTemperatureEnabled(false);
        layerManagerRef.current?.getLayer<TemperatureLayer>('temperature')?.hide();
        layerManagerRef.current?.getLayer<CloudLayer>('clouds')?.setTemperatureEnabled(false);
      }
      return next;
    });
  }, [temperatureEnabled]);

  const handlePrecipFrameChange = useCallback((runId: string) => {
    setPrecipCurrentFrameId(runId);
    const layer = layerManagerRef.current?.getLayer<PrecipitationLayer>('precipitation');
    layer?.setFrame(runId);
  }, []);

  const handleSurfaceHover = useCallback((result: { lat: number; lng: number } | null, x: number, y: number) => {
    if (!result) {
      cursorRef.current?.update(null);
      precipCursorRef.current?.update(null);
      return;
    }

    // Temperature cursor
    const tempLayer = layerManagerRef.current?.getLayer<TemperatureLayer>('temperature');
    if (tempLayer?.isVisible()) {
      const tempC = tempLayer.getTempAtLatLng(result.lat, result.lng);
      if (tempC != null) {
        cursorRef.current?.update({ x, y, lat: result.lat, lng: result.lng, tempC });
      } else {
        cursorRef.current?.update(null);
      }
    } else {
      cursorRef.current?.update(null);
    }

    // Precipitation cursor
    const precipLayer = layerManagerRef.current?.getLayer<PrecipitationLayer>('precipitation');
    if (precipLayer?.isVisible()) {
      const precip = precipLayer.getPrecipAtLatLng(result.lat, result.lng);
      if (precip) {
        precipCursorRef.current?.update({ x, y, lat: result.lat, lng: result.lng, rate: precip.rate, type: precip.type });
      } else {
        precipCursorRef.current?.update(null);
      }
    } else {
      precipCursorRef.current?.update(null);
    }
  }, []);

  const handleEarthViewReady = useCallback(() => {
    if (pendingFlyAfterEarthRef.current) {
      const spot = pendingFlyAfterEarthRef.current;
      pendingFlyAfterEarthRef.current = null;
      setFlyTo({ lat: spot.lat, lng: spot.lng, altitude: 0.5 });
    }
  }, []);

  const handleGoToHotspot = useCallback(() => {
    setHasNewHotspot(false);
    const spot = liveHotspot ?? hotspot;
    if (!spot) return;

    if (viewTarget === 'moon') {
      pendingFlyAfterEarthRef.current = spot;
      setViewTarget('earth');
      return;
    }

    console.log(`[hotspot] flying to lat=${spot.lat.toFixed(2)}, lng=${spot.lng.toFixed(2)}, count=${spot.count}`);
    setFlyTo({ lat: spot.lat, lng: spot.lng, altitude: 0.5 });
  }, [liveHotspot, hotspot, viewTarget]);

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
        cloudsEnabled={cloudsEnabled}
        lightningEnabled={lightningEnabled}
        temperatureEnabled={temperatureEnabled}
        precipitationEnabled={precipitationEnabled}
        restoredView={restoredView}
        onEarthViewReady={handleEarthViewReady}
        cameraTargetRef={cameraTargetRef}
        onSurfaceHover={handleSurfaceHover}
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
        cloudsEnabled={cloudsEnabled}
        cloudOpacity={cloudOpacity}
        onToggleClouds={handleToggleClouds}
        onCloudOpacityChange={handleCloudOpacityChange}
        lightningEnabled={lightningEnabled}
        onToggleLightning={handleToggleLightning}
        temperatureEnabled={temperatureEnabled}
        onToggleTemperature={handleToggleTemperature}
        precipitationEnabled={precipitationEnabled}
        onTogglePrecipitation={handleTogglePrecipitation}
        connectionStatus={connectionStatus}
        lastUpdate={lastUpdate}
        lightningLayer={layerManagerRef.current?.getLayer<LightningLayer>('lightning') || null}
      />
      <TemperatureLegend visible={temperatureEnabled} unit={tempUnit} onUnitChange={setTempUnit} />
      <TemperatureCursor ref={cursorRef} unit={tempUnit} />
      <PrecipitationLegend visible={precipitationEnabled} />
      <PrecipitationCursor ref={precipCursorRef} />
      <PrecipitationTimeline
        visible={precipitationEnabled}
        frames={precipFrames}
        currentFrameId={precipCurrentFrameId}
        onFrameChange={handlePrecipFrameChange}
      />
      <NavigationIcons currentPage="globe" />
    </div>
  );
};

export default GlobePage;
