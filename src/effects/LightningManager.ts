import * as THREE from 'three';
import { LightningEffect, LightningConfig } from './LightningEffect';
import { LightningStrike } from '../models/LightningStrike';

/**
 * Manager for creating and updating lightning effects on the globe
 */
export class LightningManager {
  private effects: Map<string, LightningEffect> = new Map();
  private pointMarkers: Map<string, THREE.Mesh> = new Map();
  private scene: THREE.Scene | null = null;
  private globeEl: any | null = null;
  private defaultConfig: Partial<LightningConfig>;
  private _showLightning: boolean = true;
  public maxActiveAnimations: number = 10;
  public showGlow: boolean = true;

  /**
   * Set the showLightning flag and update all active effects
   */
  set showLightning(value: boolean) {
    if (this._showLightning !== value) {
      this._showLightning = value;

      if (!value) {
        this.clearAllLightningEffects();
      }
    }
  }

  /**
   * Get the showLightning flag
   */
  get showLightning(): boolean {
    return this._showLightning;
  }
  private activeEffects: {id: string, timestamp: number}[] = [];

  /**
   * Create a new lightning manager
   * @param config Optional default configuration for all lightning effects
   */
  constructor(config: Partial<LightningConfig> = {}) {
    this.defaultConfig = config;
    this.maxActiveAnimations = 10; // Default, can be changed
    this.showGlow = true; // Flag to toggle glow effect
    this.showLightning = true; // Flag to toggle lightning lines
  }

  /**
   * Initialize the manager with the globe and scene
   * @param globeEl Reference to the globe component
   */
  initialize(globeEl: any): void {
    this.globeEl = globeEl;

    // Get the Three.js scene from the globe
    if (globeEl) {
      this.scene = globeEl.scene();
    }
  }

  /**
   * Create a lightning effect for a strike
   * @param strike Lightning strike data
   * @param config Optional configuration override
   * @returns The lightning effect's ID
   */
  createLightning(strike: LightningStrike, config?: Partial<LightningConfig>): string {
    if (!this.scene || !this.globeEl) return '';

    if (!this.showLightning) {
      this.createPointMarker(strike);
      return strike.id;
    }

    const mergedConfig: Partial<LightningConfig> = {
      ...this.defaultConfig,
      ...config
    };

    const effect = new LightningEffect(
      strike.lat,
      strike.lng,
      mergedConfig
    );

    // Apply global effect settings
    effect.showGlow = this.showGlow;
    effect.showLightning = this.showLightning;
    effect.positionOnGlobe(this.globeEl, strike.lat, strike.lng, 0);

    const lightning = effect.getObject();
    this.scene.add(lightning);
    this.effects.set(strike.id, effect);

    this.activeEffects.push({
      id: strike.id,
      timestamp: Date.now()
    });

    this.createPointMarker(strike);

    return strike.id;
  }

  /**
   * Update all active lightning effects
   * @param currentTime Current time in milliseconds
   */
  update(currentTime: number): void {
    if (!this.scene) return;

    this.ensureMaxActiveLights();

    this.activeEffects.sort((a, b) => b.timestamp - a.timestamp);

    // Limit active effects to maxActiveAnimations
    const activeIds = new Set(this.activeEffects.map(e => e.id));

    // Update each lightning effect and remove completed ones
    const completedIds: string[] = [];

    this.effects.forEach((effect, id) => {
      const shouldAnimate = activeIds.has(id);
      const isActive = effect.update(currentTime, shouldAnimate);

      if (!isActive) {
        completedIds.push(id);
        this.activeEffects = this.activeEffects.filter(e => e.id !== id);
      }
    });

    this.activeEffects = this.activeEffects.slice(0, this.maxActiveAnimations);

    // Remove completed effects
    completedIds.forEach(id => {
      const effect = this.effects.get(id);
      if (effect) {
        effect.dispose();
        this.effects.delete(id);
      }
    });

    // Fade out older point markers over time
    this.updatePointMarkers(currentTime);
  }

  ensureMaxActiveLights() {
    this.activeEffects.sort((a, b) => b.timestamp - a.timestamp);

    // Keep only the N newest effects active
    if (this.activeEffects.length > this.maxActiveAnimations) {
      const removeIds = this.activeEffects
        .slice(this.maxActiveAnimations)
        .map(e => e.id);

      removeIds.forEach(id => {
        const effect = this.effects.get(id);
        if (effect) {
          effect.terminateImmediately();
          this.activeEffects = this.activeEffects.filter(e => e.id !== id);
        }
      });
    }
  }

