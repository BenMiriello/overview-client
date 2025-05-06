import { Layer } from './LayerInterface';
import { LightningLayer } from './LightningLayer';
import { CloudLayer } from './CloudLayer';

/**
 * Factory for creating different types of data layers
 */
export class LayerFactory {
  static createLightningLayer(): LightningLayer {
    return new LightningLayer();
  }

  static createCloudLayer(): CloudLayer {
    return new CloudLayer();
  }

  /**
   * Factory method for creating different types of layers
   * (for future expansion with earthquakes, tornadoes, etc.)
   */
  static createLayer(type: string): Layer<any> | null {
    switch (type.toLowerCase()) {
      case 'lightning':
        return this.createLightningLayer();
      case 'clouds':
      case 'cloud':
        return this.createCloudLayer();
      default:
        console.warn(`Unknown layer type: ${type}`);
        return null;
    }
  }
}
