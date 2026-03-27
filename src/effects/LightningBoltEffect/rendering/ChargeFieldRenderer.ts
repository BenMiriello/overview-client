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
  /** Resolution scale for volumetric rendering (0.5 = half res, 1.0 = full) */
  volumetricResolution?: number;
}

interface FieldPlane {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
}

interface VolumetricField {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
}

// Simple composite shader for low-res volumetric upscaling
const compositeVertexShader = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const compositeFragmentShader = `
uniform sampler2D tDiffuse;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(tDiffuse, vUv);
}
`;

export class ChargeFieldRenderer {
  private scene: THREE.Scene;
  private options: Required<ChargeFieldRenderOptions>;
  private transform: CoordinateTransform | null = null;

  // Ceiling/Ground: flat horizontal metaball planes
  private ceilingPlane: FieldPlane | null = null;
  private groundPlane: FieldPlane | null = null;

  // Atmospheric/Moisture/Ionization: volumetric ray-marched 3D fields
  private atmosphericVolume: VolumetricField | null = null;
  private moistureVolume: VolumetricField | null = null;
  private ionizationVolume: VolumetricField | null = null;

  // Light direction for volumetric fields
  private lightDir: THREE.Vector3 = new THREE.Vector3(0.5, 0.8, 0.3).normalize();

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

  // Low-res volumetric rendering
  private volumetricScene: THREE.Scene | null = null;
  private renderTarget: THREE.WebGLRenderTarget | null = null;
  private compositeScene: THREE.Scene | null = null;
  private compositeCamera: THREE.OrthographicCamera | null = null;
  private compositeQuad: THREE.Mesh | null = null;
  private compositeMaterial: THREE.ShaderMaterial | null = null;
  private resolutionScale: number = 1.0;
  private lastWidth: number = 0;
  private lastHeight: number = 0;

  constructor(scene: THREE.Scene, options: ChargeFieldRenderOptions = {}) {
    this.scene = scene;
    this.resolutionScale = options.volumetricResolution ?? 0.35;
    this.options = {
      planeSize: options.planeSize ?? 1.0,
      ceilingColor: options.ceilingColor ?? new THREE.Color(0.7, 0.85, 1.0),
      groundColor: options.groundColor ?? new THREE.Color(0.5, 0.55, 0.65),
      atmosphericColor: options.atmosphericColor ?? new THREE.Color(0.85, 0.95, 1.0),
      moistureColor: options.moistureColor ?? new THREE.Color(0.6, 0.8, 0.95),
      ionizationColor: options.ionizationColor ?? new THREE.Color(1.0, 1.0, 0.9),
      opacity: options.opacity ?? 0.2,
      volumetricResolution: options.volumetricResolution ?? 0.35,
    };

    // Create separate scene for volumetrics when using low-res rendering
    if (this.resolutionScale < 1.0) {
      this.volumetricScene = new THREE.Scene();
    }
  }

