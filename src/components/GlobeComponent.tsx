import React, { useRef, useEffect, useState } from 'react';
import Globe from 'react-globe.gl';
import * as THREE from 'three';
import { GlobeLayerManager } from '../managers';
import { easeInOutCubicShifted } from '../utils';
import { updateSunDirection, patchTileMaterial, patchNightTileMaterial, createNightTileEngine, sharedNightUniforms } from '../services/dayNightMaterial';
import { createMoonMesh, updateMoonPosition, updateMoonOrientation } from '../services/moonMesh';
import { MOON_RADIUS_SCENE } from '../services/astronomy';

const TILT_THRESHOLD_ENTER = 1.0;
const TILT_THRESHOLD_EXIT  = 1.15;
const MIN_ALTITUDE         = 0.001;


const PITCH_NEAR_THRESHOLD = 0;
const PITCH_MAX_ZOOM       = Math.PI / 3; // 60° from vertical = 30° elevation at max zoom

const ORBIT_SPEED_PLANET      = 0.067;
const ORBIT_HEADING_SPEED = 2 * Math.PI / 60; // rad/s — one full revolution per 60 seconds

const NORTH_SNAP_DURATION = 1200;

interface TargetPosition {
  lat: number;
  lng: number;
}

interface FlyToTarget {
  lat: number;
  lng: number;
  altitude?: number;
}

interface GlobeComponentProps {
  onGlobeReady: (globeEl: any) => void;
  onLayerManagerReady: (layerManager: GlobeLayerManager) => void;
  targetPosition?: TargetPosition | null;
  targetPositionReady?: boolean;
  flyTo?: FlyToTarget | null;
  is3D: boolean;
  onIs3DChange: (val: boolean) => void;
  isOrbiting: boolean;
  onIsOrbitingChange: (val: boolean) => void;
  viewTarget?: 'earth' | 'moon';
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
  const tEased = t * t; // quadratic: slow to tilt near threshold, progressively steeper close to ground
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
  // Reduce altitude by cos(pitch) so camera orbits target at constant distance rather than
  // constant radial height — prevents the "zooming out" feel as tilt increases.
  const r = earthR * (1 + state.altitude * Math.cos(state.pitch));

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
  flyTo,
  is3D,
  onIs3DChange,
  isOrbiting,
  onIsOrbitingChange,
  viewTarget = 'earth',
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
  const flyToActiveRef         = useRef(false);
  useEffect(() => { prefer3DRef.current = is3D; }, [is3D]);

  const dragVelocityRef  = useRef<{ dlat: number; dlng: number } | null>(null);

  const tileEngineRef = useRef<THREE.Object3D | null>(null);

  const nightTileEngineRef = useRef<THREE.Object3D | null>(null);
  const moonMeshRef = useRef<THREE.Mesh | null>(null);

