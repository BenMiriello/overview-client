import React, { useRef, useEffect, useState } from 'react';
import Globe from 'react-globe.gl';
import * as THREE from 'three';
import { GlobeLayerManager } from '../managers';
import { easeInOutCubicShifted } from '../utils';
import { updateSunDirection, patchTileMaterial, patchNightTileMaterial, createNightTileEngine, sharedNightUniforms } from '../services/dayNightMaterial';
import { createMoonMesh, updateMoonPosition, updateMoonOrientation, MoonGroup } from '../services/moonMesh';
import { createSunGroup, updateSunPosition, updateSunHalo, disposeSunGroup, SUN_CORE_SCALE, SUN_HALO_SCALE } from '../services/sunMesh';
import { createAtmosphereMesh, updateAtmosphereCamera, disposeAtmosphereMesh } from '../services/atmosphereMesh';
import { MOON_RADIUS_SCENE } from '../services/astronomy';
import { LAYERS } from '../services/renderLayers';
import { StoredView, saveView } from './globeViewPersistence';
import { span as perfSpan, frameMark as perfFrameMark, captureRenderInfo } from '../utils/perfHUD';

const TILT_THRESHOLD_ENTER = 1.0;
const TILT_THRESHOLD_EXIT  = 1.15;
const MIN_ALTITUDE         = 0.001;

// Moon close mode mirrors earth's close-mode thresholds in moon-radius units.
const MOON_TILT_THRESHOLD_ENTER = 1.0;
const MOON_TILT_THRESHOLD_EXIT  = 1.15;
const MOON_MIN_ALTITUDE         = 0.001;

// Camera pitch tuning — all values in degrees for readability
const MIN_ELEVATION_DEG    = 22.5;   // lowest viewing angle above horizon at max zoom
const FULL_TILT_ALT        = 0.005; // altitude where min elevation is reached (cloud-ground midpoint)
const PITCH_MAX_ZOOM       = (90 - MIN_ELEVATION_DEG) * Math.PI / 180;

const ORBIT_SPEED_PLANET      = 0.067;
const ORBIT_HEADING_SPEED = 2 * Math.PI / 60; // rad/s — one full revolution per 60 seconds

// Moon orbit camera distance bounds, in units of MOON_RADIUS_SCENE.
// 1.005 → ~9 km altitude in scaled units; close enough to read individual craters
// at NASA WAC level 7 (~100 m/px).
const MOON_MIN_DISTANCE_RATIO = 1.005;
const MOON_MAX_DISTANCE_RATIO = 20;

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
  restoredView?: StoredView | null;
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

