import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import * as THREE from 'three';

// MaxEquation prevents junction accumulation: max(a, b) = a when segments have equal brightness,
// rather than additive a + b which doubles brightness at every branch point.
const MAX_BLENDING_PARAMS = {
  blending: THREE.CustomBlending,
  blendEquation: THREE.MaxEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
} as const;

export class LightningMaterials {
  private baseMaterial: LineMaterial;
  private depthMaterials: Map<string, LineMaterial> = new Map();
  private glowMaterials: Map<string, LineMaterial> = new Map();
  private baseLineWidth: number;
  private lineWidthScale: number = 1.0;

  constructor(baseLineWidth: number = 4) {
    this.baseLineWidth = baseLineWidth;
    const glowWidth = baseLineWidth * 0.75;

    this.baseMaterial = new LineMaterial({
      color: 0xffffff,
      linewidth: glowWidth,
      transparent: true,
      opacity: 1.0,
      depthWrite: false,
      ...MAX_BLENDING_PARAMS,
      vertexColors: true,
    });
    this.baseMaterial.resolution.set(window.innerWidth, window.innerHeight);
  }

  getMaterialForDepth(depth: number): LineMaterial {
    const linewidth = this.getLineWidth(depth, this.baseLineWidth) * this.lineWidthScale;
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
      ...MAX_BLENDING_PARAMS,
      vertexColors: true,
    });
    mat.resolution.set(window.innerWidth, window.innerHeight);
    this.depthMaterials.set(key, mat);
    return mat;
  }

  getGlowMaterialForDepth(depth: number): LineMaterial {
    const key = `glow_${depth.toFixed(2)}`;
    if (this.glowMaterials.has(key)) {
      return this.glowMaterials.get(key)!;
    }

    const coreWidth = this.getLineWidth(depth, this.baseLineWidth) * this.lineWidthScale;
    const glowWidth = coreWidth * 3;

    const mat = new LineMaterial({
      color: 0xaaccff,
      linewidth: glowWidth,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
    });
    mat.resolution.set(window.innerWidth, window.innerHeight);
    this.glowMaterials.set(key, mat);
    return mat;
  }

  private getLineWidth(depth: number, baseWidth: number): number {
    const minWidth = baseWidth * 0.25;
    const decay = Math.exp(-depth * 0.6);
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

  updateResolution(width: number, height: number): void {
    this.baseMaterial.resolution.set(width, height);
    for (const mat of this.depthMaterials.values()) {
      mat.resolution.set(width, height);
    }
    for (const mat of this.glowMaterials.values()) {
      mat.resolution.set(width, height);
    }
  }

  setLineWidthScale(scale: number): void {
    this.lineWidthScale = scale;
    const glowWidth = this.baseLineWidth * 0.75 * scale;
    this.baseMaterial.linewidth = glowWidth;
    for (const [key, mat] of this.depthMaterials) {
      const depth = parseFloat(key);
      mat.linewidth = this.getLineWidth(depth, this.baseLineWidth) * scale;
    }
    for (const [key, mat] of this.glowMaterials) {
      const rawKey = key.replace('glow_', '');
      const depth = parseFloat(rawKey);
      mat.linewidth = this.getLineWidth(depth, this.baseLineWidth) * scale * 3;
    }
  }

  updateOpacity(multiplier: number): void {
    this.baseMaterial.opacity = multiplier;
    for (const mat of this.depthMaterials.values()) {
      mat.opacity = multiplier;
    }
  }

  dispose(): void {
    this.baseMaterial.dispose();
    for (const mat of this.depthMaterials.values()) {
      mat.dispose();
    }
    this.depthMaterials.clear();
    for (const mat of this.glowMaterials.values()) {
      mat.dispose();
    }
    this.glowMaterials.clear();
  }
}
