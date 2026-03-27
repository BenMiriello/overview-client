import * as THREE from 'three';
import { Vec3 } from '../simulation/types';
import { CoordinateTransform } from '../CoordinateTransform';

interface Streak {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
  length: number;
}

const streakVertexShader = `
attribute float alpha;
attribute float streakLength;

varying float vAlpha;

void main() {
  vAlpha = alpha;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const streakFragmentShader = `
uniform vec3 color;

varying float vAlpha;

void main() {
  gl_FragColor = vec4(color, vAlpha * 0.4);
}
`;

export class WindStreakRenderer {
  private scene: THREE.Scene;
  private transform: CoordinateTransform | null = null;

  private streaks: Streak[] = [];
  private maxStreaks: number = 80;

  private geometry: THREE.BufferGeometry;
  private material: THREE.ShaderMaterial;
  private mesh: THREE.LineSegments;

  private positions: Float32Array;
  private alphas: Float32Array;

  private windDir: THREE.Vector3 = new THREE.Vector3(1, 0, 0);
  private windSpeed: number = 0;

  private bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  } = { minX: -1, maxX: 1, minY: -1, maxY: 1, minZ: -1, maxZ: 1 };

  private visible: boolean = true;

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    // Initialize arrays (2 vertices per streak * 3 components)
    this.positions = new Float32Array(this.maxStreaks * 6);
    this.alphas = new Float32Array(this.maxStreaks * 2);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('alpha', new THREE.BufferAttribute(this.alphas, 1));

    this.material = new THREE.ShaderMaterial({
      vertexShader: streakVertexShader,
      fragmentShader: streakFragmentShader,
      uniforms: {
        color: { value: new THREE.Color(0.7, 0.85, 1.0) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.mesh = new THREE.LineSegments(this.geometry, this.material);
    this.scene.add(this.mesh);
  }

  setTransform(worldStart: Vec3, worldEnd: Vec3): void {
    this.transform = new CoordinateTransform(worldStart, worldEnd);

    const worldScale = this.transform.worldScale;
    const center = this.transform.toWorld({ x: 0, y: 0.5, z: 0 });

    this.bounds = {
      minX: center.x - worldScale,
      maxX: center.x + worldScale,
      minY: worldEnd.y,
      maxY: worldStart.y,
      minZ: center.z - worldScale,
      maxZ: center.z + worldScale,
    };

    // Initialize streaks at random positions
    this.initializeStreaks();
  }

  setWindParameters(direction: THREE.Vector2, speed: number): void {
    this.windDir.set(direction.x, 0, direction.y).normalize();
    this.windSpeed = speed / 60; // Normalize 0-60 kts to 0-1

    // Update streak lengths based on wind speed
    for (const streak of this.streaks) {
      streak.length = 0.02 + this.windSpeed * 0.08;
    }
  }

  private initializeStreaks(): void {
    this.streaks = [];

    for (let i = 0; i < this.maxStreaks; i++) {
      this.streaks.push(this.createStreak());
    }
  }

  private createStreak(): Streak {
    const { minX, maxX, minY, maxY, minZ, maxZ } = this.bounds;

    return {
      position: new THREE.Vector3(
        minX + Math.random() * (maxX - minX),
        minY + Math.random() * (maxY - minY),
        minZ + Math.random() * (maxZ - minZ)
      ),
      velocity: this.windDir.clone(),
      life: Math.random(),
      maxLife: 0.5 + Math.random() * 1.5,
      length: 0.02 + this.windSpeed * 0.08,
    };
  }

  private respawnStreak(streak: Streak): void {
    const { minX, maxX, minY, maxY, minZ, maxZ } = this.bounds;

    // Spawn at upwind edge
    const upwindOffset = this.windDir.clone().multiplyScalar(-1);

    streak.position.set(
      minX + Math.random() * (maxX - minX),
      minY + Math.random() * (maxY - minY),
      minZ + Math.random() * (maxZ - minZ)
    );

    // Offset toward upwind side
    streak.position.add(upwindOffset.multiplyScalar((maxX - minX) * 0.4));

    streak.life = 0;
    streak.maxLife = 0.5 + Math.random() * 1.5;
    streak.length = 0.02 + this.windSpeed * 0.08;
  }

  update(deltaTime: number): void {
    if (!this.visible || this.windSpeed < 0.01) {
      this.mesh.visible = false;
      return;
    }

    this.mesh.visible = true;
    const worldScale = this.transform?.worldScale ?? 1;
    const speed = this.windSpeed * worldScale * 0.5;

    for (let i = 0; i < this.streaks.length; i++) {
      const streak = this.streaks[i];

      // Update position
      streak.position.addScaledVector(this.windDir, speed * deltaTime);

      // Update life
      streak.life += deltaTime / streak.maxLife;

      // Check if out of bounds or dead
      if (streak.life >= 1.0 || this.isOutOfBounds(streak.position)) {
        this.respawnStreak(streak);
      }

      // Compute alpha (fade in/out)
      const fadeIn = Math.min(streak.life * 4, 1);
      const fadeOut = 1 - Math.max(0, (streak.life - 0.7) / 0.3);
      const alpha = fadeIn * fadeOut;

      // Update geometry
      const baseIdx = i * 6;
      const alphaIdx = i * 2;

      // Line start (current position)
      this.positions[baseIdx] = streak.position.x;
      this.positions[baseIdx + 1] = streak.position.y;
      this.positions[baseIdx + 2] = streak.position.z;

      // Line end (position + wind direction * length)
      const endPos = streak.position.clone()
        .addScaledVector(this.windDir, streak.length * worldScale);
      this.positions[baseIdx + 3] = endPos.x;
      this.positions[baseIdx + 4] = endPos.y;
      this.positions[baseIdx + 5] = endPos.z;

      this.alphas[alphaIdx] = alpha;
      this.alphas[alphaIdx + 1] = alpha * 0.3; // Tail is dimmer
    }

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.alpha.needsUpdate = true;
  }

  private isOutOfBounds(pos: THREE.Vector3): boolean {
    const { minX, maxX, minY, maxY, minZ, maxZ } = this.bounds;
    const margin = 0.2;
    return (
      pos.x < minX - margin || pos.x > maxX + margin ||
      pos.y < minY - margin || pos.y > maxY + margin ||
      pos.z < minZ - margin || pos.z > maxZ + margin
    );
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.mesh.visible = visible && this.windSpeed > 0.01;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
