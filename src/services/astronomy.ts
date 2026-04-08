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
 * Returns the moon position in scene coordinates, in the Earth-fixed lat/lng
 * frame (same convention three-globe uses for the globe surface and the
 * day/night shader uses for its terminator). The moon ends up directly above
 * its true sub-lunar point on Earth at distance equal to its true geocentric
 * distance.
 */
export function getMoonPosition(date: Date): THREE.Vector3 {
  const observer = new Astronomy.Observer(0, 0, 0);
  const moonEqu = Astronomy.Equator('Moon', date, observer, true, true);
  const gast = Astronomy.SiderealTime(date);
  let lng = (moonEqu.ra - gast) * 15;
  if (lng > 180) lng -= 360;
  if (lng < -180) lng += 360;
  const lat = moonEqu.dec;

  const phi = (90 - lat) * Math.PI / 180;
  const theta = (90 - lng) * Math.PI / 180;
  const distScene = moonEqu.dist * AU_TO_KM * KM_TO_SCENE;

  return new THREE.Vector3(
    Math.sin(phi) * Math.cos(theta) * distScene,
    Math.cos(phi) * distScene,
    Math.sin(phi) * Math.sin(theta) * distScene,
  );
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
export const SUN_DISTANCE_SCENE = 47500;

/**
 * Sun direction in the Earth-fixed scene frame (the same convention three-globe
 * uses to place lat/lng points on the surface and the day/night shader uses
 * for its terminator). This rotates with Earth, so the visible sun stays
 * aligned with the lit hemisphere of the globe.
 *
 * Note: this differs from `getSunDirection`, which is in the inertial J2000
 * equatorial frame. The two differ by the sidereal rotation of Earth.
 */
export function getSunDirectionEarthFixed(date: Date): THREE.Vector3 {
  const [lng, lat] = getSunLatLng(date);
  const phi = (90 - lat) * Math.PI / 180;
  const theta = (90 - lng) * Math.PI / 180;
  return new THREE.Vector3(
    Math.sin(phi) * Math.cos(theta),
    Math.cos(phi),
    Math.sin(phi) * Math.sin(theta),
  ).normalize();
}

export function getSunPosition(date: Date): THREE.Vector3 {
  return getSunDirectionEarthFixed(date).multiplyScalar(SUN_DISTANCE_SCENE);
}

/**
 * Sub-earth selenographic point (degrees). Center of the near side of the moon
 * relative to Earth, including libration wobble.
 */
export function getMoonLibration(date: Date): { elon: number; elat: number } {
  const lib = Astronomy.Libration(date);
  return { elon: lib.elon, elat: lib.elat };
}

/**
 * North celestial pole direction in the scene frame.
 * Matches eqjToScene's mapping of EQJ +z (celestial north) -> scene +y.
 */
export const CELESTIAL_NORTH_SCENE = new THREE.Vector3(0, 1, 0);
