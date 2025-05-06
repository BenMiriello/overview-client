import { Layer } from './LayerInterface';
import { LightningLayer, LightningLayerConfig } from './LightningLayer';

/**
 * Factory for creating different types of data layers
 */
export class LayerFactory {
  /**
   * Create a lightning strike layer
   */
  static createLightningLayer(config?: Partial<LightningLayerConfig>): LightningLayer {
    return new LightningLayer(config);
  }
  
  /**
   * Factory method for creating other types of layers as needed
   * (for future expansion with earthquakes, tornadoes, etc.)
   */
  static createLayer(type: string, config: any = {}): Layer<any> | null {
    switch (type.toLowerCase()) {
      case 'lightning':
        return this.createLightningLayer(config);
      // Future layer types can be added here
      default:
        console.warn(`Unknown layer type: ${type}`);
        return null;
    }
  }
}
