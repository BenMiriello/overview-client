import { BaseLayer } from './LayerInterface';
import { LightningStrike } from '../models/LightningStrike';
import { ZigZagEffect, ZigZagEffectConfig } from '../effects/ZigZagEffect';
import { PointMarkerEffect, PointMarkerConfig } from '../effects/PointMarkerEffect';

/**
 * Configuration for the lightning layer
 */
export interface LightningLayerConfig {
  maxActiveAnimations: number;
  maxDisplayedStrikes: number;
  showZigZag: boolean;
  zigZagConfig: Partial<ZigZagEffectConfig>;
  markerConfig: Partial<PointMarkerConfig>;
}

/**
 * Default lightning layer configuration
 */
export const DEFAULT_LIGHTNING_CONFIG: LightningLayerConfig = {
  maxActiveAnimations: 10,
  maxDisplayedStrikes: 1000,
  showZigZag: true,
  zigZagConfig: {
    startAltitude: 0.1,
    lineWidth: 4.5,
    lineSegments: 10,
    jitterAmount: 0.022,
    branchChance: 0.5,
    branchFactor: 0.8,
    maxBranches: 5,
    duration: 1000,
    fadeOutDuration: 300
  },
  markerConfig: {
    radius: 0.08,
    color: 0xffffff,
    opacity: 0.8
  }
};

/**
 * Layer that displays lightning strikes on the globe
 */
export class LightningLayer extends BaseLayer<LightningStrike> {
  private config: LightningLayerConfig;
  private zigZagEffects: Map<string, ZigZagEffect> = new Map();
  private markerEffects: Map<string, PointMarkerEffect> = new Map();
  private activeEffects: { id: string, timestamp: number }[] = [];

  /**
   * Create a new lightning layer
   */
  constructor(config: Partial<LightningLayerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_LIGHTNING_CONFIG, ...config };
  }

  /**
   * Enable/disable zigzag lightning animations
   */
  setShowZigZag(show: boolean): void {
    if (this.config.showZigZag !== show) {
      this.config.showZigZag = show;

      if (!show) {
        this.clearZigZagEffects();
      }
    }
  }

  /**
   * Add a lightning strike to the layer
   */
  addData(strike: LightningStrike): void {
    // Create zigzag lightning effect if enabled
    if (this.config.showZigZag) {
      this.createZigZagEffect(strike);
    }

    // Always create a point marker
    this.createMarkerEffect(strike);
  }

  /**
   * Create zigzag lightning effect
   */
  private createZigZagEffect(strike: LightningStrike): void {
    if (!this.scene || !this.globeEl) return;

    const effect = new ZigZagEffect(
      strike.lat,
      strike.lng,
      this.config.zigZagConfig
    );

    effect.initialize(this.scene, this.globeEl);
    effect.positionOnGlobe(strike.lat, strike.lng, 0);

    this.zigZagEffects.set(strike.id, effect);

    this.activeEffects.push({
      id: strike.id,
      timestamp: Date.now()
    });

    // Limit active animations
    this.ensureMaxActiveEffects();
  }

  /**
   * Create marker effect
   */
  private createMarkerEffect(strike: LightningStrike): void {
    if (!this.scene || !this.globeEl) return;

    const effect = new PointMarkerEffect(
      strike.lat,
      strike.lng,
      strike.intensity || 0.5,
      this.config.markerConfig
    );

    effect.initialize(this.scene, this.globeEl);
    effect.positionOnGlobe(strike.lat, strike.lng);

    this.markerEffects.set(strike.id, effect);
  }

  /**
   * Ensure we don't exceed the maximum number of active animations
   */
  private ensureMaxActiveEffects(): void {
    // Sort by timestamp (newest first)
    this.activeEffects.sort((a, b) => b.timestamp - a.timestamp);

    // Remove excess effects
    if (this.activeEffects.length > this.config.maxActiveAnimations) {
      const removeIds = this.activeEffects
        .slice(this.config.maxActiveAnimations)
        .map(e => e.id);

      removeIds.forEach(id => {
        const effect = this.zigZagEffects.get(id);
        if (effect) {
          effect.terminateImmediately();
          this.zigZagEffects.delete(id);
        }
      });

      // Update active effects list
      this.activeEffects = this.activeEffects.slice(0, this.config.maxActiveAnimations);
    }
  }

  /**
   * Clear all zigzag lightning effects
   */
  private clearZigZagEffects(): void {
    this.zigZagEffects.forEach((effect) => {
      effect.terminateImmediately();
      effect.dispose();
    });

    this.zigZagEffects.clear();
    this.activeEffects = [];
  }

  /**
   * Update the layer
   */
  update(currentTime: number): void {
    if (!this.visible) return;

    // Update zigzag effects
    const completedZigZagIds: string[] = [];

    this.zigZagEffects.forEach((effect, id) => {
      const isActive = effect.update(currentTime);

      if (!isActive) {
        completedZigZagIds.push(id);
        this.activeEffects = this.activeEffects.filter(e => e.id !== id);
      }
    });

    // Remove completed zigzag effects
    completedZigZagIds.forEach(id => {
      const effect = this.zigZagEffects.get(id);
      if (effect) {
        effect.dispose();
        this.zigZagEffects.delete(id);
      }
    });

    // Update point markers
    const completedMarkerIds: string[] = [];

    this.markerEffects.forEach((effect, id) => {
      const isActive = effect.update(currentTime);

      if (!isActive) {
        completedMarkerIds.push(id);
      }
    });

    // Remove completed markers
    completedMarkerIds.forEach(id => {
      const effect = this.markerEffects.get(id);
      if (effect) {
        effect.dispose();
        this.markerEffects.delete(id);
      }
    });

    // Enforce max displayed strikes limit
    this.enforceMaxDisplayedStrikes();
  }

  /**
   * Enforce the maximum number of displayed strikes
   */
  private enforceMaxDisplayedStrikes(): void {
    if (this.markerEffects.size <= this.config.maxDisplayedStrikes) return;

    // Get all markers sorted by creation time (oldest first)
    const markers = Array.from(this.markerEffects.entries())
      .sort((a, b) => {
        const aTime = a[1].getObject().userData.createdAt;
        const bTime = b[1].getObject().userData.createdAt;
        return aTime - bTime;
      });

    // Remove oldest markers that exceed the limit
    const removeCount = markers.length - this.config.maxDisplayedStrikes;

    if (removeCount <= 0) return;

    markers.slice(0, removeCount).forEach(([id, effect]) => {
      effect.dispose();
      this.markerEffects.delete(id);

      // Also remove any associated zigzag effect
      const zigZag = this.zigZagEffects.get(id);
      if (zigZag) {
        zigZag.terminateImmediately();
        zigZag.dispose();
        this.zigZagEffects.delete(id);
        this.activeEffects = this.activeEffects.filter(e => e.id !== id);
      }
    });
  }

  /**
   * Get the number of active zigzag effects
   */
  getActiveZigZagCount(): number {
    return this.zigZagEffects.size;
  }

  /**
   * Get the number of displayed markers
   */
  getMarkerCount(): number {
    return this.markerEffects.size;
  }

  /**
   * Clear the layer
   */
  clear(): void {
    // Clear zigzag effects
    this.zigZagEffects.forEach(effect => effect.dispose());
    this.zigZagEffects.clear();

    // Clear markers
    this.markerEffects.forEach(effect => effect.dispose());
    this.markerEffects.clear();

    this.activeEffects = [];
  }
}
