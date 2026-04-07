import * as THREE from 'three';
import { MOON_RADIUS_SCENE, getMoonPosition, getMoonLibration, CELESTIAL_NORTH_SCENE } from './astronomy';
import { sharedNightUniforms } from './dayNightMaterial';

const MOON_TEXTURE_URL = 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets/moon_1024.jpg';

const MOON_VERT = `
  varying vec2 vUv;
  varying vec3 vWorldNormal;
  void main() {
    vUv = uv;
    // World-space normal: for a sphere, the normal in model space equals the
    // normalized vertex position. Transform by the upper-left 3x3 of modelMatrix.
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const MOON_FRAG = `
  uniform sampler2D moonMap;
  uniform vec3 sunDir;
  varying vec2 vUv;
  varying vec3 vWorldNormal;

  void main() {
    vec4 texColor = texture2D(moonMap, vUv);

    // Hard terminator — no atmosphere on the moon
    float light = max(0.0, dot(vWorldNormal, sunDir));
    float ambient = 0.15;
    float finalLight = ambient + (1.0 - ambient) * light;

    gl_FragColor = vec4(texColor.rgb * finalLight, 1.0);
  }
`;

export function createMoonMesh(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(MOON_RADIUS_SCENE, 64, 32);

  const textureLoader = new THREE.TextureLoader();
  const moonTexture = textureLoader.load(MOON_TEXTURE_URL);
  moonTexture.colorSpace = THREE.SRGBColorSpace;

  const material = new THREE.ShaderMaterial({
    vertexShader: MOON_VERT,
    fragmentShader: MOON_FRAG,
    uniforms: {
      moonMap: { value: moonTexture },
      sunDir: sharedNightUniforms.sunDir,
    },
    // transparent puts the moon in the transparent render pass so renderOrder
    // can place it AFTER the night tiles (which have depthTest: false).
    // The shader always outputs alpha=1.0 so it's visually opaque.
    transparent: true,
    depthWrite: true,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'moon';
  mesh.renderOrder = 1;
  return mesh;
}

export function updateMoonPosition(mesh: THREE.Mesh, date: Date): void {
  const pos = getMoonPosition(date);
  mesh.position.copy(pos);
}

/**
 * Orient the moon so its near side faces Earth (tidal locking), with libration
 * wobble applied. Earth is at scene origin. The moon's texture uses standard
 * SphereGeometry UV mapping where the prime meridian (center of the near side)
 * lies along the mesh's local -Z axis.
 */
const _tmpM = new THREE.Matrix4();
const _tmpEye = new THREE.Vector3();
const _tmpLibQuat = new THREE.Quaternion();
const _tmpAxisY = new THREE.Vector3(0, 1, 0);
const _tmpAxisX = new THREE.Vector3(1, 0, 0);

export function updateMoonOrientation(mesh: THREE.Mesh, date: Date): void {
  // Base orientation: look from moon center toward Earth (origin), so local -Z
  // ends up pointing at Earth. Matrix4.lookAt builds a basis whose -Z axis
  // points from `eye` toward `target`.
  _tmpEye.copy(mesh.position);
  _tmpM.lookAt(_tmpEye, new THREE.Vector3(0, 0, 0), CELESTIAL_NORTH_SCENE);
  mesh.quaternion.setFromRotationMatrix(_tmpM);

  // Libration: the sub-earth point is offset from (0,0) selenographic by
  // (elon, elat). To make that offset point face Earth instead of the prime
  // meridian, rotate the mesh by (-elon) about its local Y and (-elat) about
  // its local X — i.e., post-multiply by the inverse libration rotation.
  const { elon, elat } = getMoonLibration(date);
  const lonRad = -elon * Math.PI / 180;
  const latRad = -elat * Math.PI / 180;
  _tmpLibQuat.setFromAxisAngle(_tmpAxisY, lonRad);
  mesh.quaternion.multiply(_tmpLibQuat);
  _tmpLibQuat.setFromAxisAngle(_tmpAxisX, latRad);
  mesh.quaternion.multiply(_tmpLibQuat);
}
