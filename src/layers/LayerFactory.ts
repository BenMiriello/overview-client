import { Layer } from './LayerInterface';
import { LightningLayer, LightningLayerConfig } from './LightningLayer';
import { CloudLayer, CloudLayerConfig } from './CloudLayer';

/**
 * Factory for creating different types of data layers
 */
export class LayerFactory {
  static createLightningLayer(config?: Partial<LightningLayerConfig>): LightningLayer {
    return new LightningLayer(config);
  }

  static createCloudLayer(config?: Partial<CloudLayerConfig>): CloudLayer {
    return new CloudLayer(config);
  }

  static createLayer(type: string, config: any = {}): Layer<any> | null {
    switch (type.toLowerCase()) {
      case 'lightning':
        return this.createLightningLayer(config);
      case 'clouds':
        return this.createCloudLayer(config);
      default:
        console.warn(`Unknown layer type: ${type}`);
        return null;
    }
  }
}
