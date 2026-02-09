import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import * as THREE from 'three';

interface MaterialTier {
  material: LineMaterial;
  linewidth: number;
}

export class LightningMaterials {
  private tiers: MaterialTier[] = [];
  private glowMaterial: LineMaterial;

  constructor() {
    const tierConfigs = [
      { linewidth: 4, color: 0xeeeeff },
      { linewidth: 3, color: 0xccccff },
      { linewidth: 2, color: 0xaaaaee },
      { linewidth: 1.5, color: 0x8888dd },
    ];

    for (const cfg of tierConfigs) {
      const mat = new LineMaterial({
        color: cfg.color,
        linewidth: cfg.linewidth,
        transparent: true,
        opacity: 1.0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexColors: true,
      });
      mat.resolution.set(window.innerWidth, window.innerHeight);
      this.tiers.push({ material: mat, linewidth: cfg.linewidth });
    }

    this.glowMaterial = new LineMaterial({
      color: 0xaaccff,
      linewidth: 5,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
    });
    this.glowMaterial.resolution.set(window.innerWidth, window.innerHeight);
  }

  getMaterialForDepth(depth: number): LineMaterial {
    const idx = Math.min(depth, this.tiers.length - 1);
    return this.tiers[idx].material;
  }

  getGlowMaterial(): LineMaterial {
    return this.glowMaterial;
  }

  updateResolution(width: number, height: number): void {
    for (const tier of this.tiers) {
      tier.material.resolution.set(width, height);
    }
    this.glowMaterial.resolution.set(width, height);
  }

  updateOpacity(multiplier: number): void {
    for (const tier of this.tiers) {
      tier.material.opacity = multiplier;
    }
    this.glowMaterial.opacity = 0.3 * multiplier;
  }

  dispose(): void {
    for (const tier of this.tiers) {
      tier.material.dispose();
    }
    this.glowMaterial.dispose();
  }
}
