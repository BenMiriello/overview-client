import { Point3D } from './physics';

export enum LightningPhase {
  SEARCHING = 'searching',
  CONNECTED = 'connected',
  STRIKING = 'striking',
  FADING = 'fading'
}

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

  toWorldCoordinates(lat: number, lng: number, altitude: number): Point3D {
    const coords = this.globeEl.getCoords(lat, lng, altitude);
    return { x: coords.x, y: coords.y, z: coords.z };
  }

  getGroundPoint(lat: number, lng: number): Point3D {
    const surface = this.globeEl.getCoords(lat, lng, 0);
    return { x: surface.x, y: surface.y, z: surface.z };
  }
}
