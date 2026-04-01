import * as THREE from 'three';
import { LeaderTipInfo } from '../animation/types';
import { CoordinateTransform } from '../CoordinateTransform';
import { Vec3 } from '../simulation/types';

const coronaVertexShader = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const coronaFragmentShader = `
uniform vec3 color;
uniform float intensity;
uniform float isMainChannel;

varying vec2 vUv;

void main() {
  vec2 centered = vUv - 0.5;
  float dist = length(centered) * 2.0;

  if (dist > 1.0) {
    discard;
  }

  // Soft radial falloff with bright core
  float core = 1.0 - smoothstep(0.0, 0.3, dist);
  float halo = 1.0 - smoothstep(0.2, 1.0, dist);

  // Main channel gets brighter corona
  float mainBoost = isMainChannel > 0.5 ? 1.5 : 1.0;

  float alpha = (core * 0.8 + halo * 0.4) * intensity * mainBoost;
  alpha = clamp(alpha, 0.0, 0.7);

  // Color: blue-purple for corona discharge
  vec3 finalColor = color * (core * 1.2 + halo * 0.6);

  gl_FragColor = vec4(finalColor, alpha);
}
`;

interface CoronaSprite {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
}

export class CoronaRenderer {
  private scene: THREE.Scene;
  private sprites: CoronaSprite[] = [];
  private maxSprites: number = 32;
  private transform: CoordinateTransform | null = null;
  private baseSize: number = 0.05;
  private color: THREE.Color;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.color = new THREE.Color(0.67, 0.75, 1.0);
    this.initializeSprites();
  }

  private initializeSprites(): void {
    const geometry = new THREE.PlaneGeometry(1, 1);

    for (let i = 0; i < this.maxSprites; i++) {
      const material = new THREE.ShaderMaterial({
        vertexShader: coronaVertexShader,
        fragmentShader: coronaFragmentShader,
        uniforms: {
          color: { value: this.color },
          intensity: { value: 0 },
          isMainChannel: { value: 0 },
        },
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;

      // Billboard toward camera
      mesh.onBeforeRender = (_renderer, _scene, camera) => {
        mesh.quaternion.copy(camera.quaternion);
      };

      this.scene.add(mesh);
      this.sprites.push({ mesh, material });
    }
  }

  setTransform(worldStart: Vec3, worldEnd: Vec3): void {
    this.transform = new CoordinateTransform(worldStart, worldEnd);
    this.baseSize = this.transform.worldScale * 0.08;
  }

  update(tips: LeaderTipInfo[] | undefined): void {
    if (!tips || tips.length === 0) {
      this.hideAll();
      return;
    }

    for (let i = 0; i < this.sprites.length; i++) {
      const sprite = this.sprites[i];

      if (i < tips.length) {
        const tip = tips[i];

        // Transform position to world space
        const worldPos = this.transform
          ? this.transform.toWorld(tip.position)
          : tip.position;

        // Size: main channel corona is larger
        const size = tip.isMainChannel ? this.baseSize * 1.5 : this.baseSize;
        sprite.mesh.scale.set(size, size, 1);
        sprite.mesh.position.set(worldPos.x, worldPos.y, worldPos.z);

        sprite.material.uniforms.intensity.value = 1.0;
        sprite.material.uniforms.isMainChannel.value = tip.isMainChannel ? 1.0 : 0.0;
        sprite.mesh.visible = true;
      } else {
        sprite.mesh.visible = false;
      }
    }
  }

  private hideAll(): void {
    for (const sprite of this.sprites) {
      sprite.mesh.visible = false;
    }
  }

  dispose(): void {
    for (const sprite of this.sprites) {
      this.scene.remove(sprite.mesh);
      sprite.mesh.geometry.dispose();
      sprite.material.dispose();
    }
    this.sprites = [];
  }
}
