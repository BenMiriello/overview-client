import * as THREE from 'three';

/**
 * Interface for globe data layers
 */
export interface Layer<T> {
  initialize(globeEl: any): void;
  addData(data: T): void;
  update(currentTime: number): void;
  clear(): void;
  show(): void;
  hide(): void;
  toggle(): void;
  isVisible(): boolean;
}

/**
 * Base implementation of a layer with common functionality
 */
export abstract class BaseLayer<T> implements Layer<T> {
  protected globeEl: any | null = null;
  protected scene: THREE.Scene | null = null;
  protected visible: boolean = true;

  initialize(globeEl: any): void {
    this.globeEl = globeEl;
    if (globeEl) {
      this.scene = globeEl.scene();
    }
  }

  abstract addData(data: T): void;

  abstract update(currentTime: number): void;

  abstract clear(): void;

  show(): void {
    this.visible = true;
  }

  hide(): void {
    this.visible = false;
  }

  toggle(): void {
    this.visible = !this.visible;
  }

  isVisible(): boolean {
    return this.visible;
  }
}
