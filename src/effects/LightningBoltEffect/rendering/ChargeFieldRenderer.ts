import * as THREE from 'three';
import { AtmosphericModelData, VoronoiFieldData, VoronoiCellData, Vec3 } from '../simulation/types';

const MAX_CELLS = 16;

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

export interface ChargeFieldRenderOptions {
  planeSize?: number;
  ceilingColor?: THREE.Color;
  groundColor?: THREE.Color;
  opacity?: number;
}

export class ChargeFieldRenderer {
  private scene: THREE.Scene;
  private ceilingPlane: THREE.Mesh | null = null;
  private groundPlane: THREE.Mesh | null = null;
  private ceilingMaterial: THREE.ShaderMaterial | null = null;
  private groundMaterial: THREE.ShaderMaterial | null = null;
  private visible: boolean = true;
  private options: Required<ChargeFieldRenderOptions>;

  constructor(scene: THREE.Scene, options: ChargeFieldRenderOptions = {}) {
    this.scene = scene;
    this.options = {
      planeSize: options.planeSize ?? 1.0,
      ceilingColor: options.ceilingColor ?? new THREE.Color(0.7, 0.85, 1.0),
      groundColor: options.groundColor ?? new THREE.Color(0.9, 0.7, 0.5),
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

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.ceilingPlane) this.ceilingPlane.visible = visible;
    if (this.groundPlane) this.groundPlane.visible = visible;
  }

  isVisible(): boolean {
    return this.visible;
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
  }
}
