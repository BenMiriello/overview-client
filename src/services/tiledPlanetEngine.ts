/**
 * Shared factory for tiled planet surface engines (Earth night tiles, Moon
 * color & relief tiles, future planets). Wraps the vendored SlippyMapGlobe
 * with the conventions used throughout this project:
 *   - inner placeholder sphere is hidden
 *   - tile materials get patched the instant they're created (no flash)
 *
 * Earth's *day* tiles are NOT routed through this factory — they go through
 * react-globe.gl's built-in tile engine (see GlobeComponent.tsx). Migrating
 * day tiles is a separate, larger project.
 */

import * as THREE from 'three';
import SlippyMapGlobe, { SlippyMapOptions, TileUrlFn } from '../vendor/SlippyMapGlobe';

export type LambertPatchFn = (material: THREE.MeshLambertMaterial) => void;
export type MaterialFactory = () => THREE.Material;
export type ApplyTextureFn = (material: THREE.Material, texture: THREE.Texture) => void;

export interface TiledPlanetOptions {
  radius: number;
  tileUrl: TileUrlFn;
  maxLevel: number;
  /** Default Web Mercator. Set to 'equirectangular' for NASA Trek-style tiles. */
  projection?: 'mercator' | 'equirectangular';
  /**
   * Provide either `patchMaterial` (shortcut — uses a MeshLambertMaterial and
   * calls this function to patch it) OR `materialFactory` (full control over
   * the material type). If both are provided `materialFactory` wins.
   */
  patchMaterial?: LambertPatchFn;
  materialFactory?: MaterialFactory;
  /**
   * Custom texture binder. Required when using a `materialFactory` that
   * doesn't expose a `.map` property (e.g. `THREE.ShaderMaterial`).
   */
  applyTexture?: ApplyTextureFn;
  /** Render order applied to each tile mesh — three.js does NOT inherit renderOrder from parent groups. */
  tileRenderOrder?: number;
  /** Fired after each tile's texture loads and the tile joins the scene graph. */
  onTileLoaded?: (tile: THREE.Mesh) => void;
}

export function createTiledPlanetEngine(opts: TiledPlanetOptions): SlippyMapGlobe {
  const {
    radius,
    tileUrl,
    maxLevel,
    projection = 'mercator',
    patchMaterial,
    materialFactory,
    applyTexture,
    tileRenderOrder,
    onTileLoaded,
  } = opts;

  const resolvedFactory: MaterialFactory =
    materialFactory ??
    (() => {
      const mat = new THREE.MeshLambertMaterial();
      if (patchMaterial) patchMaterial(mat);
      return mat;
    });

  const slippyOpts: SlippyMapOptions = {
    tileUrl,
    maxLevel,
    mercatorProjection: projection === 'mercator',
    materialFactory: resolvedFactory,
    applyTexture,
    tileRenderOrder,
    onTileLoaded,
  };

  const engine = new SlippyMapGlobe(radius, slippyOpts);

  // Hide inner placeholder sphere — engines stack on a real planet mesh
  // (or are the only thing rendered, in which case the placeholder would
  // show through transparency layers).
  engine.children.forEach((child) => {
    const m = child as THREE.Mesh;
    if (m.isMesh && (m.material as THREE.Material & { isMeshBasicMaterial?: boolean })?.isMeshBasicMaterial) {
      m.visible = false;
    }
  });

  return engine;
}
