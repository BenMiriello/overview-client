import * as THREE from 'three';
import { simulateBolt, createConfig, DetailLevel, Vec3, AtmosphericModel, SimulationOutput } from './simulation';
import { BoltAnimator, createTimeline, AnimationPhase } from './animation';
import { BoltRenderer } from './rendering/BoltRenderer';
import { ScreenFlashEffect } from './rendering/FlashEffect';
import { ChargeFieldRenderer } from './rendering/ChargeFieldRenderer';
import { LightningConfig, LightningCoordinateTransform } from './LightningTypes';
import { CoordinateTransform } from './CoordinateTransform';

export interface LightningBoltEffectConfig extends LightningConfig {
  duration: number;
  fadeTime: number;
  detailLevel?: DetailLevel;
  worldStart?: Vec3;
  worldEnd?: Vec3;
  speed?: number;
  atmosphere?: AtmosphericModel;
  skipChargeRendering?: boolean;
  precomputedResult?: SimulationOutput;
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

  // Strike position for post-dissipation
  private strikeStartPosition: Vec3 | null = null;
  private mainChannelPath: Vec3[] = [];
  private mainChannelIds: Set<number> = new Set();

  // Shared coordinate transform
  private transform: CoordinateTransform | null = null;

  constructor(scene: THREE.Scene, globeEl: any, config: LightningBoltEffectConfig) {
    this.config = config;

    const detailLevel = config.detailLevel ?? DetailLevel.GLOBE;
    const baseLineWidth = 1.0;
    this.renderer = new BoltRenderer(scene, baseLineWidth);
    const resolution = config.resolution ?? 1.0;

    // Scale simulation parameters based on resolution
    const baseConfig = createConfig(detailLevel);
    const simConfig = createConfig(detailLevel, {
      stepLength: baseConfig.stepLength / resolution,
      maxSteps: Math.round(baseConfig.maxSteps * resolution),
      candidateCount: Math.round(baseConfig.candidateCount * Math.sqrt(resolution)),
      maxSegments: Math.round(baseConfig.maxSegments * resolution),
    });

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

    // Use precomputed result if provided, otherwise compute synchronously
    const result = config.precomputedResult ?? simulateBolt({
      start: normalizedStart,
      end: normalizedEnd,
      seed: config.seed ?? Date.now(),
      config: simConfig,
    }, config.atmosphere);

    const timeline = createTimeline(result.geometry, detailLevel);
    this.animator = new BoltAnimator(result.geometry, timeline, simConfig, config.speed ?? 1.0);
    this.renderer.setGeometry(result.geometry, worldStart, worldEnd);

    // Create shared coordinate transform
    this.transform = new CoordinateTransform(worldStart, worldEnd);

    // Store main channel IDs
    this.mainChannelIds = new Set(result.geometry.mainChannelIds);

    // Store strike position from first main channel segment
    const mainSegments = result.geometry.segments.filter(s => s.isMainChannel);
    if (mainSegments.length > 0) {
      // Sort by stepIndex to find the starting segment
      mainSegments.sort((a, b) => a.stepIndex - b.stepIndex);
      this.strikeStartPosition = { ...mainSegments[0].start };

      // Store main channel path for dissipation calculation
      this.mainChannelPath = mainSegments.map(s => ({ ...s.start }));
      if (mainSegments.length > 0) {
        this.mainChannelPath.push({ ...mainSegments[mainSegments.length - 1].end });
      }
    }

    // Translate bolt so the main channel's ground-strike point aligns with worldEnd
    if (this.mainChannelPath.length > 0 && this.transform) {
      const landingNormalized = this.mainChannelPath[this.mainChannelPath.length - 1];
      const landingWorld = this.transform.toWorld(landingNormalized);
      const group = this.renderer.getGroup();
      group.position.set(
        worldEnd.x - landingWorld.x,
        worldEnd.y - landingWorld.y,
        worldEnd.z - landingWorld.z,
      );
    }

    // Create charge field visualization for SHOWCASE mode (unless skipped)
    if (detailLevel === DetailLevel.SHOWCASE && result.atmosphere && !config.skipChargeRendering) {
      this.chargeRenderer = new ChargeFieldRenderer(scene, { planeSize: 1.0 });
      this.chargeRenderer.setChargeField(result.atmosphere, worldStart, worldEnd, this.transform);
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
      window.dispatchEvent(new CustomEvent('lightning-flash', {
        detail: { lat: this.config.lat, lng: this.config.lng },
      }));
    }

    if (this.screenFlash && !this.screenFlash.update()) {
      this.screenFlash = null;
    }
  }

  setSpeed(speed: number): void {
    if (this.animator) {
      this.animator.setSpeed(speed);
    }
  }

  setLineWidthScale(scale: number): void {
    this.renderer.setLineWidthScale(scale);
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

    // Release simulation data (large Maps/Sets) so GC can reclaim JS memory
    this.animator = null;
    this.transform = null;
    this.mainChannelPath = [];
    this.mainChannelIds = new Set();
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

  setMoistureVisualization(visible: boolean): void {
    if (this.chargeRenderer) {
      this.chargeRenderer.setMoistureVisible(visible);
    }
  }

  isMoistureVisualizationVisible(): boolean {
    return this.chargeRenderer?.isMoistureVisible() ?? false;
  }

  setIonizationVisualization(visible: boolean): void {
    if (this.chargeRenderer) {
      this.chargeRenderer.setIonizationVisible(visible);
    }
  }

  isIonizationVisualizationVisible(): boolean {
    return this.chargeRenderer?.isIonizationVisible() ?? false;
  }

  /**
   * Get the starting position of the strike (for post-strike dissipation).
   */
  getStrikeStartPosition(): Vec3 | null {
    return this.strikeStartPosition;
  }

  /**
   * Get the main channel path (for calculating dissipation radius).
   */
  getMainChannelPath(): Vec3[] {
    return this.mainChannelPath;
  }

  /**
   * Transform a point from normalized simulation space to world space.
   */
  private normalizedToWorld(point: Vec3): Vec3 {
    if (!this.transform) {
      return point;
    }
    return this.transform.toWorld(point);
  }

  /**
   * Get the world-space position where the strike lands (end of main channel).
   */
  getStrikeLandingPosition(): Vec3 | null {
    if (this.mainChannelPath.length === 0) return null;
    const normalizedEnd = this.mainChannelPath[this.mainChannelPath.length - 1];
    return this.normalizedToWorld(normalizedEnd);
  }

  /**
   * Get current animation state (for synchronizing external effects like ground glow).
   */
  getAnimationState(currentTime: number): {
    phase: AnimationPhase;
    phaseProgress: number;
    strokeCount: number;
    segmentBrightness: Map<number, number>;
    mainChannelIds: Set<number>;
  } | null {
    if (!this.animator || !this.animator.isStarted() || this.isCompleted || this.isTerminated) {
      return null;
    }
    const state = this.animator.update(currentTime);
    return {
      phase: state.phase,
      phaseProgress: state.phaseProgress,
      strokeCount: state.strokeCount,
      segmentBrightness: state.segmentBrightness,
      mainChannelIds: this.mainChannelIds,
    };
  }
}
