import { Layer } from './LayerInterface';
import { LightningLayer } from './LightningLayer';
import { CloudLayer } from './CloudLayer';
import { TemperatureLayer } from './TemperatureLayer';
import { PrecipitationLayer } from './PrecipitationLayer';
import { WindLayer } from './WindLayer';

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
   */
  static createLayer(type: string): Layer<any> | null {
    switch (type.toLowerCase()) {
      case 'lightning':
        return this.createLightningLayer();
      case 'clouds':
      case 'cloud':
        return this.createCloudLayer();
      case 'temperature':
        return new TemperatureLayer();
      case 'precipitation':
        return new PrecipitationLayer();
      case 'wind':
        return new WindLayer();
      default:
        console.warn(`Unknown layer type: ${type}`);
        return null;
    }
  }
}
