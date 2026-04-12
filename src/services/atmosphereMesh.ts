import * as THREE from 'three';
import {
  createAtmosphereMaterial,
  ATMOSPHERE_RADIUS_SCENE,
  BASE_SCALE_HEIGHT,
  MIE_SCALE_HEIGHT_BASE,
  BASE_CLOUD_ALT_FAR,
} from './atmosphereMaterial';
import { LAYERS } from './renderLayers';

const PLANET_RADIUS = 100;
const CLOUD_ALT_FAR  = 0.03;
const CLOUD_ALT_NEAR = 0.003;
const ALT_FAR_POINT  = 1.0;
const ALT_NEAR_POINT = 0.25;

export function createAtmosphereMesh(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(ATMOSPHERE_RADIUS_SCENE, 64, 64);
  const material = createAtmosphereMaterial();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'atmosphere';
  mesh.renderOrder = LAYERS.ATMOSPHERE;
  mesh.frustumCulled = false;
  return mesh;
}

// Smooth the atmosphere radius to prevent jitter from per-frame camera fluctuations.
let smoothedCloudAlt = CLOUD_ALT_FAR;

export function updateAtmosphereCamera(mesh: THREE.Mesh, camera: THREE.Camera): void {
  const mat = mesh.material as THREE.ShaderMaterial;
  (mat.uniforms.uCameraPos.value as THREE.Vector3).copy(camera.position);

  const cameraAlt = (camera as THREE.PerspectiveCamera).position.length() / PLANET_RADIUS - 1;
  const t = Math.max(0, Math.min(1, (ALT_FAR_POINT - cameraAlt) / (ALT_FAR_POINT - ALT_NEAR_POINT)));
  const targetCloudAlt = CLOUD_ALT_FAR + (CLOUD_ALT_NEAR - CLOUD_ALT_FAR) * t;

  // Lerp toward target to avoid per-frame jitter from small camera position fluctuations.
  smoothedCloudAlt += (targetCloudAlt - smoothedCloudAlt) * 0.08;

  // Atmosphere = 2× cloud altitude. Scale height tracks proportionally so the
  // atmosphere always extends visually above the cloud shell at every zoom level.
  const atmRadius = PLANET_RADIUS * (1 + smoothedCloudAlt * 2);
  const scaleRatio = smoothedCloudAlt / BASE_CLOUD_ALT_FAR;
  mat.uniforms.uAtmosphereR.value    = atmRadius;
  mat.uniforms.uScaleHeight.value    = BASE_SCALE_HEIGHT    * scaleRatio;
  mat.uniforms.uScaleHeightMie.value = MIE_SCALE_HEIGHT_BASE * scaleRatio;
}

export function disposeAtmosphereMesh(mesh: THREE.Mesh): void {
  mesh.geometry.dispose();
  (mesh.material as THREE.ShaderMaterial).dispose();
}
