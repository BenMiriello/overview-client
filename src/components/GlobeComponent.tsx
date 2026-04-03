import React, { useRef, useEffect, useState } from 'react';
import Globe from 'react-globe.gl';
import * as THREE from 'three';
import { GlobeLayerManager } from '../managers';
import { easeInOutCubicShifted } from '../utils';

const TILT_THRESHOLD_ENTER = 1.0;
const TILT_THRESHOLD_EXIT  = 1.15;
const MIN_ALTITUDE         = 0.01;

const PITCH_NEAR_THRESHOLD = 0;
const PITCH_MAX_ZOOM       = Math.PI / 4;

const ORBIT_SPEED_PLANET      = 0.067;
const ORBIT_HEADING_SPEED = 2 * Math.PI / 60; // rad/s — one full revolution per 60 seconds

const NORTH_SNAP_DURATION = 1200;

interface TargetPosition {
  lat: number;
  lng: number;
}

interface GlobeComponentProps {
  onGlobeReady: (globeEl: any) => void;
  onLayerManagerReady: (layerManager: GlobeLayerManager) => void;
  targetPosition?: TargetPosition | null;
  targetPositionReady?: boolean;
  is3D: boolean;
  isOrbiting: boolean;
  onIsOrbitingChange: (val: boolean) => void;
}

// Target-primary state: the ground point (targetLat/targetLng) is the invariant.
// Camera position is always derived from this — never stored, never round-tripped.
interface CloseModeState {
  targetLat: number;
  targetLng: number;
  altitude: number;
  heading: number;  // radians clockwise from north
  pitch: number;    // radians from vertical: 0=nadir, PI/2=horizon
}

function latLngToCartesian(lat: number, lng: number, radius: number): THREE.Vector3 {
  const phi   = (90 - lat) * Math.PI / 180;
  const theta = (lng + 180) * Math.PI / 180;
  return new THREE.Vector3(
    -(radius * Math.sin(phi) * Math.cos(theta)),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.sin(theta)
  );
}

function cartesianToLatLng(v: THREE.Vector3): { lat: number; lng: number } {
  const r   = v.length();
  const lat = 90 - Math.acos(v.y / r) * 180 / Math.PI;
  const lng = Math.atan2(v.z, -v.x) * 180 / Math.PI - 180;
  return { lat, lng: ((lng + 540) % 360) - 180 };
}

function pitchFromAltitude(altitude: number): number {
  const t = Math.max(0, Math.min(1,
    (TILT_THRESHOLD_ENTER - altitude) / (TILT_THRESHOLD_ENTER - MIN_ALTITUDE)
  ));
  const tEased = t * t * t;
  return PITCH_NEAR_THRESHOLD + (PITCH_MAX_ZOOM - PITCH_NEAR_THRESHOLD) * tEased;
}

function raySphereIntersect(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  radius: number
): THREE.Vector3 | null {
  const b = 2 * direction.dot(origin);
  const c = origin.dot(origin) - radius * radius;
  const disc = b * b - 4 * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / 2;
  if (t < 0) return null;
  return origin.clone().addScaledVector(direction, t);
}

/**
 * Derives camera world position from target-primary state.
 *
 * pitch=0: camera directly above T.
 * pitch>0: camera offset from T by angleO on the sphere, opposite the heading direction.
 */
function cameraPositionFromTarget(state: CloseModeState, earthR: number): THREE.Vector3 {
  const T = latLngToCartesian(state.targetLat, state.targetLng, earthR);
  const T_unit = T.clone().normalize();
  const r = earthR * (1 + state.altitude);

  if (state.pitch < 0.001) {
    return T_unit.clone().multiplyScalar(r);
  }

  const sinAngleT = Math.min(1, r * Math.sin(state.pitch) / earthR);
  const angleO = Math.asin(sinAngleT) - state.pitch;

  if (angleO < 0.001) {
    return T_unit.clone().multiplyScalar(r);
  }

  // Surface tangent at T: build local frame, apply heading, negate to get "behind" direction
  const worldNorth = new THREE.Vector3(0, 1, 0);
  let eastAtT = new THREE.Vector3().crossVectors(worldNorth, T_unit);
  if (eastAtT.lengthSq() < 1e-6) eastAtT.set(1, 0, 0);
  eastAtT.normalize();
  const northAtT = new THREE.Vector3().crossVectors(T_unit, eastAtT).normalize();

  const headingQuat = new THREE.Quaternion().setFromAxisAngle(T_unit, -state.heading);
  const lookNorth = northAtT.clone().applyQuaternion(headingQuat);
  // Camera is behind the look direction
  const tangent = lookNorth.clone().negate();

  return T_unit.clone()
    .multiplyScalar(Math.cos(angleO))
    .addScaledVector(tangent, Math.sin(angleO))
    .normalize()
    .multiplyScalar(r);
}

