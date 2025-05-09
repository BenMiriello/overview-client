export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export interface PathfindingConfig {
  resolution: number;       // 0-1 scale (unused in simple version)
  startPoint?: Point3D;     // Optional starting point
  heightOffset?: number;    // Height above endPoint for default start
}

export function calculateLightningPath(
  endPoint: Point3D,
  config: PathfindingConfig
): Point3D[] {
  // Create default start point if not provided
  const startPoint = config.startPoint || {
    x: endPoint.x,
    y: endPoint.y + (config.heightOffset || 2.0),
    z: endPoint.z
  };
  
  return [
    { ...startPoint },
    { ...endPoint }
  ];
}
