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
  private circleMarkers: Map<string, THREE.Mesh> = new Map();
  private scene: THREE.Scene | null = null;
  private globeEl: any | null = null;
  private defaultConfig: Partial<LightningConfig>;
  
  /**
   * Create a new lightning manager
   * @param config Optional default configuration for all lightning effects
   */
  constructor(config: Partial<LightningConfig> = {}) {
    this.defaultConfig = config;
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
    
    // Position on globe
    effect.positionOnGlobe(this.globeEl, strike.lat, strike.lng, 0);
    
    // Add to scene
    const lightning = effect.getObject();
    this.scene.add(lightning);
    
    // Store the effect with the strike ID
    this.effects.set(strike.id, effect);
    
    // Create a persistent circle marker at the strike location
    this.createCircleMarker(strike);
    
    return strike.id;
  }
  
  /**
   * Update all active lightning effects
   * @param currentTime Current time in milliseconds
   */
  update(currentTime: number): void {
    // Don't do anything if not initialized
    if (!this.scene) return;
    
    // Update each lightning effect and remove completed ones
    const completedIds: string[] = [];
    
    this.effects.forEach((effect, id) => {
      const isActive = effect.update(currentTime);
      
      // If the effect is done, mark for removal
      if (!isActive) {
        completedIds.push(id);
      }
    });
    
    // Remove completed effects
    completedIds.forEach(id => {
      const effect = this.effects.get(id);
      if (effect) {
        effect.dispose();
        this.effects.delete(id);
        
        // Make sure the circle marker is visible after lightning is gone
        const circle = this.circleMarkers.get(id);
        if (circle && circle.material instanceof THREE.Material) {
          circle.material.opacity = 0.8;
        }
      }
    });
    
    // Fade out older circle markers over time
    this.updateCircleMarkers(currentTime);
  }
  
  /**
   * Get the number of active lightning effects
   */
  getActiveCount(): number {
    return this.effects.size;
  }
  
  /**
   * Create a persistent circle marker at the strike location
   * @param strike Lightning strike data
   */
  private createCircleMarker(strike: LightningStrike): void {
    if (!this.scene || !this.globeEl) return;
    
    // Create circle geometry (flat disc)
    const radius = 0.25; // Circle radius in degrees (slightly smaller than before)
    const resolution = 16; // Higher resolution for smoother circle
    const geometry = new THREE.CircleGeometry(radius, resolution);
    
    // Create material with glow-like appearance
    const material = new THREE.MeshBasicMaterial({
      color: strike.intensity ? getIntensityColor(strike.intensity) : 0xffffff,
      transparent: true,
      opacity: 0.1, // Start with low opacity as lightning is active
      side: THREE.DoubleSide,
      depthWrite: false, // To avoid z-fighting issues
      blending: THREE.AdditiveBlending // Give it a glow effect
    });
    
    // Create mesh
    const circle = new THREE.Mesh(geometry, material);
    
    // Store creation time for aging effects
    circle.userData = {
      createdAt: Date.now(),
      strikeId: strike.id,
      intensity: strike.intensity || 0.5
    };
    
    // Position on globe surface
    const surfaceCoords = this.globeEl.getCoords(strike.lat, strike.lng, 0.001); // Slightly above surface
    circle.position.set(surfaceCoords.x, surfaceCoords.y, surfaceCoords.z);
    
    // Orient to face outward from globe center
    const normal = new THREE.Vector3()
      .subVectors(surfaceCoords, new THREE.Vector3(0, 0, 0))
      .normalize();
    
    circle.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1), // Default circle orientation (Z axis)
      normal                       // Direction to face
    );
    
    // Add to scene
    this.scene.add(circle);
    
    // Store with strike ID for later reference
    this.circleMarkers.set(strike.id, circle);
  }
  
  /**
   * Update circle markers (fade out older ones)
   * @param currentTime Current time in milliseconds
   */
  private updateCircleMarkers(currentTime: number): void {
    const maxAge = 30000; // 30 seconds before completely fading out
    const fadeStartAge = 10000; // Start fading after 10 seconds
    
    // Remove very old markers
    const removeIds: string[] = [];
    
    this.circleMarkers.forEach((circle, id) => {
      // Each marker stores creation time in a custom property
      if (!circle.userData.createdAt) {
        // Initialize if not yet set
        circle.userData.createdAt = currentTime;
      }
      
      const age = currentTime - circle.userData.createdAt;
      
      if (age > maxAge) {
        // Mark for removal if too old
        removeIds.push(id);
      } else if (age > fadeStartAge && circle.material instanceof THREE.Material) {
        // Gradually reduce opacity for older strikes
        const fadeRatio = 1 - ((age - fadeStartAge) / (maxAge - fadeStartAge));
        circle.material.opacity = Math.min(0.8, fadeRatio * 0.8);
      }
    });
    
    // Remove old markers
    removeIds.forEach(id => {
      const circle = this.circleMarkers.get(id);
      if (circle) {
        if (circle.geometry) circle.geometry.dispose();
        if (circle.material instanceof THREE.Material) circle.material.dispose();
        if (this.scene) this.scene.remove(circle);
        this.circleMarkers.delete(id);
      }
    });
  }
  
  /**
   * Clear all lightning effects and circle markers
   */
  clear(): void {
    // Remove all effects
    this.effects.forEach(effect => {
      effect.dispose();
    });
    
    // Remove all circle markers
    this.circleMarkers.forEach(circle => {
      if (circle.geometry) circle.geometry.dispose();
      if (circle.material instanceof THREE.Material) circle.material.dispose();
      if (this.scene) this.scene.remove(circle);
    });
    
    this.effects.clear();
    this.circleMarkers.clear();
  }
}
