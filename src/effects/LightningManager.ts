import * as THREE from 'three';
import { LightningEffect, LightningConfig } from './LightningEffect';
import { LightningStrike } from '../models/LightningStrike';

/**
 * Manager for creating and updating lightning effects on the globe
 */
export class LightningManager {
  private effects: Map<string, LightningEffect> = new Map();
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
      }
    });
  }
  
  /**
   * Get the number of active lightning effects
   */
  getActiveCount(): number {
    return this.effects.size;
  }
  
  /**
   * Clear all lightning effects
   */
  clear(): void {
    // Remove all effects
    this.effects.forEach(effect => {
      effect.dispose();
    });
    
    this.effects.clear();
  }
}
