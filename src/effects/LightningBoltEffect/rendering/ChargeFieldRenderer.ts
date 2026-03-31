import * as THREE from 'three';
import { AtmosphericModelData, VoronoiFieldData, Vec3 } from '../simulation/types';
import { CoordinateTransform } from '../CoordinateTransform';
import { AtmosphereSimulator } from '../simulation/AtmosphereSimulator';
import { VoronoiField } from '../simulation/VoronoiField';
import { AtmosphereSnapshot } from '../simulation/SimulationTimeline';
import {
  chargeFieldVertexShader,
  chargeFieldFragmentShader,
  MAX_CELLS,
} from './shaders/chargeFieldShaders';

type FieldType = VoronoiField | VoronoiFieldData;

export interface ChargeFieldRenderOptions {
  planeSize?: number;
  ceilingColor?: THREE.Color;
  groundColor?: THREE.Color;
  atmosphericColor?: THREE.Color;
  moistureColor?: THREE.Color;
  ionizationColor?: THREE.Color;
  opacity?: number;
}

interface FieldPlane {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
}

export class ChargeFieldRenderer {
  private scene: THREE.Scene;
  private options: Required<ChargeFieldRenderOptions>;
  private transform: CoordinateTransform | null = null;

  // All fields rendered as flat horizontal metaball planes
  private ceilingPlane: FieldPlane | null = null;
  private groundPlane: FieldPlane | null = null;
  private atmosphericPlane: FieldPlane | null = null;
  private moisturePlane: FieldPlane | null = null;
  private ionizationPlane: FieldPlane | null = null;

  // Visibility states
  private visible: boolean = true;
  private ceilingVisible: boolean = true;
  private groundVisible: boolean = true;
  private atmosphericVisible: boolean = true;
  private moistureVisible: boolean = true;
  private ionizationVisible: boolean = true;

  // World Y bounds
  private worldCeilingY: number = 0;
  private worldGroundY: number = 0;

  // Wind parameters
  private windDir: THREE.Vector2 = new THREE.Vector2(1, 0);
  private windSpeed: number = 0;

  constructor(scene: THREE.Scene, options: ChargeFieldRenderOptions = {}) {
    this.scene = scene;
    this.options = {
      planeSize: options.planeSize ?? 1.0,
      ceilingColor: options.ceilingColor ?? new THREE.Color(0.7, 0.85, 1.0),
      groundColor: options.groundColor ?? new THREE.Color(0.5, 0.55, 0.65),
      atmosphericColor: options.atmosphericColor ?? new THREE.Color(0.85, 0.95, 1.0),
      moistureColor: options.moistureColor ?? new THREE.Color(0.6, 0.8, 0.95),
      ionizationColor: options.ionizationColor ?? new THREE.Color(1.0, 1.0, 0.9),
      opacity: options.opacity ?? 0.2,
    };
  }

  setWindParameters(direction: THREE.Vector2, speed: number): void {
    this.windDir.copy(direction).normalize();
    this.windSpeed = speed / 60; // Normalize to 0-1 range from 0-60 kts

    const planes = [
      this.ceilingPlane, this.groundPlane,
      this.atmosphericPlane, this.moisturePlane, this.ionizationPlane,
    ];
    for (const plane of planes) {
      if (plane) {
        plane.material.uniforms.windDir.value.copy(this.windDir);
        plane.material.uniforms.windSpeed.value = this.windSpeed;
      }
    }
  }