  // Day/night: darken day tiles + GIBS night tiles with additive blending for city lights
  useEffect(() => {
    if (!isGlobeReady || !globeEl.current) return;
    let cancelled = false;
    let rafId: number;

    const globeRadius = globeEl.current.getGlobeRadius() as number;
    const nightEngine = createNightTileEngine(globeRadius);
    nightEngine.scale.setScalar(1.001);
    const scene = globeEl.current.scene() as THREE.Scene;
    scene.add(nightEngine);
    nightTileEngineRef.current = nightEngine;

    const moonMesh = createMoonMesh();
    scene.add(moonMesh);
    moonMeshRef.current = moonMesh;

    // Sky sphere: located once the background texture mesh is created by the
    // library. Identified by BackSide material with a color/image map (the
    // atmosphere uses ShaderMaterial so it's distinguishable).
    let skySphere: THREE.Mesh | null = null;
    const findSkySphere = (): THREE.Mesh | null => {
      let found: THREE.Mesh | null = null;
      scene.traverse((obj: any) => {
        if (found) return;
        if (obj.isMesh && obj.material?.side === THREE.BackSide && obj.material?.map) {
          found = obj;
        }
      });
      return found;
    };

    const EARTH_R = globeRadius;
    const MOON_R_SCENE = MOON_RADIUS_SCENE;
    const tmpCamPos = new THREE.Vector3();
    const tmpDir = new THREE.Vector3();
    const tmpSunDir = new THREE.Vector3();
    const tmpMoonPos = new THREE.Vector3();

    const computeBrightArea = (body: 'earth' | 'moon', camPos: THREE.Vector3, bodyPos: THREE.Vector3, bodyR: number, fovRad: number, albedoScale: number): number => {
      const toBody = tmpDir.subVectors(bodyPos, camPos);
      const dist = toBody.length();
      if (dist <= bodyR) return albedoScale; // inside surface — treat as fully bright
      const angularR = Math.asin(bodyR / dist);
      const screenFraction = Math.min(1, (angularR / fovRad) * (angularR / fovRad));
      // Lit hemisphere fraction visible from camera
      const camToBody = toBody.normalize();
      const bodyToCam = camToBody.clone().negate();
      const lit = Math.max(0, Math.min(1, bodyToCam.dot(tmpSunDir) * 0.5 + 0.5));
      return lit * albedoScale * Math.min(1, screenFraction / 0.1);
    };

    const tick = () => {
      if (cancelled || !globeEl.current) return;

      const now = new Date();
      updateSunDirection(now);

      const prevMoonPos = moonMesh.position.clone();
      updateMoonPosition(moonMesh, now);
      updateMoonOrientation(moonMesh, now);

      // When in moon view: apply drag inertia, compute camera from orbit state, render
      if (inMoonViewRef.current && moonOrbitState.current && globeEl.current) {
        try {
          // Apply drag velocity with exponential decay
          if (moonVelocityRef.current) {
            const dt = 1 / 60; // approximate frame time
            moonOrbitState.current.theta += moonVelocityRef.current.dTheta * dt;
            moonOrbitState.current.phi = Math.max(0.1, Math.min(Math.PI - 0.1,
              moonOrbitState.current.phi + moonVelocityRef.current.dPhi * dt));
            const decay = Math.exp(-3 * dt);
            moonVelocityRef.current.dTheta *= decay;
            moonVelocityRef.current.dPhi *= decay;
            if (Math.abs(moonVelocityRef.current.dTheta) + Math.abs(moonVelocityRef.current.dPhi) < 0.001) {
              moonVelocityRef.current = null;
            }
          }

          const cam = globeEl.current.camera();
          const moonPos = moonMesh.position;
          const { theta, phi, distance } = moonOrbitState.current;

          const offset = new THREE.Vector3(
            distance * Math.sin(phi) * Math.sin(theta),
            distance * Math.cos(phi),
            distance * Math.sin(phi) * Math.cos(theta),
          );
          cam.position.copy(moonPos).add(offset);
          cam.up.set(0, 1, 0);
          cam.lookAt(moonPos);

          renderScene();
        } catch { /* ignore */ }
      }

      // Patch day tiles with day/night darkening shader
      const camera = globeEl.current.camera();
      const scene = globeEl.current.scene() as THREE.Scene;
      scene.traverse((child: any) => {
        if (child.isMesh && child.material?.isMeshLambertMaterial && !child.material.userData?.__nightTilePatched) {
          patchTileMaterial(child.material);
        }
      });

      // Drive night tile engine + patch night tiles
      nightEngine.updatePov(camera);

      nightEngine.traverse((child: any) => {
        if (child.isMesh && child.material?.isMeshBasicMaterial) {
          child.visible = false;
        } else if (child.isMesh && child.material?.isMeshLambertMaterial) {
          patchNightTileMaterial(child.material);
          child.material.depthWrite = false;
        }
      });

      // Star visibility: fade the sky sphere based on how much bright surface
      // dominates the camera's field of view.
      if (!skySphere) skySphere = findSkySphere();
      if (skySphere) {
        const cam = camera as THREE.PerspectiveCamera;
        const fovRad = (cam.fov * Math.PI) / 180;
        tmpCamPos.copy(cam.position);
        tmpSunDir.copy(sharedNightUniforms.sunDir.value);

        const earthBright = computeBrightArea('earth', tmpCamPos, new THREE.Vector3(0, 0, 0), EARTH_R, fovRad, 1.0);
        tmpMoonPos.copy(moonMesh.position);
        const moonBright = computeBrightArea('moon', tmpCamPos, tmpMoonPos, MOON_R_SCENE, fovRad, 0.4);

        const totalBright = earthBright + moonBright;
        const starVisibility = 1.0 - THREE.MathUtils.smoothstep(totalBright, 0.0, 0.4);

        const mat = skySphere.material as THREE.MeshBasicMaterial;
        if (!mat.transparent) mat.transparent = true;
        mat.opacity = starVisibility;
      }

      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      scene.remove(nightEngine);
      nightEngine.clearTiles();
      nightTileEngineRef.current = null;
      scene.remove(moonMesh);
      moonMesh.geometry.dispose();
      (moonMesh.material as THREE.ShaderMaterial).dispose();
      moonMeshRef.current = null;
    };
  }, [isGlobeReady]);

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
      if (inMoonViewRef.current) return;
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
          tileEngineRef.current = obj;
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
    // Sync parent — skip when flyTo triggered the exit so we don't switch to 2D mid-navigation
    if (!flyToActiveRef.current) {
      onIs3DChange(false);
    }
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