// Moon close mode state. Lat/lng are in the moon-LOCAL frame (the moon mesh
// rotates over time; lat/lng remain a constant point on the moon's surface).
interface MoonCloseState {
  targetLat: number;
  targetLng: number;
  altitude: number;  // in moon-radius units
  heading: number;
  pitch: number;
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
  if (altitude >= TILT_THRESHOLD_ENTER) return 0;
  if (altitude <= FULL_TILT_ALT) return PITCH_MAX_ZOOM;
  const t = Math.log(TILT_THRESHOLD_ENTER / altitude)
          / Math.log(TILT_THRESHOLD_ENTER / FULL_TILT_ALT);
  return PITCH_MAX_ZOOM * (1 - (1 - t) * (1 - t));
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

// In close mode the pitched camera's nadir exits the frustum, so the library's octree
// search (centred on nadir) produces zero tiles that pass the frustum test. Fix: send
// additional updatePov calls from synthetic nadir-looking cameras placed above the
// look-at area the camera actually sees — one at the screen centre, one near the horizon.
// Both synthetics share the same altitude as the real camera → same level → no tile eviction.
// After both, the real camera is restored so _isInView reverts to the actual frustum.
//
// Works for any sphere: pass sphereCenter=(0,0,0) for Earth, moonMesh.position for Moon.
function applyHorizonTilePovs(
  engine: { updatePov: (cam: THREE.Camera) => void },
  camera: THREE.PerspectiveCamera,
  sphereCenter: THREE.Vector3,
  sphereRadius: number,
): void {
  const lookDir = new THREE.Vector3();
  camera.getWorldDirection(lookDir);
  const originLocal = camera.position.clone().sub(sphereCenter);
  const camAlt = camera.position.distanceTo(sphereCenter) - sphereRadius;

  const fovHalf = (camera.fov * Math.PI) / 360;
  const right = new THREE.Vector3().crossVectors(lookDir, camera.up).normalize();

  const buildSynth = (dir: THREE.Vector3): THREE.PerspectiveCamera | null => {
    const hit = raySphereIntersect(originLocal, dir, sphereRadius);
    if (!hit) return null;
    const hitWorld = hit.clone().add(sphereCenter);
    const normal = hit.clone().normalize();
    const synth = camera.clone();
    synth.position.copy(hitWorld).addScaledVector(normal, camAlt);
    synth.lookAt(sphereCenter);
    // Widen FOV so the frustum accepts tiles across the library's full octree/bbox search
    // radius. At close altitude the real FOV accepts only ~2° of arc around the nadir;
    // 150° accepts tiles up to ~65° from nadir, matching the octree search radius.
    synth.fov = 150;
    synth.updateProjectionMatrix();
    synth.updateMatrixWorld(true);
    return synth;
  };

  // Near-ground ray: covers the lower screen portion (tiles closer to directly below camera).
  const nearDir = lookDir.clone().applyAxisAngle(right, -fovHalf * 0.7);
  const synthNear = buildSynth(nearDir);
  if (synthNear) engine.updatePov(synthNear);

  const synthCenter = buildSynth(lookDir);
  if (synthCenter) engine.updatePov(synthCenter);

  // Horizon ray: covers the far zone (tiles toward the visible horizon).
  const horizonDir = lookDir.clone().applyAxisAngle(right, fovHalf * 0.8);
  const synthHorizon = buildSynth(horizonDir);
  if (synthHorizon) engine.updatePov(synthHorizon);

  engine.updatePov(camera);
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

  if (angleO <= 0) {
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

// Moon-local lat/lng → cartesian. Matches SlippyMapGlobe's polar2Cartesian
// convention so coords align with the moon's tile UVs (lng=0,lat=0 → +Z).
function moonPolar2Cartesian(lat: number, lng: number, r: number): THREE.Vector3 {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((90 - lng) * Math.PI) / 180;
  return new THREE.Vector3(
    r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  );
}

function moonCartesian2Polar(v: THREE.Vector3): { lat: number; lng: number } {
  const r = v.length();
  if (r < 1e-9) return { lat: 0, lng: 0 };
  const phi = Math.acos(Math.max(-1, Math.min(1, v.y / r)));
  const lat = 90 - (phi * 180) / Math.PI;
  const theta = Math.atan2(v.z, v.x);
  let lng = 90 - (theta * 180) / Math.PI;
  lng = ((lng + 540) % 360) - 180;
  return { lat, lng };
}

/**
 * Sets the camera position/orientation from a moon-local target. The math
 * mirrors `applyCameraState` but operates in the moon's local frame, then
 * transforms to world coords via the moon mesh's current world matrix
 * (the moon both moves and rotates over time, so this must run every frame).
 */
function applyMoonCameraState(
  camera: THREE.Camera,
  state: MoonCloseState,
  moonMesh: THREE.Object3D,
  moonR: number,
): void {
  const T_local = moonPolar2Cartesian(state.targetLat, state.targetLng, moonR);
  const T_unit = T_local.clone().normalize();

  const r = moonR * (1 + state.altitude * Math.cos(state.pitch));

  let camPos_local: THREE.Vector3;
  if (state.pitch < 0.001) {
    camPos_local = T_unit.clone().multiplyScalar(r);
  } else {
    const sinAngleT = Math.min(1, (r * Math.sin(state.pitch)) / moonR);
    const angleO = Math.asin(sinAngleT) - state.pitch;

    if (angleO < 0.001) {
      camPos_local = T_unit.clone().multiplyScalar(r);
    } else {
      const localY = new THREE.Vector3(0, 1, 0);
      let eastAtT = new THREE.Vector3().crossVectors(localY, T_unit);
      if (eastAtT.lengthSq() < 1e-6) eastAtT.set(1, 0, 0);
      eastAtT.normalize();
      const northAtT = new THREE.Vector3().crossVectors(T_unit, eastAtT).normalize();

      const headingQuat = new THREE.Quaternion().setFromAxisAngle(T_unit, -state.heading);
      const lookNorth = northAtT.clone().applyQuaternion(headingQuat);
      const tangent = lookNorth.clone().negate();

      camPos_local = T_unit.clone()
        .multiplyScalar(Math.cos(angleO))
        .addScaledVector(tangent, Math.sin(angleO))
        .normalize()
        .multiplyScalar(r);
    }
  }

  // Up vector in moon-local frame: local-north rotated by heading.
  const localY = new THREE.Vector3(0, 1, 0);
  let eastAtT = new THREE.Vector3().crossVectors(localY, T_unit);
  if (eastAtT.lengthSq() < 1e-6) eastAtT.set(1, 0, 0);
  eastAtT.normalize();
  const northAtT = new THREE.Vector3().crossVectors(T_unit, eastAtT).normalize();
  const headingQuat = new THREE.Quaternion().setFromAxisAngle(T_unit, -state.heading);
  const upDir_local = northAtT.clone().applyQuaternion(headingQuat);

  // Transform local positions/directions to world via moon's current transform.
  moonMesh.updateMatrixWorld();
  const T_world = T_local.clone().applyMatrix4(moonMesh.matrixWorld);
  const camPos_world = camPos_local.clone().applyMatrix4(moonMesh.matrixWorld);
  const upDir_world = upDir_local.clone().applyQuaternion(moonMesh.quaternion);

  camera.position.copy(camPos_world);
  camera.up.copy(upDir_world);
  camera.lookAt(T_world);
}

const introCameraMovement = (
  globeEl: React.RefObject<any>,
  target: TargetPosition,
  shouldAbort: () => boolean,
): { cancel: () => void } => {
  let startTime: number | null = null;
  let animationFrameId: number | null = null;
  let isCanceled = false;

  const initialAltitude = 4;
  const initialLat = target.lat - 10;
  const initialLng = target.lng + 33;

  globeEl.current.pointOfView({ lat: initialLat, lng: initialLng, altitude: initialAltitude }, 0);

  setTimeout(() => {
    if (isCanceled || shouldAbort()) return;

    const duration = 5000;
    const latDelta = target.lat - initialLat;
    const lngDelta = target.lng - initialLng;
    const altShift = -1;

    const animate = (timestamp: number) => {
      if (isCanceled || shouldAbort()) return;
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
  restoredView = null,
}) => {
  const globeEl          = useRef<any>(null);
  const layerManagerRef  = useRef<GlobeLayerManager | null>(null);
  const [isGlobeReady, setIsGlobeReady] = useState(false);
  const animationRef     = useRef<{ cancel: () => void } | null>(null);
  const cancelIntroRef   = useRef<(() => void) | null>(null);
  const restoredViewRef  = useRef<boolean>(restoredView !== null);
  const isOrbitingFirstRunRef = useRef(true);

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

  const tileEngineRef    = useRef<THREE.Object3D | null>(null);
  // The ThreeSlippyMapGlobe instance inside the globe group — needed to call
  // updatePov() ourselves when OrbitControls is disabled (close mode), since
  // the library only calls it from the controls 'change' event.
  const dayTileEngineRef = useRef<any>(null);

  const nightTileEngineRef = useRef<THREE.Object3D | null>(null);
  const moonMeshRef = useRef<MoonGroup | null>(null);

  // Day/night: darken day tiles + GIBS night tiles with additive blending for city lights
  useEffect(() => {
    if (!isGlobeReady || !globeEl.current) return;
    let cancelled = false;
    let rafId: number;

    const globeRadius = globeEl.current.getGlobeRadius() as number;
    const nightEngine = createNightTileEngine(globeRadius);
    nightEngine.scale.setScalar(1.0001);
    const scene = globeEl.current.scene() as THREE.Scene;
    scene.add(nightEngine);
    nightTileEngineRef.current = nightEngine;

    const moonMesh = createMoonMesh();
    scene.add(moonMesh);
    moonMeshRef.current = moonMesh;

    const sunGroup = createSunGroup();
    // Sun is geometrically far behind everything else (~47500 units). For the
    // additive atmosphere shell to compose its limb glow on top of the sun,
    // the sun must enter the framebuffer first.
    sunGroup.renderOrder = LAYERS.SUN;
    sunGroup.traverse((obj: THREE.Object3D) => { obj.renderOrder = LAYERS.SUN; });
    scene.add(sunGroup);

    const atmosphereMesh = createAtmosphereMesh();
    scene.add(atmosphereMesh);

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
    const SUN_BRIGHTNESS_SCALE = 4;
    const tmpCamPos = new THREE.Vector3();
    const tmpDir = new THREE.Vector3();
    const tmpSunDir = new THREE.Vector3();
    const tmpMoonPos = new THREE.Vector3();
    const tmpSunPos = new THREE.Vector3();
    const tmpRayDir = new THREE.Vector3();
    const sunFrustum = new THREE.Frustum();
    const sunSphere = new THREE.Sphere(new THREE.Vector3(), SUN_HALO_SCALE / 2);
    const tmpProjScreen = new THREE.Matrix4();
    const synthDayCam = new THREE.PerspectiveCamera();

    // Returns true if the segment from `camPos` to `sunPos` passes through a
    // sphere at the origin with radius `EARTH_R`. Standard ray-sphere
    // intersection: solve |camPos + t*dir|^2 = R^2 for t in (0, |sunPos-camPos|).
    // Used as the close-mode fallback when the planar disk-overlap formula
    // breaks down (Earth subtends a large angle of the view).
    const sunOccludedByEarth = (camPos: THREE.Vector3, sunPos: THREE.Vector3): boolean => {
      tmpRayDir.subVectors(sunPos, camPos);
      const dist = tmpRayDir.length();
      if (dist === 0) return false;
      tmpRayDir.divideScalar(dist);
      const b = camPos.dot(tmpRayDir);
      const c = camPos.lengthSq() - EARTH_R * EARTH_R;
      const disc = b * b - c;
      if (disc < 0) return false;
      const sq = Math.sqrt(disc);
      const t1 = -b - sq;
      const t2 = -b + sq;
      return (t1 > 0 && t1 < dist) || (t2 > 0 && t2 < dist);
    };

    // Continuous fraction in [0, 1] of how much of the sun's photosphere disk
    // is covered by Earth from the camera's POV. Both the corona halo opacity
    // and the star-fade contribution lerp on this single value, since both
    // visual responses correspond to the same physical event (the bright
    // photosphere being progressively eaten by Earth's limb).
    //
    // Math: model sun and Earth as angular disks seen from the camera and
    // compute their planar lens-area intersection in angular space. This is
    // accurate for `earthAngularR < ~30°`; above that the spherical-cap
    // curvature dominates and we fall back to the binary ray-sphere test.
    const MAX_PLANAR_EARTH_ANGLE = Math.PI / 6; // 30°
    const SUN_OCCLUSION_RADIUS = SUN_CORE_SCALE / 2;
    const sunOccludedFraction = (camPos: THREE.Vector3, sunPos: THREE.Vector3): number => {
      const distEarth = camPos.length();
      if (distEarth <= EARTH_R * 1.00001) return 0;

      const toSunX = sunPos.x - camPos.x;
      const toSunY = sunPos.y - camPos.y;
      const toSunZ = sunPos.z - camPos.z;
      const distSun = Math.sqrt(toSunX * toSunX + toSunY * toSunY + toSunZ * toSunZ);
      if (distSun === 0) return 0;

      // Earth behind camera relative to sun direction → cannot occlude.
      const toEarthDotSunDir = (-camPos.x) * toSunX + (-camPos.y) * toSunY + (-camPos.z) * toSunZ;
      if (toEarthDotSunDir <= 0) return 0;

      const sinEarth = THREE.MathUtils.clamp(EARTH_R / distEarth, 0, 0.9999);
      const earthAngularR = Math.asin(sinEarth);

      // Close camera: planar formula breaks down. Fall back to binary.
      if (earthAngularR > MAX_PLANAR_EARTH_ANGLE) {
        return sunOccludedByEarth(camPos, sunPos) ? 1 : 0;
      }

      const sunAngularR = Math.atan(SUN_OCCLUSION_RADIUS / distSun);

      // Angular separation between camera→Earth and camera→sun directions.
      const cosSep = THREE.MathUtils.clamp(
        (-camPos.x * toSunX + -camPos.y * toSunY + -camPos.z * toSunZ) / (distEarth * distSun),
        -1,
        1,
      );
      const sep = Math.acos(cosSep);

      if (sep >= sunAngularR + earthAngularR) return 0;
      if (sep + sunAngularR <= earthAngularR) return 1;
      if (sep + earthAngularR <= sunAngularR) {
        const ratio = earthAngularR / sunAngularR;
        return ratio * ratio;
      }

      const r1 = sunAngularR;
      const r2 = earthAngularR;
      const d = sep;
      const a = THREE.MathUtils.clamp((d * d + r1 * r1 - r2 * r2) / (2 * d * r1), -1, 1);
      const b = THREE.MathUtils.clamp((d * d + r2 * r2 - r1 * r1) / (2 * d * r2), -1, 1);
      const lens =
        r1 * r1 * (Math.acos(a) - a * Math.sqrt(Math.max(0, 1 - a * a))) +
        r2 * r2 * (Math.acos(b) - b * Math.sqrt(Math.max(0, 1 - b * b)));
      return THREE.MathUtils.clamp(lens / (Math.PI * r1 * r1), 0, 1);
    };

    // Returns a brightness contribution for `body` based on how tall it appears
    // on screen and how much of the visible hemisphere is sunlit. The height
    // fraction (not area) gives a better feel for "how much the body dominates
    // the view" across different aspect ratios.
    const computeBrightArea = (camPos: THREE.Vector3, bodyPos: THREE.Vector3, bodyR: number, fovRad: number, albedoScale: number): number => {
      const toBody = tmpDir.subVectors(bodyPos, camPos);
      const dist = toBody.length();
      if (dist <= bodyR) return albedoScale;
      const angularR = Math.asin(bodyR / dist);
      const heightFraction = Math.min(1, (2 * angularR) / fovRad);
      const camToBody = toBody.normalize();
      const bodyToCam = camToBody.clone().negate();
      const lit = Math.max(0, Math.min(1, bodyToCam.dot(tmpSunDir) * 0.5 + 0.5));
      return lit * albedoScale * heightFraction;
    };

    // Snapshot for gating tile-engine updatePov calls. SlippyMap recomputes
    // its level + fetches on every updatePov, which thrashes when called every
    // frame across multiple engines. We only call updatePov when the camera
    // actually moved by more than a threshold since the last call.
    const lastEngineCamPos = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN);

    // Per-frame back-side tile culling. SlippyMap engines never evict tiles
    // until the LOD level changes, so panning at a fixed level accumulates
    // tiles on the far side of the sphere — they keep getting drawn (depth-
    // rejected by the planet) and burn draw calls + setProgram binds. We
    // skip the binds entirely by toggling mesh.visible based on a horizon
    // test in the engine's local frame.
    //
    // Math: tile passes if its bounding-sphere centroid `c` (in engine-local
    // coords) satisfies `c · camLocal > R · |c|`. For tiles whose centroid
    // sits on a sphere of radius R this reduces to the standard horizon test
    // `c · camLocal > R²`. Limb tolerance (0.95) keeps tiles whose corners
    // may still be visible even when the centroid has just crossed under.
    const tmpCullCam = new THREE.Vector3();
    let lastEvictAt = 0;
    const EVICT_INTERVAL_MS = 1000;
    const EVICT_AGE_MS = 30_000;
    const cullEngineTiles = (engine: THREE.Object3D, sphereR: number, cam: THREE.Camera) => {
      cam.getWorldPosition(tmpCullCam);
      engine.worldToLocal(tmpCullCam);
      const D = tmpCullCam.length();
      // horizonCos = cos(arccos(R/D)) = R/D — the cosine of the angle to the visible horizon.
      const horizonCos = sphereR / D;
      const sinHorizon = Math.sqrt(Math.max(0, 1 - horizonCos * horizonCos));
      const kids = engine.children;
      for (let i = 0; i < kids.length; i++) {
        const mesh = kids[i] as THREE.Mesh;
        if (!(mesh as any).isMesh || !mesh.geometry) continue;
        if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
        const bs = mesh.geometry.boundingSphere!;
        const c = bs.center;
        let cLen = (mesh.userData as any).__cullCLen as number | undefined;
        if (cLen === undefined) {
          cLen = c.length();
          (mesh.userData as any).__cullCLen = cLen;
        }
        // Skip full-sphere children (e.g. SlippyMap's _innerBackLayer): their
        // centroid sits at the origin so the horizon test is meaningless.
        if (cLen < sphereR * 0.1) continue;

        // Tile angular radius from the law of cosines on the triangle
        // (globe origin, bounding-sphere centroid, farthest tile vertex).
        // All tile vertices lie on the sphere of radius sphereR, so:
        //   bsRadius² = sphereR² + cLen² - 2·sphereR·cLen·cos(tileAngularRadius)
        // → cos(tileAngularRadius) = (sphereR² + cLen² - bsRadius²) / (2·sphereR·cLen)
        // This correctly maps the 3D bounding sphere to an angular footprint on the
        // globe surface, unlike the old "dotCA + bsRadius" formula which treated bsRadius
        // as a Z-direction offset and produced large false-positives at close altitudes.
        const tileAngleCos = Math.max(-1, Math.min(1,
          (sphereR * sphereR + cLen * cLen - bs.radius * bs.radius) / (2 * sphereR * cLen)
        ));
        const sinTileAngle = Math.sqrt(Math.max(0, 1 - tileAngleCos * tileAngleCos));

        // A tile is visible if angle(centroid, camera) < horizonAngle + tileAngularRadius.
        // In cosine form: cos(angle) > cos(horizonAngle + tileAngularRadius)
        //   = cosH·cosT − sinH·sinT  (angle-addition formula)
        // 5% buffer (× 0.95) so limb tiles don't pop out before they're fully loaded.
        const limitCos = (horizonCos * tileAngleCos - sinHorizon * sinTileAngle) * 0.95;
        const cDotCam = c.dot(tmpCullCam) / (cLen * D); // cos(angle between centroid and camera)
        const vis = cDotCam > limitCos;
        mesh.visible = vis;
        if (vis) (mesh.userData as any).__lastVisibleAt = Date.now();
      }
    };

    // Recovery watchdog for the npm Earth day engine (react-globe.gl / three-slippy-map-globe).
    // That engine has no onError callback, so failed fetches leave tiles permanently stuck
    // (d.loading=true, blank texture). When child count stops changing in close mode,
    // the engine is likely stuck — clearTiles() resets all tile state.
    const dayEngineWatchdog = { lastCount: -1, lastChangedAt: Date.now() };
    const cameraMoved = (cam: THREE.Camera, threshold: number): boolean => {
      if (Number.isNaN(lastEngineCamPos.x)) {
        lastEngineCamPos.copy(cam.position);
        return true;
      }
      if (cam.position.distanceToSquared(lastEngineCamPos) > threshold * threshold) {
        lastEngineCamPos.copy(cam.position);
        return true;
      }
      return false;
    };

    // Tracks the last stable level for the npm day engine. The npm engine has no
    // hysteresis — we implement it here to prevent level thrashing near thresholds.
    let dayStableLevel: number | null = null;

    const tick = () => {
      if (cancelled || !globeEl.current) return;

      const now = new Date();
      perfSpan('astro', () => {
        updateSunDirection(now);
        updateMoonPosition(moonMesh, now);
        updateMoonOrientation(moonMesh, now);
        updateSunPosition(sunGroup, now);
      });

      // When in moon view + close mode: drive camera from moon-local close state.
      if (inMoonViewRef.current && moonCloseState.current && globeEl.current) {
        try {
          if (moonCloseDragVelocityRef.current) {
            const dt = 1 / 60;
            moonCloseState.current.targetLat += moonCloseDragVelocityRef.current.dlat * dt;
            moonCloseState.current.targetLng += moonCloseDragVelocityRef.current.dlng * dt;
            moonCloseState.current.targetLat = Math.max(-85, Math.min(85, moonCloseState.current.targetLat));
            const decay = Math.exp(-2.5 * dt);
            moonCloseDragVelocityRef.current.dlat *= decay;
            moonCloseDragVelocityRef.current.dlng *= decay;
            if (Math.abs(moonCloseDragVelocityRef.current.dlat) + Math.abs(moonCloseDragVelocityRef.current.dlng) < 0.001) {
              moonCloseDragVelocityRef.current = null;
            }
          }
          const cam = globeEl.current.camera() as THREE.Camera;
          applyMoonCameraState(cam, moonCloseState.current, moonMesh, MOON_RADIUS_SCENE);
          renderScene();
        } catch { /* ignore */ }
      }

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

          if (moonZoomVelocityRef.current !== 0) {
            const newDist = Math.max(
              MOON_RADIUS_SCENE * MOON_MIN_DISTANCE_RATIO,
              Math.min(MOON_RADIUS_SCENE * MOON_MAX_DISTANCE_RATIO,
                moonOrbitState.current.distance * Math.exp(moonZoomVelocityRef.current))
            );
            const newAlt = newDist / MOON_RADIUS_SCENE - 1;
            if (prefer3DRef.current && newAlt < MOON_TILT_THRESHOLD_ENTER) {
              moonZoomVelocityRef.current = 0;
              enterMoonCloseMode(newAlt);
            } else {
              moonOrbitState.current.distance = newDist;
              moonZoomVelocityRef.current *= 0.75; // exponential decay, ~0.5s to drain
              if (Math.abs(moonZoomVelocityRef.current) < 1e-5) moonZoomVelocityRef.current = 0;
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
      perfSpan('sceneTraverse', () => {
        scene.traverse((child: any) => {
          if (child.isMesh && child.material?.isMeshLambertMaterial && !child.material.userData?.__nightTilePatched) {
            patchTileMaterial(child.material);
          }
        });
      });

      // Compute once — cameraMoved updates its internal lastEngineCamPos on the first true result,
      // so all engines share the same snapshot for this tick.
      const ENGINE_MOVE_THRESHOLD = 0.05;
      const cameraActuallyMoved = cameraMoved(camera, ENGINE_MOVE_THRESHOLD);

      // Close mode: OrbitControls disabled — controls.change never fires, drive every frame.
      // Normal mode: controls.change → globe.gl setPointOfView → updatePov covers user-driven moves.
      //   cameraActuallyMoved fills the gap for programmatic moves (intro animation, flyTo) that
      //   bypass OrbitControls entirely. Double-calling during user drag is harmless — the library's
      //   d.loading flag prevents redundant fetches.
      if (dayTileEngineRef.current && (inCloseModeRef.current || cameraActuallyMoved)) {
        perfSpan('updatePov.day', () => {
          if (!inCloseModeRef.current) {
            const perspCam = camera as THREE.PerspectiveCamera;
            if (perspCam.fov !== undefined) {
              const D = camera.position.length();
              const distFromSurface = (D - EARTH_R) / EARTH_R;

              // Altitude-adaptive FOV: arccos(R/D) is the horizon angle. synthFov covers
              // the full visible hemisphere + 5° so edge tiles' hull points pass the npm
              // engine's containsPoint frustum test at any altitude.
              const visAngleDeg = D > EARTH_R
                ? Math.acos(EARTH_R / D) * (180 / Math.PI)
                : 89;
              const synthFov = Math.min(179, visAngleDeg * 2 + 10);

              // Client-side hysteresis: the npm engine has none — OrbitControls inertia
              // oscillates near level thresholds, causing the engine to remove all tiles
              // of the old level before new ones arrive, blanking the globe each bounce.
              const HYSTERESIS = 0.05;
              const thresholds: number[] = dayTileEngineRef.current!.thresholds;
              const curLevel = dayStableLevel ?? dayTileEngineRef.current!.level;
              const rawIdx = thresholds.findIndex((t: number) => t && t <= distFromSurface);
              const rawLevel = Math.min(17, Math.max(0, rawIdx < 0 ? thresholds.length : rawIdx));

              let targetLevel = rawLevel;
              if (rawLevel !== curLevel) {
                const isZoomingIn = rawLevel > curLevel;
                const boundaryIdx = isZoomingIn ? curLevel : rawLevel;
                const boundary = thresholds[boundaryIdx] ?? 0;
                const shouldSwitch = isZoomingIn
                  ? distFromSurface < boundary * (1 - HYSTERESIS)
                  : distFromSurface > boundary * (1 + HYSTERESIS);
                if (!shouldSwitch) targetLevel = curLevel;
              }
              dayStableLevel = targetLevel;

              // Single camera combining both fixes: wide FOV (edge tiles) + hysteresis
              // altitude (level lock). One call instead of two — the npm engine has no
              // position-change early-return, so a second real-camera call would recompute
              // the level from the real altitude and undo the hysteresis.
              synthDayCam.fov = synthFov;
              synthDayCam.aspect = perspCam.aspect;
              synthDayCam.near = perspCam.near;
              synthDayCam.far = perspCam.far;
              const synth = synthDayCam;
              if (targetLevel !== rawLevel) {
                // Hysteresis zone: clamp altitude so the engine's level stays stable.
                // At level <= renderAllCap (6), #isInView passes all tiles regardless of
                // frustum, so the shifted position doesn't affect which tiles are fetched.
                const isZoomingIn = rawLevel > targetLevel;
                const boundary = thresholds[isZoomingIn ? targetLevel : rawLevel] ?? distFromSurface;
                const safeDistFromSurface = boundary * (isZoomingIn ? 1.025 : 0.975);
                synth.position.copy(camera.position).normalize().multiplyScalar(
                  EARTH_R * (1 + safeDistFromSurface)
                );
                synth.quaternion.copy(camera.quaternion);
              } else {
                // Stable level: real position with exact view matrix for correct frustum.
                synth.position.copy(camera.position);
                synth.quaternion.copy(camera.quaternion);
                synth.matrixWorld.copy(camera.matrixWorld);
                synth.matrixWorldInverse.copy(camera.matrixWorldInverse);
              }
              synth.updateProjectionMatrix();
              dayTileEngineRef.current!.updatePov(synth);
            }
          } else {
            dayTileEngineRef.current!.updatePov(camera);
          }
        });
        // Synthetic cameras only needed when camera actually moved — tiles are already
        // loaded when stationary, so the extra updatePov calls would be pure overhead.
        if (inCloseModeRef.current && cameraActuallyMoved) {
          applyHorizonTilePovs(dayTileEngineRef.current, camera as THREE.PerspectiveCamera,
            new THREE.Vector3(), EARTH_R);
        }

        // Watchdog: if in close mode and the tile child count hasn't changed in 30s,
        // the engine is likely stuck with blank tiles. clearTiles() resets all state
        // so tiles can be re-fetched fresh.
        if (inCloseModeRef.current) {
          const count = dayTileEngineRef.current.children.length;
          if (count !== dayEngineWatchdog.lastCount) {
            dayEngineWatchdog.lastCount = count;
            dayEngineWatchdog.lastChangedAt = Date.now();
          } else if (Date.now() - dayEngineWatchdog.lastChangedAt > 30_000) {
            dayTileEngineRef.current.clearTiles();
            dayEngineWatchdog.lastChangedAt = Date.now();
          }
        }
      }
      if (inCloseModeRef.current || cameraActuallyMoved) {
        perfSpan('updatePov.night', () => nightEngine.updatePov(camera));
        if (inCloseModeRef.current && cameraActuallyMoved) {
          applyHorizonTilePovs(nightEngine, camera as THREE.PerspectiveCamera,
            new THREE.Vector3(), EARTH_R);
        }
        if (moonMeshRef.current) {
          const inMoonClose = inMoonViewRef.current && moonCloseState.current !== null;
          if (inMoonClose || cameraActuallyMoved) {
            const moonCenter = moonMeshRef.current.position.clone();
            moonMeshRef.current.colorEngine.updatePov(camera);
            if (inMoonClose && cameraActuallyMoved) {
              applyHorizonTilePovs(moonMeshRef.current.colorEngine,
                camera as THREE.PerspectiveCamera, moonCenter, MOON_RADIUS_SCENE);
            }
            moonMeshRef.current.reliefEngine.updatePov(camera);
            if (inMoonClose && cameraActuallyMoved) {
              applyHorizonTilePovs(moonMeshRef.current.reliefEngine,
                camera as THREE.PerspectiveCamera, moonCenter, MOON_RADIUS_SCENE);
            }
          }
        }
      }

      perfSpan('cullTiles', () => {
        if (dayTileEngineRef.current) cullEngineTiles(dayTileEngineRef.current, EARTH_R, camera);
        cullEngineTiles(nightEngine, EARTH_R, camera);
        if (moonMeshRef.current) {
          cullEngineTiles(moonMeshRef.current.colorEngine, MOON_R_SCENE, camera);
          cullEngineTiles(moonMeshRef.current.reliefEngine, MOON_R_SCENE, camera);
        }
      });

      const evictNow = Date.now();
      if (evictNow - lastEvictAt > EVICT_INTERVAL_MS) {
        lastEvictAt = evictNow;
        perfSpan('evict', () => {
          const pred = (m: THREE.Mesh) =>
            !m.visible && evictNow - ((m.userData as any).__lastVisibleAt ?? 0) > EVICT_AGE_MS;
          nightEngine.evictTiles(pred);
          if (moonMeshRef.current) {
            moonMeshRef.current.colorEngine.evictTiles(pred);
            moonMeshRef.current.reliefEngine.evictTiles(pred);
          }
        });
      }

      perfSpan('nightTraverse', () => {
        nightEngine.traverse((child: any) => {
          if (child.isMesh && child.material?.isMeshBasicMaterial) {
            child.visible = false;
          } else if (child.isMesh && child.material?.isMeshLambertMaterial) {
            patchNightTileMaterial(child.material);
            child.material.depthWrite = false;
          }
        });
      });

      // Star visibility: modulate the sky sphere material color (which is
      // multiplied into its texture) instead of opacity. Using opacity reveals
      // the renderer clear color through the fade — color modulation keeps the
      // result at pure black at zero brightness regardless of clear color.
      // Sun occlusion: compute once per tick. Used for both star fade and
      // halo visibility (corona only shows when the sun is blocked).
      const camForSun = camera as THREE.PerspectiveCamera;
      const fovRad = (camForSun.fov * Math.PI) / 180;
      let sunOcclFraction = 0;
      perfSpan('sunHalo', () => {
        tmpCamPos.copy(camForSun.position);
        tmpSunPos.copy(sunGroup.position);
        sunOcclFraction = sunOccludedFraction(tmpCamPos, tmpSunPos);
        updateSunHalo(sunGroup, sunOcclFraction);
        updateAtmosphereCamera(atmosphereMesh, camForSun);
      });

      if (!skySphere) {
        skySphere = findSkySphere();
        if (skySphere) {
          // Background must not write depth: it's far away and z-precision
          // there is too coarse, causing additive sprites (the sun) to flicker
          // when they fall on the wrong side of the depth test.
          (skySphere.material as THREE.MeshBasicMaterial).depthWrite = false;
        }
      }
      if (skySphere) {
        const sky = skySphere;
        perfSpan('skyBright', () => {
          tmpSunDir.copy(sharedNightUniforms.sunDir.value);

          const earthBright = computeBrightArea(tmpCamPos, new THREE.Vector3(0, 0, 0), EARTH_R, fovRad, 0.8);
          tmpMoonPos.copy(moonMesh.position);
          const moonBright = computeBrightArea(tmpCamPos, tmpMoonPos, MOON_R_SCENE, fovRad, 0.66);

          // Sun contribution: stylized fixed angular size from the halo sprite,
          // gated by a sphere-frustum check (so it doesn't pop when only the
          // sun's center crosses the frame edge) and scaled by the same
          // occlusion fraction that drives the halo lerp.
          tmpProjScreen.multiplyMatrices(camForSun.projectionMatrix, camForSun.matrixWorldInverse);
          sunFrustum.setFromProjectionMatrix(tmpProjScreen);
          sunSphere.center.copy(tmpSunPos);
          let sunBright = 0;
          if (sunFrustum.intersectsSphere(sunSphere)) {
            const sunDist = tmpCamPos.distanceTo(tmpSunPos);
            const sunAngularR = Math.atan((SUN_HALO_SCALE / 2) / sunDist);
            const sunHeightFraction = Math.min(1, (2 * sunAngularR) / fovRad);
            sunBright = sunHeightFraction * SUN_BRIGHTNESS_SCALE * (1 - sunOcclFraction);
          }

          const totalBright = earthBright + moonBright + sunBright;
          // Begin dimming once a fully-lit body covers ~10% of viewport height,
          // fully gone once it covers ~70%.
          const starVisibility = 1.0 - THREE.MathUtils.smoothstep(totalBright, 0.1, 0.7);

          (sky.material as THREE.MeshBasicMaterial).color.setScalar(starVisibility);
        });
      }

      perfFrameMark();
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
      moonMesh.colorEngine.clearTiles();
      moonMesh.reliefEngine.clearTiles();
      moonMeshRef.current = null;
      scene.remove(sunGroup);
      disposeSunGroup(sunGroup);
      scene.remove(atmosphereMesh);
      disposeAtmosphereMesh(atmosphereMesh);
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

    // Default near plane (0.1) clips the globe surface at close-mode max zoom,
    // where the camera is only ~0.05 units from the surface. Reduce to prevent clipping.
    const camera = globeEl.current.camera() as THREE.PerspectiveCamera;
    camera.near = 0.01;
    camera.updateProjectionMatrix();

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
    cancelIntroRef.current = stopIntroAnimation;

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
          // Cache the ThreeSlippyMapGlobe instance so the tick loop can call
          // updatePov() when OrbitControls is disabled (see dayTileEngineRef).
          obj.traverse((child: any) => {
            if (Array.isArray(child.thresholds)) dayTileEngineRef.current = child;
          });
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
    try { (window as any).__globeReady = true; } catch { /* ignore */ }

    return () => {
      controls.removeEventListener('change', checkThreshold);
      try {
        if (controls.domElement) {
          controls.domElement.removeEventListener('mousedown', stopIntroAnimation);
          controls.domElement.removeEventListener('wheel', stopIntroAnimation);
          controls.domElement.removeEventListener('touchstart', stopIntroAnimation);
        }
      } catch { /* ignore */ }
      cancelIntroRef.current = null;
    };
  }, [isGlobeReady, onGlobeReady, onLayerManagerReady]);

  // ── Close-mode enter/exit ────────────────────────────────────────────────

  function enterCloseMode(controls: any) {
    if (inCloseModeRef.current || !globeEl.current) return;

    cancelIntroRef.current?.();

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

    // Pause the library's animation loops — same pattern as moon view.
    // Stops _animationCycle AND prevents the TWEEN loop from overriding our
    // manually-driven camera (the TWEEN loop bypasses controls.update entirely).
    globeEl.current?.pauseAnimation?.();
    try {
      const pov = globeEl.current?.pointOfView?.();
      if (pov) globeEl.current.pointOfView(pov, 0);
    } catch { /* ignore */ }

    if (isOrbitingRef.current) {
      isOrbitingRef.current = false;
      onIsOrbitingChange(false);
    }

    dragVelocityRef.current = null;
    inCloseModeRef.current = true;
    entryAnimatingRef.current = false;

    // Snap pitch to its target value immediately. The previous 500ms ramp from
    // pitch=0 caused a visible camera-position slide on the surface tangent
    // (driven by cameraPositionFromTarget's angleO calculation), which the user
    // perceived as the day/night terminator "snapping" on close-mode entry.
    closeModeState.current.pitch = targetPitch;

    startCloseModeLoop(controls);

    const el = controls.domElement;
    el.addEventListener('mousedown', onCloseMouseDown);
    el.addEventListener('wheel', onCloseWheel, { passive: false });
    el.addEventListener('touchstart', onCloseTouchStart, { passive: false });
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
    globeEl.current?.resumeAnimation?.();

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
    // Note: do NOT touch the user's 2D/3D preference here. The 2D/3D button is
    // a pure preference; whether tilt is actually applied is gated by altitude.
    // Zooming out past TILT_THRESHOLD_EXIT exits close mode but the user's
    // preference must persist so zooming back in re-enters close mode.
  }

  // ── Close-mode RAF loop ──────────────────────────────────────────────────

  function startCloseModeLoop(controls: any) {
    let lastTime: number | null = null;
    let prevFlyActive = flyToActiveRef.current;

    const tick = (now: number) => {
      if (!inCloseModeRef.current || !closeModeState.current || !globeEl.current) return;

      const dt = lastTime !== null ? Math.min((now - lastTime) / 1000, 0.1) : 0;
      lastTime = now;

      if (!exitAnimatingRef.current && !entryAnimatingRef.current) {
        if (isOrbitingRef.current) {
          closeModeState.current.heading += ORBIT_HEADING_SPEED * dt;
          if (closeModeState.current.heading > 2 * Math.PI) closeModeState.current.heading -= 2 * Math.PI;
        }

        if (dragVelocityRef.current && dt > 0 && !flyToActiveRef.current) {
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

      const flyNow = flyToActiveRef.current;
      if (prevFlyActive && !flyNow && closeModeState.current) {
        console.log(`[flyTo-render] targetLng=${closeModeState.current.targetLng.toFixed(4)} targetLat=${closeModeState.current.targetLat.toFixed(4)}`);
      }
      prevFlyActive = flyNow;

      applyCameraState(camera, closeModeState.current, earthR);
      renderScene();

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
    cancelIntroRef.current?.();
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
    if (restoredViewRef.current) return;
    const target = targetPosition;
    console.log(
      `[GlobeComponent] intro animation → lat=${target.lat.toFixed(2)}, lng=${target.lng.toFixed(2)} (hotspot)`
    );
    if (animationRef.current) {
      animationRef.current.cancel();
    }
    animationRef.current = introCameraMovement(
      globeEl,
      target,
      () => inCloseModeRef.current || inMoonViewRef.current,
    );
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
    // Clear any residual drag inertia — it would fight the animation and corrupt the destination
    dragVelocityRef.current = null;

    let controls: any;
    try { controls = globeEl.current.controls(); } catch { flyToActiveRef.current = false; return; }

    const currentAlt = globeEl.current.pointOfView().altitude;

    // Only enter close-mode (3D) if user has 3D enabled AND we're coming from far-mode.
    // Respect the user's 2D/3D preference — never override it from internal paths.
    if (!inCloseModeRef.current && currentAlt >= TILT_THRESHOLD_ENTER && prefer3DRef.current) {
      preventReentryRef.current = false;
      enterCloseMode(controls);
    }

    if (closeModeState.current) {
      // ── Close-mode path: animate closeModeState directly ──────────────────
      const startLat = closeModeState.current.targetLat;
      const startLng = closeModeState.current.targetLng;
      const startAlt = closeModeState.current.altitude;

      // Normalize to shortest angular path — works even when startLng has
      // accumulated many full rotations of panning (single ±360 is insufficient).
      const lngDelta = (((flyTo.lng - startLng) % 360) + 540) % 360 - 180;

      console.log(`[flyTo] target=lat:${flyTo.lat.toFixed(2)},lng:${flyTo.lng.toFixed(2)} startLng=${startLng.toFixed(2)} lngDelta=${lngDelta.toFixed(2)} endLng=${(startLng+lngDelta).toFixed(2)}`);

      const targetAlt = flyTo.altitude ?? 0.5;

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
          console.log(`[flyTo-done] actual targetLng=${closeModeState.current?.targetLng.toFixed(4)} targetLat=${closeModeState.current?.targetLat.toFixed(4)}`);
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

      const lngDelta = (((flyTo.lng - start.lng) % 360) + 540) % 360 - 180;

      const targetAlt = flyTo.altitude ?? 0.5;
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

    // Moon path: same semantics as earth, but using moonCloseState/moonOrbitState.
    if (inMoonViewRef.current) {
      if (!is3D && moonCloseState.current) {
        exitMoonCloseMode();
      }
      if (is3D && !moonCloseState.current && moonOrbitState.current) {
        const altitude = moonOrbitState.current.distance / MOON_RADIUS_SCENE - 1;
        if (altitude < MOON_TILT_THRESHOLD_ENTER) {
          enterMoonCloseMode(altitude);
        }
      }
      return;
    }

    // Earth path
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

    // First run after mount: do not fire the level-snap tween, since the user
    // never toggled anything. The snap was previously firing a 1200ms no-op
    // pointOfView tween that fought initial input and clobbered restore.
    if (isOrbitingFirstRunRef.current) {
      isOrbitingFirstRunRef.current = false;
      return;
    }

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
  const moonCloseDragVelocityRef = useRef<{ dlat: number; dlng: number } | null>(null);
  const moonZoomVelocityRef = useRef<number>(0); // log-scale zoom rate per frame, decays each tick
  const moonCloseState = useRef<MoonCloseState | null>(null);

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
      perfSpan('render', () => renderer.render(scene, camera));
      captureRenderInfo(renderer);
    } catch { /* ignore */ }
  }

  /**
   * Radians of orbit-angle change per pixel of drag, scaled so the moon's
   * surface tracks the cursor 1:1 in screen space at any zoom level.
   *
   * Same shape as Earth close-mode's `degPerPx = 2 * alt * tan(fov/2) / viewH`,
   * adapted to moon orbit: `alt` becomes the camera altitude above the moon
   * surface in moon-radii units, and the result is in radians instead of
   * degrees (matching the units of moonOrbitState.theta/phi).
   */
  function moonDragRadPerPx(): number {
    if (!globeEl.current || !moonOrbitState.current) return 0;
    const camera = globeEl.current.camera() as THREE.PerspectiveCamera;
    const viewH = globeEl.current.renderer().domElement.clientHeight;
    const fovRad = (camera.fov * Math.PI) / 180;
    const altInRadii = (moonOrbitState.current.distance - MOON_RADIUS_SCENE) / MOON_RADIUS_SCENE;
    return (2 * altInRadii * Math.tan(fovRad / 2)) / viewH;
  }

  // Transition: orbit → close. Pick the surface point currently under the
  // camera (in moon-local frame) and seed the close-mode state from it.
  function enterMoonCloseMode(altitude: number) {
    if (!moonMeshRef.current || !globeEl.current) return;
    const moonMesh = moonMeshRef.current;
    moonMesh.updateMatrixWorld();

    const cam = globeEl.current.camera() as THREE.Camera;
    const camLocal = moonMesh.worldToLocal(cam.position.clone());
    if (camLocal.lengthSq() < 1e-9) return;
    const T_unit = camLocal.clone().normalize();
    const T_local = T_unit.clone().multiplyScalar(MOON_RADIUS_SCENE);
    const { lat, lng } = moonCartesian2Polar(T_local);

    // Compute heading so close-mode's camera up matches orbit mode's up=(0,1,0) world-space,
    // preventing a visible rotation snap at the threshold crossing.
    const upLocal = new THREE.Vector3(0, 1, 0).applyQuaternion(moonMesh.quaternion.clone().conjugate());
    const upTangent = upLocal.sub(T_unit.clone().multiplyScalar(upLocal.dot(T_unit)));
    let heading = 0;
    if (upTangent.lengthSq() > 1e-6) {
      upTangent.normalize();
      const localY = new THREE.Vector3(0, 1, 0);
      let eastAtT = new THREE.Vector3().crossVectors(localY, T_unit);
      if (eastAtT.lengthSq() < 1e-6) eastAtT.set(1, 0, 0);
      eastAtT.normalize();
      const northAtT = new THREE.Vector3().crossVectors(T_unit, eastAtT).normalize();
      heading = Math.atan2(upTangent.dot(eastAtT), upTangent.dot(northAtT));
    }

    moonCloseState.current = {
      targetLat: lat,
      targetLng: lng,
      altitude,
      heading,
      pitch: pitchFromAltitude(altitude),
    };
    moonOrbitState.current = null;
    moonVelocityRef.current = null;
    moonCloseDragVelocityRef.current = null;
    moonZoomVelocityRef.current = 0;
  }

  // Transition: close → orbit. Reproject the current camera world position
  // into spherical coords around the moon's current world position so the
  // camera does not jump.
  function exitMoonCloseMode() {
    if (!moonCloseState.current || !moonMeshRef.current || !globeEl.current) return;
    const moonMesh = moonMeshRef.current;
    moonMesh.updateMatrixWorld();

    const cam = globeEl.current.camera() as THREE.Camera;
    const offset = cam.position.clone().sub(moonMesh.position);
    const distance = Math.max(MOON_RADIUS_SCENE * MOON_MIN_DISTANCE_RATIO, offset.length());
    const phi = Math.acos(Math.max(-1, Math.min(1, offset.y / distance)));
    const theta = Math.atan2(offset.x, offset.z);

    moonOrbitState.current = { theta, phi, distance };
    moonCloseState.current = null;
    moonCloseDragVelocityRef.current = null;
    moonZoomVelocityRef.current = 0;
  }

  // Moon mouse/touch handlers — dispatch by which mode is active. Both modes
  // share the same listener attachment (registered once on entering moon view).
  const onMoonMouseDown = (e: MouseEvent) => {
    if (moonCloseState.current) {
      moonCloseDragVelocityRef.current = null;
      let lastX = e.clientX;
      let lastY = e.clientY;
      let lastMoveTime = performance.now();
      let smoothDlat = 0;
      let smoothDlng = 0;

      const onCloseMove = (me: MouseEvent) => {
        if (!moonCloseState.current || !globeEl.current) return;
        const dx = me.clientX - lastX;
        const dy = me.clientY - lastY;
        lastX = me.clientX;
        lastY = me.clientY;
        if (dx === 0 && dy === 0) return;

        const camera = globeEl.current.camera() as THREE.PerspectiveCamera;
        const viewH = globeEl.current.renderer().domElement.clientHeight;
        const fovRad = (camera.fov * Math.PI) / 180;
        const alt = moonCloseState.current.altitude;
        const degPerPx = (2 * alt * Math.tan(fovRad / 2) * (180 / Math.PI)) / viewH;
        const cosLat = Math.cos((moonCloseState.current.targetLat * Math.PI) / 180);

        const h = moonCloseState.current.heading;
        const cosH = Math.cos(h);
        const sinH = Math.sin(h);
        const dlat = degPerPx * (dy * cosH + dx * sinH);
        const dlng = (degPerPx * (dy * sinH - dx * cosH)) / Math.max(cosLat, 0.1);

        moonCloseState.current.targetLat += dlat;
        moonCloseState.current.targetLng += dlng;
        moonCloseState.current.targetLat = Math.max(-85, Math.min(85, moonCloseState.current.targetLat));

        const now = performance.now();
        const dt = (now - lastMoveTime) / 1000;
        if (dt > 0 && dt < 0.1) {
          const alpha = 0.3;
          smoothDlat = smoothDlat * (1 - alpha) + (dlat / dt) * alpha;
          smoothDlng = smoothDlng * (1 - alpha) + (dlng / dt) * alpha;
        }
        lastMoveTime = now;
      };
      const onCloseUp = () => {
        moonCloseDragVelocityRef.current = { dlat: smoothDlat, dlng: smoothDlng };
        window.removeEventListener('mousemove', onCloseMove);
        window.removeEventListener('mouseup', onCloseUp);
      };
      window.addEventListener('mousemove', onCloseMove);
      window.addEventListener('mouseup', onCloseUp);
      return;
    }

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
      const radPerPx = moonDragRadPerPx();
      const dTheta = -dx * radPerPx;
      const dPhi = -dy * radPerPx;
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

    if (moonCloseState.current) {
      const factor = Math.pow(0.999, -e.deltaY);
      const newAlt = Math.max(MOON_MIN_ALTITUDE, moonCloseState.current.altitude * factor);
      if (newAlt > MOON_TILT_THRESHOLD_EXIT) {
        exitMoonCloseMode();
        return;
      }
      moonCloseState.current.altitude = newAlt;
      moonCloseState.current.pitch = pitchFromAltitude(newAlt);
      return;
    }

    if (!moonOrbitState.current) return;
    // Accumulate into a decaying zoom velocity so scroll has smooth inertia.
    // Math.pow(1.001, deltaY) = exp(deltaY * ~0.001); dividing by 4 keeps the
    // total integrated zoom equivalent when the 0.75 decay series sums to 4.
    moonZoomVelocityRef.current += e.deltaY * 0.00025;
  };

  const moonTouchRef = useRef<{ x: number; y: number; dist: number | null } | null>(null);

  const onMoonTouchStart = (e: TouchEvent) => {
    e.preventDefault();
    if (!moonOrbitState.current && !moonCloseState.current) return;
    const t0 = e.touches[0];
    const dist = e.touches.length === 2
      ? Math.hypot(e.touches[1].clientX - t0.clientX, e.touches[1].clientY - t0.clientY)
      : null;
    moonTouchRef.current = { x: t0.clientX, y: t0.clientY, dist };

    const onTouchMove = (te: TouchEvent) => {
      if (!moonTouchRef.current) return;
      const t = te.touches[0];

      if (moonCloseState.current) {
        if (te.touches.length === 2 && moonTouchRef.current.dist !== null) {
          const newDist = Math.hypot(te.touches[1].clientX - t.clientX, te.touches[1].clientY - t.clientY);
          const scale = moonTouchRef.current.dist / newDist;
          const newAlt = Math.max(MOON_MIN_ALTITUDE, moonCloseState.current.altitude * scale);
          if (newAlt > MOON_TILT_THRESHOLD_EXIT) {
            exitMoonCloseMode();
            return;
          }
          moonCloseState.current.altitude = newAlt;
          moonCloseState.current.pitch = pitchFromAltitude(newAlt);
          moonTouchRef.current.dist = newDist;
        } else if (te.touches.length === 1 && globeEl.current) {
          const dx = t.clientX - moonTouchRef.current.x;
          const dy = t.clientY - moonTouchRef.current.y;
          moonTouchRef.current.x = t.clientX;
          moonTouchRef.current.y = t.clientY;

          const camera = globeEl.current.camera() as THREE.PerspectiveCamera;
          const viewH = globeEl.current.renderer().domElement.clientHeight;
          const fovRad = (camera.fov * Math.PI) / 180;
          const alt = moonCloseState.current.altitude;
          const degPerPx = (2 * alt * Math.tan(fovRad / 2) * (180 / Math.PI)) / viewH;
          const cosLat = Math.cos((moonCloseState.current.targetLat * Math.PI) / 180);

          const h = moonCloseState.current.heading;
          const cosH = Math.cos(h);
          const sinH = Math.sin(h);
          const dlat = degPerPx * (dy * cosH + dx * sinH);
          const dlng = (degPerPx * (dy * sinH - dx * cosH)) / Math.max(cosLat, 0.1);

          moonCloseState.current.targetLat += dlat;
          moonCloseState.current.targetLng += dlng;
          moonCloseState.current.targetLat = Math.max(-85, Math.min(85, moonCloseState.current.targetLat));
        }
        return;
      }

      if (!moonOrbitState.current) return;
      if (te.touches.length === 2 && moonTouchRef.current.dist !== null) {
        const newDist = Math.hypot(te.touches[1].clientX - t.clientX, te.touches[1].clientY - t.clientY);
        const scale = moonTouchRef.current.dist / newDist;
        const newOrbitDist = Math.max(
          MOON_RADIUS_SCENE * MOON_MIN_DISTANCE_RATIO,
          Math.min(MOON_RADIUS_SCENE * MOON_MAX_DISTANCE_RATIO, moonOrbitState.current.distance * scale)
        );
        const newAltitude = newOrbitDist / MOON_RADIUS_SCENE - 1;
        if (prefer3DRef.current && newAltitude < MOON_TILT_THRESHOLD_ENTER) {
          enterMoonCloseMode(newAltitude);
          return;
        }
        moonOrbitState.current.distance = newOrbitDist;
        moonTouchRef.current.dist = newDist;
      } else if (te.touches.length === 1) {
        const dx = t.clientX - moonTouchRef.current.x;
        const dy = t.clientY - moonTouchRef.current.y;
        moonTouchRef.current.x = t.clientX;
        moonTouchRef.current.y = t.clientY;
        const radPerPx = moonDragRadPerPx();
        moonOrbitState.current.theta -= dx * radPerPx;
        moonOrbitState.current.phi = Math.max(0.1, Math.min(Math.PI - 0.1,
          moonOrbitState.current.phi - dy * radPerPx));
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

  function enterMoonView(controls: any, camera: THREE.PerspectiveCamera, moonMesh: THREE.Object3D) {
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
    moonCloseState.current = null;
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

  // ── Restore stored view on first render ──────────────────────────────────
  useEffect(() => {
    if (!isGlobeReady || !globeEl.current || !restoredView) return;
    if (!restoredViewRef.current) return;
    restoredViewRef.current = false; // one-shot

    // Defer one RAF so the library finishes its own first-frame setup before
    // we start asserting camera state.
    const rafId = requestAnimationFrame(() => {
      if (!globeEl.current) return;
      let controls: any;
      try { controls = globeEl.current.controls(); } catch { return; }
      if (!controls) return;

      if (restoredView.viewTarget === 'moon') {
        // viewTargetRef was already initialized to 'moon' from the prop, so the
        // earth/moon switching effect already returned early — just inline the
        // moon-view setup without the 3-second fly-in animation.
        viewTargetRef.current = 'moon';
        inMoonViewRef.current = true;
        pauseLibrary(controls);
        if (restoredView.mode === 'moonClose' && restoredView.moonClose) {
          moonCloseState.current = { ...restoredView.moonClose };
          moonOrbitState.current = null;
        } else if (restoredView.moon) {
          moonOrbitState.current = { ...restoredView.moon };
          moonCloseState.current = null;
        } else {
          // No usable moon data — fall back to a sensible default orbit so we
          // don't end up in a no-state moon view.
          moonOrbitState.current = { theta: 0, phi: Math.PI / 2, distance: MOON_RADIUS_SCENE * 4 };
        }
        const el = controls.domElement;
        el.addEventListener('mousedown', onMoonMouseDown);
        el.addEventListener('wheel', onMoonWheel, { passive: false });
        el.addEventListener('touchstart', onMoonTouchStart, { passive: false });
        return;
      }

      if (restoredView.mode === 'close' && restoredView.close) {
        // Force into close mode without any of enterCloseMode's animations or
        // camera derivation. We already have the exact target/pitch/heading.
        const c = restoredView.close;
        prefer3DRef.current = true;
        preventReentryRef.current = false;
        closeModeState.current = { ...c };
        inCloseModeRef.current = true;
        entryAnimatingRef.current = false;
        exitAnimatingRef.current = false;
        dragVelocityRef.current = null;

        origControlsUpdateRef.current = controls.update.bind(controls);
        controls.update = () => false;
        controls.enabled = false;
        controls.autoRotate = false;
        globeEl.current.pauseAnimation?.();
        // Kill any in-flight pov tween from the library's init/animation loop.
        try {
          const pov = globeEl.current.pointOfView?.();
          if (pov) globeEl.current.pointOfView(pov, 0);
        } catch { /* ignore */ }

        // Apply once immediately for the first frame; the RAF loop takes over after.
        try {
          const camera = globeEl.current.camera() as THREE.Camera;
          const earthR = globeEl.current.getGlobeRadius();
          applyCameraState(camera, closeModeState.current, earthR);
          renderScene();
        } catch { /* ignore */ }

        startCloseModeLoop(controls);

        const el = controls.domElement;
        el.addEventListener('mousedown', onCloseMouseDown);
        el.addEventListener('wheel', onCloseWheel, { passive: false });
        el.addEventListener('touchstart', onCloseTouchStart, { passive: false });
        return;
      }

      if (restoredView.far) {
        // Two-step: snap once to kill any in-flight library tween, then snap
        // to the restored target. The first call ensures any TWEEN
        // interpolating from the library's default position is overwritten.
        try {
          const cur = globeEl.current.pointOfView?.();
          if (cur) globeEl.current.pointOfView(cur, 0);
        } catch { /* ignore */ }
        globeEl.current.pointOfView(restoredView.far, 0);
      }
    });

    return () => cancelAnimationFrame(rafId);
  }, [isGlobeReady]);

  // ── Periodic save of view state ──────────────────────────────────────────
  useEffect(() => {
    if (!isGlobeReady || !globeEl.current) return;

    let lastSerialized = '';

    const snapshot = (): StoredView | null => {
      if (!globeEl.current) return null;
      const mode: StoredView['mode'] = inMoonViewRef.current
        ? (moonCloseState.current ? 'moonClose' : 'moon')
        : inCloseModeRef.current
        ? 'close'
        : 'far';

      const view: StoredView = {
        version: 1,
        viewTarget: viewTargetRef.current,
        is3D: prefer3DRef.current,
        isOrbiting: isOrbitingRef.current,
        mode,
      };

      try {
        const pov = globeEl.current.pointOfView();
        if (pov && Number.isFinite(pov.lat) && Number.isFinite(pov.lng) && Number.isFinite(pov.altitude)) {
          view.far = { lat: pov.lat, lng: pov.lng, altitude: pov.altitude };
        }
      } catch { /* ignore */ }

      if (closeModeState.current) {
        view.close = { ...closeModeState.current };
      }
      if (moonOrbitState.current) {
        view.moon = { ...moonOrbitState.current };
      }
      if (moonCloseState.current) {
        view.moonClose = { ...moonCloseState.current };
      }

      return view;
    };

    const persist = () => {
      const view = snapshot();
      if (!view) return;
      // Refuse to save snapshots missing the essential field for the active
      // mode — restoring such a blob would land at the library default and
      // produce the "wrong location on reload" bug.
      if (view.mode === 'far' && !view.far) return;
      if (view.mode === 'close' && !view.close) return;
      if (view.mode === 'moon' && !view.moon) return;
      if (view.mode === 'moonClose' && !view.moonClose) return;
      const serialized = JSON.stringify(view);
      if (serialized === lastSerialized) return;
      lastSerialized = serialized;
      saveView(view);
    };

    const intervalId = window.setInterval(persist, 500);
    const onBeforeUnload = () => persist();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') persist();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      persist();
    };
  }, [isGlobeReady, restoredView]);

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
      showAtmosphere={false}
      enablePointerInteraction={false}
    />
  );
};
