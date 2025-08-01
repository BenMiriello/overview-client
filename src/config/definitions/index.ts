import { CloudsConfig, CLOUDS_UI_KEYS } from './clouds';
import {
  LightningConfig,
  LightningBoltConfig,
  MarkerConfig,
  LIGHTNING_UI_KEYS,
  MARKER_UI_KEYS
} from './lightning';

export * from './clouds';
export * from './lightning';

export const GlobalConfig = {
  layers: {
    clouds: CloudsConfig,
    lightning: {
      ...LightningConfig,
      lightningBoltConfig: LightningBoltConfig,
      markerConfig: MarkerConfig,
    }
  }
};

export const UI_KEYS = {
  'layers.clouds': CLOUDS_UI_KEYS,
  'layers.lightning': LIGHTNING_UI_KEYS,
  'layers.lightning.markerConfig': MARKER_UI_KEYS
};
