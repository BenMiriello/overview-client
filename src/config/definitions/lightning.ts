export const LightningConfig = {
  maxActiveAnimations: 10,
  maxDisplayedStrikes: 256,
  showLightningBolt: true,
};

export const LightningBoltConfig = {
  startAltitude: 0.02, // Will be overwritten to sync with cloud height when cloud layer is enabled
  endAltitude: 0.0005,
  lineWidth: 3.5,
  lineSegments: 8,
  jitterAmount: 0.02,
  branchChance: 0.4,
  branchFactor: 0.7,
  maxBranches: 4,
  duration: 1000,
  fadeOutDuration: 300,
  color: 0xffffff
};

export const MarkerConfig = {
  radius: 0.08,
  color: 0xffffff,
  opacity: 1,
};

// Key config options that will have UI controls
export const LIGHTNING_UI_KEYS = [
  'showLightningBolt',
  'maxDisplayedStrikes'
] as const;

export const MARKER_UI_KEYS = [
  'radius'
] as const;
