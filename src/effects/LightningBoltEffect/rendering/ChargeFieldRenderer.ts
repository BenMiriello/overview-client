import * as THREE from 'three';
import { AtmosphericModelData, VoronoiFieldData, VoronoiCellData, Vec3 } from '../simulation/types';

const MAX_CELLS = 16;

// Vertex shader for 2D charge planes
const chargeVertexShader = `
varying vec2 vPosition;

void main() {
  vPosition = position.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const chargeFragmentShader = `
uniform vec3 cellCenters[${MAX_CELLS}];
uniform float cellIntensities[${MAX_CELLS}];
uniform float cellRadii[${MAX_CELLS}];
uniform int cellCount;
uniform vec3 baseColor;
uniform float opacity;

varying vec2 vPosition;

float getChargeValue(vec2 pos) {
  float value = 0.0;
  for (int i = 0; i < ${MAX_CELLS}; i++) {
    if (i >= cellCount) break;
    float dist = distance(pos, cellCenters[i].xz);
    if (dist < cellRadii[i]) {
      float t = dist / cellRadii[i];
      float falloff = (cos(t * 3.14159) + 1.0) * 0.5;
      value += cellIntensities[i] * falloff;
    }
  }
  return clamp(value, 0.0, 1.5);
}

void main() {
  float intensity = getChargeValue(vPosition);
  gl_FragColor = vec4(baseColor, intensity * opacity);
}
`;

// Vertex shader for 3D atmospheric charge sprites (billboarded)
const atmosphericVertexShader = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Fragment shader for 3D atmospheric charge sprites
const atmosphericFragmentShader = `
uniform vec3 baseColor;
uniform float intensity;
uniform float opacity;

varying vec2 vUv;