  // ── Programmatic fly-to (hotspot navigation) ─────────────────────────────
  useEffect(() => {
    if (!isGlobeReady || !globeEl.current || !flyTo) return;

    if (animationRef.current) animationRef.current.cancel();

    flyToActiveRef.current = true;

    let controls: any;
    try { controls = globeEl.current.controls(); } catch { flyToActiveRef.current = false; return; }

    const currentAlt = globeEl.current.pointOfView().altitude;

    // Only enter close-mode (3D) if coming from far-mode — if the user is already zoomed
    // in close but chose 2D, respect that and fall through to the pointOfView path below.
    if (!inCloseModeRef.current && currentAlt >= TILT_THRESHOLD_ENTER) {
      preventReentryRef.current = false;
      prefer3DRef.current = true;
      onIs3DChange(true);
      enterCloseMode(controls);
    }

    if (closeModeState.current) {
      // ── Close-mode path: animate closeModeState directly ──────────────────
      const startLat = closeModeState.current.targetLat;
      const startLng = closeModeState.current.targetLng;
      const startAlt = closeModeState.current.altitude;

      let lngDelta = flyTo.lng - startLng;
      if (lngDelta > 180) lngDelta -= 360;
      if (lngDelta < -180) lngDelta += 360;

      const targetAlt = Math.min(flyTo.altitude ?? 0.5, startAlt);

      const duration = 1500;
      let startTime: number | null = null;
      let raf: number | null = null;
      let canceled = false;

      const animate = (ts: number) => {
        if (canceled || !closeModeState.current) return;
        startTime ??= ts;
        const t = Math.min((ts - startTime) / duration, 1);
        const p = easeInOutCubicShifted(t, 0);
        closeModeState.current.targetLat = startLat + (flyTo.lat - startLat) * p;
        closeModeState.current.targetLng = startLng + lngDelta * p;
        closeModeState.current.altitude  = startAlt + (targetAlt - startAlt) * p;
        if (!entryAnimatingRef.current) {
          closeModeState.current.pitch = pitchFromAltitude(closeModeState.current.altitude);
        }
        if (t < 1) {
          raf = requestAnimationFrame(animate);
        } else {
          flyToActiveRef.current = false;
        }
      };

      // One tick so enterCloseMode's first RAF frame runs before we start overwriting state
      const tid = setTimeout(() => {
        if (!canceled) raf = requestAnimationFrame(animate);
      }, 0);

      animationRef.current = {
        cancel: () => {
          canceled = true;
          flyToActiveRef.current = false;
          clearTimeout(tid);
          if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
        },
      };
    } else {
      // ── 2D fallback: user is zoomed in close but in 2D mode — respect it ──
      flyToActiveRef.current = false;
      const start = globeEl.current.pointOfView();
      globeEl.current.pointOfView(start, 0); // reset OrbitControls damping

      let lngDelta = flyTo.lng - start.lng;
      if (lngDelta > 180) lngDelta -= 360;
      if (lngDelta < -180) lngDelta += 360;

      const targetAlt = Math.min(flyTo.altitude ?? 0.5, start.altitude);
      const duration = 1500;
      let startTime: number | null = null;
      let raf: number | null = null;
      let canceled = false;

      const animate = (ts: number) => {
        if (canceled) return;
        startTime ??= ts;
        const t = Math.min((ts - startTime) / duration, 1);
        const p = easeInOutCubicShifted(t, 0);
        globeEl.current.pointOfView({
          lat:      start.lat      + (flyTo.lat - start.lat) * p,
          lng:      start.lng      + lngDelta                * p,
          altitude: start.altitude + (targetAlt - start.altitude) * p,
        }, 0);
        if (t < 1) raf = requestAnimationFrame(animate);
      };

      const tid = setTimeout(() => {
        if (!canceled) raf = requestAnimationFrame(animate);
      }, 0);

      animationRef.current = {
        cancel: () => {
          canceled = true;
          clearTimeout(tid);
          if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
        },
      };
    }

    return () => {
      if (animationRef.current) {
        animationRef.current.cancel();
        animationRef.current = null;
      }
    };
  }, [isGlobeReady, flyTo]);

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
    if (inMoonViewRef.current) return;

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

