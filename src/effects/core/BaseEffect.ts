import * as THREE from 'three';
import { Effect } from './EffectInterface';

export abstract class BaseEffect implements Effect {
  protected scene: THREE.Scene | null = null;
  protected globeEl: any;
  protected isTerminated: boolean = false;
  protected resources: (THREE.BufferGeometry | THREE.Material | THREE.Object3D)[] = [];

  constructor(
    public lat: number,
    public lng: number,
    public intensity: number = 0.5
  ) {}

  abstract initialize(scene: THREE.Scene, globeEl: any): void;
  abstract update(currentTime: number): boolean;
  abstract positionOnGlobe(lat: number, lng: number, altitude?: number): void;
  abstract getObject(): THREE.Object3D;

  protected registerResource(resource: THREE.BufferGeometry | THREE.Material | THREE.Object3D): void {
    this.resources.push(resource);
  }

  terminateImmediately(): void {
    if (this.isTerminated) return;
    this.isTerminated = true;

    const object = this.getObject();
    if (this.scene && object) {
      this.scene.remove(object);
    }

    this.dispose();
  }

  dispose(): void {
    this.resources.forEach(resource => {
      if (resource instanceof THREE.BufferGeometry) {
        resource.dispose();
      } else if (resource instanceof THREE.Material) {
        resource.dispose();
      } else if (resource instanceof THREE.Object3D && resource.parent) {
        resource.parent.remove(resource);
      }
    });
    this.resources = [];
  }
}
