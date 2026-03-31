import * as THREE from 'three';
import { AtmosphericModelData, VoronoiFieldData, Vec3 } from '../simulation/types';
import { CoordinateTransform } from '../CoordinateTransform';
import { AtmosphereSimulator } from '../simulation/AtmosphereSimulator';
import { VoronoiField } from '../simulation/VoronoiField';
import { AtmosphereSnapshot } from '../simulation/SimulationTimeline';
import {
  chargeFieldVertexShader,
  chargeFieldFragmentShader,
  sphereImpostorVertexShader,
  sphereImpostorFragmentShader,
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

interface SphereImpostor {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
}

export class ChargeFieldRenderer {
  private scene: THREE.Scene;
  private options: Required<ChargeFieldRenderOptions>;
  private transform: CoordinateTransform | null = null;

  // Ceiling/Ground/Atmospheric: flat horizontal metaball planes
  private ceilingPlane: FieldPlane | null = null;
  private groundPlane: FieldPlane | null = null;
  private atmosphericPlane: FieldPlane | null = null;

  // Moisture/Ionization: per-cell sphere impostors (billboard quads)
  private moistureImpostors: SphereImpostor[] = [];
  private ionizationImpostors: SphereImpostor[] = [];

  // Light direction for sphere impostors
  private lightDir: THREE.Vector3 = new THREE.Vector3(0.3, 0.8, 0.5).normalize();

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
    this.windSpeed = speed / 60;

    const planes = [this.ceilingPlane, this.groundPlane, this.atmosphericPlane];
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

    this.ceilingPlane = this.createFieldPlane(
      atmosphere.ceilingCharge,
      this.options.ceilingColor,
      this.options.opacity,
      this.worldCeilingY
    );

    this.groundPlane = this.createFieldPlane(
      atmosphere.groundCharge,
      this.options.groundColor,
      this.options.opacity,
      this.worldGroundY
    );

    const height = this.worldCeilingY - this.worldGroundY;

    // Atmospheric charge: horizontal metaball just below cloud layer
    if (atmosphere.atmosphericCharge) {
      this.atmosphericPlane = this.createFieldPlane(
        atmosphere.atmosphericCharge,
        this.options.atmosphericColor,
        this.options.opacity * 1.5,
        this.worldCeilingY - height * 0.15
      );
    }

    // Moisture: 3D sphere impostors
    if (atmosphere.moisture) {
      this.moistureImpostors = this.createSphereImpostors(
        atmosphere.moisture,
        this.options.moistureColor,
        this.options.opacity * 4.0,
        this.worldGroundY + height * 0.05,
        this.worldCeilingY - height * 0.2
      );
    }

    // Ionization: 3D sphere impostors (smaller, brighter)
    if (atmosphere.ionizationSeeds) {
      this.ionizationImpostors = this.createSphereImpostors(
        atmosphere.ionizationSeeds,
        this.options.ionizationColor,
        this.options.opacity * 5.0,
        this.worldGroundY + height * 0.1,
        this.worldCeilingY - height * 0.1
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
      this.worldCeilingY
    );

    this.groundPlane = this.createFieldPlane(
      simulator.groundCharge,
      this.options.groundColor,
      this.options.opacity,
      this.worldGroundY
    );

    const height = this.worldCeilingY - this.worldGroundY;

    this.atmosphericPlane = this.createFieldPlane(
      simulator.atmosphericCharge,
      this.options.atmosphericColor,
      this.options.opacity * 1.5,
      this.worldCeilingY - height * 0.15
    );

    this.moistureImpostors = this.createSphereImpostors(
      simulator.moisture,
      this.options.moistureColor,
      this.options.opacity * 4.0,
      this.worldGroundY + height * 0.05,
      this.worldCeilingY - height * 0.2
    );

    this.ionizationImpostors = this.createSphereImpostors(
      simulator.ionizationSeeds,
      this.options.ionizationColor,
      this.options.opacity * 1.5,
      this.worldGroundY + height * 0.1,
      this.worldCeilingY - height * 0.1
    );

    this.updateVisibility();
  }

  updateFromSimulator(simulator: AtmosphereSimulator): void {
    this.updateFieldPlane(this.ceilingPlane, simulator.ceilingCharge);
    this.updateFieldPlane(this.groundPlane, simulator.groundCharge);
    this.updateFieldPlane(this.atmosphericPlane, simulator.atmosphericCharge);
    this.updateSphereImpostors(this.moistureImpostors, simulator.moisture);
    this.updateSphereImpostors(this.ionizationImpostors, simulator.ionizationSeeds);
  }

  updateFromSnapshot(snapshot: AtmosphereSnapshot): void {
    this.updateFieldPlane(this.ceilingPlane, snapshot.ceilingCharge);
    this.updateFieldPlane(this.groundPlane, snapshot.groundCharge);
    this.updateFieldPlane(this.atmosphericPlane, snapshot.atmosphericCharge);
    this.updateSphereImpostors(this.moistureImpostors, snapshot.moisture);
    this.updateSphereImpostors(this.ionizationImpostors, snapshot.ionizationSeeds);
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
      this.worldCeilingY
    );

    this.groundPlane = this.createFieldPlane(
      snapshot.groundCharge,
      this.options.groundColor,
      this.options.opacity,
      this.worldGroundY
    );

    const height = this.worldCeilingY - this.worldGroundY;

    this.atmosphericPlane = this.createFieldPlane(
      snapshot.atmosphericCharge,
      this.options.atmosphericColor,
      this.options.opacity * 1.5,
      this.worldCeilingY - height * 0.15
    );

    this.moistureImpostors = this.createSphereImpostors(
      snapshot.moisture,
      this.options.moistureColor,
      this.options.opacity * 4.0,
      this.worldGroundY + height * 0.05,
      this.worldCeilingY - height * 0.2
    );

    this.ionizationImpostors = this.createSphereImpostors(
      snapshot.ionizationSeeds,
      this.options.ionizationColor,
      this.options.opacity * 1.5,
      this.worldGroundY + height * 0.1,
      this.worldCeilingY - height * 0.1
    );

    this.updateVisibility();
  }

  // --- Flat metaball planes (ceiling, ground, atmospheric) ---

  private createFieldPlane(
    field: FieldType,
    color: THREE.Color,
    opacity: number,
    yPosition: number
  ): FieldPlane {
    const worldScale = this.transform?.worldScale ?? 1;
    const planeSize = worldScale * 2.5;

    const geometry = new THREE.PlaneGeometry(planeSize, planeSize);
    geometry.rotateX(-Math.PI / 2);

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

  // --- Sphere impostors (moisture, ionization) ---

  private createSphereImpostors(
    field: FieldType,
    color: THREE.Color,
    opacity: number,
    yMin: number,
    yMax: number
  ): SphereImpostor[] {
    const worldScale = this.transform?.worldScale ?? 1;
    const impostors: SphereImpostor[] = [];
    const midY = (yMin + yMax) / 2;
    const rangeY = yMax - yMin;

    for (let i = 0; i < field.cells.length && i < 8; i++) {
      const cell = field.cells[i];
      const worldPos = this.transform
        ? this.transform.toWorld(cell.center)
        : cell.center;

      // Distribute Y positions within the layer range
      const cellY = midY + ((i * 0.618) % 1 - 0.5) * rangeY * 0.7;
      const radius = cell.falloffRadius * worldScale;

      // Billboard quad: 2 triangles covering (-1,-1) to (1,1)
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array([
        -1, -1, 0,  1, -1, 0,  1, 1, 0,
        -1, -1, 0,  1, 1, 0,  -1, 1, 0,
      ]);
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

      const material = new THREE.ShaderMaterial({
        vertexShader: sphereImpostorVertexShader,
        fragmentShader: sphereImpostorFragmentShader,
        uniforms: {
          sphereCenter: { value: new THREE.Vector3(worldPos.x, cellY, worldPos.z) },
          sphereRadius: { value: radius },
          baseColor: { value: color.clone() },
          opacity: { value: opacity },
          intensity: { value: cell.intensity },
          lightDir: { value: this.lightDir },
        },
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      impostors.push({ mesh, material });
    }

    return impostors;
  }

  private updateSphereImpostors(impostors: SphereImpostor[], field: FieldType): void {
    const worldScale = this.transform?.worldScale ?? 1;

    for (let i = 0; i < impostors.length; i++) {
      const imp = impostors[i];
      if (i < field.cells.length) {
        const cell = field.cells[i];
        const worldPos = this.transform
          ? this.transform.toWorld(cell.center)
          : cell.center;

        const center = imp.material.uniforms.sphereCenter.value as THREE.Vector3;
        center.x = worldPos.x;
        center.z = worldPos.z;

        imp.material.uniforms.sphereRadius.value = cell.falloffRadius * worldScale;
        imp.material.uniforms.intensity.value = cell.intensity;
      } else {
        imp.material.uniforms.intensity.value = 0;
      }
      imp.material.uniformsNeedUpdate = true;
    }
  }

  // --- Visibility ---

  private setImpostorsVisible(impostors: SphereImpostor[], vis: boolean): void {
    for (const imp of impostors) {
      imp.mesh.visible = vis;
    }
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
    this.setImpostorsVisible(this.moistureImpostors, this.visible && this.moistureVisible);
    this.setImpostorsVisible(this.ionizationImpostors, this.visible && this.ionizationVisible);
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
    this.setImpostorsVisible(this.moistureImpostors, this.visible && visible);
  }

  isMoistureVisible(): boolean {
    return this.moistureVisible;
  }

  setIonizationVisible(visible: boolean): void {
    this.ionizationVisible = visible;
    this.setImpostorsVisible(this.ionizationImpostors, this.visible && visible);
  }

  isIonizationVisible(): boolean {
    return this.ionizationVisible;
  }

  // --- No-ops for backward compatibility ---

  renderVolumetrics(_renderer: THREE.WebGLRenderer, _camera: THREE.Camera): void {}

  isLowResEnabled(): boolean {
    return false;
  }

  // --- Cleanup ---

  private disposeFieldPlane(plane: FieldPlane | null): void {
    if (!plane) return;
    this.scene.remove(plane.mesh);
    plane.mesh.geometry.dispose();
    plane.material.dispose();
  }

  private disposeImpostors(impostors: SphereImpostor[]): void {
    for (const imp of impostors) {
      this.scene.remove(imp.mesh);
      imp.mesh.geometry.dispose();
      imp.material.dispose();
    }
  }

  dispose(): void {
    this.disposeFieldPlane(this.ceilingPlane);
    this.ceilingPlane = null;

    this.disposeFieldPlane(this.groundPlane);
    this.groundPlane = null;

    this.disposeFieldPlane(this.atmosphericPlane);
    this.atmosphericPlane = null;

    this.disposeImpostors(this.moistureImpostors);
    this.moistureImpostors = [];

    this.disposeImpostors(this.ionizationImpostors);
    this.ionizationImpostors = [];
  }
}
