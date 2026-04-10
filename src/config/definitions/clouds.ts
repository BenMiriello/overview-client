export const CloudsConfig = {
  altitude: 0.01,
  opacity: 0.65,
  size: 3.5,
  imagePath: '/clouds.png',
  rotationSpeed: 0,
  useLiveTexture: true,
  liveTextureEndpoint: `${import.meta.env.VITE_SERVER_URL}/api/clouds/8k`,
  fallbackImagePath: '/clouds-fallback.png',
  refreshIntervalMs: 30 * 60 * 1000,
  detailStrength: 0.10,
  densityLo: 0.05,
  bumpStrength: 2.5,
  reliefAmount: 1.2,
};

// Key config options that will have UI controls
export const CLOUDS_UI_KEYS = [
  'opacity'
] as const;
