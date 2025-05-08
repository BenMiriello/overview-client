import { Effect } from './EffectInterface';
import { LightningBoltEffect, LightningBoltEffectConfig } from '../LightningBoltEffect/LightningBoltEffect';
import { PointMarkerEffect, PointMarkerConfig } from '../PointMarkerEffect';

/**
 * Factory for creating different types of visual effects
 */
export class EffectFactory {
  static createLightningBoltEffect(
    lat: number, 
    lng: number, 
    config?: Partial<LightningBoltEffectConfig>
  ): LightningBoltEffect {
    return new LightningBoltEffect(lat, lng, config);
  }

  static createPointMarkerEffect(
    lat: number, 
    lng: number, 
    intensity: number = 0.5,
    config?: Partial<PointMarkerConfig>
  ): PointMarkerEffect {
    return new PointMarkerEffect(lat, lng, intensity, config);
  }

  static createEffect(
    type: string, 
    lat: number, 
    lng: number, 
    options: any = {}
  ): Effect | null {
    switch (type.toLowerCase()) {
      case 'zigzag':
      case 'lightning':
        return this.createLightningBoltEffect(lat, lng, options.config);
      case 'marker':
      case 'point':
        return this.createPointMarkerEffect(
          lat, 
          lng, 
          options.intensity || 0.5, 
          options.config
        );
      // Future effect types can be added here
      default:
        console.warn(`Unknown effect type: ${type}`);
        return null;
    }
  }
}
