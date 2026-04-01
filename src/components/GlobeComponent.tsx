import React, { useRef, useEffect, useState } from 'react';
import Globe from 'react-globe.gl';
import * as THREE from 'three';
import { GlobeLayerManager } from '../managers';
import { easeInOutCubicShifted } from '../utils';

// Altitudes for close/far mode hysteresis — enter close below ENTER, exit above EXIT.
// The gap prevents rapid toggling when hovering near the boundary.
const TILT_THRESHOLD_ENTER = 1.0;
const TILT_THRESHOLD_EXIT  = 1.15;

// Minimum practical altitude (matches minDistance / earthRadius)
const MIN_ALTITUDE = 0.15;

// controls.target shift as a fraction of the distance to the surface point:
// 0 = globe center, 1 = full surface. These create 30°–60° tilt from top-down.
const TILT_FRACTION_CLOSE = 0.45; // tilt at threshold entry  (~30° from top-down)
const TILT_FRACTION_MAX   = 0.80; // tilt at max zoom-in     (~60° from top-down)

// autoRotateSpeed units are internal to OrbitControls.
// PLANET: existing ISS-speed planet rotation (~92 min period)
// SURFACE: 90-second orbit around the surface point
const ORBIT_SPEED_PLANET  = 0.067;
const ORBIT_SPEED_SURFACE = 4.1;

// Duration (ms) for the ease-to-north animation when orbit is turned off
const NORTH_SNAP_DURATION = 1200;

interface TargetPosition {
  lat: number;
  lng: number;
}

interface GlobeComponentProps {
  onGlobeReady: (globeEl: any) => void;
  onLayerManagerReady: (layerManager: GlobeLayerManager) => void;
  targetPosition?: TargetPosition | null;
  /** true once the hotspot fetch has settled (success or failure); animation waits for this */
  targetPositionReady?: boolean;
  is3D: boolean;
  isOrbiting: boolean;
  onIs3DChange: (val: boolean) => void;
  onIsOrbitingChange: (val: boolean) => void;
  onCloseModeChange: (isClose: boolean) => void;
}

const DEFAULT_TARGET = { lat: 20, lng: -55 };

/** Converts lat/lng to a point on the globe surface in THREE.js world space. */
function getSurfacePoint(lat: number, lng: number, radius: number): THREE.Vector3 {
  const phi   = (90 - lat) * Math.PI / 180;
  const theta = (lng + 180) * Math.PI / 180;
  return new THREE.Vector3(
    -(radius * Math.sin(phi) * Math.cos(theta)),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.sin(theta)
  );
}

const introCameraMovement = (
  globeEl: React.RefObject<any>,
  target: TargetPosition,
): { cancel: () => void } => {
  let startTime: number | null = null;
  let animationFrameId: number | null = null;
  let isCanceled = false;

  const initialAltitude = 4;
  const initialLat = target.lat - 10;
  const initialLng = target.lng + 33;

  globeEl.current.pointOfView({ lat: initialLat, lng: initialLng, altitude: initialAltitude }, 0);

  setTimeout(() => {
    if (isCanceled) return;

    const duration = 5000;
    const latDelta = target.lat - initialLat;
    const lngDelta = target.lng - initialLng;
    const altShift = -1;

    const animate = (timestamp: number) => {
      if (isCanceled) return;
      startTime ||= timestamp;
      const elapsed = timestamp - startTime;

      if (elapsed < duration) {
        const t = elapsed / duration;
        const progress = easeInOutCubicShifted(t, 1/4);

        globeEl.current.pointOfView({
          lat: initialLat + latDelta * progress,
          lng: initialLng + lngDelta * progress,
          altitude: initialAltitude + altShift * progress,
        }, 0);

        animationFrameId = requestAnimationFrame(animate);
      }
    };

    animationFrameId = requestAnimationFrame(animate);
  }, 0);

  return {
    cancel: () => {
      isCanceled = true;
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
    }
  };
};


