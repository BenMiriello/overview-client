import * as THREE from 'three';
import { BaseEffect } from './core/BaseEffect';
import { BaseEffectConfig } from './core/EffectInterface';
import { MarkerType } from '../types';

export interface PointMarkerConfig extends BaseEffectConfig {
  markerType: MarkerType;
  radius: number;
  color: number;
  opacity: number;
  resolution: number;   // Geometry resolution (CIRCLE/DONUT only)
  altitude: number;
  duration: number;
  fadeInDuration: number;
  maxAge: number;
  fadeStartAge: number;
  innerRadius: number;  // DONUT inner radius
  outerRadius: number;  // DONUT outer radius
}

export const DEFAULT_MARKER_CONFIG: PointMarkerConfig = {
  markerType: MarkerType.ZAP,
  radius: 0.1,
  color: 0xffdd00,
  opacity: 1,
  resolution: 25,
  altitude: 0.00001,
  duration: 60000,
  fadeInDuration: 0,
  fadeOutDuration: 2000,
  maxAge: 60000,
  fadeStartAge: 58000,
  innerRadius: 0.05,
  outerRadius: 0.07,
};

// Lucide 'Zap' polygon — 24×24 viewBox, same as <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
const ZAP_POINTS = [[13,2],[3,14],[12,14],[11,22],[21,10],[12,10],[13,2]] as const;

function createZapTexture(size: number = 128): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const s = size / 24;

  // Lucide uses fill="none" stroke="currentColor" stroke-width="2"
  // stroke-linecap="round" stroke-linejoin="round"
  ctx.strokeStyle = '#ffdd00';
  ctx.lineWidth = 2 * s;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.moveTo(ZAP_POINTS[0][0] * s, ZAP_POINTS[0][1] * s);
  for (let i = 1; i < ZAP_POINTS.length; i++) {
    ctx.lineTo(ZAP_POINTS[i][0] * s, ZAP_POINTS[i][1] * s);
  }
  ctx.closePath();
  ctx.stroke();

  return new THREE.CanvasTexture(canvas);
}

/**
 * Creates markers flat on the globe surface at strike locations.
 * All types use a THREE.Mesh oriented tangent to the globe.
 * ZAP uses a 1×1 PlaneGeometry (scaled each frame for constant screen size).
 */
export class PointMarkerEffect extends BaseEffect {
  private marker: THREE.Mesh;
  private geometry: THREE.BufferGeometry;
  private material: THREE.MeshBasicMaterial;
  private config: PointMarkerConfig;
  private createTime: number;
  private clusterVisible: boolean = true;

  constructor(
    lat: number,
    lng: number,
    intensity: number = 0.5,
    config: Partial<PointMarkerConfig> = {}
  ) {
    super(lat, lng, intensity);
    this.config = { ...DEFAULT_MARKER_CONFIG, ...config };
    this.createTime = Date.now();

    if (this.config.markerType === MarkerType.ZAP) {
      // Unit plane — scale set each frame for constant screen size
      this.geometry = new THREE.PlaneGeometry(1, 1);
      const texture = createZapTexture(128);
      this.registerResource(texture);
      this.material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
        alphaTest: 0.01,
      });
    } else if (this.config.markerType === MarkerType.CIRCLE) {
      this.geometry = new THREE.CircleGeometry(this.config.radius, this.config.resolution);
      this.material = new THREE.MeshBasicMaterial({
        color: this.config.color,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
    } else {
      // DONUT
      this.geometry = new THREE.RingGeometry(
        this.config.innerRadius, this.config.outerRadius, this.config.resolution, 0, 0, Math.PI * 2
      );
      this.material = new THREE.MeshBasicMaterial({
        color: this.config.color,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
    }

    this.marker = new THREE.Mesh(this.geometry, this.material);
    this.marker.renderOrder = 30;
    this.marker.userData = { createdAt: this.createTime, intensity: this.intensity };

    this.registerResource(this.geometry);
    this.registerResource(this.material);
    this.registerResource(this.marker);
  }

  initialize(scene: THREE.Scene, globeEl: any): void {
    this.globeEl = globeEl;
    this.scene = scene;
    if (scene && !this.marker.parent) {
      scene.add(this.marker);
    }
  }

  update(currentTime: number): boolean {
    if (this.isTerminated) return false;

    const age = currentTime - this.createTime;

    if (age > this.config.maxAge) {
      this.markComplete();
      return false;
    }

    let opacity: number;
    if (age < this.config.fadeInDuration) {
      opacity = (age / this.config.fadeInDuration) * this.config.opacity;
    } else if (age < this.config.fadeStartAge) {
      opacity = this.config.opacity;
    } else {
      const fadeRatio = 1 - (age - this.config.fadeStartAge) / (this.config.maxAge - this.config.fadeStartAge);
      opacity = Math.max(0, fadeRatio * this.config.opacity);
    }

    this.material.opacity = Math.min(this.config.opacity, opacity);
    this.marker.visible = this.clusterVisible && this.material.opacity > 0;

    return true;
  }

  positionOnGlobe(lat: number, lng: number, altitude: number = this.config.altitude): void {
    if (!this.globeEl) return;
    const coords = this.globeEl.getCoords(lat, lng, altitude);
    this.marker.position.set(coords.x, coords.y, coords.z);

    // Build a full orientation frame so the icon is consistently north-up across
    // all globe positions. setFromUnitVectors(Z, normal) alone leaves the in-plane
    // rotation around Z arbitrary, causing the icon to appear rotated differently
    // at different latitudes/longitudes.
    const normal = new THREE.Vector3().copy(coords).normalize();
    const worldNorth = new THREE.Vector3(0, 1, 0);

    // Project world north onto the tangent plane at this surface point
    let northOnPlane = worldNorth.clone().addScaledVector(normal, -worldNorth.dot(normal));
    if (northOnPlane.lengthSq() < 0.0001) {
      // Near poles: fall back to world east as the reference direction
      northOnPlane.set(1, 0, 0).addScaledVector(normal, -normal.x);
    }
    northOnPlane.normalize();

    const right = new THREE.Vector3().crossVectors(northOnPlane, normal).normalize();
    const matrix = new THREE.Matrix4().makeBasis(right, northOnPlane, normal);
    this.marker.quaternion.setFromRotationMatrix(matrix);
  }

  // Sets world-space size for ZAP markers. Call each frame with the value from
  // LightningLayer.getIconScale() to maintain constant screen-pixel size.
  setMarkerScale(worldSize: number): void {
    if (this.config.markerType === MarkerType.ZAP) {
      this.marker.scale.set(worldSize, worldSize, 1);
    }
  }

  getWorldPosition(): THREE.Vector3 {
    return this.marker.position.clone();
  }

  setClusterVisible(visible: boolean): void {
    this.clusterVisible = visible;
  }

  terminateImmediately(): void {
    this.material.opacity = 0;
    this.marker.visible = false;
    super.terminateImmediately();
  }

  getObject(): THREE.Object3D {
    return this.marker;
  }

  dispose(): void {
    super.dispose();
  }
}
