import * as THREE from 'three';
import { LightningEffect, LightningConfig } from './LightningEffect';
import { LightningStrike } from '../models/LightningStrike';

/**
 * Helper function to get a color based on strike intensity
 */
function getIntensityColor(intensity: number): number {
  // Default to white if no intensity data
  if (intensity === undefined) return 0xffffff;

  // Map intensity to a color
  if (intensity > 0.8) {
    return 0xff4500; // Strong strike - Orange/Red
  } else if (intensity > 0.5) {
    return 0xffaa00; // Medium strike - Yellow
  } else {
    return 0xaaccff; // Weak strike - Light Blue
  }
}

/**
 * Manager for creating and updating lightning effects on the globe
 */
export class LightningManager {
  private effects: Map<string, LightningEffect> = new Map();
  private pointMarkers: Map<string, THREE.Mesh> = new Map();
  private scene: THREE.Scene | null = null;
  private globeEl: any | null = null;
  private defaultConfig: Partial<LightningConfig>;

  // New properties for limiting active animations
  public maxActiveAnimations: number = 10;
  public showGlow: boolean = true;
  public showLightning: boolean = true;
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

    // Merge configs with defaults then any strike-specific config
    const mergedConfig: Partial<LightningConfig> = {
      ...this.defaultConfig,
      ...config
    };

    // Create a new lightning effect
    const effect = new LightningEffect(
      strike.lat,
      strike.lng,
      mergedConfig
    );

    // Apply global effect settings
    effect.showGlow = this.showGlow;
    effect.showLightning = this.showLightning;

    // Position on globe
    effect.positionOnGlobe(this.globeEl, strike.lat, strike.lng, 0);

    // Add to scene
    const lightning = effect.getObject();
    this.scene.add(lightning);

    // Store the effect with the strike ID
    this.effects.set(strike.id, effect);

    // Add to active effects list
    this.activeEffects.push({
      id: strike.id,
      timestamp: Date.now()
    });

    // Create a persistent point marker at the strike location
    this.createPointMarker(strike);

    return strike.id;
  }

  /**
   * Update all active lightning effects
   * @param currentTime Current time in milliseconds
   */
  update(currentTime: number): void {
    // Don't do anything if not initialized
    if (!this.scene) return;

    this.ensureMaxActiveLights();

    // Sort effects by timestamp (newest first)
    this.activeEffects.sort((a, b) => b.timestamp - a.timestamp);

    // Limit active effects to maxActiveAnimations
    const activeIds = new Set(this.activeEffects.map(e => e.id));
    // const activeIds = new Set(this.activeEffects.slice(0, this.maxActiveAnimations).map(e => e.id));

    // Update each lightning effect and remove completed ones
    const completedIds: string[] = [];

    this.effects.forEach((effect, id) => {
      // Only allow animation for effects in the active set
      const shouldAnimate = activeIds.has(id);

      // Pass the animation flag to the effect
      const isActive = effect.update(currentTime, shouldAnimate);

      // If the effect is done, mark for removal
      if (!isActive) {
        completedIds.push(id);
        // Remove from active effects list
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

        // Make sure the point marker is visible after lightning is gone
        const marker = this.pointMarkers.get(id);
        if (marker && marker.material instanceof THREE.Material) {
          marker.material.opacity = 0.8;
        }
      }
    });

    // Fade out older point markers over time
    this.updatePointMarkers(currentTime);
  }

  ensureMaxActiveLights() {
    // Sort by timestamp (newest first)
    this.activeEffects.sort((a, b) => b.timestamp - a.timestamp);
    
    // Keep only the N newest effects active
    if (this.activeEffects.length > this.maxActiveAnimations) {
      // Get the IDs that should be immediately deactivated
      const removeIds = this.activeEffects
        .slice(this.maxActiveAnimations)
        .map(e => e.id);

      // Force-terminate these effects
      removeIds.forEach(id => {
        const effect = this.effects.get(id);
        if (effect) {
          // Remove the light completely from the scene
          effect.terminateImmediately();
          // Remove from active list
          this.activeEffects = this.activeEffects.filter(e => e.id !== id);
        }
      });
    }
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
   */
  private createPointMarker(strike: LightningStrike): void {
    if (!this.scene || !this.globeEl) return;

    // Create circle geometry (flat disc) - 1/4 the size of the original animation
    const radius = 0.0625; // Small white circle, 1/4 the size of the original
    const resolution = 12; // Lower resolution for better performance
    const geometry = new THREE.CircleGeometry(radius, resolution);

    // Create material for permanent marker (non-glowing)
    const material = new THREE.MeshBasicMaterial({
      color: strike.intensity ? getIntensityColor(strike.intensity) : 0xffffff,
      transparent: true,
      opacity: 0, // Start invisible while lightning is active
      side: THREE.DoubleSide,
      depthWrite: false
    });

    // Create mesh
    const marker = new THREE.Mesh(geometry, material);

    // Store creation time for aging effects
    marker.userData = {
      createdAt: Date.now(),
      strikeId: strike.id,
      intensity: strike.intensity || 0.5
    };

    // Position on globe surface
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

    // Add to scene
    this.scene.add(marker);

    // Store with strike ID for later reference
    this.pointMarkers.set(strike.id, marker);
  }

  /**
   * Update point markers (fade out older ones)
   * @param currentTime Current time in milliseconds
   */
  private updatePointMarkers(currentTime: number): void {
    const maxAge = 60000; // 60 seconds before completely fading out
    const fadeStartAge = 10000; // Start fading after 10 seconds

    // Remove very old markers
    const removeIds: string[] = [];

    this.pointMarkers.forEach((marker, id) => {
      // Each marker stores creation time in a custom property
      if (!marker.userData.createdAt) {
        // Initialize if not yet set
        marker.userData.createdAt = currentTime;
      }

      const age = currentTime - marker.userData.createdAt;

      if (age > maxAge) {
        // Mark for removal if too old
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
    // Remove all effects
    this.effects.forEach(effect => {
      effect.dispose();
    });

    // Remove all point markers
    this.pointMarkers.forEach(marker => {
      if (marker.geometry) marker.geometry.dispose();
      if (marker.material instanceof THREE.Material) marker.material.dispose();
      if (this.scene) this.scene.remove(marker);
    });

    this.effects.clear();
    this.pointMarkers.clear();
  }
}