  // ── Earth/Moon view switching ────────────────────────────────────────────
  //
  // Strategy: the library (react-globe.gl) has TWO independent RAF loops that
  // control the camera — _animationCycle (controls.update + render) and a TWEEN
  // IIFE that processes pointOfView() animations. We cannot patch controls.update
  // to suppress camera movement because the TWEEN loop bypasses controls entirely.
  //
  // Solution: pause the library's animation entirely, clear any active tweens,
  // and fully own the camera + rendering during moon view (same proven pattern
  // as close-mode).
  //
  const viewTargetRef = useRef(viewTarget);
  const moonViewAnimRef = useRef<{ cancel: () => void } | null>(null);
  const inMoonViewRef = useRef(false);
  const savedControlsUpdateRef = useRef<((...args: any[]) => any) | null>(null);

  interface MoonOrbitState {
    theta: number;   // azimuthal angle (radians)
    phi: number;     // polar angle from Y-up (radians), clamped to avoid poles
    distance: number;
  }
  const moonOrbitState = useRef<MoonOrbitState | null>(null);
  const moonVelocityRef = useRef<{ dTheta: number; dPhi: number } | null>(null);

  function pauseLibrary(controls: any) {
    if (!savedControlsUpdateRef.current) {
      savedControlsUpdateRef.current = controls.update.bind(controls);
    }
    controls.update = () => false;
    controls.enabled = false;
    controls.autoRotate = false;
    // Stop the library's _animationCycle (controls.update + renderer.render)
    globeEl.current?.pauseAnimation?.();
    // Kill any active camera tweens by snapping pointOfView to current position
    // (duration=0 means no tween created, and any running tween for a previous
    // pointOfView call will be superseded)
    try {
      const pov = globeEl.current?.pointOfView?.();
      if (pov) globeEl.current.pointOfView(pov, 0);
    } catch { /* ignore */ }
  }

  function resumeLibrary(controls: any) {
    if (savedControlsUpdateRef.current) {
      controls.update = savedControlsUpdateRef.current;
      savedControlsUpdateRef.current = null;
    }
    controls.enabled = true;
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.minDistance = 100.1;
    controls.maxDistance = 10000;
    controls.target.set(0, 0, 0);
    globeEl.current?.resumeAnimation?.();
  }

  function renderScene() {
    if (!globeEl.current) return;
    try {
      const renderer = globeEl.current.renderer();
      const scene = globeEl.current.scene();
      const camera = globeEl.current.camera();
      renderer.render(scene, camera);
    } catch { /* ignore */ }
  }

