import * as THREE from 'three';
import { BaseEffect } from '../core/BaseEffect';
import { BaseEffectConfig } from '../core/EffectInterface';
import { 
  calculateLightningPath,
  Point3D,
  PathfindingConfig
} from './PathfindingLogic';

export interface LightningBoltEffectConfig extends BaseEffectConfig {
  startAltitude?: number;    // Height above surface
  color: number;             // Hex color
  lineWidth: number;         // Line thickness
  resolution: number;        // 0-1 scale
  duration: number;          // Animation duration in ms
  speed?: number;            // Animation speed multiplier
}

export const DEFAULT_LIGHTNING_BOLT_CONFIG: LightningBoltEffectConfig = {
  startAltitude: 0.05,
  color: 0xffffff,
  lineWidth: 3.5,
  resolution: 0.5,
  duration: 1500,
  fadeOutDuration: 300,
  speed: 1.0,
};

export class LightningBoltEffect extends BaseEffect {
  private geometry: THREE.BufferGeometry;
  private material: THREE.LineBasicMaterial;
  private mainLine: THREE.Line;
  private group: THREE.Group;
  private config: LightningBoltEffectConfig;
  private pathfindingConfig: PathfindingConfig;
  private startTime: number;

  constructor(
    lat: number,
    lng: number,
    config: Partial<LightningBoltEffectConfig> = {}
  ) {
    super(lat, lng, 0.5);
    this.config = { ...DEFAULT_LIGHTNING_BOLT_CONFIG, ...config };
    this.startTime = performance.now() / 1000;

    this.pathfindingConfig = {
      resolution: this.config.resolution || 0.5,
      heightOffset: this.config.startAltitude || 0.05,
    };

    this.group = new THREE.Group();
    this.group.renderOrder = 20;

    this.geometry = new THREE.BufferGeometry();
    this.material = new THREE.LineBasicMaterial({
      color: this.config.color,
      transparent: true,
      opacity: 0,
      linewidth: this.config.lineWidth,
      depthWrite: false,
    });

    this.mainLine = new THREE.Line(this.geometry, this.material);
    this.group.add(this.mainLine);

    this.registerResource(this.geometry);
    this.registerResource(this.material);
    this.registerResource(this.group);
    this.registerResource(this.mainLine);
  }

  updateSpeed(speed: number): void {
    if (this.config.speed !== speed) {
      this.config.speed = speed;
    }
  }

  setStartTime(time: number): void {
    this.startTime = time;
  }

  initialize(scene: THREE.Scene, globeEl: any): void {
    this.globeEl = globeEl;
    this.scene = scene;
    if (scene && !this.group.parent) {
      scene.add(this.group);
    }

    this.updateLightningGeometry();
  }

  private updateLightningGeometry(): void {
    if (!this.globeEl) return;

    const surfacePoint = this.globeEl.getCoords(this.lat, this.lng, 0);

    // For globe, make cloud point higher above the surface
    // react-globe.gl seems to use a base radius of 100
    const heightFactor = this.config.startAltitude || 0.05;
    const cloudPoint = this.globeEl.getCoords(this.lat, this.lng, heightFactor);

    const endPoint: Point3D = {
      x: surfacePoint.x,
      y: surfacePoint.y,
      z: surfacePoint.z
    };

    const startPoint: Point3D = {
      x: cloudPoint.x,
      y: cloudPoint.y,
      z: cloudPoint.z
    };

    // Override start point in pathfinding config
    this.pathfindingConfig.startPoint = startPoint;

    const points = calculateLightningPath(endPoint, this.pathfindingConfig);
    const threePoints = points.map(point => new THREE.Vector3(point.x, point.y, point.z));

    this.geometry.dispose();
    this.geometry = new THREE.BufferGeometry().setFromPoints(threePoints);

    if (this.mainLine.parent === this.group) {
      this.group.remove(this.mainLine);
    }
    this.mainLine = new THREE.Line(this.geometry, this.material);
    this.group.add(this.mainLine);

    this.registerResource(this.geometry);
    this.registerResource(this.mainLine);
  }

  update(currentTime: number): boolean {
    if (this.isTerminated) return false;

    const elapsed = performance.now() / 1000 - this.startTime;
    const speedFactor = this.config.speed || 1.0;
    const scaledElapsed = elapsed * speedFactor;
    const totalDuration = this.config.duration / 1000;

    if (scaledElapsed > totalDuration) {
      this.terminateImmediately();
      return false;
    }

    const phaseLength = totalDuration / 3;

    if (scaledElapsed < phaseLength) {
      // Fade in
      this.material.opacity = scaledElapsed / phaseLength;
    }
    else if (scaledElapsed < phaseLength * 2) {
      // Full brightness
      this.material.opacity = 1.0;
    } 
    else {
      // Fade out
      const fadeProgress = (scaledElapsed - phaseLength * 2) / phaseLength;
      this.material.opacity = Math.max(0, 1.0 - fadeProgress);
    }

    return true;
  }

  updateStartAltitude(altitude: number): void {
    if (this.config.startAltitude !== altitude) {
      this.config.startAltitude = altitude;
      this.pathfindingConfig.heightOffset = altitude;

      if (this.globeEl && this.scene) {
        this.updateLightningGeometry();
      }
    }
  }

  positionOnGlobe(lat: number, lng: number, altitude: number = 0): void {
    if (!this.globeEl) return;

    this.lat = lat;
    this.lng = lng;

    if (this.globeEl && this.scene) {
      this.updateLightningGeometry();
    }

    this.group.position.set(0, 0, 0);
    this.group.quaternion.identity();
    this.group.scale.set(1, 1, 1);
  }

  terminateImmediately(): void {
    this.material.opacity = 0;
    super.terminateImmediately();
  }

  getObject(): THREE.Group {
    return this.group;
  }

  dispose(): void {
    super.dispose();
  }
}