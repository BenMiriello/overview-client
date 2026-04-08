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

export type TilePatchFn = (material: THREE.MeshLambertMaterial) => void;

export interface TiledPlanetOptions {
  radius: number;
  tileUrl: TileUrlFn;
  maxLevel: number;
  /** Default Web Mercator. Set to 'equirectangular' for NASA Trek-style tiles. */
  projection?: 'mercator' | 'equirectangular';
  /** Called once per tile material as soon as it's constructed. */
  patchMaterial?: TilePatchFn;
  /** Render order applied to each tile mesh — three.js does NOT inherit renderOrder from parent groups. */
  tileRenderOrder?: number;
}

export function createTiledPlanetEngine(opts: TiledPlanetOptions): SlippyMapGlobe {
  const { radius, tileUrl, maxLevel, projection = 'mercator', patchMaterial, tileRenderOrder } = opts;

  const slippyOpts: SlippyMapOptions = {
    tileUrl,
    maxLevel,
    mercatorProjection: projection === 'mercator',
    materialFactory: () => {
      const mat = new THREE.MeshLambertMaterial();
      if (patchMaterial) patchMaterial(mat);
      return mat;
    },
    tileRenderOrder,
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
