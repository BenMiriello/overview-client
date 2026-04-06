import * as THREE from 'three';
import { MOON_RADIUS_SCENE, getMoonPosition } from './astronomy';
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
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'moon';
  return mesh;
}

export function updateMoonPosition(mesh: THREE.Mesh, date: Date): void {
  const pos = getMoonPosition(date);
  mesh.position.copy(pos);
}