export const GlobeComponent: React.FC<GlobeComponentProps> = ({
  onGlobeReady,
  onLayerManagerReady,
  targetPosition,
  targetPositionReady = true,
  is3D,
  isOrbiting,
  onIs3DChange,
  onIsOrbitingChange,
  onCloseModeChange,
}) => {
  const globeEl = useRef<any>(null);
  const layerManagerRef = useRef<GlobeLayerManager | null>(null);
  const [isGlobeReady, setIsGlobeReady] = useState(false);
  const animationRef = useRef<{ cancel: () => void } | null>(null);

  // Refs so event listeners always read latest prop values without stale closures
  const is3DRef         = useRef(is3D);
  const isOrbitingRef   = useRef(isOrbiting);
  const tiltPausedRef   = useRef(false);
  const inCloseModeRef  = useRef(false);
  const globeOrigin     = useRef(new THREE.Vector3(0, 0, 0));

  // Main controls setup — runs once when the globe is ready
  useEffect(() => {
    if (!isGlobeReady || !globeEl.current) return;

    let controls: any;
    try {
      controls = globeEl.current.controls();
    } catch {
      return;
    }
    if (!controls) return;

    controls.autoRotateSpeed = ORBIT_SPEED_PLANET;
    controls.minDistance = 100.1;
    controls.maxDistance = 10000;

    // ── Tilt updater ──────────────────────────────────────────────────────────
    const updateTilt = () => {
      if (!globeEl.current) return;
      const pov = globeEl.current.pointOfView();
      const { lat, lng, altitude } = pov;
      // Hysteresis: enter close mode below ENTER threshold, exit above EXIT threshold
      const enteringClose = altitude < TILT_THRESHOLD_ENTER && !inCloseModeRef.current;
      const exitingClose  = altitude > TILT_THRESHOLD_EXIT  &&  inCloseModeRef.current;
      const isClose = inCloseModeRef.current
        ? altitude < TILT_THRESHOLD_EXIT
        : altitude < TILT_THRESHOLD_ENTER;

      // Auto-trigger 3D + orbit when crossing the threshold inward
      if (enteringClose) {
        inCloseModeRef.current = true;
        onCloseModeChange(true);
        onIs3DChange(true);
        onIsOrbitingChange(true);
      }

      // Auto-disable 3D when crossing the threshold outward
      if (exitingClose) {
        inCloseModeRef.current = false;
        onCloseModeChange(false);
        onIs3DChange(false);
      }

      // Update orbit speed when the close/far boundary is crossed while orbiting
      if (isOrbitingRef.current) {
        controls.autoRotateSpeed = isClose ? ORBIT_SPEED_SURFACE : ORBIT_SPEED_PLANET;
      }

      // Apply tilt if 3D is active and we're not mid-north-snap
      if (tiltPausedRef.current || !is3DRef.current) return;

      const t = Math.max(0, Math.min(1,
        (TILT_THRESHOLD_ENTER - altitude) / (TILT_THRESHOLD_ENTER - MIN_ALTITUDE)
      ));
      const tiltFraction = TILT_FRACTION_CLOSE + (TILT_FRACTION_MAX - TILT_FRACTION_CLOSE) * t;
      const earthR = globeEl.current.getGlobeRadius();
      const surface = getSurfacePoint(lat, lng, earthR);

      // Set target without calling controls.update() — calling update() inside a
      // change listener causes a synchronous infinite event loop. OrbitControls
      // picks up the new target on its next internal frame.
      controls.target.lerpVectors(globeOrigin.current, surface, tiltFraction);
    };

    controls.addEventListener('change', updateTilt);

    // ── User-interaction stop ─────────────────────────────────────────────────
    const stopCameraMovement = () => {
      if (animationRef.current) {
        animationRef.current.cancel();
        animationRef.current = null;
      }
      controls.autoRotate = false;
      if (isOrbitingRef.current) {
        onIsOrbitingChange(false);
      }
    };

    controls.domElement.addEventListener('mousedown', stopCameraMovement);
    controls.domElement.addEventListener('wheel', stopCameraMovement);
    controls.domElement.addEventListener('touchstart', stopCameraMovement);

    // ── Satellite tile engine ─────────────────────────────────────────────────
    // react-globe.gl's ref only exposes a whitelist of methods, so globeTileEngineUrl
    // isn't on the ref directly. The underlying threeGlobe THREE.Group (from globe.gl's
    // fromKapsule wrapper) has it — find it by traversing the scene.
    const scene = globeEl.current.scene() as any;
    if (scene) {
      scene.traverse((obj: any) => {
        if (typeof obj.globeTileEngineUrl === 'function') {
          obj.globeTileEngineUrl(
            (x: number, y: number, level: number) =>
              `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${level}/${y}/${x}`
          );
          obj.globeTileEngineMaxLevel(17);
        }
      });
    }

    // ── Layer manager ─────────────────────────────────────────────────────────
    if (!layerManagerRef.current) {
      const manager = new GlobeLayerManager();
      manager.initialize(globeEl.current);
      layerManagerRef.current = manager;
      onLayerManagerReady(manager);
    }

    onGlobeReady(globeEl.current);

    return () => {
      controls.removeEventListener('change', updateTilt);
      try {
        if (controls.domElement) {
          const clone = controls.domElement.cloneNode(true);
          if (controls.domElement.parentNode) {
            controls.domElement.parentNode.replaceChild(clone, controls.domElement);
          }
        }
      } catch {
        // ignore
      }
    };
  }, [isGlobeReady, onGlobeReady, onLayerManagerReady]);

  // ── Intro animation — starts once targetPosition is resolved ─────────────
  // Separated from the main setup effect so targetPosition is a tracked dep.
  // targetPositionReady prevents starting with the fallback before the fetch settles.
  useEffect(() => {
    if (!isGlobeReady || !globeEl.current || !targetPositionReady) return;
    const target = targetPosition ?? DEFAULT_TARGET;
    console.log(
      `[GlobeComponent] intro animation → lat=${target.lat.toFixed(2)}, lng=${target.lng.toFixed(2)}` +
      (targetPosition ? ' (hotspot)' : ' (default fallback)')
    );
    if (animationRef.current) {
      animationRef.current.cancel();
    }
    animationRef.current = introCameraMovement(globeEl, target);
    return () => {
      if (animationRef.current) {
        animationRef.current.cancel();
        animationRef.current = null;
      }
    };
  }, [isGlobeReady, targetPosition, targetPositionReady]);

  // ── React to is3D prop changes ────────────────────────────────────────────
  useEffect(() => {
    is3DRef.current = is3D;
    if (!isGlobeReady || !globeEl.current) return;
    let controls: any;
    try { controls = globeEl.current.controls(); } catch { return; }
    if (!controls) return;

    if (!is3D) {
      controls.target.copy(globeOrigin.current);
    }
    // If is3D just turned on, the controls.change listener re-applies tilt on the next frame
  }, [is3D, isGlobeReady]);

  // ── React to isOrbiting prop changes ─────────────────────────────────────
  useEffect(() => {
    isOrbitingRef.current = isOrbiting;
    if (!isGlobeReady || !globeEl.current) return;
    let controls: any;
    try { controls = globeEl.current.controls(); } catch { return; }
    if (!controls) return;

    if (isOrbiting) {
      const pov = globeEl.current.pointOfView();
      const isClose = pov.altitude < TILT_THRESHOLD_ENTER;
      controls.autoRotateSpeed = isClose ? ORBIT_SPEED_SURFACE : ORBIT_SPEED_PLANET;
      controls.autoRotate = true;
    } else {
      controls.autoRotate = false;

      // Ease back to north-at-top by re-pointing camera at current lat/lng/altitude.
      // globe.gl's pointOfView always places the camera in the canonical north-up
      // orientation for the given coordinates.
      const pov = globeEl.current.pointOfView();
      tiltPausedRef.current = true;
      globeEl.current.pointOfView(
        { lat: pov.lat, lng: pov.lng, altitude: pov.altitude },
        NORTH_SNAP_DURATION
      );

      // Re-engage tilt after the north-snap animation completes
      // (functional delay tied to the animation duration, not a race-condition workaround)
      setTimeout(() => {
        tiltPausedRef.current = false;
      }, NORTH_SNAP_DURATION + 100);
    }
  }, [isOrbiting, isGlobeReady]);

  // ── Layer manager cleanup ─────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (layerManagerRef.current) {
        layerManagerRef.current.dispose();
        layerManagerRef.current = null;
      }
    };
  }, []);

  return (
    <Globe
      ref={globeEl}
      onGlobeReady={() => setIsGlobeReady(true)}
      globeImageUrl="https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg"
      bumpImageUrl="https://unpkg.com/three-globe/example/img/earth-topology.png"
      backgroundImageUrl="https://unpkg.com/three-globe/example/img/night-sky.png"
      animateIn={false}
    />
  );
};
