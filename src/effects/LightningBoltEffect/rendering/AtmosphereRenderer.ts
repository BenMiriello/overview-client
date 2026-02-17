import * as THREE from 'three';
import { AtmosphereSimulator } from '../simulation/AtmosphereSimulator';
import { VoronoiField } from '../simulation/VoronoiField';
import { Vec3 } from '../simulation/types';
import { CoordinateTransform } from '../CoordinateTransform';

const MAX_CELLS = 16;

// Vertex shader for sprites (billboarded)
const spriteVertexShader = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Fragment shader for sprites
const spriteFragmentShader = `
uniform vec3 baseColor;
uniform float intensity;
uniform float opacity;

varying vec2 vUv;

void main() {
  vec2 centered = vUv - 0.5;
  float dist = length(centered) * 2.0;

  if (dist > 1.0) {
    discard;
  }

  float falloff = (cos(dist * 3.14159) + 1.0) * 0.5;
  float alpha = intensity * falloff * opacity;

  gl_FragColor = vec4(baseColor, alpha);
}
`;

export interface AtmosphereRendererOptions {
  planeSize?: number;
  ceilingColor?: THREE.Color;
  groundColor?: THREE.Color;
  atmosphericColor?: THREE.Color;
  moistureColor?: THREE.Color;
  ionizationColor?: THREE.Color;
  opacity?: number;
}

interface SpriteData {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
}

export class AtmosphereRenderer {
  private scene: THREE.Scene;
  private options: Required<AtmosphereRendererOptions>;

  // All fields rendered as sprites
  private ceilingSprites: SpriteData[] = [];
  private groundSprites: SpriteData[] = [];
  private atmosphericSprites: SpriteData[] = [];
  private moistureSprites: SpriteData[] = [];
  private ionizationSprites: SpriteData[] = [];

  // Visibility states
  private visible: boolean = true;
  private ceilingVisible: boolean = true;
  private groundVisible: boolean = true;
  private atmosphericVisible: boolean = true;
  private moistureVisible: boolean = true;
  private ionizationVisible: boolean = true;

  // Coordinate transform
  private transform: CoordinateTransform | null = null;

  constructor(scene: THREE.Scene, options: AtmosphereRendererOptions = {}) {
    this.scene = scene;
    this.options = {
      planeSize: options.planeSize ?? 1.0,
      ceilingColor: options.ceilingColor ?? new THREE.Color(0.7, 0.85, 1.0),
      groundColor: options.groundColor ?? new THREE.Color(0.9, 0.7, 0.5),
      atmosphericColor: options.atmosphericColor ?? new THREE.Color(0.85, 0.95, 1.0),
      moistureColor: options.moistureColor ?? new THREE.Color(0.6, 0.8, 0.95),
      ionizationColor: options.ionizationColor ?? new THREE.Color(1.0, 1.0, 0.9),
      opacity: options.opacity ?? 0.2,
    };
  }

  /**
   * Initialize rendering objects from a simulator.
   */
  initialize(simulator: AtmosphereSimulator, worldStart: Vec3, worldEnd: Vec3): void {
    // Dispose existing
    this.dispose();

    // Create coordinate transform
    this.transform = new CoordinateTransform(worldStart, worldEnd);

    // Create ceiling sprites (flat, lying horizontal)
    this.ceilingSprites = this.createSprites(
      simulator.ceilingCharge,
      this.options.ceilingColor,
      this.options.opacity,
      1,
      true
    );

    // Create ground sprites (flat, lying horizontal)
    this.groundSprites = this.createSprites(
      simulator.groundCharge,
      this.options.groundColor,
      this.options.opacity,
      1,
      true
    );

    // Create 3D sprites
    this.atmosphericSprites = this.createSprites(
      simulator.atmosphericCharge,
      this.options.atmosphericColor,
      this.options.opacity * 0.9
    );

    this.moistureSprites = this.createSprites(
      simulator.moisture,
      this.options.moistureColor,
      this.options.opacity * 1.2
    );

    this.ionizationSprites = this.createSprites(
      simulator.ionizationSeeds,
      this.options.ionizationColor,
      this.options.opacity * 3.0,
      8
    );

    this.updateVisibility();
  }

  /**
   * Update rendering from simulator state. Call each frame.
   */
  updateFromSimulator(simulator: AtmosphereSimulator): void {
    // Update all sprite positions and intensities
    this.updateSprites(this.ceilingSprites, simulator.ceilingCharge);
    this.updateSprites(this.groundSprites, simulator.groundCharge);
    this.updateSprites(this.atmosphericSprites, simulator.atmosphericCharge);
    this.updateSprites(this.moistureSprites, simulator.moisture);
    this.updateSprites(this.ionizationSprites, simulator.ionizationSeeds, 8);
  }

