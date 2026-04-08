export const CloudsConfig = {
  altitude: 0.01,
  opacity: 0.85,
  size: 3.5,
  imagePath: '/clouds.png',
  rotationSpeed: 0,
  useLiveTexture: true,
  liveTextureEndpoint: 'http://localhost:3001/api/clouds/2k',
  fallbackImagePath: '/clouds-fallback.png',
  refreshIntervalMs: 30 * 60 * 1000,
  detailStrength: 0.35,
  thickness: 0.004,
  shadowStrength: 1.2,
};

// Key config options that will have UI controls
export const CLOUDS_UI_KEYS = [
  'opacity'
] as const;
