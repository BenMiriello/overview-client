import { BaseLayer } from './LayerInterface';
import { LightningStrike } from '../models/LightningStrike';
import { ZigZagEffect } from '../effects/ZigZagEffect';
import { PointMarkerEffect } from '../effects/PointMarkerEffect';
import { getConfig, setConfig } from '../config';
import { DataStream } from '../services/dataStreams/interfaces';

/**
 * Layer that displays lightning strikes on the globe
 */
export class LightningLayer extends BaseLayer<LightningStrike> {
  private zigZagEffects: Map<string, ZigZagEffect> = new Map();
  private markerEffects: Map<string, PointMarkerEffect> = new Map();
  private activeEffects: { id: string, timestamp: number }[] = [];
  private startAltitude: number = getConfig<number>('layers.clouds.altitude') ?? 
                                  getConfig<number>('layers.lightning.zigZagConfig.startAltitude') ?? 
                                  0.02;

  private dataStream: DataStream<LightningStrike> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(dataStream?: DataStream<LightningStrike>) {
    super();

    if (dataStream) {
      this.setDataStream(dataStream);
    }
  }

  /**
   * Set the data stream for this layer
   * @param dataStream The data stream to use
   */
  setDataStream(dataStream: DataStream<LightningStrike>): void {
    // Clean up any existing subscription
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    this.dataStream = dataStream;

    // Subscribe to the data stream
    if (this.dataStream) {
      this.unsubscribe = this.dataStream.subscribe(this.addData.bind(this));
    }
  }

  getDataStream(): DataStream<LightningStrike> | null {
    return this.dataStream;
  }

  setShowZigZag(show: boolean): void {
    const currentShowZigZag = getConfig<boolean>('layers.lightning.showZigZag');
    if (currentShowZigZag !== show) {
      setConfig('layers.lightning.showZigZag', show);

      if (!show) {
        this.clearZigZagEffects();
      }
    }
  }

  addData(strike: LightningStrike): void {
    if (getConfig<boolean>('layers.lightning.showZigZag')) {
      this.createZigZagEffect(strike);
    }

    this.createMarkerEffect(strike);
    this.enforceMaxDisplayedStrikes();
  }

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

    // Get zigzag configuration values
    const config = {
      startAltitude: this.startAltitude,
      lineWidth: getConfig<number>('layers.lightning.zigZagConfig.lineWidth')             || 3.5,
      lineSegments: getConfig<number>('layers.lightning.zigZagConfig.lineSegments')       || 8,
      jitterAmount: getConfig<number>('layers.lightning.zigZagConfig.jitterAmount')       || 0.02,
      branchChance: getConfig<number>('layers.lightning.zigZagConfig.branchChance')       || 0.4,
      branchFactor: getConfig<number>('layers.lightning.zigZagConfig.branchFactor')       || 0.7,
      maxBranches: getConfig<number>('layers.lightning.zigZagConfig.maxBranches')         || 4,
      duration: getConfig<number>('layers.lightning.zigZagConfig.duration')               || 1000,
      fadeOutDuration: getConfig<number>('layers.lightning.zigZagConfig.fadeOutDuration') || 300
    };

    const effect = new ZigZagEffect(strike.lat, strike.lng, config);

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

    // Get marker configuration values
    const config = {
      radius: getConfig<number>('layers.lightning.markerConfig.radius')   || 0.08,
      color: getConfig<number>('layers.lightning.markerConfig.color')     || 0xffffff,
      opacity: getConfig<number>('layers.lightning.markerConfig.opacity') || 0.8,
      // If lightning is disabled, show markers immediately with full opacity
      fadeInDuration: getConfig<boolean>('layers.lightning.showZigZag') ? 1500 : 0
    };

    const effect = new PointMarkerEffect(strike.lat, strike.lng, strike.intensity || 0.5, config);

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

    const maxActiveAnimations = getConfig<number>('layers.lightning.maxActiveAnimations') || 10;

    // Remove excess effects
    if (this.activeEffects.length > maxActiveAnimations) {
      const removeIds = this.activeEffects
        .slice(maxActiveAnimations)
        .map(e => e.id);

      removeIds.forEach(id => {
        const effect = this.zigZagEffects.get(id);
        if (effect) {
          effect.terminateImmediately();
          this.zigZagEffects.delete(id);
        }
      });

      // Update active effects list
      this.activeEffects = this.activeEffects.slice(0, maxActiveAnimations);
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

    completedMarkerIds.forEach(id => {
      this.markerEffects.delete(id);
    });
  }

  private enforceMaxDisplayedStrikes(): void {
    const maxDisplayedStrikes = getConfig<number>('layers.lightning.maxDisplayedStrikes') || 256;

    if (this.markerEffects.size <= maxDisplayedStrikes) return;

    // Get all markers sorted by creation time (oldest first)
    const markers = Array.from(this.markerEffects.entries())
      .sort((a, b) => {
        const aTime = a[1].getObject().userData.createdAt || 0;
        const bTime = b[1].getObject().userData.createdAt || 0;
        return aTime - bTime;
      });

    // Remove oldest markers that exceed the limit
    const removeCount = markers.length - maxDisplayedStrikes;

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

    // Clean up data stream subscription
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  show(): void {
    super.show();
  }

  hide(): void {
    super.hide();

    // Immediately terminate all visible zigzag effects when hiding the layer
    if (!getConfig<boolean>('layers.lightning.showZigZag')) {
      this.clearZigZagEffects();
    }
  }
}