  setWindParameters(direction: THREE.Vector2, speed: number): void {
    this.windDir.copy(direction).normalize();
    this.windSpeed = speed / 60; // Normalize to 0-1 range from 0-60 kts

    // Update flat plane materials
    const planes = [this.ceilingPlane, this.groundPlane];
    for (const plane of planes) {
      if (plane) {
        plane.material.uniforms.windDir.value.copy(this.windDir);
        plane.material.uniforms.windSpeed.value = this.windSpeed;
      }
    }

    // Update volumetric field materials
    const volumes = [this.atmosphericVolume, this.moistureVolume, this.ionizationVolume];
    for (const volume of volumes) {
      if (volume) {
        volume.material.uniforms.windDir.value.copy(this.windDir);
        volume.material.uniforms.windSpeed.value = this.windSpeed;
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

    // Volumetric atmospheric charge - fills most of the atmosphere
    // Concentrated in upper half but extends through the full column
    if (atmosphere.atmosphericCharge) {
      const height = this.worldCeilingY - this.worldGroundY;
      const upperBound = this.worldCeilingY - height * 0.05;
      const lowerBound = this.worldGroundY + height * 0.15;
      this.atmosphericVolume = this.createVolumetricField(
        atmosphere.atmosphericCharge,
        this.options.atmosphericColor,
        this.options.opacity * 3.0,
        lowerBound,
        upperBound
      );
    }

    // Moisture - pervades mid and lower atmosphere, overlaps with atmospheric
    if (atmosphere.moisture) {
      const height = this.worldCeilingY - this.worldGroundY;
      const upperBound = this.worldCeilingY - height * 0.2;
      const lowerBound = this.worldGroundY + height * 0.05;
      this.moistureVolume = this.createVolumetricField(
        atmosphere.moisture,
        this.options.moistureColor,
        this.options.opacity * 3.5,
        lowerBound,
        upperBound
      );
    }

    // Ionization - spans the full column (ionization happens everywhere)
    if (atmosphere.ionizationSeeds) {
      const height = this.worldCeilingY - this.worldGroundY;
      const upperBound = this.worldCeilingY - height * 0.1;
      const lowerBound = this.worldGroundY + height * 0.1;
      this.ionizationVolume = this.createVolumetricField(
        atmosphere.ionizationSeeds,
        this.options.ionizationColor,
        this.options.opacity * 3.0,
        lowerBound,
        upperBound
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

    // Volumetric atmospheric field - fills most of the column
    const height = this.worldCeilingY - this.worldGroundY;
    this.atmosphericVolume = this.createVolumetricField(
      simulator.atmosphericCharge,
      this.options.atmosphericColor,
      this.options.opacity * 3.0,
      this.worldGroundY + height * 0.15,
      this.worldCeilingY - height * 0.05
    );

    // Volumetric moisture field - mid to lower, overlapping atmospheric
    this.moistureVolume = this.createVolumetricField(
      simulator.moisture,
      this.options.moistureColor,
      this.options.opacity * 3.5,
      this.worldGroundY + height * 0.05,
      this.worldCeilingY - height * 0.2
    );

    // Volumetric ionization field - spans full column
    this.ionizationVolume = this.createVolumetricField(
      simulator.ionizationSeeds,
      this.options.ionizationColor,
      this.options.opacity * 3.0,
      this.worldGroundY + height * 0.1,
      this.worldCeilingY - height * 0.1
    );

    this.updateVisibility();
  }

  updateFromSimulator(simulator: AtmosphereSimulator): void {
    this.updateFieldPlane(this.ceilingPlane, simulator.ceilingCharge);
    this.updateFieldPlane(this.groundPlane, simulator.groundCharge);
    this.updateVolumetricField(this.atmosphericVolume, simulator.atmosphericCharge);
    this.updateVolumetricField(this.moistureVolume, simulator.moisture);
    this.updateVolumetricField(this.ionizationVolume, simulator.ionizationSeeds);
  }

  updateFromSnapshot(snapshot: AtmosphereSnapshot): void {
    this.updateFieldPlane(this.ceilingPlane, snapshot.ceilingCharge);
    this.updateFieldPlane(this.groundPlane, snapshot.groundCharge);
    this.updateVolumetricField(this.atmosphericVolume, snapshot.atmosphericCharge);
    this.updateVolumetricField(this.moistureVolume, snapshot.moisture);
    this.updateVolumetricField(this.ionizationVolume, snapshot.ionizationSeeds);
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

    // Volumetric fields - overlapping vertical regions
    const height = this.worldCeilingY - this.worldGroundY;
    this.atmosphericVolume = this.createVolumetricField(
      snapshot.atmosphericCharge,
      this.options.atmosphericColor,
      this.options.opacity * 3.0,
      this.worldGroundY + height * 0.15,
      this.worldCeilingY - height * 0.05
    );

    this.moistureVolume = this.createVolumetricField(
      snapshot.moisture,
      this.options.moistureColor,
      this.options.opacity * 3.5,
      this.worldGroundY + height * 0.05,
      this.worldCeilingY - height * 0.2
    );

    this.ionizationVolume = this.createVolumetricField(
      snapshot.ionizationSeeds,
      this.options.ionizationColor,
      this.options.opacity * 3.0,
      this.worldGroundY + height * 0.1,
      this.worldCeilingY - height * 0.1
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

  private createVolumetricField(
    field: FieldType,
    color: THREE.Color,
    opacity: number,
    yMin: number,
    yMax: number
  ): VolumetricField {
    const worldScale = this.transform?.worldScale ?? 1;
    const planeSize = worldScale * 2.5;

    // Create a box geometry that covers the volume bounds
    const height = yMax - yMin;
    const geometry = new THREE.BoxGeometry(planeSize, height, planeSize);

    // Prepare cell data arrays (3D positions for volumetric)
    const cells = field.cells.slice(0, MAX_VOLUMETRIC_CELLS);
    const cellCenters: THREE.Vector3[] = [];
    const cellIntensities: number[] = [];
    const cellRadii: number[] = [];

    const midY = (yMin + yMax) / 2;

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const worldPos = this.transform
        ? this.transform.toWorld(cell.center)
        : cell.center;
      const cellY = midY + ((i * 0.618) % 1 - 0.5) * height * 0.7;
      cellCenters.push(new THREE.Vector3(worldPos.x, cellY, worldPos.z));
      cellIntensities.push(cell.intensity);
      cellRadii.push(cell.falloffRadius * worldScale);
    }

    while (cellCenters.length < MAX_VOLUMETRIC_CELLS) {
      cellCenters.push(new THREE.Vector3(0, 0, 0));
      cellIntensities.push(0);
      cellRadii.push(0);
    }

    const worldCenter = this.transform
      ? this.transform.toWorld({ x: 0, y: 0, z: 0 })
      : { x: 0, y: 0, z: 0 };

    const boundMin = new THREE.Vector3(
      worldCenter.x - planeSize / 2,
      yMin,
      worldCenter.z - planeSize / 2
    );
    const boundMax = new THREE.Vector3(
      worldCenter.x + planeSize / 2,
      yMax,
      worldCenter.z + planeSize / 2
    );

    const material = new THREE.ShaderMaterial({
      vertexShader: volumetricVertexShader,
      fragmentShader: volumetricFragmentShader,
      uniforms: {
        cellCenters: { value: cellCenters },
        cellIntensities: { value: cellIntensities },
        cellRadii: { value: cellRadii },
        cellCount: { value: cells.length },
        baseColor: { value: color },
        opacity: { value: opacity },
        boundMin: { value: boundMin },
        boundMax: { value: boundMax },
        lightDir: { value: this.lightDir },
        windDir: { value: this.windDir.clone() },
        windSpeed: { value: this.windSpeed },
        radiusScale: { value: 1.0 },
      },
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(worldCenter.x, midY, worldCenter.z);

    // Add to volumetric scene if using low-res rendering, otherwise main scene
    const targetScene = this.volumetricScene ?? this.scene;
    targetScene.add(mesh);

    return { mesh, material };
  }

  private updateVolumetricField(volume: VolumetricField | null, field: FieldType): void {
    if (!volume) return;

    const cells = field.cells.slice(0, MAX_VOLUMETRIC_CELLS);
    const worldScale = this.transform?.worldScale ?? 1;

    const cellCenters = volume.material.uniforms.cellCenters.value as THREE.Vector3[];
    const cellIntensities = volume.material.uniforms.cellIntensities.value as number[];
    const cellRadii = volume.material.uniforms.cellRadii.value as number[];

    const boundMin = volume.material.uniforms.boundMin.value as THREE.Vector3;
    const boundMax = volume.material.uniforms.boundMax.value as THREE.Vector3;
    const midY = (boundMin.y + boundMax.y) / 2;
    const height = boundMax.y - boundMin.y;

    for (let i = 0; i < MAX_VOLUMETRIC_CELLS; i++) {
      if (i < cells.length) {
        const cell = cells[i];
        const worldPos = this.transform
          ? this.transform.toWorld(cell.center)
          : cell.center;
        // Maintain consistent Y positions (using cell index for determinism)
        const cellY = midY + ((i * 0.618) % 1 - 0.5) * height * 0.7;
        cellCenters[i].set(worldPos.x, cellY, worldPos.z);
        cellIntensities[i] = cell.intensity;
        cellRadii[i] = cell.falloffRadius * worldScale;
      } else {
        cellCenters[i].set(0, 0, 0);
        cellIntensities[i] = 0;
        cellRadii[i] = 0;
      }
    }

    volume.material.uniforms.cellCount.value = cells.length;
    volume.material.uniformsNeedUpdate = true;
  }

  private updateVisibility(): void {
    if (this.ceilingPlane) {
      this.ceilingPlane.mesh.visible = this.visible && this.ceilingVisible;
    }
    if (this.groundPlane) {
      this.groundPlane.mesh.visible = this.visible && this.groundVisible;
    }
    if (this.atmosphericVolume) {
      this.atmosphericVolume.mesh.visible = this.visible && this.atmosphericVisible;
    }
    if (this.moistureVolume) {
      this.moistureVolume.mesh.visible = this.visible && this.moistureVisible;
    }
    if (this.ionizationVolume) {
      this.ionizationVolume.mesh.visible = this.visible && this.ionizationVisible;
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
    if (this.atmosphericVolume) {
      this.atmosphericVolume.mesh.visible = this.visible && visible;
    }
  }

  isAtmosphericVisible(): boolean {
    return this.atmosphericVisible;
  }

  setMoistureVisible(visible: boolean): void {
    this.moistureVisible = visible;
    if (this.moistureVolume) {
      this.moistureVolume.mesh.visible = this.visible && visible;
    }
  }

  isMoistureVisible(): boolean {
    return this.moistureVisible;
  }

  setIonizationVisible(visible: boolean): void {
    this.ionizationVisible = visible;
    if (this.ionizationVolume) {
      this.ionizationVolume.mesh.visible = this.visible && visible;
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

  private disposeVolumetricField(volume: VolumetricField | null): void {
    if (!volume) return;
    const targetScene = this.volumetricScene ?? this.scene;
    targetScene.remove(volume.mesh);
    volume.mesh.geometry.dispose();
    volume.material.dispose();
  }

  /**
   * Render volumetric fields to low-res target and composite.
   * Call this each frame when using volumetricResolution < 1.0.
   */
  renderVolumetrics(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    if (!this.volumetricScene || this.resolutionScale >= 1.0) return;

    // Check if any volumetric is visible
    const hasVisibleVolumetric =
      (this.visible && this.atmosphericVisible && this.atmosphericVolume) ||
      (this.visible && this.moistureVisible && this.moistureVolume) ||
      (this.visible && this.ionizationVisible && this.ionizationVolume);

    if (!hasVisibleVolumetric) {
      return;
    }

    // Get current size and update render target if needed
    const size = renderer.getSize(new THREE.Vector2());
    const width = Math.floor(size.x * this.resolutionScale);
    const height = Math.floor(size.y * this.resolutionScale);

    if (width !== this.lastWidth || height !== this.lastHeight) {
      this.initRenderTarget(width, height);
      this.lastWidth = width;
      this.lastHeight = height;
    }

    if (!this.renderTarget || !this.compositeScene || !this.compositeCamera) return;

    // Update volumetric visibility in the separate scene
    if (this.atmosphericVolume) {
      this.atmosphericVolume.mesh.visible = this.visible && this.atmosphericVisible;
    }
    if (this.moistureVolume) {
      this.moistureVolume.mesh.visible = this.visible && this.moistureVisible;
    }
    if (this.ionizationVolume) {
      this.ionizationVolume.mesh.visible = this.visible && this.ionizationVisible;
    }

    // Render volumetric scene to low-res target
    const currentRenderTarget = renderer.getRenderTarget();
    const currentAutoClear = renderer.autoClear;

    renderer.setRenderTarget(this.renderTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(this.volumetricScene, camera);

    // Composite to main framebuffer using orthographic camera
    renderer.setRenderTarget(currentRenderTarget);
    renderer.autoClear = false;
    renderer.render(this.compositeScene!, this.compositeCamera!);
    renderer.autoClear = currentAutoClear;
  }

  private initRenderTarget(width: number, height: number): void {
    // Dispose old render target
    if (this.renderTarget) {
      this.renderTarget.dispose();
    }

    // Create new render target
    this.renderTarget = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
    });

    // Create composite scene and camera on first init
    if (!this.compositeScene) {
      this.compositeScene = new THREE.Scene();
      this.compositeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

      this.compositeMaterial = new THREE.ShaderMaterial({
        vertexShader: compositeVertexShader,
        fragmentShader: compositeFragmentShader,
        uniforms: {
          tDiffuse: { value: this.renderTarget.texture },
        },
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      });

      const geometry = new THREE.PlaneGeometry(2, 2);
      this.compositeQuad = new THREE.Mesh(geometry, this.compositeMaterial);
      this.compositeScene.add(this.compositeQuad);
    } else {
      // Update texture reference
      this.compositeMaterial!.uniforms.tDiffuse.value = this.renderTarget.texture;
    }
  }

  /**
   * Check if low-res volumetric rendering is enabled.
   */
  isLowResEnabled(): boolean {
    return this.resolutionScale < 1.0 && this.volumetricScene !== null;
  }

  dispose(): void {
    this.disposeFieldPlane(this.ceilingPlane);
    this.ceilingPlane = null;

    this.disposeFieldPlane(this.groundPlane);
    this.groundPlane = null;

    this.disposeVolumetricField(this.atmosphericVolume);
    this.atmosphericVolume = null;

    this.disposeVolumetricField(this.moistureVolume);
    this.moistureVolume = null;

    this.disposeVolumetricField(this.ionizationVolume);
    this.ionizationVolume = null;

    // Dispose low-res rendering resources
    if (this.renderTarget) {
      this.renderTarget.dispose();
      this.renderTarget = null;
    }

    if (this.compositeQuad) {
      this.compositeQuad.geometry.dispose();
      this.compositeQuad = null;
    }

    if (this.compositeMaterial) {
      this.compositeMaterial.dispose();
      this.compositeMaterial = null;
    }

    this.compositeScene = null;
    this.compositeCamera = null;
    this.volumetricScene = null;
  }
}
