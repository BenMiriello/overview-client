import { BaseLayer } from './LayerInterface';
import { LightningStrike } from '../models/LightningStrike';
import { LightningBoltEffect, LightningBoltEffectConfig } from '../effects/LightningBoltEffect';
import { PointMarkerEffect } from '../effects/PointMarkerEffect';
import { getConfig, setConfig } from '../config';
import { DataStream } from '../services/dataStreams/interfaces';

/**
 * Layer that displays lightning strikes on the globe
 */
export class LightningLayer extends BaseLayer<LightningStrike> {
  private lightningBoltEffects: Map<string, LightningBoltEffect> = new Map();
  private markerEffects: Map<string, PointMarkerEffect> = new Map();
  private activeEffects: { id: string, timestamp: number }[] = [];
  private startAltitude: number = getConfig<number>('layers.clouds.altitude') ?? 
                                  getConfig<number>('layers.lightning.lightningBoltConfig.startAltitude') ?? 
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

  setShowLightningBolt(show: boolean): void {
    const currentShowLightningBolt = getConfig<boolean>('layers.lightning.showLightningBolt');
    if (currentShowLightningBolt !== show) {
      setConfig('layers.lightning.showLightningBolt', show);

      if (!show) {
        this.clearLightningBoltEffects();
      }
    }
  }

  addData(strike: LightningStrike): void {
    console.log('LightningLayer: Adding strike', strike);
    console.log('showLightningBolt config:', getConfig<boolean>('layers.lightning.showLightningBolt'));
    if (getConfig<boolean>('layers.lightning.showLightningBolt')) {
      this.createLightningBoltEffect(strike);
    }

    this.createMarkerEffect(strike);
    this.enforceMaxDisplayedStrikes();
  }

  private createLightningBoltEffect(strike: LightningStrike): void {
    if (!this.scene || !this.globeEl) return;

    // If we already have this strike, remove the old one first
    if (this.lightningBoltEffects.has(strike.id)) {
      const oldEffect = this.lightningBoltEffects.get(strike.id);
      if (oldEffect) {
        oldEffect.terminate();
        this.lightningBoltEffects.delete(strike.id);
      }
    }

    const config: LightningBoltEffectConfig = {
      lat: strike.lat,
      lng: strike.lng,
      startAltitude: this.startAltitude,
      groundAltitude: 0,
      resolution: getConfig<number>('layers.lightning.lightningBoltConfig.resolution') || 0.7,
      seed: Math.random() * 10000,
      enableScreenFlash: false, // Only enable for showcase
      duration: getConfig<number>('layers.lightning.lightningBoltConfig.duration') || 1.0,
      fadeTime: (getConfig<number>('layers.lightning.lightningBoltConfig.fadeOutDuration') ?? 300) / 1000
    };

    const effect = new LightningBoltEffect(this.scene, this.globeEl, config);

    this.lightningBoltEffects.set(strike.id, effect);

    this.activeEffects.push({
      id: strike.id,
      timestamp: Date.now()
    });

    // Limit active animations
    this.ensureMaxActiveEffects();
  }

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

    const config = {
      radius: getConfig<number>('layers.lightning.markerConfig.radius')             || 0.08,
      color: getConfig<number>('layers.lightning.markerConfig.color')               || 0xffffff,
      opacity: getConfig<number>('layers.lightning.markerConfig.opacity')           || 0.8,
      // displayDelay: getConfig<number>('layers.lightning.markerConfig.displayDelay') || 500,
      // If lightning is disabled, show markers immediately with full opacity
      fadeInDuration: getConfig<boolean>('layers.lightning.showLightningBolt')              ? 1500 : 0,
    };

    const effect = new PointMarkerEffect(strike.lat, strike.lng, strike.intensity || 0.5, config);

    effect.initialize(this.scene, this.globeEl);
    effect.positionOnGlobe(strike.lat, strike.lng);

    this.markerEffects.set(strike.id, effect);
  }

  private ensureMaxActiveEffects(): void {
    this.activeEffects.sort((a, b) => b.timestamp - a.timestamp);

    const maxActiveAnimations = getConfig<number>('layers.lightning.maxActiveAnimations') || 10;

    // Remove excess effects
    if (this.activeEffects.length > maxActiveAnimations) {
    const removeIds = this.activeEffects
    .slice(maxActiveAnimations)
    .map(e => e.id);

    removeIds.forEach(id => {
    const effect = this.lightningBoltEffects.get(id);
    if (effect) {
    effect.terminate();
    this.lightningBoltEffects.delete(id);
    }
    });

      // Update active effects list
      this.activeEffects = this.activeEffects.slice(0, maxActiveAnimations);
    }
  }

  private clearLightningBoltEffects(): void {
    this.lightningBoltEffects.forEach((effect) => {
      effect.terminate();
    });

    this.lightningBoltEffects.clear();
    this.activeEffects = [];
  }

  private getLineWidthScale(): number {
    if (!this.globeEl) return 1.0;
    try {
      const camera = this.globeEl.camera();
      const distance = camera.position.length();
      const referenceDistance = 300;
      return Math.max(0.25, Math.min(2.5, referenceDistance / distance));
    } catch {
      return 1.0;
    }
  }

  update(currentTime: number): void {
    if (!this.visible) return;

    const lineWidthScale = this.getLineWidthScale();

    // Update lightning bolt effects and collect completed IDs
    const completedLightningBoltIds: string[] = [];

    this.lightningBoltEffects.forEach((effect, id) => {
      effect.setLineWidthScale(lineWidthScale);
      effect.update(currentTime);
      const isActive = !effect.isComplete();

      if (!isActive) {
        completedLightningBoltIds.push(id);
        // Remove from active effects tracking
        this.activeEffects = this.activeEffects.filter(e => e.id !== id);
      }
    });

    completedLightningBoltIds.forEach(id => {
      const effect = this.lightningBoltEffects.get(id);
      if (effect) {
        effect.terminate();
      }
      this.lightningBoltEffects.delete(id);
    });

    // Update point markers and collect completed IDs
    const completedMarkerIds: string[] = [];

    this.markerEffects.forEach((effect, id) => {
      effect.update(currentTime);
      const isActive = !effect.isComplete();

      if (!isActive) {
        completedMarkerIds.push(id);
      }
    });

    completedMarkerIds.forEach(id => {
      const effect = this.markerEffects.get(id);
      if (effect) {
        effect.terminate();
      }
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
      effect.terminate();
      this.markerEffects.delete(id);

      // Also remove any associated lightning bolt effect
      const lightningBolt = this.lightningBoltEffects.get(id);
      if (lightningBolt) {
        lightningBolt.terminate();
        this.lightningBoltEffects.delete(id);
        this.activeEffects = this.activeEffects.filter(e => e.id !== id);
      }
    });
  }

  getActiveLightningBoltCount(): number {
    return this.lightningBoltEffects.size;
  }

  getMarkerCount(): number {
    return this.markerEffects.size;
  }

  clear(): void {
    // Clear lightning bolt effects with proper cleanup
    this.lightningBoltEffects.forEach(effect => {
      effect.terminate();
    });
    this.lightningBoltEffects.clear();

    // Clear markers with proper cleanup
    this.markerEffects.forEach(effect => {
      effect.terminate();
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

    // Immediately terminate all visible lightning bolt effects when hiding the layer
    if (!getConfig<boolean>('layers.lightning.showLightningBolt')) {
      this.clearLightningBoltEffects();
    }
  }
}
