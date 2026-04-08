import * as THREE from 'three';
import { createAtmosphereMaterial, ATMOSPHERE_RADIUS_SCENE } from './atmosphereMaterial';

export function createAtmosphereMesh(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(ATMOSPHERE_RADIUS_SCENE, 64, 64);
  const material = createAtmosphereMaterial();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'atmosphere';
  mesh.renderOrder = 5;
  mesh.frustumCulled = false;
  return mesh;
}

export function updateAtmosphereCamera(mesh: THREE.Mesh, camera: THREE.Camera): void {
  const mat = mesh.material as THREE.ShaderMaterial;
  (mat.uniforms.uCameraPos.value as THREE.Vector3).copy(camera.position);
}

export function disposeAtmosphereMesh(mesh: THREE.Mesh): void {
  mesh.geometry.dispose();
  (mesh.material as THREE.ShaderMaterial).dispose();
}
