import { Vec3 } from './simulation';

export { DetailLevel } from './simulation';

export interface LightningConfig {
  lat: number;
  lng: number;
  startAltitude: number;
  groundAltitude: number;
  resolution: number;
  seed?: number;
  enableScreenFlash?: boolean;
}

export class LightningCoordinateTransform {
  constructor(private globeEl: any) {}

  toWorldCoordinates(lat: number, lng: number, altitude: number): Vec3 {
    const coords = this.globeEl.getCoords(lat, lng, altitude);
    return { x: coords.x, y: coords.y, z: coords.z };
  }

  getGroundPoint(lat: number, lng: number): Vec3 {
    const surface = this.globeEl.getCoords(lat, lng, 0);
    return { x: surface.x, y: surface.y, z: surface.z };
  }
}
