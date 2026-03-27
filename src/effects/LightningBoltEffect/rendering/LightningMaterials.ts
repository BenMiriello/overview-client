import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import * as THREE from 'three';

export class LightningMaterials {
  private baseMaterial: LineMaterial;
  private glowMaterial: LineMaterial;
  private depthMaterials: Map<string, LineMaterial> = new Map();

  constructor() {
    this.baseMaterial = new LineMaterial({
      color: 0xffffff,
      linewidth: 4,
      transparent: true,
      opacity: 1.0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
    });
    this.baseMaterial.resolution.set(window.innerWidth, window.innerHeight);

    this.glowMaterial = new LineMaterial({
      color: 0xaaccff,
      linewidth: 3,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
    });
    this.glowMaterial.resolution.set(window.innerWidth, window.innerHeight);
  }

  getMaterialForDepth(depth: number): LineMaterial {
    const linewidth = this.getLineWidth(depth, 4);
    const color = this.getColor(depth);

    const key = `${depth.toFixed(2)}`;
    if (this.depthMaterials.has(key)) {
      return this.depthMaterials.get(key)!;
    }

    const mat = new LineMaterial({
      color,
      linewidth,
      transparent: true,
      opacity: 1.0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
    });
    mat.resolution.set(window.innerWidth, window.innerHeight);
    this.depthMaterials.set(key, mat);
    return mat;
  }

  private getLineWidth(depth: number, baseWidth: number): number {
    // Line width falls off more slowly - branches remain visible
    const minWidth = baseWidth * 0.3;
    const decay = Math.exp(-depth * 0.5);
    return minWidth + (baseWidth - minWidth) * decay;
  }

  private getColor(depth: number): number {
    // Main channel: pure white-blue (brightness 1.0)
    // Deeper branches: slightly more blue, slightly dimmer
    const baseBrightness = 1.0;
    const minBrightness = 0.7;
    const decay = Math.exp(-depth * 0.35);
    const brightness = minBrightness + (baseBrightness - minBrightness) * decay;

    // Keep blue at full, reduce r/g for deeper branches (more blue tint)
    const rgFactor = 0.9 + 0.1 * decay;
    const r = Math.floor(255 * brightness * rgFactor);
    const g = Math.floor(255 * brightness * rgFactor);
    const b = 255;
    return (r << 16) | (g << 8) | b;
  }

  getGlowMaterial(): LineMaterial {
    return this.glowMaterial;
  }

  updateResolution(width: number, height: number): void {
    this.baseMaterial.resolution.set(width, height);
    this.glowMaterial.resolution.set(width, height);
    for (const mat of this.depthMaterials.values()) {
      mat.resolution.set(width, height);
    }
  }

  updateOpacity(multiplier: number): void {
    this.baseMaterial.opacity = multiplier;
    this.glowMaterial.opacity = 0.3 * multiplier;
    for (const mat of this.depthMaterials.values()) {
      mat.opacity = multiplier;
    }
  }

  dispose(): void {
    this.baseMaterial.dispose();
    this.glowMaterial.dispose();
    for (const mat of this.depthMaterials.values()) {
      mat.dispose();
    }
    this.depthMaterials.clear();
  }
}
