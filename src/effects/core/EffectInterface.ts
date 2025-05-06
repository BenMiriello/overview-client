import * as THREE from 'three';

/**
 * Interface for all visual effects
 */
export interface Effect {
  initialize(scene: THREE.Scene, globeEl: any): void;
  update(currentTime: number): boolean;
  positionOnGlobe(lat: number, lng: number, altitude?: number): void;
  dispose(): void;
  terminateImmediately(): void;
  getObject(): THREE.Object3D;
}

/**
 * Basic configuration properties common to many effects
 */
export interface BaseEffectConfig {
  fadeOutDuration: number; // Fade out duration in ms
}

/**
 * Generic effect manager interface
 */
export interface EffectManager<T, C> {
  initialize(globeEl: any): void;
  createEffect(data: T, config?: Partial<C>): string;
  update(currentTime: number): void;
  clear(): void;
  getActiveCount(): number;
}