void main() {
  // Radial distance from center (0 at center, 1 at edge)
  vec2 centered = vUv - 0.5;
  float dist = length(centered) * 2.0;

  if (dist > 1.0) {
    discard;
  }

  // Cosine falloff matching Voronoi field
  float falloff = (cos(dist * 3.14159) + 1.0) * 0.5;
  float alpha = intensity * falloff * opacity;

  gl_FragColor = vec4(baseColor, alpha);
}
`;

export interface ChargeFieldRenderOptions {
  planeSize?: number;
  ceilingColor?: THREE.Color;
  groundColor?: THREE.Color;
  atmosphericColor?: THREE.Color;
  moistureColor?: THREE.Color;
  ionizationColor?: THREE.Color;
  opacity?: number;
}

export class ChargeFieldRenderer {
  private scene: THREE.Scene;
  private ceilingPlane: THREE.Mesh | null = null;
  private groundPlane: THREE.Mesh | null = null;
  private ceilingMaterial: THREE.ShaderMaterial | null = null;
  private groundMaterial: THREE.ShaderMaterial | null = null;
  private atmosphericSprites: THREE.Mesh[] = [];
  private atmosphericMaterials: THREE.ShaderMaterial[] = [];
  private moistureSprites: THREE.Mesh[] = [];
  private moistureMaterials: THREE.ShaderMaterial[] = [];
  private ionizationSprites: THREE.Mesh[] = [];
  private ionizationMaterials: THREE.ShaderMaterial[] = [];
  private visible: boolean = true;
  private atmosphericVisible: boolean = true;
  private moistureVisible: boolean = true;
  private ionizationVisible: boolean = true;
  private options: Required<ChargeFieldRenderOptions>;

  constructor(scene: THREE.Scene, options: ChargeFieldRenderOptions = {}) {
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

  setChargeField(
    atmosphere: AtmosphericModelData,
    worldStart: Vec3,
    worldEnd: Vec3
  ): void {
    this.dispose();

    const worldMidX = (worldStart.x + worldEnd.x) / 2;
    const worldMidZ = (worldStart.z + worldEnd.z) / 2;

    // Create ceiling plane
    this.ceilingMaterial = this.createMaterial(
      atmosphere.ceilingCharge,
      this.options.ceilingColor
    );
    this.ceilingPlane = this.createPlane(
      this.ceilingMaterial,
      worldMidX,
      worldStart.y,
      worldMidZ
    );
    this.scene.add(this.ceilingPlane);

    // Create ground plane
    this.groundMaterial = this.createMaterial(
      atmosphere.groundCharge,
      this.options.groundColor
    );
    this.groundPlane = this.createPlane(
      this.groundMaterial,
      worldMidX,
      worldEnd.y,
      worldMidZ
    );
    this.scene.add(this.groundPlane);

    // Create atmospheric charge sprites (3D)
    if (atmosphere.atmosphericCharge) {
      this.createAtmosphericSprites(atmosphere.atmosphericCharge);
    }

    // Create moisture sprites (3D)
    if (atmosphere.moisture) {
      this.createMoistureSprites(atmosphere.moisture);
    }

    // Create ionization seed sprites (3D)
    if (atmosphere.ionizationSeeds) {
      this.createIonizationSprites(atmosphere.ionizationSeeds);
    }
  }

  private createMaterial(
    field: VoronoiFieldData,
    color: THREE.Color
  ): THREE.ShaderMaterial {
    const cells = field.cells.slice(0, MAX_CELLS);

    const cellCenters = new Array(MAX_CELLS)
      .fill(null)
      .map(() => new THREE.Vector3());
    const cellIntensities = new Array(MAX_CELLS).fill(0);
    const cellRadii = new Array(MAX_CELLS).fill(0);

    cells.forEach((cell: VoronoiCellData, i: number) => {
      cellCenters[i].set(cell.center.x, cell.center.y, cell.center.z);
      cellIntensities[i] = cell.intensity;
      cellRadii[i] = cell.falloffRadius;
    });

    return new THREE.ShaderMaterial({
      vertexShader: chargeVertexShader,
      fragmentShader: chargeFragmentShader,
      uniforms: {
        cellCenters: { value: cellCenters },
        cellIntensities: { value: cellIntensities },
        cellRadii: { value: cellRadii },
        cellCount: { value: cells.length },
        baseColor: { value: color },
        opacity: { value: this.options.opacity },
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
  }

  private createPlane(
    material: THREE.ShaderMaterial,
    x: number,
    y: number,
    z: number
  ): THREE.Mesh {
    const geometry = new THREE.PlaneGeometry(
      this.options.planeSize,
      this.options.planeSize,
      32,
      32
    );
    geometry.rotateX(-Math.PI / 2);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.visible = this.visible;

    return mesh;
  }

  private createAtmosphericSprites(field: VoronoiFieldData): void {
    const cells = field.cells.slice(0, MAX_CELLS);

    for (const cell of cells) {
      const size = cell.falloffRadius * 2;
      const geometry = new THREE.PlaneGeometry(size, size);

      const material = new THREE.ShaderMaterial({
        vertexShader: atmosphericVertexShader,
        fragmentShader: atmosphericFragmentShader,
        uniforms: {
          baseColor: { value: this.options.atmosphericColor },
          intensity: { value: cell.intensity },
          opacity: { value: this.options.opacity * 1.5 },
        },
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });

      const sprite = new THREE.Mesh(geometry, material);
      sprite.position.set(cell.center.x, cell.center.y, cell.center.z);
      sprite.visible = this.visible && this.atmosphericVisible;

      // Make sprite face camera (billboarding done via onBeforeRender)
      sprite.onBeforeRender = (renderer, scene, camera) => {
        sprite.quaternion.copy(camera.quaternion);
      };

      this.atmosphericSprites.push(sprite);
      this.atmosphericMaterials.push(material);
      this.scene.add(sprite);
    }
  }

  private createMoistureSprites(field: VoronoiFieldData): void {
    const cells = field.cells.slice(0, MAX_CELLS);

    for (const cell of cells) {
      const size = cell.falloffRadius * 2;
      const geometry = new THREE.PlaneGeometry(size, size);

      const material = new THREE.ShaderMaterial({
        vertexShader: atmosphericVertexShader,
        fragmentShader: atmosphericFragmentShader,
        uniforms: {
          baseColor: { value: this.options.moistureColor },
          intensity: { value: cell.intensity },
          opacity: { value: this.options.opacity * 1.2 },
        },
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });

      const sprite = new THREE.Mesh(geometry, material);
      sprite.position.set(cell.center.x, cell.center.y, cell.center.z);
      sprite.visible = this.visible && this.moistureVisible;

      sprite.onBeforeRender = (renderer, scene, camera) => {
        sprite.quaternion.copy(camera.quaternion);
      };

      this.moistureSprites.push(sprite);
      this.moistureMaterials.push(material);
      this.scene.add(sprite);
    }
  }

  private createIonizationSprites(field: VoronoiFieldData): void {
    const cells = field.cells.slice(0, MAX_CELLS);

    for (const cell of cells) {
      // Ionization seeds are small but we scale up for visibility
      const size = Math.max(cell.falloffRadius * 8, 0.02);
      const geometry = new THREE.PlaneGeometry(size, size);

      const material = new THREE.ShaderMaterial({
        vertexShader: atmosphericVertexShader,
        fragmentShader: atmosphericFragmentShader,
        uniforms: {
          baseColor: { value: this.options.ionizationColor },
          intensity: { value: cell.intensity },
          opacity: { value: this.options.opacity * 3.0 },
        },
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });

      const sprite = new THREE.Mesh(geometry, material);
      sprite.position.set(cell.center.x, cell.center.y, cell.center.z);
      sprite.visible = this.visible && this.ionizationVisible;

      sprite.onBeforeRender = (renderer, scene, camera) => {
        sprite.quaternion.copy(camera.quaternion);
      };

      this.ionizationSprites.push(sprite);
      this.ionizationMaterials.push(material);
      this.scene.add(sprite);
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.ceilingPlane) this.ceilingPlane.visible = visible;
    if (this.groundPlane) this.groundPlane.visible = visible;
    for (const sprite of this.atmosphericSprites) {
      sprite.visible = visible && this.atmosphericVisible;
    }
    for (const sprite of this.moistureSprites) {
      sprite.visible = visible && this.moistureVisible;
    }
    for (const sprite of this.ionizationSprites) {
      sprite.visible = visible && this.ionizationVisible;
    }
  }

  isVisible(): boolean {
    return this.visible;
  }

  setAtmosphericVisible(visible: boolean): void {
    this.atmosphericVisible = visible;
    for (const sprite of this.atmosphericSprites) {
      sprite.visible = this.visible && visible;
    }
  }

  isAtmosphericVisible(): boolean {
    return this.atmosphericVisible;
  }

  setMoistureVisible(visible: boolean): void {
    this.moistureVisible = visible;
    for (const sprite of this.moistureSprites) {
      sprite.visible = this.visible && visible;
    }
  }

  isMoistureVisible(): boolean {
    return this.moistureVisible;
  }

  setIonizationVisible(visible: boolean): void {
    this.ionizationVisible = visible;
    for (const sprite of this.ionizationSprites) {
      sprite.visible = this.visible && visible;
    }
  }

  isIonizationVisible(): boolean {
    return this.ionizationVisible;
  }

  dispose(): void {
    if (this.ceilingPlane) {
      this.scene.remove(this.ceilingPlane);
      this.ceilingPlane.geometry.dispose();
      this.ceilingPlane = null;
    }
    if (this.groundPlane) {
      this.scene.remove(this.groundPlane);
      this.groundPlane.geometry.dispose();
      this.groundPlane = null;
    }
    if (this.ceilingMaterial) {
      this.ceilingMaterial.dispose();
      this.ceilingMaterial = null;
    }
    if (this.groundMaterial) {
      this.groundMaterial.dispose();
      this.groundMaterial = null;
    }
    for (const sprite of this.atmosphericSprites) {
      this.scene.remove(sprite);
      sprite.geometry.dispose();
    }
    for (const material of this.atmosphericMaterials) {
      material.dispose();
    }
    this.atmosphericSprites = [];
    this.atmosphericMaterials = [];

    for (const sprite of this.moistureSprites) {
      this.scene.remove(sprite);
      sprite.geometry.dispose();
    }
    for (const material of this.moistureMaterials) {
      material.dispose();
    }
    this.moistureSprites = [];
    this.moistureMaterials = [];

    for (const sprite of this.ionizationSprites) {
      this.scene.remove(sprite);
      sprite.geometry.dispose();
    }
    for (const material of this.ionizationMaterials) {
      material.dispose();
    }
    this.ionizationSprites = [];
    this.ionizationMaterials = [];
  }
}