/**
 * Sets the Three.js camera position and orientation from target-primary state.
 * Uses camera.lookAt(T) directly — no dual-frame orientation math.
 */
function applyCameraState(
  camera: THREE.Camera,
  state: CloseModeState,
  earthR: number
): void {
  const camPos = cameraPositionFromTarget(state, earthR);
  camera.position.copy(camPos);

  const T_world = latLngToCartesian(state.targetLat, state.targetLng, earthR);

  // camera.up encodes heading: target's local north rotated by heading around T's normal
  const T_unit = T_world.clone().normalize();
  const worldNorth = new THREE.Vector3(0, 1, 0);
  let eastAtT = new THREE.Vector3().crossVectors(worldNorth, T_unit);
  if (eastAtT.lengthSq() < 1e-6) eastAtT.set(1, 0, 0);
  eastAtT.normalize();
  const northAtT = new THREE.Vector3().crossVectors(T_unit, eastAtT).normalize();

  const headingQuat = new THREE.Quaternion().setFromAxisAngle(T_unit, -state.heading);
  const upDir = northAtT.clone().applyQuaternion(headingQuat);

  camera.up.copy(upDir);
  camera.lookAt(T_world);
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
  onIsOrbitingChange,
}) => {
  const globeEl          = useRef<any>(null);
  const layerManagerRef  = useRef<GlobeLayerManager | null>(null);
  const [isGlobeReady, setIsGlobeReady] = useState(false);
  const animationRef     = useRef<{ cancel: () => void } | null>(null);

  const closeModeState   = useRef<CloseModeState | null>(null);
  const closeModeRafRef  = useRef<number | null>(null);
  const inCloseModeRef   = useRef(false);
  const isOrbitingRef    = useRef(isOrbiting);
  const tiltPausedRef    = useRef(false);

  const origControlsUpdateRef = useRef<(() => boolean) | null>(null);

  const prefer3DRef            = useRef(is3D);
  const exitAnimatingRef       = useRef(false);
  const entryAnimatingRef      = useRef(false);
  const preventReentryRef      = useRef(false);
  const justExitedCloseModeRef = useRef(false);
  useEffect(() => { prefer3DRef.current = is3D; }, [is3D]);

  const dragVelocityRef  = useRef<{ dlat: number; dlng: number } | null>(null);

  // ── Main controls setup ──────────────────────────────────────────────────
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
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;

    const checkThreshold = () => {
      if (inCloseModeRef.current) return;
      if (!globeEl.current) return;
      const { altitude } = globeEl.current.pointOfView();
      if (altitude >= TILT_THRESHOLD_EXIT) {
        preventReentryRef.current = false;
      }
      if (altitude < TILT_THRESHOLD_ENTER && prefer3DRef.current && !preventReentryRef.current) {
        enterCloseMode(controls);
      }
    };

    controls.addEventListener('change', checkThreshold);

    const stopIntroAnimation = () => {
      if (animationRef.current) {
        animationRef.current.cancel();
        animationRef.current = null;
      }
    };

    controls.domElement.addEventListener('mousedown', stopIntroAnimation);
    controls.domElement.addEventListener('wheel', stopIntroAnimation, { passive: true });
    controls.domElement.addEventListener('touchstart', stopIntroAnimation);

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

    if (!layerManagerRef.current) {
      const manager = new GlobeLayerManager();
      manager.initialize(globeEl.current);
      layerManagerRef.current = manager;
      onLayerManagerReady(manager);
    }

    onGlobeReady(globeEl.current);

    return () => {
      controls.removeEventListener('change', checkThreshold);
      try {
        if (controls.domElement) {
          controls.domElement.removeEventListener('mousedown', stopIntroAnimation);
          controls.domElement.removeEventListener('wheel', stopIntroAnimation);
          controls.domElement.removeEventListener('touchstart', stopIntroAnimation);
        }
      } catch { /* ignore */ }
    };
  }, [isGlobeReady, onGlobeReady, onLayerManagerReady]);

  // ── Close-mode enter/exit ────────────────────────────────────────────────

  function enterCloseMode(controls: any) {
    if (inCloseModeRef.current || !globeEl.current) return;

    const camera = globeEl.current.camera() as THREE.PerspectiveCamera;
    const earthR = globeEl.current.getGlobeRadius();
    const camPos = camera.position;
    const dist   = camPos.length();
    const altitude = (dist - earthR) / earthR;

    // OrbitControls targets origin → camera looks along -camPos direction.
    // Raycast from camera center to find the surface point we're looking at.
    const lookDir = camPos.clone().normalize().negate();
    const hit = raySphereIntersect(camPos, lookDir, earthR);
    let targetLat: number, targetLng: number;
    if (hit) {
      const ll = cartesianToLatLng(hit);
      targetLat = ll.lat;
      targetLng = ll.lng;
    } else {
      const ll = cartesianToLatLng(camPos);
      targetLat = ll.lat;
      targetLng = ll.lng;
    }

    const targetPitch = pitchFromAltitude(altitude);
    closeModeState.current = {
      targetLat,
      targetLng,
      altitude,
      heading: 0,
      pitch: 0,
    };

    origControlsUpdateRef.current = controls.update.bind(controls);
    controls.update   = () => false;
    controls.enabled  = false;
    controls.autoRotate = false;

    if (isOrbitingRef.current) {
      isOrbitingRef.current = false;
      onIsOrbitingChange(false);
    }

    dragVelocityRef.current = null;
    inCloseModeRef.current = true;
    entryAnimatingRef.current = true;

    startCloseModeLoop(controls);

    const el = controls.domElement;
    el.addEventListener('mousedown', onCloseMouseDown);
    el.addEventListener('wheel', onCloseWheel, { passive: false });
    el.addEventListener('touchstart', onCloseTouchStart, { passive: false });

    // Animate pitch from 0 to target (2D→3D transition), using dynamic pitch so zoom can continue
    const startTime = performance.now();
    const DURATION = 500;
    const animateEntry = (now: number) => {
      if (!closeModeState.current || !inCloseModeRef.current) return;
      const t = Math.min((now - startTime) / DURATION, 1);
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      closeModeState.current.pitch = pitchFromAltitude(closeModeState.current.altitude) * ease;
      if (t < 1) {
        requestAnimationFrame(animateEntry);
      } else {
        entryAnimatingRef.current = false;
      }
    };
    requestAnimationFrame(animateEntry);
  }

  function animateExitCloseMode(controls: any) {
    if (!closeModeState.current || !globeEl.current) return;

    const startPitch = closeModeState.current.pitch;
    const rawH = closeModeState.current.heading % (2 * Math.PI);
    const startHeading = rawH > Math.PI ? rawH - 2 * Math.PI : rawH < -Math.PI ? rawH + 2 * Math.PI : rawH;

    if (startPitch < 0.01 && Math.abs(startHeading) < 0.01) {
      exitCloseMode(controls);
      return;
    }

    isOrbitingRef.current = false;
    dragVelocityRef.current = null;
    exitAnimatingRef.current = true;

    const startTime = performance.now();
    const DURATION = 500;

    const animTick = (now: number) => {
      if (!closeModeState.current) return;
      const t = Math.min((now - startTime) / DURATION, 1);
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

      closeModeState.current.pitch = startPitch * (1 - ease);
      closeModeState.current.heading = startHeading * (1 - ease);

      if (t < 1) {
        requestAnimationFrame(animTick);
      } else {
        closeModeState.current.pitch = 0;
        closeModeState.current.heading = 0;
        exitAnimatingRef.current = false;
        exitCloseMode(controls);
      }
    };
    requestAnimationFrame(animTick);
  }

  function exitCloseMode(controls: any) {
    if (!inCloseModeRef.current) return;

    stopCloseModeLoop();

    if (origControlsUpdateRef.current) {
      controls.update = origControlsUpdateRef.current;
      origControlsUpdateRef.current = null;
    }
    controls.enabled    = true;
    controls.autoRotate = false;
    controls.target.set(0, 0, 0);

    // Position camera directly above the target point
    if (closeModeState.current && globeEl.current) {
      const camera = globeEl.current.camera() as THREE.Camera;
      const earthR = globeEl.current.getGlobeRadius();
      const { targetLat, targetLng, altitude } = closeModeState.current;
      const dist = earthR * (1 + altitude);
      camera.position.copy(latLngToCartesian(targetLat, targetLng, dist));
      camera.up.set(0, 1, 0);
      camera.lookAt(0, 0, 0);
    }

    const el = controls.domElement;
    el.removeEventListener('mousedown', onCloseMouseDown);
    el.removeEventListener('wheel', onCloseWheel);
    el.removeEventListener('touchstart', onCloseTouchStart);

    closeModeState.current = null;
    inCloseModeRef.current = false;
    preventReentryRef.current = true;
    justExitedCloseModeRef.current = true;
    onIsOrbitingChange(false);
    isOrbitingRef.current = false;
  }

  // ── Close-mode RAF loop ──────────────────────────────────────────────────

  function startCloseModeLoop(controls: any) {
    let lastTime: number | null = null;

    const tick = (now: number) => {
      if (!inCloseModeRef.current || !closeModeState.current || !globeEl.current) return;

      const dt = lastTime !== null ? Math.min((now - lastTime) / 1000, 0.1) : 0;
      lastTime = now;

      if (!exitAnimatingRef.current && !entryAnimatingRef.current) {
        if (isOrbitingRef.current) {
          closeModeState.current.heading += ORBIT_HEADING_SPEED * dt;
          if (closeModeState.current.heading > 2 * Math.PI) closeModeState.current.heading -= 2 * Math.PI;
        }

        if (dragVelocityRef.current && dt > 0) {
          closeModeState.current.targetLat += dragVelocityRef.current.dlat * dt;
          closeModeState.current.targetLng += dragVelocityRef.current.dlng * dt;
          closeModeState.current.targetLat = Math.max(-85, Math.min(85, closeModeState.current.targetLat));
          const decay = Math.exp(-2.5 * dt);
          dragVelocityRef.current.dlat *= decay;
          dragVelocityRef.current.dlng *= decay;
          if (Math.abs(dragVelocityRef.current.dlat) + Math.abs(dragVelocityRef.current.dlng) < 0.001) {
            dragVelocityRef.current = null;
          }
        }
      }

      const camera = globeEl.current.camera() as THREE.Camera;
      const earthR = globeEl.current.getGlobeRadius();
      applyCameraState(camera, closeModeState.current, earthR);
      controls.dispatchEvent({ type: 'change' });

      closeModeRafRef.current = requestAnimationFrame(tick);
    };

    closeModeRafRef.current = requestAnimationFrame(tick);
  }

  function stopCloseModeLoop() {
    if (closeModeRafRef.current !== null) {
      cancelAnimationFrame(closeModeRafRef.current);
      closeModeRafRef.current = null;
    }
  }

  // ── Close-mode event handlers ────────────────────────────────────────────

  const onCloseMouseDown = (e: MouseEvent) => {
    if (!globeEl.current || !closeModeState.current || exitAnimatingRef.current || entryAnimatingRef.current) return;

    dragVelocityRef.current = null;

    let lastX = e.clientX;
    let lastY = e.clientY;
    let lastMoveTime = performance.now();
    let smoothDlat = 0;
    let smoothDlng = 0;

    const onMouseMove = (me: MouseEvent) => {
      if (!closeModeState.current || !globeEl.current) return;

      const dx = me.clientX - lastX;
      const dy = me.clientY - lastY;
      lastX = me.clientX;
      lastY = me.clientY;
      if (dx === 0 && dy === 0) return;

      const camera = globeEl.current.camera() as THREE.PerspectiveCamera;
      const viewH = globeEl.current.renderer().domElement.clientHeight;
      const fovRad = camera.fov * Math.PI / 180;
      const alt = closeModeState.current.altitude;

      const degPerPx = (2 * alt * Math.tan(fovRad / 2) * (180 / Math.PI)) / viewH;
      const cosLat = Math.cos(closeModeState.current.targetLat * Math.PI / 180);

      const h = closeModeState.current.heading;
      const cosH = Math.cos(h);
      const sinH = Math.sin(h);
      const dlat = degPerPx * (dy * cosH + dx * sinH);
      const dlng = degPerPx * (dy * sinH - dx * cosH) / Math.max(cosLat, 0.1);

      closeModeState.current.targetLat += dlat;
      closeModeState.current.targetLng += dlng;
      closeModeState.current.targetLat = Math.max(-85, Math.min(85, closeModeState.current.targetLat));

      const now = performance.now();
      const dt = (now - lastMoveTime) / 1000;
      if (dt > 0 && dt < 0.1) {
        const alpha = 0.3;
        smoothDlat = smoothDlat * (1 - alpha) + (dlat / dt) * alpha;
        smoothDlng = smoothDlng * (1 - alpha) + (dlng / dt) * alpha;
      }
      lastMoveTime = now;
    };

    const onMouseUp = () => {
      dragVelocityRef.current = { dlat: smoothDlat, dlng: smoothDlng };
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const onCloseWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!closeModeState.current || !globeEl.current || exitAnimatingRef.current) return;

    const zoomFactor = Math.pow(0.999, -e.deltaY);
    const newAlt = Math.max(MIN_ALTITUDE, closeModeState.current.altitude * zoomFactor);

    if (newAlt > TILT_THRESHOLD_EXIT) {
      let controls: any;
      try { controls = globeEl.current.controls(); } catch { return; }
      animateExitCloseMode(controls);
      return;
    }

    closeModeState.current.altitude = newAlt;
    if (!entryAnimatingRef.current) {
      closeModeState.current.pitch = pitchFromAltitude(newAlt);
    }
  };

  const touchStartRef = useRef<{ x: number; y: number; dist: number | null } | null>(null);

  const onCloseTouchStart = (e: TouchEvent) => {
    e.preventDefault();
    if (!globeEl.current || !closeModeState.current || exitAnimatingRef.current) return;

    if (entryAnimatingRef.current && e.touches.length < 2) return;

    const t0 = e.touches[0];
    const dist = e.touches.length === 2
      ? Math.hypot(e.touches[1].clientX - t0.clientX, e.touches[1].clientY - t0.clientY)
      : null;
    touchStartRef.current = { x: t0.clientX, y: t0.clientY, dist };
    dragVelocityRef.current = null;

    let lastTouchX = t0.clientX;
    let lastTouchY = t0.clientY;
    let lastTouchMoveTime = performance.now();
    let smoothTouchDlat = 0;
    let smoothTouchDlng = 0;

    const onTouchMove = (te: TouchEvent) => {
      if (!closeModeState.current || !touchStartRef.current || !globeEl.current) return;
      const t = te.touches[0];

      if (te.touches.length === 2 && touchStartRef.current.dist !== null) {
        const newDist = Math.hypot(te.touches[1].clientX - t.clientX, te.touches[1].clientY - t.clientY);
        const scale   = touchStartRef.current.dist / newDist;
        const newAlt  = Math.max(MIN_ALTITUDE, closeModeState.current.altitude * scale);
        if (newAlt > TILT_THRESHOLD_EXIT) {
          let controls: any;
          try { controls = globeEl.current?.controls(); } catch { return; }
          if (controls) animateExitCloseMode(controls);
          return;
        }
        closeModeState.current.altitude = newAlt;
        if (!entryAnimatingRef.current) {
          closeModeState.current.pitch = pitchFromAltitude(newAlt);
        }
        touchStartRef.current.dist = newDist;
      } else if (te.touches.length === 1 && !entryAnimatingRef.current) {
        const dx = t.clientX - lastTouchX;
        const dy = t.clientY - lastTouchY;
        lastTouchX = t.clientX;
        lastTouchY = t.clientY;
        if (dx === 0 && dy === 0) return;

        const camera = globeEl.current.camera() as THREE.PerspectiveCamera;
        const viewH = globeEl.current.renderer().domElement.clientHeight;
        const fovRad = camera.fov * Math.PI / 180;
        const alt = closeModeState.current.altitude;

        const degPerPx = (2 * alt * Math.tan(fovRad / 2) * (180 / Math.PI)) / viewH;
        const cosLat = Math.cos(closeModeState.current.targetLat * Math.PI / 180);

        const h = closeModeState.current.heading;
        const cosH = Math.cos(h);
        const sinH = Math.sin(h);
        const dlat = degPerPx * (dy * cosH + dx * sinH);
        const dlng = degPerPx * (dy * sinH - dx * cosH) / Math.max(cosLat, 0.1);

        closeModeState.current.targetLat += dlat;
        closeModeState.current.targetLng += dlng;
        closeModeState.current.targetLat = Math.max(-85, Math.min(85, closeModeState.current.targetLat));

        const now = performance.now();
        const dt = (now - lastTouchMoveTime) / 1000;
        if (dt > 0 && dt < 0.1) {
          const alpha = 0.3;
          smoothTouchDlat = smoothTouchDlat * (1 - alpha) + (dlat / dt) * alpha;
          smoothTouchDlng = smoothTouchDlng * (1 - alpha) + (dlng / dt) * alpha;
        }
        lastTouchMoveTime = now;
      }
    };

    const onTouchEnd = () => {
      touchStartRef.current = null;
      dragVelocityRef.current = { dlat: smoothTouchDlat, dlng: smoothTouchDlng };
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };

    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
  };

  // ── Intro animation ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!isGlobeReady || !globeEl.current || !targetPositionReady) return;
    if (!targetPosition) return;
    const target = targetPosition;
    console.log(
      `[GlobeComponent] intro animation → lat=${target.lat.toFixed(2)}, lng=${target.lng.toFixed(2)} (hotspot)`
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

  // ── React to is3D preference changes ─────────────────────────────────────
  useEffect(() => {
    if (!isGlobeReady || !globeEl.current) return;
    prefer3DRef.current = is3D;

    if (!is3D && inCloseModeRef.current) {
      try {
        animateExitCloseMode(globeEl.current.controls());
      } catch { /* ignore */ }
    }

    if (is3D) {
      preventReentryRef.current = false;
      if (!inCloseModeRef.current) {
        const { altitude } = globeEl.current.pointOfView();
        if (altitude < TILT_THRESHOLD_ENTER) {
          try {
            enterCloseMode(globeEl.current.controls());
          } catch { /* ignore */ }
        }
      }
    }
  }, [is3D, isGlobeReady]);

  // ── React to isOrbiting prop changes ─────────────────────────────────────
  useEffect(() => {
    isOrbitingRef.current = isOrbiting;

    if (!isGlobeReady || !globeEl.current) return;

    if (inCloseModeRef.current) {
      if (!isOrbiting && !tiltPausedRef.current && closeModeState.current
          && Math.abs(closeModeState.current.heading) > 0.01) {
        const raw = closeModeState.current.heading % (2 * Math.PI);
        const startHeading = raw > Math.PI ? raw - 2 * Math.PI : raw < -Math.PI ? raw + 2 * Math.PI : raw;
        const startTime     = performance.now();
        tiltPausedRef.current = true;

        const snapTick = (now: number) => {
          if (!closeModeState.current) return;
          const elapsed = now - startTime;
          const t = Math.min(elapsed / NORTH_SNAP_DURATION, 1);
          const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
          closeModeState.current.heading = startHeading * (1 - ease);
          if (t < 1) {
            requestAnimationFrame(snapTick);
          } else {
            closeModeState.current.heading = 0;
            tiltPausedRef.current = false;
          }
        };
        requestAnimationFrame(snapTick);
      }
      return;
    }

    // Far mode
    let controls: any;
    try { controls = globeEl.current.controls(); } catch { return; }
    if (!controls) return;

    if (isOrbiting) {
      controls.autoRotateSpeed = ORBIT_SPEED_PLANET;
      controls.autoRotate = true;
    } else {
      controls.autoRotate = false;
      if (justExitedCloseModeRef.current) {
        justExitedCloseModeRef.current = false;
        return;
      }
      const pov = globeEl.current.pointOfView();
      tiltPausedRef.current = true;
      globeEl.current.pointOfView(
        { lat: pov.lat, lng: pov.lng, altitude: pov.altitude },
        NORTH_SNAP_DURATION
      );
      const snapStart = performance.now();
      const checkSnapDone = () => {
        if (performance.now() - snapStart >= NORTH_SNAP_DURATION) {
          tiltPausedRef.current = false;
        } else {
          requestAnimationFrame(checkSnapDone);
        }
      };
      requestAnimationFrame(checkSnapDone);
    }
  }, [isOrbiting, isGlobeReady]);

  // ── Layer manager cleanup ────────────────────────────────────────────────
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
