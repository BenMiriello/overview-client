import * as THREE from 'three';
import { LightningBoltEffectConfig } from './LightningBoltEffect';

export function createRandomGenerator(seed: number): () => number {
  return function() {
    const x = Math.sin(seed++) * 10000;
    return x - Math.floor(x);
  };
}

/**
 * Create the lightning strike geometry with direct world coordinates
 */
export function createLightningStrikeGeometry(
  lat: number,
  lng: number,
  globeEl: any,
  config: LightningBoltEffectConfig,
  random: () => number
): THREE.BufferGeometry {
  if (!globeEl) return new THREE.BufferGeometry();

  const segments = config.lineSegments;
  const points: THREE.Vector3[] = [];

  // Get globe radius from the globe element
  let globeRadius = 100; // Default fallback
  if (globeEl._mainSphere && globeEl._mainSphere.geometry && globeEl._mainSphere.geometry.parameters) {
    globeRadius = globeEl._mainSphere.geometry.parameters.radius || 100;
  }

  // Calculate surface and cloud points in actual world coordinates
  const surfacePoint = globeEl.getCoords(lat, lng, 0);
  const cloudPoint = globeEl.getCoords(lat, lng, config.startAltitude);

  // Direction from center to surface point (normalized)
  const directionVector = new THREE.Vector3()
    .subVectors(surfacePoint, new THREE.Vector3(0, 0, 0))
    .normalize();

  // Create a basis for sideways movement (perpendicular to direction)
  const sideways = new THREE.Vector3(1, 0, 0);
  if (Math.abs(directionVector.y) < 0.9) {
    sideways.crossVectors(directionVector, new THREE.Vector3(0, 1, 0)).normalize();
  } else {
    sideways.crossVectors(directionVector, new THREE.Vector3(0, 0, 1)).normalize();
  }
  const updown = new THREE.Vector3().crossVectors(directionVector, sideways).normalize();

  // Jitter scale - small enough to keep zigzag tight
  const jitterScale = globeRadius * 0.004;

  let prevJitterX = 0, prevJitterZ = 0;

  // First point is exact cloud position
  points.push(new THREE.Vector3(cloudPoint.x, cloudPoint.y, cloudPoint.z));

  // Create zigzag points between cloud and surface
  for (let i = 1; i < segments; i++) {
    const t = i / segments;

    // Position along the line from cloud to surface
    const pos = new THREE.Vector3()
      .lerpVectors(cloudPoint, surfacePoint, t);

    // Apply jitter perpendicular to the main direction
    const jitterX = (prevJitterX + (random() * 2 - 1) * config.jitterAmount);
    const jitterZ = (prevJitterZ + (random() * 2 - 1) * config.jitterAmount);

    // Pull toward center to prevent wandering
    const pullToCenter = 0.3;
    prevJitterX = jitterX * (1 - pullToCenter);
    prevJitterZ = jitterZ * (1 - pullToCenter);

    // Apply jitter in local coordinate system
    pos.add(sideways.clone().multiplyScalar(jitterX * jitterScale));
    pos.add(updown.clone().multiplyScalar(jitterZ * jitterScale));

    points.push(pos);
  }

  // Last point is exact surface position
  // Make sure it extends all the way to the ground (-1.8 in scene coordinates)
  const groundPoint = new THREE.Vector3(surfacePoint.x, -1.8, surfacePoint.z);
  points.push(groundPoint);

  return new THREE.BufferGeometry().setFromPoints(points);
}

/**
 * Create branches from the main line
 */
