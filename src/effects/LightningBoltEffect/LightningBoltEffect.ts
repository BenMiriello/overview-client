import * as THREE from 'three';
import { simulateBolt, createConfig, DetailLevel, Vec3, AtmosphericModelData } from './simulation';
import { BoltAnimator, createTimeline, AnimationPhase } from './animation';
import { BoltRenderer } from './rendering/BoltRenderer';
import { ScreenFlashEffect } from './rendering/FlashEffect';
import { ChargeFieldRenderer } from './rendering/ChargeFieldRenderer';
import { LightningConfig, LightningCoordinateTransform } from './LightningTypes';

export interface LightningBoltEffectConfig extends LightningConfig {
  duration: number;
  fadeTime: number;
  detailLevel?: DetailLevel;
  worldStart?: Vec3;
  worldEnd?: Vec3;
  speed?: number;
}

export class LightningBoltEffect {
  private config: LightningBoltEffectConfig;

  private animator: BoltAnimator | null = null;
  private renderer: BoltRenderer;
  private chargeRenderer: ChargeFieldRenderer | null = null;
  private screenFlash: ScreenFlashEffect | null = null;
  private screenFlashFired: boolean = false;

  private isCompleted: boolean = false;
  private isTerminated: boolean = false;

  constructor(scene: THREE.Scene, globeEl: any, config: LightningBoltEffectConfig) {
    this.config = config;

    this.renderer = new BoltRenderer(scene);

    const detailLevel = config.detailLevel ?? DetailLevel.GLOBE;
    const simConfig = createConfig(detailLevel);

    let worldStart: Vec3;
    let worldEnd: Vec3;

    if (config.worldStart && config.worldEnd) {
      worldStart = config.worldStart;
      worldEnd = config.worldEnd;
    } else {
      const coordTransform = new LightningCoordinateTransform(globeEl);
      const ws = coordTransform.toWorldCoordinates(config.lat, config.lng, config.startAltitude);
      const we = coordTransform.getGroundPoint(config.lat, config.lng);
      worldStart = { x: ws.x, y: ws.y, z: ws.z };
      worldEnd = { x: we.x, y: we.y, z: we.z };
    }

    const normalizedStart: Vec3 = { x: 0, y: 0.5, z: 0 };
    const normalizedEnd: Vec3 = { x: 0, y: -0.5, z: 0 };

    const result = simulateBolt({
      start: normalizedStart,
      end: normalizedEnd,
      seed: config.seed ?? Date.now(),
      config: simConfig,
    });

    const timeline = createTimeline(result.geometry, detailLevel);
    this.animator = new BoltAnimator(result.geometry, timeline, simConfig, config.speed ?? 1.0);
    this.renderer.setGeometry(result.geometry, worldStart, worldEnd);

    // Create charge field visualization for SHOWCASE mode
    if (detailLevel === DetailLevel.SHOWCASE && result.atmosphere) {
      this.chargeRenderer = new ChargeFieldRenderer(scene, { planeSize: 1.0 });
      this.chargeRenderer.setChargeField(result.atmosphere, worldStart, worldEnd);
    }
  }

  update(currentTime: number): void {
    if (this.isCompleted || this.isTerminated) return;

    if (!this.animator!.isStarted()) {
      this.animator!.start(currentTime);
    }

    const state = this.animator!.update(currentTime);

    if (state.phase === AnimationPhase.COMPLETE) {
      this.isCompleted = true;
      return;
    }

    this.renderer.render(state);

    if (
      state.phase === AnimationPhase.RETURN_STROKE &&
      state.strokeCount === 0 &&
      !this.screenFlashFired &&
      this.config.enableScreenFlash
    ) {
      this.screenFlashFired = true;
      this.screenFlash = new ScreenFlashEffect(0.15);
    }

    if (this.screenFlash && !this.screenFlash.update()) {
      this.screenFlash = null;
    }
  }

  updateResolution(width: number, height: number): void {
    this.renderer.updateResolution(width, height);
  }

  isComplete(): boolean {
    return this.isCompleted;
  }

  terminate(): void {
    if (this.isTerminated) return;
    this.isTerminated = true;

    this.renderer.dispose();

    if (this.chargeRenderer) {
      this.chargeRenderer.dispose();
      this.chargeRenderer = null;
    }

    if (this.screenFlash) {
      this.screenFlash.dispose();
      this.screenFlash = null;
    }
  }

  setChargeVisualization(visible: boolean): void {
    if (this.chargeRenderer) {
      this.chargeRenderer.setVisible(visible);
    }
  }

  isChargeVisualizationVisible(): boolean {
    return this.chargeRenderer?.isVisible() ?? false;
  }

  setAtmosphericChargeVisualization(visible: boolean): void {
    if (this.chargeRenderer) {
      this.chargeRenderer.setAtmosphericVisible(visible);
    }
  }

  isAtmosphericChargeVisualizationVisible(): boolean {
    return this.chargeRenderer?.isAtmosphericVisible() ?? false;
  }
}