  // ============ Visibility Controls ============

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.updateVisibility();
  }

  isVisible(): boolean {
    return this.visible;
  }

  setCeilingVisible(visible: boolean): void {
    this.ceilingVisible = visible;
    for (const sprite of this.ceilingSprites) {
      sprite.mesh.visible = this.visible && visible;
    }
  }

  setGroundVisible(visible: boolean): void {
    this.groundVisible = visible;
    for (const sprite of this.groundSprites) {
      sprite.mesh.visible = this.visible && visible;
    }
  }

  setAtmosphericVisible(visible: boolean): void {
    this.atmosphericVisible = visible;
    for (const sprite of this.atmosphericSprites) {
      sprite.mesh.visible = this.visible && visible;
    }
  }

  isAtmosphericVisible(): boolean {
    return this.atmosphericVisible;
  }

  setMoistureVisible(visible: boolean): void {
    this.moistureVisible = visible;
    for (const sprite of this.moistureSprites) {
      sprite.mesh.visible = this.visible && visible;
    }
  }

  isMoistureVisible(): boolean {
    return this.moistureVisible;
  }

  setIonizationVisible(visible: boolean): void {
    this.ionizationVisible = visible;
    for (const sprite of this.ionizationSprites) {
      sprite.mesh.visible = this.visible && visible;
    }
  }

  isIonizationVisible(): boolean {
    return this.ionizationVisible;
  }

  // ============ Private Methods ============

  private updateVisibility(): void {
    for (const sprite of this.ceilingSprites) {
      sprite.mesh.visible = this.visible && this.ceilingVisible;
    }
    for (const sprite of this.groundSprites) {
      sprite.mesh.visible = this.visible && this.groundVisible;
    }
    for (const sprite of this.atmosphericSprites) {
      sprite.mesh.visible = this.visible && this.atmosphericVisible;
    }
    for (const sprite of this.moistureSprites) {
      sprite.mesh.visible = this.visible && this.moistureVisible;
    }
    for (const sprite of this.ionizationSprites) {
      sprite.mesh.visible = this.visible && this.ionizationVisible;
    }
  }

  private createSprites(
    field: VoronoiField,
    color: THREE.Color,
    opacity: number,
    sizeMultiplier: number = 1,
    flat: boolean = false
  ): SpriteData[] {
    const sprites: SpriteData[] = [];
    const cells = field.cells.slice(0, MAX_CELLS);

    for (const cell of cells) {
      // Scale size by world scale
      const worldScale = this.transform?.worldScale ?? 1;
      const size = cell.falloffRadius * 2 * sizeMultiplier * worldScale;
      const geometry = new THREE.PlaneGeometry(size, size);

      // For flat sprites (ceiling/ground), rotate geometry to lie horizontal
      if (flat) {
        geometry.rotateX(-Math.PI / 2);
      }

      const material = new THREE.ShaderMaterial({
        vertexShader: spriteVertexShader,
        fragmentShader: spriteFragmentShader,
        uniforms: {
          baseColor: { value: color },
          intensity: { value: cell.intensity },
          opacity: { value: opacity },
        },
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });

      const mesh = new THREE.Mesh(geometry, material);

      // Transform from normalized to world space
      const worldPos = this.transform
        ? this.transform.toWorld(cell.center)
        : cell.center;
      mesh.position.set(worldPos.x, worldPos.y, worldPos.z);

      // Billboard only for non-flat sprites (3D atmospheric fields)
      if (!flat) {
        mesh.onBeforeRender = (_renderer, _scene, camera) => {
          mesh.quaternion.copy(camera.quaternion);
        };
      }

      this.scene.add(mesh);
      sprites.push({ mesh, material });
    }

    return sprites;
  }

  private updateSprites(sprites: SpriteData[], field: VoronoiField, _sizeMultiplier: number = 1): void {
    const cells = field.cells.slice(0, MAX_CELLS);

    for (let i = 0; i < sprites.length && i < cells.length; i++) {
      const sprite = sprites[i];
      const cell = cells[i];

      // Transform from normalized to world space
      const worldPos = this.transform
        ? this.transform.toWorld(cell.center)
        : cell.center;
      sprite.mesh.position.set(worldPos.x, worldPos.y, worldPos.z);

      // Update intensity uniform
      sprite.material.uniforms.intensity.value = cell.intensity;
    }
  }

  private disposeSprites(sprites: SpriteData[]): void {
    for (const sprite of sprites) {
      this.scene.remove(sprite.mesh);
      sprite.mesh.geometry.dispose();
      sprite.material.dispose();
    }
  }

  dispose(): void {
    this.disposeSprites(this.ceilingSprites);
    this.ceilingSprites = [];

    this.disposeSprites(this.groundSprites);
    this.groundSprites = [];

    this.disposeSprites(this.atmosphericSprites);
    this.atmosphericSprites = [];

    this.disposeSprites(this.moistureSprites);
    this.moistureSprites = [];

    this.disposeSprites(this.ionizationSprites);
    this.ionizationSprites = [];
  }
}