  /**
   * Forcefully clear all active lightning effects
   */
  clearAllLightningEffects(): void {
    this.effects.forEach((effect, id) => {
      effect.terminateImmediately();
      effect.dispose();

      // Remove from tracking collections
      this.effects.delete(id);
    });

    this.activeEffects = [];
  }

  /**
   * Get the number of active lightning effects
   */
  getActiveCount(): number {
    return this.effects.size;
  }

  /**
   * Create a persistent point marker at the strike location
   * @param strike Lightning strike data
   * @param currentTime Current time in milliseconds
   */
  private createPointMarker(strike: LightningStrike): void {
    if (!this.scene || !this.globeEl) return;

    // Create circle geometry (flat disc) - 1/4 the size of the original animation
    const radius = 0.08; // Small white circle
    const resolution = 25; // Lower resolution gives better performance
    const geometry = new THREE.CircleGeometry(radius, resolution);

    // Create material for permanent marker (non-glowing)
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff, // white // 0xffaa00, // yellow
      transparent: true,
      opacity: this.showLightning ? 0 : 0.8, // Visible immediately if no lightning
      side: THREE.DoubleSide,
      depthWrite: false
    });

    const marker = new THREE.Mesh(geometry, material);

    // Store creation time for aging effects
    marker.userData = {
      createdAt: Date.now(),
      strikeId: strike.id,
      intensity: strike.intensity || 0.5
    };

    const surfaceCoords = this.globeEl.getCoords(strike.lat, strike.lng, 0.001); // Slightly above surface
    marker.position.set(surfaceCoords.x, surfaceCoords.y, surfaceCoords.z);

    // Orient to face outward from globe center
    const normal = new THREE.Vector3()
      .subVectors(surfaceCoords, new THREE.Vector3(0, 0, 0))
      .normalize();

    marker.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1), // Default circle marker orientation (Z axis)
      normal                       // Direction to face
    );

    this.scene.add(marker);
    this.pointMarkers.set(strike.id, marker);
  }

  /**
   * Update point markers (fade out older ones)
   * @param currentTime Current time in milliseconds
   */
  private updatePointMarkers(currentTime: number): void {
    const maxAge = 60000; // 60 seconds before completely fading out
    const fadeStartAge = 10000; // Start fading after 10 seconds

    const removeIds: string[] = [];

    this.pointMarkers.forEach((marker, id) => {
      const age = currentTime - marker.userData.createdAt;
      // Duration is based on the total lightning animation duration (1.5s total)
      const fadeInDuration = 1500; // Match the lightning animation duration

      // Make markers fade in during the lightning animation
      if (this.showLightning && age < fadeInDuration && marker.material instanceof THREE.Material) {
        // Gradually increase opacity as the lightning animation plays
        const fadeRatio = age / fadeInDuration;
        marker.material.opacity = Math.min(0.8, fadeRatio * 0.8);
      } else if (age > maxAge) {
        removeIds.push(id);
      } else if (age > fadeStartAge && marker.material instanceof THREE.Material) {
        // Gradually reduce opacity for older strikes
        const fadeRatio = 1 - ((age - fadeStartAge) / (maxAge - fadeStartAge));
        marker.material.opacity = Math.min(0.8, fadeRatio * 0.8);
      }
    });

    // Remove old markers
    removeIds.forEach(id => {
      const marker = this.pointMarkers.get(id);
      if (marker) {
        if (marker.geometry) marker.geometry.dispose();
        if (marker.material instanceof THREE.Material) marker.material.dispose();
        if (this.scene) this.scene.remove(marker);
        this.pointMarkers.delete(id);
      }
    });
  }

  /**
   * Clear all lightning effects and point markers
   */
  clear(): void {
    this.effects.forEach(effect => {
      effect.dispose();
    });

    this.pointMarkers.forEach(marker => {
      if (marker.geometry) marker.geometry.dispose();
      if (marker.material instanceof THREE.Material) marker.material.dispose();
      if (this.scene) this.scene.remove(marker);
    });

    this.effects.clear();
    this.pointMarkers.clear();
  }
}