  // Moon orbit mouse/touch handlers (modeled after close-mode handlers)
  const onMoonMouseDown = (e: MouseEvent) => {
    if (!moonOrbitState.current) return;
    moonVelocityRef.current = null;
    let lastX = e.clientX;
    let lastY = e.clientY;
    let lastTime = performance.now();
    let smoothDTheta = 0;
    let smoothDPhi = 0;

    const onMouseMove = (me: MouseEvent) => {
      if (!moonOrbitState.current) return;
      const dx = me.clientX - lastX;
      const dy = me.clientY - lastY;
      lastX = me.clientX;
      lastY = me.clientY;
      const dTheta = -dx * 0.003;
      const dPhi = -dy * 0.003;
      moonOrbitState.current.theta += dTheta;
      moonOrbitState.current.phi = Math.max(0.1, Math.min(Math.PI - 0.1,
        moonOrbitState.current.phi + dPhi));

      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      if (dt > 0 && dt < 0.1) {
        const alpha = 0.3;
        smoothDTheta = smoothDTheta * (1 - alpha) + (dTheta / dt) * alpha;
        smoothDPhi = smoothDPhi * (1 - alpha) + (dPhi / dt) * alpha;
      }
      lastTime = now;
    };
    const onMouseUp = () => {
      moonVelocityRef.current = { dTheta: smoothDTheta, dPhi: smoothDPhi };
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const onMoonWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!moonOrbitState.current) return;
    const factor = Math.pow(1.001, e.deltaY);
    moonOrbitState.current.distance = Math.max(
      MOON_RADIUS_SCENE * 1.5,
      Math.min(MOON_RADIUS_SCENE * 20, moonOrbitState.current.distance * factor)
    );
  };

  const moonTouchRef = useRef<{ x: number; y: number; dist: number | null } | null>(null);

