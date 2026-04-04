export const LightningConfig = {
  maxActiveAnimations: 10,
  maxDisplayedStrikes: 256,
  showLightningBolt: true,
};

export const LightningBoltConfig = {
  startAltitude: 0.02, // Will be overwritten to sync with cloud height when cloud layer is enabled
  endAltitude: 0.0005,
  resolution: 0.7,     // Complexity level (0-1)
  duration: 1000,
  fadeOutDuration: 300,
  color: 0xffffff
};

export const MarkerConfig = {
  radius: 0.08,
  color: 0xffdd00,
  opacity: 0.9,
};

// Key config options that will have UI controls
export const LIGHTNING_UI_KEYS = [
  'showLightningBolt',
  'maxDisplayedStrikes'
] as const;

export const MARKER_UI_KEYS = [
  'radius'
] as const;
