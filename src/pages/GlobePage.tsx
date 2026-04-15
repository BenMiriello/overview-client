import { useRef, useCallback, useEffect, useState } from 'react';
import { useLightningData } from '../services/dataStreams/hooks';
import { GlobeComponent, GlobeControls, TemperatureLegend, PrecipitationLegend, WindLegend, WeatherTimeline } from '../components';
import { TemperatureCursor, TemperatureCursorHandle } from '../components/TemperatureCursor';
import { PrecipitationCursor, PrecipitationCursorHandle } from '../components/PrecipitationCursor';
import { WindCursor, WindCursorHandle } from '../components/WindCursor';
import { NavigationIcons } from '../components/Navigation';
import { LightningLayer, CloudLayer, TemperatureLayer, PrecipitationLayer, WindLayer } from '../layers';
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
  const [windEnabled, setWindEnabled] = useState(() => restoredView?.windEnabled ?? false);
  const [tempUnit, setTempUnit] = useState<'C' | 'F'>('C');
  const [windUnit, setWindUnit] = useState<'ms' | 'kmh' | 'kts'>('ms');
  const cursorRef = useRef<TemperatureCursorHandle>(null);
  const precipCursorRef = useRef<PrecipitationCursorHandle>(null);
  const windCursorRef = useRef<WindCursorHandle>(null);
  const [precipFrames, setPrecipFrames] = useState<{ runId: string; timestamp: number }[]>([]);
  const [precipCurrentFrameId, setPrecipCurrentFrameId] = useState<string | null>(null);
  const [precipReadyIds, setPrecipReadyIds] = useState<Set<string>>(new Set());
  const [tempFrames, setTempFrames] = useState<{ runId: string; timestamp: number }[]>([]);
  const [tempCurrentFrameId, setTempCurrentFrameId] = useState<string | null>(null);
  const [tempReadyIds, setTempReadyIds] = useState<Set<string>>(new Set());
  const [windFrames, setWindFrames] = useState<{ runId: string; timestamp: number }[]>([]);
  const [windCurrentFrameId, setWindCurrentFrameId] = useState<string | null>(null);
  const [windReadyIds, setWindReadyIds] = useState<Set<string>>(new Set());

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
  const windEnabledRef = useRef(windEnabled);
  windEnabledRef.current = windEnabled;

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
      temperatureLayer.setOnFrameListChange(frames => {
        setTempFrames(frames);
        setTempReadyIds(temperatureLayer.getReadyFrameIds());
        if (frames.length > 0 && !temperatureLayer.getCurrentFrameId()) {
          setTempCurrentFrameId(frames[frames.length - 1].runId);
        } else {
          setTempCurrentFrameId(temperatureLayer.getCurrentFrameId());
        }
      });
      temperatureLayer.setOnFrameReady(ids => setTempReadyIds(ids));
    }
    const precipitationLayer = manager.createLayer<PrecipitationLayer>('precipitation', 'precipitation');
    if (precipitationLayer) {
      precipitationEnabledRef.current ? precipitationLayer.show() : precipitationLayer.hide();
      precipitationLayer.setOnFrameListChange(frames => {
        setPrecipFrames(frames);
        setPrecipReadyIds(precipitationLayer.getReadyFrameIds());
        if (frames.length > 0 && !precipitationLayer.getCurrentFrameId()) {
          setPrecipCurrentFrameId(frames[frames.length - 1].runId);
        } else {
          setPrecipCurrentFrameId(precipitationLayer.getCurrentFrameId());
        }
      });
      precipitationLayer.setOnFrameReady(ids => setPrecipReadyIds(ids));
    }
    const windLayer = manager.createLayer<WindLayer>('wind', 'wind');
    if (windLayer) {
      windEnabledRef.current ? windLayer.show() : windLayer.hide();
      windLayer.setOnFrameListChange(frames => {
        setWindFrames(frames);
        setWindReadyIds(windLayer.getReadyFrameIds());
        if (frames.length > 0 && !windLayer.getCurrentFrameId()) {
          setWindCurrentFrameId(frames[frames.length - 1].runId);
        } else {
          setWindCurrentFrameId(windLayer.getCurrentFrameId());
        }
      });
      windLayer.setOnFrameReady(ids => setWindReadyIds(ids));
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

  const hideOtherOverlays = useCallback((except: 'temperature' | 'precipitation' | 'wind') => {
    if (except !== 'temperature' && temperatureEnabled) {
      setTemperatureEnabled(false);
      layerManagerRef.current?.getLayer<TemperatureLayer>('temperature')?.hide();
      layerManagerRef.current?.getLayer<CloudLayer>('clouds')?.setTemperatureEnabled(false);
    }
    if (except !== 'precipitation' && precipitationEnabled) {
      setPrecipitationEnabled(false);
      layerManagerRef.current?.getLayer<PrecipitationLayer>('precipitation')?.hide();
    }
    if (except !== 'wind' && windEnabled) {
      setWindEnabled(false);
      layerManagerRef.current?.getLayer<WindLayer>('wind')?.hide();
    }
  }, [temperatureEnabled, precipitationEnabled, windEnabled]);

  const handleToggleTemperature = useCallback(() => {
    setTemperatureEnabled(v => {
      const next = !v;
      const layer = layerManagerRef.current?.getLayer<TemperatureLayer>('temperature');
      next ? layer?.show() : layer?.hide();
      layerManagerRef.current?.getLayer<CloudLayer>('clouds')?.setTemperatureEnabled(next);
      if (next) hideOtherOverlays('temperature');
      return next;
    });
  }, [hideOtherOverlays]);

  const handleTogglePrecipitation = useCallback(() => {
    setPrecipitationEnabled(v => {
      const next = !v;
      const layer = layerManagerRef.current?.getLayer<PrecipitationLayer>('precipitation');
      next ? layer?.show() : layer?.hide();
      if (next) hideOtherOverlays('precipitation');
      return next;
    });
  }, [hideOtherOverlays]);

  const handleToggleWind = useCallback(() => {
    setWindEnabled(v => {
      const next = !v;
      const layer = layerManagerRef.current?.getLayer<WindLayer>('wind');
      next ? layer?.show() : layer?.hide();
      if (next) hideOtherOverlays('wind');
      return next;
    });
  }, [hideOtherOverlays]);

  const handleTempFrameChange = useCallback((runId: string) => {
    setTempCurrentFrameId(runId);
    const layer = layerManagerRef.current?.getLayer<TemperatureLayer>('temperature');
    layer?.setFrame(runId);
  }, []);

  const handlePrecipFrameChange = useCallback((runId: string) => {
    setPrecipCurrentFrameId(runId);
    const layer = layerManagerRef.current?.getLayer<PrecipitationLayer>('precipitation');
    layer?.setFrame(runId);
  }, []);

  const handleWindFrameChange = useCallback((runId: string) => {
    setWindCurrentFrameId(runId);
    const layer = layerManagerRef.current?.getLayer<WindLayer>('wind');
    layer?.setFrame(runId);
  }, []);

  const handleTempPrefetch = useCallback(() => {
    layerManagerRef.current?.getLayer<TemperatureLayer>('temperature')?.prefetchAllFrames();
  }, []);
  const handlePrecipPrefetch = useCallback(() => {
    layerManagerRef.current?.getLayer<PrecipitationLayer>('precipitation')?.prefetchAllFrames();
  }, []);
  const handleWindPrefetch = useCallback(() => {
    layerManagerRef.current?.getLayer<WindLayer>('wind')?.prefetchAllFrames();
  }, []);

  // Hide lightning during timeline playback, restore when stopped
  const lightningEnabledBeforePlaybackRef = useRef<boolean | null>(null);
  const handleTimelinePlayingChange = useCallback((playing: boolean) => {
    const layer = layerManagerRef.current?.getLayer<LightningLayer>('lightning');
    if (!layer) return;
    if (playing) {
      lightningEnabledBeforePlaybackRef.current = layer.isVisible();
      if (layer.isVisible()) layer.hide();
    } else {
      if (lightningEnabledBeforePlaybackRef.current) layer.show();
      lightningEnabledBeforePlaybackRef.current = null;
    }
  }, []);

  const handleSurfaceHover = useCallback((result: { lat: number; lng: number } | null, x: number, y: number) => {
    if (!result) {
      cursorRef.current?.update(null);
      precipCursorRef.current?.update(null);
      windCursorRef.current?.update(null);
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

    // Wind cursor
    const windLayer = layerManagerRef.current?.getLayer<WindLayer>('wind');
    if (windLayer?.isVisible()) {
      const wind = windLayer.getWindAtLatLng(result.lat, result.lng);
      if (wind) {
        windCursorRef.current?.update({ x, y, lat: result.lat, lng: result.lng, speed: wind.speed, direction: wind.direction });
      } else {
        windCursorRef.current?.update(null);
      }
    } else {
      windCursorRef.current?.update(null);
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
        windEnabled={windEnabled}
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
        windEnabled={windEnabled}
        onToggleWind={handleToggleWind}
        connectionStatus={connectionStatus}
        lastUpdate={lastUpdate}
        lightningLayer={layerManagerRef.current?.getLayer<LightningLayer>('lightning') || null}
      />
      <TemperatureLegend visible={temperatureEnabled} unit={tempUnit} onUnitChange={setTempUnit} />
      <TemperatureCursor ref={cursorRef} unit={tempUnit} />
      <WeatherTimeline
        visible={temperatureEnabled}
        frames={tempFrames}
        currentFrameId={tempCurrentFrameId}
        onFrameChange={handleTempFrameChange}
        readyFrameIds={tempReadyIds}
        onRequestPrefetch={handleTempPrefetch}
        onPlayingChange={handleTimelinePlayingChange}
      />
      <PrecipitationLegend visible={precipitationEnabled} />
      <PrecipitationCursor ref={precipCursorRef} />
      <WeatherTimeline
        visible={precipitationEnabled}
        frames={precipFrames}
        currentFrameId={precipCurrentFrameId}
        onFrameChange={handlePrecipFrameChange}
        readyFrameIds={precipReadyIds}
        onRequestPrefetch={handlePrecipPrefetch}
        onPlayingChange={handleTimelinePlayingChange}
      />
      <WindLegend visible={windEnabled} unit={windUnit} onUnitChange={setWindUnit} />
      <WindCursor ref={windCursorRef} unit={windUnit} />
      <WeatherTimeline
        visible={windEnabled}
        frames={windFrames}
        currentFrameId={windCurrentFrameId}
        onFrameChange={handleWindFrameChange}
        readyFrameIds={windReadyIds}
        onRequestPrefetch={handleWindPrefetch}
        onPlayingChange={handleTimelinePlayingChange}
      />
      <NavigationIcons currentPage="globe" />
    </div>
  );
};

export default GlobePage;
