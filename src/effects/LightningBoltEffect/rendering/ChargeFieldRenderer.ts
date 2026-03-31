import * as THREE from 'three';
import { AtmosphericModelData, VoronoiFieldData, Vec3 } from '../simulation/types';
import { CoordinateTransform } from '../CoordinateTransform';
import { AtmosphereSimulator } from '../simulation/AtmosphereSimulator';
import { VoronoiField } from '../simulation/VoronoiField';
import { AtmosphereSnapshot } from '../simulation/SimulationTimeline';
import {
  chargeFieldVertexShader,
  chargeFieldFragmentShader,
  volumetricVertexShader,
  volumetricFragmentShader,
  MAX_CELLS,
  MAX_VOLUMETRIC_CELLS,
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

interface UnifiedVolume {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
}

export class ChargeFieldRenderer {
  private scene: THREE.Scene;
  private options: Required<ChargeFieldRenderOptions>;
  private transform: CoordinateTransform | null = null;

  // Ceiling/Ground: flat horizontal metaball planes
  private ceilingPlane: FieldPlane | null = null;
  private groundPlane: FieldPlane | null = null;

  // Single unified volume for all 3D atmospheric fields
  private unifiedVolume: UnifiedVolume | null = null;

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

    const planes = [this.ceilingPlane, this.groundPlane];
    for (const plane of planes) {
      if (plane) {
        plane.material.uniforms.windDir.value.copy(this.windDir);
        plane.material.uniforms.windSpeed.value = this.windSpeed;
      }
    }

    if (this.unifiedVolume) {
      this.unifiedVolume.material.uniforms.windDir.value.copy(this.windDir);
      this.unifiedVolume.material.uniforms.windSpeed.value = this.windSpeed;
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
    this.createAll(atmosphere.ceilingCharge, atmosphere.groundCharge,
      atmosphere.atmosphericCharge, atmosphere.moisture, atmosphere.ionizationSeeds);
    this.updateVisibility();
  }

  initialize(simulator: AtmosphereSimulator, worldStart: Vec3, worldEnd: Vec3): void {
    this.dispose();
    this.transform = new CoordinateTransform(worldStart, worldEnd);
    this.worldCeilingY = worldStart.y;
    this.worldGroundY = worldEnd.y;
    this.createAll(simulator.ceilingCharge, simulator.groundCharge,
      simulator.atmosphericCharge, simulator.moisture, simulator.ionizationSeeds);
    this.updateVisibility();
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
    this.createAll(snapshot.ceilingCharge, snapshot.groundCharge,
      snapshot.atmosphericCharge, snapshot.moisture, snapshot.ionizationSeeds);
    this.updateVisibility();
  }

  private createAll(
    ceiling: FieldType, ground: FieldType,
    atmospheric: FieldType, moisture: FieldType, ionization: FieldType
  ): void {
    this.ceilingPlane = this.createFieldPlane(
      ceiling, this.options.ceilingColor, this.options.opacity, this.worldCeilingY
    );
    this.groundPlane = this.createFieldPlane(
      ground, this.options.groundColor, this.options.opacity, this.worldGroundY
    );

    if (import.meta.env.VITE_SHOW_ATMOSPHERIC_LAYERS === 'true') {
      this.unifiedVolume = this.createUnifiedVolume(atmospheric, moisture, ionization);
    }
  }

  updateFromSimulator(simulator: AtmosphereSimulator): void {
    this.updateFieldPlane(this.ceilingPlane, simulator.ceilingCharge);
    this.updateFieldPlane(this.groundPlane, simulator.groundCharge);
    this.updateUnifiedVolume(simulator.atmosphericCharge, simulator.moisture, simulator.ionizationSeeds);
  }

  updateFromSnapshot(snapshot: AtmosphereSnapshot): void {
    this.updateFieldPlane(this.ceilingPlane, snapshot.ceilingCharge);
    this.updateFieldPlane(this.groundPlane, snapshot.groundCharge);
    this.updateUnifiedVolume(snapshot.atmosphericCharge, snapshot.moisture, snapshot.ionizationSeeds);
  }

  // --- Flat metaball planes (ceiling/ground) ---

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
        const worldPos = this.transform ? this.transform.toWorld(cell.center) : cell.center;
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

  // --- Unified volumetric field (all 3 atmospheric layers in one pass) ---

  private prepareCells3D(field: FieldType, yMin: number, yMax: number) {
    const worldScale = this.transform?.worldScale ?? 1;
    const cells = field.cells.slice(0, MAX_VOLUMETRIC_CELLS);
    const midY = (yMin + yMax) / 2;
    const height = yMax - yMin;

    const centers: THREE.Vector3[] = [];
    const intensities: number[] = [];
    const radii: number[] = [];

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const worldPos = this.transform ? this.transform.toWorld(cell.center) : cell.center;
      const cellY = midY + ((i * 0.618) % 1 - 0.5) * height * 0.7;
      centers.push(new THREE.Vector3(worldPos.x, cellY, worldPos.z));
      intensities.push(cell.intensity);
      radii.push(cell.falloffRadius * worldScale * 1.3);
    }

    while (centers.length < MAX_VOLUMETRIC_CELLS) {
      centers.push(new THREE.Vector3(0, 0, 0));
      intensities.push(0);
      radii.push(0);
    }

    return { centers, intensities, radii, count: cells.length };
  }

  private createUnifiedVolume(
    atmospheric: FieldType, moisture: FieldType, ionization: FieldType
  ): UnifiedVolume {
    const worldScale = this.transform?.worldScale ?? 1;
    const height = this.worldCeilingY - this.worldGroundY;
    const midY = (this.worldCeilingY + this.worldGroundY) / 2;
    const sphereRadius = Math.max(worldScale * 2.5, height) * 0.65;

    const worldCenter = this.transform
      ? this.transform.toWorld({ x: 0, y: 0, z: 0 })
      : { x: 0, y: 0, z: 0 };

    const atmo = this.prepareCells3D(atmospheric,
      this.worldGroundY + height * 0.15, this.worldCeilingY - height * 0.05);
    const moist = this.prepareCells3D(moisture,
      this.worldGroundY + height * 0.05, this.worldCeilingY - height * 0.2);
    const ion = this.prepareCells3D(ionization,
      this.worldGroundY + height * 0.1, this.worldCeilingY - height * 0.1);

    const geometry = new THREE.SphereGeometry(sphereRadius, 16, 12);

    const material = new THREE.ShaderMaterial({
      vertexShader: volumetricVertexShader,
      fragmentShader: volumetricFragmentShader,
      uniforms: {
        atmoCenters: { value: atmo.centers },
        atmoIntensities: { value: atmo.intensities },
        atmoRadii: { value: atmo.radii },
        atmoCount: { value: atmo.count },
        atmoColor: { value: this.options.atmosphericColor },
        atmoOpacity: { value: this.atmosphericVisible ? this.options.opacity * 2.0 : 0.0 },

        moistCenters: { value: moist.centers },
        moistIntensities: { value: moist.intensities },
        moistRadii: { value: moist.radii },
        moistCount: { value: moist.count },
        moistColor: { value: this.options.moistureColor },
        moistOpacity: { value: this.moistureVisible ? this.options.opacity * 2.5 : 0.0 },

        ionCenters: { value: ion.centers },
        ionIntensities: { value: ion.intensities },
        ionRadii: { value: ion.radii },
        ionCount: { value: ion.count },
        ionColor: { value: this.options.ionizationColor },
        ionOpacity: { value: this.ionizationVisible ? this.options.opacity * 2.0 : 0.0 },

        volumeCenter: { value: new THREE.Vector3(worldCenter.x, midY, worldCenter.z) },
        volumeRadius: { value: sphereRadius },
        windDir: { value: this.windDir.clone() },
        windSpeed: { value: this.windSpeed },
      },
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(worldCenter.x, midY, worldCenter.z);
    this.scene.add(mesh);

    return { mesh, material };
  }

  private updateUnifiedVolume(
    atmospheric: FieldType, moisture: FieldType, ionization: FieldType
  ): void {
    if (!this.unifiedVolume) return;
    const worldScale = this.transform?.worldScale ?? 1;
    const height = this.worldCeilingY - this.worldGroundY;
    const u = this.unifiedVolume.material.uniforms;

    this.updateCells3D(u.atmoCenters.value, u.atmoIntensities.value, u.atmoRadii.value,
      atmospheric, this.worldGroundY + height * 0.15, this.worldCeilingY - height * 0.05, worldScale);
    u.atmoCount.value = Math.min(atmospheric.cells.length, MAX_VOLUMETRIC_CELLS);

    this.updateCells3D(u.moistCenters.value, u.moistIntensities.value, u.moistRadii.value,
      moisture, this.worldGroundY + height * 0.05, this.worldCeilingY - height * 0.2, worldScale);
    u.moistCount.value = Math.min(moisture.cells.length, MAX_VOLUMETRIC_CELLS);

    this.updateCells3D(u.ionCenters.value, u.ionIntensities.value, u.ionRadii.value,
      ionization, this.worldGroundY + height * 0.1, this.worldCeilingY - height * 0.1, worldScale);
    u.ionCount.value = Math.min(ionization.cells.length, MAX_VOLUMETRIC_CELLS);

    this.unifiedVolume.material.uniformsNeedUpdate = true;
  }

  private updateCells3D(
    centers: THREE.Vector3[], intensities: number[], radii: number[],
    field: FieldType, yMin: number, yMax: number, worldScale: number
  ): void {
    const cells = field.cells.slice(0, MAX_VOLUMETRIC_CELLS);
    const midY = (yMin + yMax) / 2;
    const height = yMax - yMin;

    for (let i = 0; i < MAX_VOLUMETRIC_CELLS; i++) {
      if (i < cells.length) {
        const cell = cells[i];
        const worldPos = this.transform ? this.transform.toWorld(cell.center) : cell.center;
        const cellY = midY + ((i * 0.618) % 1 - 0.5) * height * 0.7;
        centers[i].set(worldPos.x, cellY, worldPos.z);
        intensities[i] = cell.intensity;
        radii[i] = cell.falloffRadius * worldScale * 1.3;
      } else {
        centers[i].set(0, 0, 0);
        intensities[i] = 0;
        radii[i] = 0;
      }
    }
  }

  // --- Visibility ---

  private updateVisibility(): void {
    if (this.ceilingPlane) {
      this.ceilingPlane.mesh.visible = this.visible && this.ceilingVisible;
    }
    if (this.groundPlane) {
      this.groundPlane.mesh.visible = this.visible && this.groundVisible;
    }
    // For the unified volume, toggle per-field opacity to 0 instead of hiding the mesh
    this.syncVolumeVisibility();
  }

  private syncVolumeVisibility(): void {
    if (!this.unifiedVolume) return;
    const u = this.unifiedVolume.material.uniforms;
    const anyVisible = this.visible && (this.atmosphericVisible || this.moistureVisible || this.ionizationVisible);
    this.unifiedVolume.mesh.visible = anyVisible;

    u.atmoOpacity.value = (this.visible && this.atmosphericVisible) ? this.options.opacity * 2.0 : 0.0;
    u.moistOpacity.value = (this.visible && this.moistureVisible) ? this.options.opacity * 2.5 : 0.0;
    u.ionOpacity.value = (this.visible && this.ionizationVisible) ? this.options.opacity * 2.0 : 0.0;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.updateVisibility();
  }

  isVisible(): boolean { return this.visible; }

  setCeilingVisible(visible: boolean): void {
    this.ceilingVisible = visible;
    if (this.ceilingPlane) this.ceilingPlane.mesh.visible = this.visible && visible;
  }

  setGroundVisible(visible: boolean): void {
    this.groundVisible = visible;
    if (this.groundPlane) this.groundPlane.mesh.visible = this.visible && visible;
  }

  setAtmosphericVisible(visible: boolean): void {
    this.atmosphericVisible = visible;
    this.syncVolumeVisibility();
  }

  isAtmosphericVisible(): boolean { return this.atmosphericVisible; }

  setMoistureVisible(visible: boolean): void {
    this.moistureVisible = visible;
    this.syncVolumeVisibility();
  }

  isMoistureVisible(): boolean { return this.moistureVisible; }

  setIonizationVisible(visible: boolean): void {
    this.ionizationVisible = visible;
    this.syncVolumeVisibility();
  }

  isIonizationVisible(): boolean { return this.ionizationVisible; }

  // No-ops for backward compat
  renderVolumetrics(_renderer: THREE.WebGLRenderer, _camera: THREE.Camera): void {}
  isLowResEnabled(): boolean { return false; }

  // --- Cleanup ---

  private disposeFieldPlane(plane: FieldPlane | null): void {
    if (!plane) return;
    this.scene.remove(plane.mesh);
    plane.mesh.geometry.dispose();
    plane.material.dispose();
  }

  dispose(): void {
    this.disposeFieldPlane(this.ceilingPlane);
    this.ceilingPlane = null;
    this.disposeFieldPlane(this.groundPlane);
    this.groundPlane = null;

    if (this.unifiedVolume) {
      this.scene.remove(this.unifiedVolume.mesh);
      this.unifiedVolume.mesh.geometry.dispose();
      this.unifiedVolume.material.dispose();
      this.unifiedVolume = null;
    }
  }
}
