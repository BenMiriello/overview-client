import * as THREE from 'three';

export interface FlashEffectConfig {
  center: THREE.Vector3;
  intensity: number;
  duration: number;
  color: THREE.Color;
}

export class FlashEffect {
  private light: THREE.PointLight;
  private startTime: number;
  private config: FlashEffectConfig;

  constructor(config: FlashEffectConfig) {
    this.config = config;
    this.startTime = Date.now();

    this.light = new THREE.PointLight(
      config.color,
      config.intensity * 100,
      50,
      2
    );

    this.light.position.copy(config.center);
  }

  update(): boolean {
    const elapsed = (Date.now() - this.startTime) / 1000;
    const progress = elapsed / this.config.duration;

    if (progress >= 1) {
      this.light.intensity = 0;
      return false;
    }

    const flashCurve = Math.pow(1 - progress, 3);
    this.light.intensity = this.config.intensity * 100 * flashCurve;

    return true;
  }

  getLight(): THREE.PointLight {
    return this.light;
  }

  dispose(): void {
    this.light.dispose();
  }
}

export class ScreenFlashEffect {
  private overlay: HTMLDivElement | null = null;
  private startTime: number;
  private duration: number;

  constructor(duration: number = 0.15) {
    this.duration = duration;
    this.startTime = Date.now();
    this.createOverlay();
  }

  private createOverlay(): void {
    this.overlay = document.createElement('div');
    this.overlay.style.position = 'fixed';
    this.overlay.style.top = '0';
    this.overlay.style.left = '0';
    this.overlay.style.width = '100%';
    this.overlay.style.height = '100%';
    this.overlay.style.backgroundColor = 'white';
    this.overlay.style.pointerEvents = 'none';
    this.overlay.style.zIndex = '9999';
    document.body.appendChild(this.overlay);
  }

  update(): boolean {
    if (!this.overlay) return false;

    const elapsed = (Date.now() - this.startTime) / 1000;
    const progress = elapsed / this.duration;

    if (progress >= 1) {
      this.dispose();
      return false;
    }

    const opacity = Math.pow(1 - progress, 2);
    this.overlay.style.opacity = opacity.toString();

    return true;
  }

  dispose(): void {
    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
      this.overlay = null;
    }
  }
}