  setChargeField(
    atmosphere: AtmosphericModelData,
    worldStart: Vec3,
    worldEnd: Vec3,
    transform?: CoordinateTransform
  ): void {
    this.dispose();

    this.transform = transform ?? new CoordinateTransform(worldStart, worldEnd);
    this.worldCeilingY = worldStart.y;
    this.worldGroundY = worldEnd.y;

    // Create ceiling plane (flat, horizontal)
    this.ceilingPlane = this.createFieldPlane(
      atmosphere.ceilingCharge,
      this.options.ceilingColor,
      this.options.opacity,
      this.worldCeilingY,
      true
    );

    // Create ground plane (flat, horizontal)
    this.groundPlane = this.createFieldPlane(
      atmosphere.groundCharge,
      this.options.groundColor,
      this.options.opacity,
      this.worldGroundY,
      true
    );

    const height = this.worldCeilingY - this.worldGroundY;

    // Atmospheric charge plane at upper-mid atmosphere
    if (atmosphere.atmosphericCharge) {
      this.atmosphericPlane = this.createFieldPlane(
        atmosphere.atmosphericCharge,
        this.options.atmosphericColor,
        this.options.opacity * 3.0,
        this.worldGroundY + height * 0.55,
        true
      );
    }

    // Moisture plane at mid-lower atmosphere
    if (atmosphere.moisture) {
      this.moisturePlane = this.createFieldPlane(
        atmosphere.moisture,
        this.options.moistureColor,
        this.options.opacity * 3.5,
        this.worldGroundY + height * 0.4,
        true
      );
    }

    // Ionization plane at mid atmosphere
    if (atmosphere.ionizationSeeds) {
      this.ionizationPlane = this.createFieldPlane(
        atmosphere.ionizationSeeds,
        this.options.ionizationColor,
        this.options.opacity * 3.0,
        this.worldGroundY + height * 0.5,
        true
      );
    }

    this.updateVisibility();
  }

  initialize(simulator: AtmosphereSimulator, worldStart: Vec3, worldEnd: Vec3): void {
    this.dispose();

    this.transform = new CoordinateTransform(worldStart, worldEnd);
    this.worldCeilingY = worldStart.y;
    this.worldGroundY = worldEnd.y;

    this.ceilingPlane = this.createFieldPlane(
      simulator.ceilingCharge,
      this.options.ceilingColor,
      this.options.opacity,
      this.worldCeilingY,
      true
    );

    this.groundPlane = this.createFieldPlane(
      simulator.groundCharge,
      this.options.groundColor,
      this.options.opacity,
      this.worldGroundY,
      true
    );

    const height = this.worldCeilingY - this.worldGroundY;

    this.atmosphericPlane = this.createFieldPlane(
      simulator.atmosphericCharge,
      this.options.atmosphericColor,
      this.options.opacity * 1.5,
      this.worldGroundY + height * 0.55,
      true
    );

    this.moisturePlane = this.createFieldPlane(
      simulator.moisture,
      this.options.moistureColor,
      this.options.opacity * 1.8,
      this.worldGroundY + height * 0.4,
      true
    );

    this.ionizationPlane = this.createFieldPlane(
      simulator.ionizationSeeds,
      this.options.ionizationColor,
      this.options.opacity * 1.5,
      this.worldGroundY + height * 0.5,
      true
    );

    this.updateVisibility();
  }

  updateFromSimulator(simulator: AtmosphereSimulator): void {
    this.updateFieldPlane(this.ceilingPlane, simulator.ceilingCharge);
    this.updateFieldPlane(this.groundPlane, simulator.groundCharge);
    this.updateFieldPlane(this.atmosphericPlane, simulator.atmosphericCharge);
    this.updateFieldPlane(this.moisturePlane, simulator.moisture);
    this.updateFieldPlane(this.ionizationPlane, simulator.ionizationSeeds);
  }

  updateFromSnapshot(snapshot: AtmosphereSnapshot): void {
    this.updateFieldPlane(this.ceilingPlane, snapshot.ceilingCharge);
    this.updateFieldPlane(this.groundPlane, snapshot.groundCharge);
    this.updateFieldPlane(this.atmosphericPlane, snapshot.atmosphericCharge);
    this.updateFieldPlane(this.moisturePlane, snapshot.moisture);
    this.updateFieldPlane(this.ionizationPlane, snapshot.ionizationSeeds);
  }

