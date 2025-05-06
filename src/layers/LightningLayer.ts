import { BaseLayer } from './LayerInterface';
import { LightningStrike } from '../models/LightningStrike';
import { ZigZagEffect, ZigZagEffectConfig, DEFAULT_ZIGZAG_CONFIG } from '../effects/ZigZagEffect';
import { PointMarkerEffect, PointMarkerConfig } from '../effects/PointMarkerEffect';
import { DEFAULT_CLOUD_CONFIG } from './CloudLayer';

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
  maxActiveAnimations: 20,
  maxDisplayedStrikes: 1000,
  showZigZag: true,
  zigZagConfig: {
    // Use the same defaults from ZigZagEffect
    ...DEFAULT_ZIGZAG_CONFIG,
    // Override only specific values if needed
    lineWidth: 4.0
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
  public config: LightningLayerConfig;
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
   * Update the starting altitude for zigzag effects to match cloud layer
   */
  updateZigZagStartAltitude(altitude: number): void {
    if (this.config.zigZagConfig) {
      this.config.zigZagConfig.startAltitude = altitude;

      // Update any existing effects
      this.zigZagEffects.forEach((effect) => {
        effect.updateStartAltitude(altitude);
      });
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

    // Enforce max displayed strikes immediately
    this.enforceMaxDisplayedStrikes();
  }

  /**
   * Create zigzag lightning effect
   */
  private createZigZagEffect(strike: LightningStrike): void {
    if (!this.scene || !this.globeEl) return;

    // If we already have this strike, remove the old one first
    if (this.zigZagEffects.has(strike.id)) {
      const oldEffect = this.zigZagEffects.get(strike.id);
      if (oldEffect) {
        oldEffect.terminateImmediately();
        this.zigZagEffects.delete(strike.id);
      }
    }

    const effect = new ZigZagEffect(
      strike.lat,
      strike.lng,
      this.config.zigZagConfig
    );

    effect.initialize(this.scene, this.globeEl);
    // Position at the surface level - the zigzag height is handled by its internal geometry
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

    // If we already have this strike, remove the old one first
    if (this.markerEffects.has(strike.id)) {
      const oldEffect = this.markerEffects.get(strike.id);
      if (oldEffect) {
        oldEffect.terminateImmediately();
        this.markerEffects.delete(strike.id);
      }
    }

    const effect = new PointMarkerEffect(
      strike.lat,
      strike.lng,
      strike.intensity || 0.5,
      {
        ...this.config.markerConfig,
        // If lightning is disabled, show markers immediately with full opacity
        fadeInDuration: this.config.showZigZag ? 1500 : 0
      }
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
    });

    this.zigZagEffects.clear();
    this.activeEffects = [];
  }

  /**
   * Update the layer
   */
  update(currentTime: number): void {
    if (!this.visible) return;

    // Update zigzag effects and collect completed IDs
    const completedZigZagIds: string[] = [];

    this.zigZagEffects.forEach((effect, id) => {
      const isActive = effect.update(currentTime);

      if (!isActive) {
        completedZigZagIds.push(id);
        // Remove from active effects tracking
        this.activeEffects = this.activeEffects.filter(e => e.id !== id);
      }
    });

    // Remove completed zigzag effects
    completedZigZagIds.forEach(id => {
      this.zigZagEffects.delete(id);
    });

    // Update point markers and collect completed IDs
    const completedMarkerIds: string[] = [];

    this.markerEffects.forEach((effect, id) => {
      const isActive = effect.update(currentTime);

      if (!isActive) {
        completedMarkerIds.push(id);
      }
    });

    // Remove completed markers
    completedMarkerIds.forEach(id => {
      this.markerEffects.delete(id);
    });
  }

  /**
   * Enforce the maximum number of displayed strikes
   */
  private enforceMaxDisplayedStrikes(): void {
    if (this.markerEffects.size <= this.config.maxDisplayedStrikes) return;

    // Get all markers sorted by creation time (oldest first)
    const markers = Array.from(this.markerEffects.entries())
      .sort((a, b) => {
        const aTime = a[1].getObject().userData.createdAt || 0;
        const bTime = b[1].getObject().userData.createdAt || 0;
        return aTime - bTime;
      });

    // Remove oldest markers that exceed the limit
    const removeCount = markers.length - this.config.maxDisplayedStrikes;

    if (removeCount <= 0) return;

    markers.slice(0, removeCount).forEach(([id, effect]) => {
      effect.terminateImmediately();
      this.markerEffects.delete(id);

      // Also remove any associated zigzag effect
      const zigZag = this.zigZagEffects.get(id);
      if (zigZag) {
        zigZag.terminateImmediately();
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
    // Clear zigzag effects with proper cleanup
    this.zigZagEffects.forEach(effect => {
      effect.terminateImmediately();
    });
    this.zigZagEffects.clear();

    // Clear markers with proper cleanup
    this.markerEffects.forEach(effect => {
      effect.terminateImmediately();
    });
    this.markerEffects.clear();

    this.activeEffects = [];
  }

  /**
   * Show the layer
   */
  show(): void {
    super.show();
  }

  /**
   * Hide the layer
   */
  hide(): void {
    super.hide();

    // Immediately terminate all visible zigzag effects when hiding the layer
    if (!this.config.showZigZag) {
      this.clearZigZagEffects();
    }
  }
}
