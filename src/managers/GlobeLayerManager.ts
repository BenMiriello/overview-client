import { Layer } from '../layers/LayerInterface';
import { LayerFactory } from '../layers/LayerFactory';

/**
 * Central manager for all globe layers
 * Handles initialization, updates, and configuration of multiple layer types
 */
export class GlobeLayerManager {
  private layers: Map<string, Layer<any>> = new Map();
  private globeEl: any | null = null;
  private animationFrameId: number | null = null;

  initialize(globeEl: any): void {
    this.globeEl = globeEl;

    // Start the animation loop
    this.startAnimationLoop();
  }

  /**
  * Add a layer to the manager
  * @param id Unique identifier for the layer
  * @param layer Layer implementation
  */
  addLayer<T extends Layer<any>>(id: string, layer: T): T {
    // Check if layer with this ID already exists
    if (this.layers.has(id)) {
      console.warn(`Layer with id '${id}' already exists. Removing existing layer.`);
      this.removeLayer(id);
    }
    
    // Initialize the layer with the globe element if it hasn't been already
    if (this.globeEl) {
      layer.initialize(this.globeEl);
    }
    
    // Store the layer with its ID
    this.layers.set(id, layer);
    
    return layer;
  }

  /**
   * Remove a layer by ID
   * @param id Layer identifier
   * @returns true if layer was found and removed, false otherwise
   */
  removeLayer(id: string): boolean {
    const layer = this.layers.get(id);

    if (layer) {
      // Clear the layer and clean up resources
      layer.clear();
      this.layers.delete(id);
      return true;
    }

    return false;
  }

  /**
   * Get a layer by ID with type safety
   * @param id Layer identifier
   * @returns The layer instance or null if not found
   */
  getLayer<T extends Layer<any>>(id: string): T | null {
    const layer = this.layers.get(id);
    return layer as T || null;
  }

  /**
   * Update all layers
   * @param currentTime Current timestamp for animation
   */
  updateAllLayers(currentTime: number = Date.now()): void {
    this.layers.forEach(layer => {
      if (layer.isVisible()) {
        layer.update(currentTime);
      }
    });
  }

  /**
   * Toggle visibility of a layer
   * @param id Layer identifier
   * @returns New visibility state or null if layer not found
   */
  toggleLayer(id: string): boolean | null {
    const layer = this.layers.get(id);

    if (layer) {
      layer.toggle();
      return layer.isVisible();
    }

    return null;
  }

  /**
   * Set visibility of a layer
   * @param id Layer identifier
   * @param visible Visibility state to set
   * @returns true if layer was found, false otherwise
   */
  setLayerVisibility(id: string, visible: boolean): boolean {
    const layer = this.layers.get(id);

    if (layer) {
      if (visible) {
        layer.show();
      } else {
        layer.hide();
      }
      return true;
    }

    return false;
  }

  /**
   * Get IDs of all registered layers
   */
  getLayerIds(): string[] {
    return Array.from(this.layers.keys());
  }

  /**
   * Check if a layer exists
   * @param id Layer identifier
   */
  hasLayer(id: string): boolean {
    return this.layers.has(id);
  }

  clearAllLayers(): void {
    this.layers.forEach(layer => {
      layer.clear();
    });

    this.layers.clear();
  }

  private startAnimationLoop(): void {
    if (this.animationFrameId !== null) {
      return;
    }

    const animate = () => {
      const currentTime = Date.now();
      this.updateAllLayers(currentTime);
      this.animationFrameId = requestAnimationFrame(animate);
    };

    this.animationFrameId = requestAnimationFrame(animate);
  }

  stopAnimationLoop(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  /**
  * Create and add a layer using the LayerFactory
  * @param id Unique identifier for the layer
  * @param type Type of layer to create (e.g., 'lightning', 'cloud')
  * @param config Configuration for the layer
  * @returns The created layer or null if type is unknown
  */
  createLayer<T extends Layer<any>>(id: string, type: string, config?: any): T | null {
    const layer = LayerFactory.createLayer(type, config);
    
    if (layer) {
      // Just add the layer - initialization happens in addLayer
      this.addLayer(id, layer);
      return layer as T;
    }
    
    return null;
  }

  /**
   * Clean up resources when manager is no longer needed
   */
  dispose(): void {
    this.stopAnimationLoop();
    this.clearAllLayers();
    this.globeEl = null;
  }
}