  initializeFromSnapshot(
    snapshot: AtmosphereSnapshot,
    worldStart: Vec3,
    worldEnd: Vec3
  ): void {
    this.dispose();

    this.transform = new CoordinateTransform(worldStart, worldEnd);
    this.worldCeilingY = worldStart.y;
    this.worldGroundY = worldEnd.y;

    this.ceilingPlane = this.createFieldPlane(
      snapshot.ceilingCharge,
      this.options.ceilingColor,
      this.options.opacity,
      this.worldCeilingY,
      true
    );

    this.groundPlane = this.createFieldPlane(
      snapshot.groundCharge,
      this.options.groundColor,
      this.options.opacity,
      this.worldGroundY,
      true
    );

    const height = this.worldCeilingY - this.worldGroundY;

    this.atmosphericPlane = this.createFieldPlane(
      snapshot.atmosphericCharge,
      this.options.atmosphericColor,
      this.options.opacity * 1.5,
      this.worldGroundY + height * 0.55,
      true
    );

    this.moisturePlane = this.createFieldPlane(
      snapshot.moisture,
      this.options.moistureColor,
      this.options.opacity * 1.8,
      this.worldGroundY + height * 0.4,
      true
    );

    this.ionizationPlane = this.createFieldPlane(
      snapshot.ionizationSeeds,
      this.options.ionizationColor,
      this.options.opacity * 1.5,
      this.worldGroundY + height * 0.5,
      true
    );

    this.updateVisibility();
  }

