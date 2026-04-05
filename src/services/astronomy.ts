import * as THREE from 'three';
import * as Astronomy from 'astronomy-engine';

const EARTH_RADIUS_KM = 6371;
const SCENE_EARTH_RADIUS = 100;
const KM_TO_SCENE = SCENE_EARTH_RADIUS / EARTH_RADIUS_KM;
const AU_TO_KM = 149597870.7;

export const MOON_RADIUS_SCENE = 1737.4 * KM_TO_SCENE; // ~27.3

/**
 * Returns the sub-solar point as [longitude, latitude] in degrees.
 * This is where the sun is directly overhead on Earth's surface.
 */
export function getSunLatLng(date: Date): [number, number] {
  const sunPos = Astronomy.SunPosition(date);
  // elon is ecliptic longitude, elat is ecliptic latitude (near 0 for sun)
  // For the sub-solar point we need the sun's declination and hour angle.
  // Use GeoVector to get equatorial coords, then convert.
  const sunVec = Astronomy.GeoVector('Sun', date, true);
  const equ = Astronomy.Equator('Sun', date, new Astronomy.Observer(0, 0, 0), true, true);

  // Declination = latitude of sub-solar point
  const lat = equ.dec;

  // Right ascension vs sidereal time gives the longitude
  const gast = Astronomy.SiderealTime(date); // hours
  // Sub-solar longitude = (RA - GAST) * 15, normalized to [-180, 180]
  let lng = (equ.ra - gast) * 15;
  if (lng > 180) lng -= 360;
  if (lng < -180) lng += 360;

  return [lng, lat];
}

/**
 * Returns Greenwich Apparent Sidereal Time in hours.
 */
export function getSiderealTimeHours(date: Date): number {
  return Astronomy.SiderealTime(date);
}

/**
 * Converts a J2000 equatorial vector (AU) to Three.js scene coordinates.
 * EQJ: x toward vernal equinox, z toward north celestial pole.
 * Scene: y is up. Map EQJ z -> scene y, EQJ x -> scene -z, EQJ y -> scene x.
 */
function eqjToScene(v: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(
    v.y * AU_TO_KM * KM_TO_SCENE,
    v.z * AU_TO_KM * KM_TO_SCENE,
    -v.x * AU_TO_KM * KM_TO_SCENE,
  );
}

/**
 * Returns the moon position in scene coordinates (geocentric equatorial J2000).
 */
export function getMoonPosition(date: Date): THREE.Vector3 {
  const moonVec = Astronomy.GeoMoon(date);
  return eqjToScene(moonVec);
}

/**
 * Returns the sun direction as a normalized scene vector.
 */
export function getSunDirection(date: Date): THREE.Vector3 {
  const sunVec = Astronomy.GeoVector('Sun', date, true);
  return eqjToScene(sunVec).normalize();
}

/**
 * Returns the sun position in scene coords (for placing a distant directional light).
 */
export function getSunPosition(date: Date): THREE.Vector3 {
  return getSunDirection(date).multiplyScalar(50000);
}
