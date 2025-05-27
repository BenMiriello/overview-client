import * as THREE from 'three';
import { Effect } from '../core/EffectInterface';

import { SteppedLeader, ReturnStroke } from './physics';
import { LeaderRenderer, StrokeRenderer, FlashEffect, ScreenFlashEffect } from './rendering';
import { LightningConfig, LightningPhase, LightningCoordinateTransform } from './LightningTypes';

export interface LightningBoltEffectConfig extends LightningConfig {
  duration: number;
  fadeTime: number;
}

export class LightningBoltEffect implements Effect {
  private scene: THREE.Scene;
  private globeEl: any;
  private config: LightningBoltEffectConfig;

  private phase: LightningPhase = LightningPhase.SEARCHING;
  private phaseStartTime: number = 0;
  private stepsTaken: number = 0;

  private coordinateTransform: LightningCoordinateTransform;
  private steppedLeader: SteppedLeader;
  private returnStroke: ReturnStroke | null = null;

  private leaderRenderer: LeaderRenderer;
  private strokeRenderer: StrokeRenderer;
  private flashEffect: FlashEffect | null = null;
  private screenFlash: ScreenFlashEffect | null = null;

  private mainGroup: THREE.Group;

  private isCompleted: boolean = false;
  private isTerminated: boolean = false;

  constructor(scene: THREE.Scene, globeEl: any, config: LightningBoltEffectConfig) {
    this.scene = scene;
    this.globeEl = globeEl;
    this.config = config;

    this.coordinateTransform = new LightningCoordinateTransform(globeEl);

    const start = this.coordinateTransform.toWorldCoordinates(
      config.lat,
      config.lng,
      config.startAltitude
    );

    const ground = this.coordinateTransform.getGroundPoint(config.lat, config.lng);

    this.steppedLeader = new SteppedLeader(start, ground, config.seed);

    this.leaderRenderer = new LeaderRenderer();
    this.strokeRenderer = new StrokeRenderer();

    this.mainGroup = new THREE.Group();
    this.scene.add(this.mainGroup);

    this.phaseStartTime = Date.now();
  }

  update(currentTime: number): void {
    const phaseElapsed = (currentTime - this.phaseStartTime) / 1000;

    switch (this.phase) {
      case LightningPhase.SEARCHING:
        this.updateSearchingPhase(phaseElapsed);
        break;

      case LightningPhase.CONNECTED:
        this.updateConnectedPhase(phaseElapsed);
        break;

      case LightningPhase.STRIKING:
        this.updateStrikingPhase(phaseElapsed);
        break;

      case LightningPhase.FADING:
        this.updateFadingPhase(phaseElapsed);
        break;
    }

    if (this.flashEffect && !this.flashEffect.update()) {
      this.mainGroup.remove(this.flashEffect.getLight());
      this.flashEffect.dispose();
      this.flashEffect = null;
    }

    if (this.screenFlash && !this.screenFlash.update()) {
      this.screenFlash = null;
    }
  }

  private updateSearchingPhase(elapsed: number): void {
    const stepInterval = 0.05; // Slower steps to be visible
    const totalStepsNeeded = Math.floor(elapsed / stepInterval);
    const stepsToTake = totalStepsNeeded - this.stepsTaken;

    for (let i = 0; i < stepsToTake && i < 2; i++) { // Fewer steps per frame
      if (!this.steppedLeader.step()) {
        this.transitionToPhase(LightningPhase.CONNECTED);
        return;
      }
      this.stepsTaken++;
    }

    // Clear previous frame's render
    this.leaderRenderer.clear();

    const leaderGroup = this.leaderRenderer.render(this.steppedLeader.getSegments());
    this.mainGroup.add(leaderGroup);
  }

  private updateConnectedPhase(elapsed: number): void {
    // Keep showing stepped leader during this phase
    const leaderGroup = this.leaderRenderer.render(this.steppedLeader.getSegments());
    this.mainGroup.add(leaderGroup);

    if (elapsed > 0.05) { // Shorter pause
      this.returnStroke = new ReturnStroke(this.steppedLeader.getSegments());
      this.transitionToPhase(LightningPhase.STRIKING);

      if (this.config.enableScreenFlash) {
        this.screenFlash = new ScreenFlashEffect(0.15);
      }
    }
  }

  private updateStrikingPhase(elapsed: number): void {
    if (!this.returnStroke) {
      this.transitionToPhase(LightningPhase.FADING);
      return;
    }

    const flashIntensity = Math.exp(-elapsed * 4);

    // Clear previous renders
    this.leaderRenderer.clear();
    this.mainGroup.clear();

    const strokeGroup = this.strokeRenderer.render(
      this.returnStroke.getStroke(),
      flashIntensity
    );
    this.mainGroup.add(strokeGroup);

    if (!this.flashEffect && elapsed < 0.05) {
      const flash = this.returnStroke.getFlashEffect();
      if (flash) {
        this.flashEffect = new FlashEffect({
          center: new THREE.Vector3(flash.center.x, flash.center.y, flash.center.z),
          intensity: flash.intensity * 2, // Stronger flash
          duration: 0.5,
          color: new THREE.Color(0.9, 0.9, 1.0)
        });
        this.mainGroup.add(this.flashEffect.getLight());
      }
    } else if (this.flashEffect) {
      // Re-add flash effect if it still exists
      this.mainGroup.add(this.flashEffect.getLight());
    }

    if (elapsed > 0.3) { // Shorter strike phase
      this.transitionToPhase(LightningPhase.FADING);
    }
  }

  private updateFadingPhase(elapsed: number): void {
    const fadeProgress = elapsed / this.config.fadeTime;

    if (fadeProgress >= 1) {
      this.markComplete();
      return;
    }

    const opacity = 1 - fadeProgress;
    this.mainGroup.traverse((child) => {
      if (child instanceof THREE.Line) {
        const material = child.material as THREE.LineBasicMaterial;
        material.opacity = material.opacity * opacity;
      }
    });
  }

  private transitionToPhase(newPhase: LightningPhase): void {
    this.phase = newPhase;
    this.phaseStartTime = Date.now();
    this.stepsTaken = 0;
  }

  isComplete(): boolean {
    return this.isCompleted;
  }

  protected markComplete(): void {
    this.isCompleted = true;
  }

  terminate(): void {
    if (this.isTerminated) return;
    this.isTerminated = true;
    this.leaderRenderer.dispose();
    this.strokeRenderer.dispose();

    if (this.flashEffect) {
      this.mainGroup.remove(this.flashEffect.getLight());
      this.flashEffect.dispose();
    }

    if (this.screenFlash) {
      this.screenFlash.dispose();
    }

    if (this.mainGroup.parent) {
      this.mainGroup.parent.remove(this.mainGroup);
    }

    this.mainGroup.traverse((child) => {
      if (child instanceof THREE.Line) {
        child.geometry.dispose();
        if (child.material instanceof THREE.Material) {
          child.material.dispose();
        }
      }
    });
  }
}