  private createFieldPlane(
    field: FieldType,
    color: THREE.Color,
    opacity: number,
    yPosition: number,
    flat: boolean
  ): FieldPlane {
    const worldScale = this.transform?.worldScale ?? 1;
    const planeSize = worldScale * 2.5;

    const geometry = new THREE.PlaneGeometry(planeSize, planeSize);
    if (flat) {
      geometry.rotateX(-Math.PI / 2);
    }

    // Prepare cell data arrays
    const cells = field.cells.slice(0, MAX_CELLS);
    const cellCenters: THREE.Vector2[] = [];
    const cellIntensities: number[] = [];
    const cellRadii: number[] = [];

    for (const cell of cells) {
      const worldPos = this.transform
        ? this.transform.toWorld(cell.center)
        : cell.center;
      cellCenters.push(new THREE.Vector2(worldPos.x, worldPos.z));
      cellIntensities.push(cell.intensity);
      cellRadii.push(cell.falloffRadius * worldScale);
    }

    // Pad arrays to MAX_CELLS
    while (cellCenters.length < MAX_CELLS) {
      cellCenters.push(new THREE.Vector2(0, 0));
      cellIntensities.push(0);
      cellRadii.push(0);
    }

    const material = new THREE.ShaderMaterial({
      vertexShader: chargeFieldVertexShader,
      fragmentShader: chargeFieldFragmentShader,
      uniforms: {
        cellCenters: { value: cellCenters },
        cellIntensities: { value: cellIntensities },
        cellRadii: { value: cellRadii },
        cellCount: { value: cells.length },
        baseColor: { value: color },
        opacity: { value: opacity },
        windDir: { value: this.windDir.clone() },
        windSpeed: { value: this.windSpeed },
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const mesh = new THREE.Mesh(geometry, material);

    // Position at the correct Y level
    const worldCenter = this.transform
      ? this.transform.toWorld({ x: 0, y: 0, z: 0 })
      : { x: 0, y: 0, z: 0 };
    mesh.position.set(worldCenter.x, yPosition, worldCenter.z);

    this.scene.add(mesh);

    return { mesh, material };
  }

  private updateFieldPlane(plane: FieldPlane | null, field: FieldType): void {
    if (!plane) return;

    const cells = field.cells.slice(0, MAX_CELLS);
    const worldScale = this.transform?.worldScale ?? 1;

    const cellCenters = plane.material.uniforms.cellCenters.value as THREE.Vector2[];
    const cellIntensities = plane.material.uniforms.cellIntensities.value as number[];
    const cellRadii = plane.material.uniforms.cellRadii.value as number[];

    for (let i = 0; i < MAX_CELLS; i++) {
      if (i < cells.length) {
        const cell = cells[i];
        const worldPos = this.transform
          ? this.transform.toWorld(cell.center)
          : cell.center;
        cellCenters[i].set(worldPos.x, worldPos.z);
        cellIntensities[i] = cell.intensity;
        cellRadii[i] = cell.falloffRadius * worldScale;
      } else {
        cellCenters[i].set(0, 0);
        cellIntensities[i] = 0;
        cellRadii[i] = 0;
      }
    }

    plane.material.uniforms.cellCount.value = cells.length;
    plane.material.uniformsNeedUpdate = true;
  }

  private updateVisibility(): void {
    if (this.ceilingPlane) {
      this.ceilingPlane.mesh.visible = this.visible && this.ceilingVisible;
    }
    if (this.groundPlane) {
      this.groundPlane.mesh.visible = this.visible && this.groundVisible;
    }
    if (this.atmosphericPlane) {
      this.atmosphericPlane.mesh.visible = this.visible && this.atmosphericVisible;
    }
    if (this.moisturePlane) {
      this.moisturePlane.mesh.visible = this.visible && this.moistureVisible;
    }
    if (this.ionizationPlane) {
      this.ionizationPlane.mesh.visible = this.visible && this.ionizationVisible;
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.updateVisibility();
  }

  isVisible(): boolean {
    return this.visible;
  }

  setCeilingVisible(visible: boolean): void {
    this.ceilingVisible = visible;
    if (this.ceilingPlane) {
      this.ceilingPlane.mesh.visible = this.visible && visible;
    }
  }

  setGroundVisible(visible: boolean): void {
    this.groundVisible = visible;
    if (this.groundPlane) {
      this.groundPlane.mesh.visible = this.visible && visible;
    }
  }

  setAtmosphericVisible(visible: boolean): void {
    this.atmosphericVisible = visible;
    if (this.atmosphericPlane) {
      this.atmosphericPlane.mesh.visible = this.visible && visible;
    }
  }

  isAtmosphericVisible(): boolean {
    return this.atmosphericVisible;
  }

  setMoistureVisible(visible: boolean): void {
    this.moistureVisible = visible;
    if (this.moisturePlane) {
      this.moisturePlane.mesh.visible = this.visible && visible;
    }
  }

  isMoistureVisible(): boolean {
    return this.moistureVisible;
  }

  setIonizationVisible(visible: boolean): void {
    this.ionizationVisible = visible;
    if (this.ionizationPlane) {
      this.ionizationPlane.mesh.visible = this.visible && visible;
    }
  }

  isIonizationVisible(): boolean {
    return this.ionizationVisible;
  }

  private disposeFieldPlane(plane: FieldPlane | null): void {
    if (!plane) return;
    this.scene.remove(plane.mesh);
    plane.mesh.geometry.dispose();
    plane.material.dispose();
  }

  /** No-op: volumetric rendering removed in favor of flat planes. */
  renderVolumetrics(_renderer: THREE.WebGLRenderer, _camera: THREE.Camera): void {}

  /** Always false: volumetric rendering removed. */
  isLowResEnabled(): boolean {
    return false;
  }

  dispose(): void {
    this.disposeFieldPlane(this.ceilingPlane);
    this.ceilingPlane = null;

    this.disposeFieldPlane(this.groundPlane);
    this.groundPlane = null;

    this.disposeFieldPlane(this.atmosphericPlane);
    this.atmosphericPlane = null;

    this.disposeFieldPlane(this.moisturePlane);
    this.moisturePlane = null;

    this.disposeFieldPlane(this.ionizationPlane);
    this.ionizationPlane = null;
  }
}