export function createBranches(
  globeEl: any,
  config: LightningBoltEffectConfig,
  geometry: THREE.BufferGeometry,
  material: THREE.LineBasicMaterial,
  random: () => number,
  registerResource: (resource: any) => void
): { branches: THREE.Line[], lines: THREE.Line[] } {
  if (!globeEl) return { branches: [], lines: [] };

  const branches: THREE.Line[] = [];
  const lines: THREE.Line[] = [];
  const segments = config.lineSegments;
  const maxBranches = config.maxBranches;
  let branchCount = 0;

  // Get the vertices of the main line
  const positions = geometry.getAttribute('position');

  // Skip the very top (cloud) and bottom (surface) segments
  // Only create branches in the middle portion of the lightning
  const skipTop = Math.floor(segments * 0.15); // Skip top 15%
  const skipBottom = Math.floor(segments * 0.15); // Skip bottom 15%

  // Get globe radius for scaling branches appropriately
  let globeRadius = 100; // Default fallback
  if (globeEl._mainSphere && globeEl._mainSphere.geometry && globeEl._mainSphere.geometry.parameters) {
    globeRadius = globeEl._mainSphere.geometry.parameters.radius || 100;
  }

  // Scale branches to be appropriate for globe size
  const branchScale = globeRadius * 0.005;

  for (let i = skipTop; i < segments - skipBottom && branchCount < maxBranches; i++) {
    if (random() < config.branchChance) {
      // Get the vertex position from the main lightning line
      const startPoint = new THREE.Vector3(
        positions.getX(i),
        positions.getY(i),
        positions.getZ(i)
      );

      // Calculate direction from globe center to this point
      const center = new THREE.Vector3(0, 0, 0);
      const dir = new THREE.Vector3().subVectors(startPoint, center).normalize();

      // Create a local coordinate system at this point
      const sideways = new THREE.Vector3(1, 0, 0);
      if (Math.abs(dir.y) < 0.9) {
        sideways.crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
      } else {
        sideways.crossVectors(dir, new THREE.Vector3(0, 0, 1)).normalize();
      }
      const updown = new THREE.Vector3().crossVectors(dir, sideways).normalize();

      // Create random branch direction (mostly sideways, slightly downward)
      const randomSideways = (random() * 2 - 1) * branchScale;

      // More downward as we get closer to ground
      const downwardBias = i / segments; 
      const randomDown = random() * branchScale * 0.7 * downwardBias;

      // Combined branch direction
      const branchDir = new THREE.Vector3()
        .addScaledVector(sideways, randomSideways)
        .addScaledVector(updown, randomDown);

      // Ensure branch points away from center a bit to look natural
      const outwardAmount = branchScale * 0.3;
      branchDir.addScaledVector(dir, outwardAmount);

      // End point of the branch
      const endPoint = new THREE.Vector3().copy(startPoint).add(branchDir);

      // Create a multi-point branch with zigzag effect
      const branchPoints = [startPoint.clone()];

      // Add intermediate zigzag points on the branch (fewer points for shorter branches)
      const subSegments = 1 + Math.floor(random() * 2);
      for (let j = 1; j <= subSegments; j++) {
        const t = j / (subSegments + 1);

        // Base interpolated position
        const midPoint = new THREE.Vector3().lerpVectors(startPoint, endPoint, t);

        // Small perpendicular jitter for zigzag effect
        const jitterSize = branchScale * 0.1;
        const jitterDir = new THREE.Vector3()
          .addScaledVector(sideways, (random() * 2 - 1) * jitterSize)
          .addScaledVector(updown, (random() * 2 - 1) * jitterSize);

        midPoint.add(jitterDir);
        branchPoints.push(midPoint);
      }

      // Add final point
      branchPoints.push(endPoint);

      // Create geometry and line for the branch
      const branchGeometry = new THREE.BufferGeometry().setFromPoints(branchPoints);
      const branchMaterial = material.clone();
      const branch = new THREE.Line(branchGeometry, branchMaterial);

      // Register resources
      registerResource(branchGeometry);
      registerResource(branchMaterial);
      registerResource(branch);

      // Store for animation
      branches.push(branch);
      lines.push(branch);
      branchCount++;
    }
  }

  return { branches, lines };
}