  const onMoonTouchStart = (e: TouchEvent) => {
    e.preventDefault();
    if (!moonOrbitState.current) return;
    const t0 = e.touches[0];
    const dist = e.touches.length === 2
      ? Math.hypot(e.touches[1].clientX - t0.clientX, e.touches[1].clientY - t0.clientY)
      : null;
    moonTouchRef.current = { x: t0.clientX, y: t0.clientY, dist };

    const onTouchMove = (te: TouchEvent) => {
      if (!moonOrbitState.current || !moonTouchRef.current) return;
      const t = te.touches[0];
      if (te.touches.length === 2 && moonTouchRef.current.dist !== null) {
        const newDist = Math.hypot(te.touches[1].clientX - t.clientX, te.touches[1].clientY - t.clientY);
        const scale = moonTouchRef.current.dist / newDist;
        moonOrbitState.current.distance = Math.max(
          MOON_RADIUS_SCENE * 1.5,
          Math.min(MOON_RADIUS_SCENE * 20, moonOrbitState.current.distance * scale)
        );
        moonTouchRef.current.dist = newDist;
      } else if (te.touches.length === 1) {
        const dx = t.clientX - moonTouchRef.current.x;
        const dy = t.clientY - moonTouchRef.current.y;
        moonTouchRef.current.x = t.clientX;
        moonTouchRef.current.y = t.clientY;
        moonOrbitState.current.theta -= dx * 0.003;
        moonOrbitState.current.phi = Math.max(0.1, Math.min(Math.PI - 0.1,
          moonOrbitState.current.phi - dy * 0.003));
      }
    };
    const onTouchEnd = () => {
      moonTouchRef.current = null;
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
  };

  function enterMoonView(controls: any, camera: THREE.PerspectiveCamera, moonMesh: THREE.Mesh) {
    const moonPos = moonMesh.position.clone();
    const camToMoon = moonPos.clone().sub(camera.position);
    const dist = MOON_RADIUS_SCENE * 4;

    // Compute initial spherical coords from approach direction
    const endOffset = camToMoon.clone().normalize().multiplyScalar(-dist);
    const spherical = new THREE.Spherical().setFromVector3(endOffset);

    moonOrbitState.current = {
      theta: spherical.theta,
      phi: spherical.phi,
      distance: dist,
    };

    // Attach moon orbit handlers
    const el = controls.domElement;
    el.addEventListener('mousedown', onMoonMouseDown);
    el.addEventListener('wheel', onMoonWheel, { passive: false });
    el.addEventListener('touchstart', onMoonTouchStart, { passive: false });
  }

  function exitMoonView(controls: any) {
    moonOrbitState.current = null;
    const el = controls.domElement;
    el.removeEventListener('mousedown', onMoonMouseDown);
    el.removeEventListener('wheel', onMoonWheel);
    el.removeEventListener('touchstart', onMoonTouchStart);
  }

  useEffect(() => {
    if (!isGlobeReady || !globeEl.current || !moonMeshRef.current) return;
    if (viewTarget === viewTargetRef.current) return;
    viewTargetRef.current = viewTarget;

    // Cancel any in-flight animation
    if (moonViewAnimRef.current) {
      moonViewAnimRef.current.cancel();
      moonViewAnimRef.current = null;
    }

    let controls: any;
    try { controls = globeEl.current.controls(); } catch { return; }

    const camera = globeEl.current.camera() as THREE.PerspectiveCamera;
    const moonMesh = moonMeshRef.current;

    if (viewTarget === 'moon') {
      // Set flag BEFORE exitCloseMode to guard the isOrbiting effect
      inMoonViewRef.current = true;

      if (inCloseModeRef.current) exitCloseMode(controls);

      // Pause the library entirely — stops both _animationCycle and kills tweens
      pauseLibrary(controls);

      const startPos = camera.position.clone();
      const startLookTarget = new THREE.Vector3(0, 0, 0); // earth origin
      const duration = 3000;
      let startTime: number | null = null;
      let raf: number | null = null;
      let canceled = false;

      const animate = (ts: number) => {
        if (canceled || !globeEl.current) return;
        startTime ??= ts;
        const t = Math.min((ts - startTime) / duration, 1);
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

        const moonPos = moonMesh.position.clone();
        const viewDist = MOON_RADIUS_SCENE * 4;
        const approachDir = startPos.clone().sub(moonPos).normalize();
        const endPos = moonPos.clone().add(approachDir.multiplyScalar(viewDist));

        camera.position.lerpVectors(startPos, endPos, ease);
        const lookTarget = new THREE.Vector3().lerpVectors(startLookTarget, moonPos, ease);
        camera.up.set(0, 1, 0);
        camera.lookAt(lookTarget);

        renderScene();

        if (t < 1) {
          raf = requestAnimationFrame(animate);
        } else {
          enterMoonView(controls, camera, moonMesh);
          moonViewAnimRef.current = null;
        }
      };

      raf = requestAnimationFrame(animate);
      moonViewAnimRef.current = {
        cancel: () => {
          canceled = true;
          if (raf !== null) cancelAnimationFrame(raf);
        },
      };
    } else {
      // Flying back to earth
      exitMoonView(controls);

      const startPos = camera.position.clone();
      const startLookTarget = moonMesh.position.clone();
      const earthR = globeEl.current.getGlobeRadius() as number;
      const duration = 3000;
      let startTime: number | null = null;
      let raf: number | null = null;
      let canceled = false;

      const animate = (ts: number) => {
        if (canceled || !globeEl.current) return;
        startTime ??= ts;
        const t = Math.min((ts - startTime) / duration, 1);
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

        const earthTarget = new THREE.Vector3(0, 0, 0);
        const viewDist = earthR * 3.5;
        const approachDir = startPos.clone().sub(earthTarget).normalize();
        const endPos = earthTarget.clone().add(approachDir.multiplyScalar(viewDist));

        camera.position.lerpVectors(startPos, endPos, ease);
        const lookTarget = new THREE.Vector3().lerpVectors(startLookTarget, earthTarget, ease);
        camera.up.set(0, 1, 0);
        camera.lookAt(lookTarget);

        renderScene();

        if (t < 1) {
          raf = requestAnimationFrame(animate);
        } else {
          inMoonViewRef.current = false;
          resumeLibrary(controls);
          moonViewAnimRef.current = null;
        }
      };

      raf = requestAnimationFrame(animate);
      moonViewAnimRef.current = {
        cancel: () => {
          canceled = true;
          if (raf !== null) cancelAnimationFrame(raf);
          inMoonViewRef.current = false;
          resumeLibrary(controls);
        },
      };
    }

    return () => {
      if (moonViewAnimRef.current) {
        moonViewAnimRef.current.cancel();
        moonViewAnimRef.current = null;
      }
    };
  }, [viewTarget, isGlobeReady]);

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
