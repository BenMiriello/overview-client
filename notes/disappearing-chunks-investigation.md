# Disappearing Globe Chunks — Investigation Context Dump

## The Bug

User sees "constantly different chunks disappearing" on the globe. Symptoms:
- Usually at the EDGE of the screen
- Half or quarter of the globe goes blank at once
- Mid to high altitude zooms primarily, but also in close mode
- Different chunks each time — constantly cycling
- Pre-existing before any of our recent fixes

---

## Code Architecture (Critical Context)

### Three Tile Engines
1. **Day tiles** — npm `three-slippy-map-globe` package (UNMODIFIABLE). Used for Earth day surface (ArcGIS satellite imagery). Found in scene by `obj.traverse(child => Array.isArray(child.thresholds))` → stored in `dayTileEngineRef.current`.
2. **Night tiles** — vendored `src/vendor/SlippyMapGlobe.ts` (MODIFIABLE). GIBS Black Marble, Mercator projection, maxLevel=8, scale=1.0001.
3. **Moon tiles** — two vendored instances: colorEngine (Trek equirect maxLevel=7) and reliefEngine (Trek equirect maxLevel=6).

### Globe radius
`GLOBE_RADIUS = 100` (from three-globe npm package). `EARTH_R = globeEl.current.getGlobeRadius() = 100`.

### Key files
- `src/vendor/SlippyMapGlobe.ts` — vendored tile engine, modifiable
- `src/components/GlobeComponent.tsx` — tick loop, cullEngineTiles, updatePov calls
- `node_modules/three-slippy-map-globe/dist/three-slippy-map-globe.js` — npm day engine, read-only

---

## What We Tried (Chronological)

### Fix 1: Vendored engine `#isInView` — sphere test (COMMITTED, `src/vendor/SlippyMapGlobe.ts`)
**Problem diagnosed**: `#isInView` used a 5-point hull test (`containsPoint` on center + 4 corners). For large tiles (45-90° wide at level 2-4), all 5 hull points can be outside the frustum even when the tile overlaps the screen. Tiles never fetched → blank at edges.

**Fix applied**:
- Added `Sphere` to Three.js imports
- Added `_tmpSphere = new Sphere()` scratch at module scope
- Replaced `hullPnts?: Vector3[]` in TileMeta with `tileRadius?: number`
- Replaced `#isInView` body: uses `frustum.intersectsSphere(_tmpSphere)` where sphere center = `d.centroid` transformed to world space via `applyMatrix4(this.matrixWorld)`, radius = `2 * this.#radius * Math.sin(halfDiag / 2)` (exact chord from centroid to farthest corner)
- Note: `R * sin(θ)` formula underestimates by 17% for large tiles; correct formula is `2R * sin(θ/2)`

**Result**: Should fix night/moon tile edge issues. User says still broken.

### Fix 2: npm day engine synthetic wide-FOV call (IN GlobeComponent.tsx)
**Problem diagnosed**: npm `three-slippy-map-globe` has the SAME 5-point hull `#isInView` test (confirmed by reading `node_modules/three-slippy-map-globe/dist/three-slippy-map-globe.js` lines 2232-2264). Unmodifiable. `containsPoint` test causes same false-negative issue for day tiles.

**Fix applied**: In `GlobeComponent.tsx` tick loop, before calling `dayTileEngineRef.current.updatePov(camera)`, added a pre-call with a synthetic wide-FOV camera:
```typescript
if (!inCloseModeRef.current) {
  const perspCam = camera as THREE.PerspectiveCamera;
  if (perspCam.fov !== undefined) {
    const synth = perspCam.clone() as THREE.PerspectiveCamera;
    synth.fov = Math.min(175, perspCam.fov + 75);
    synth.updateProjectionMatrix();
    dayTileEngineRef.current!.updatePov(synth);
  }
}
dayTileEngineRef.current!.updatePov(camera);
```

**How it works**: npm engine has NO early-return guard in `updatePov` (unlike vendored). Each call fully re-runs. Synthetic call with wider frustum fetches tiles near screen edges. Real call runs after, sets engine state correctly. Tiles already started by synthetic call (d.obj set, d.loading=true) are filtered out by `!d.obj` check in real call — no double-fetch.

**Result**: User says STILL broken.

---

## Things Investigated and Ruled Out (or Unresolved)

### `cullEngineTiles` (GlobeComponent.tsx lines 617-638)
Per-frame horizon test: `c.dot(tmpCullCam) > sphereR * cLen * limbTol` where `limbTol = 0.95`.
- `c` = `mesh.geometry.boundingSphere.center` in engine-local space
- `tmpCullCam` = camera position in engine-local space (via `engine.worldToLocal`)
- `cLen` = `c.length()`, cached as `__cullCLen`
- For equatorial tiles: `cLen ≈ 0.925 * R` (bounding box center of spherical cap is inside sphere)
- Math verified: for D=2R camera, shows tiles up to 61.6° from center vs horizon at 60° → 1.6° buffer. Correct.
- Does NOT appear to be over-aggressive for front-hemisphere tiles
- **However: unverified whether parent transform of day engine affects worldToLocal calculation**
- `EARTH_R = globeRadius = 100` matches actual tile engine radius ✓
- `cLen < sphereR * 0.1` guard skips inner sphere (cLen=0) ✓

### `evictTiles` (lines 833-844)
- `EVICT_AGE_MS = 30_000` — only evicts tiles invisible for 30+ seconds
- Ruled out as cause of "constantly" disappearing (too slow)

### Level changes in npm engine
- Level setter: zoom-in keeps old tiles (depthWrite=false), zoom-out removes upper tiles
- Calls `#fetchNeededTiles` both from setter AND unconditionally in `updatePov` (line 2274)
- `#fetchNeededTiles` IS called on every `updatePov` even if level unchanged ✓

### npm engine `#fetchNeededTiles` behavior
- Filters `!d.obj` (unloaded tiles only)
- Tiles added to scene ONLY AFTER texture loads (`this.add(tile)` in TextureLoader callback)
- NO `MAX_CONCURRENT` limit (unlike vendored engine which has `MAX_CONCURRENT = 16`)
- Octree search radius at mid altitude (D=2R): `(R * 3) = 3R` — captures entire front hemisphere ✓

### Synthetic camera correctness concern (potentially unresolved)
When `perspCam.clone()` is called, the clone has NO parent. When `updateMatrixWorld()` is called inside the npm engine's `#isInView`, the clone's matrixWorld is computed without parent transforms. IF the real camera has a parent with non-identity transform in the react-globe.gl scene graph, the synthetic camera's frustum would use the wrong view matrix. The frustum might point in the wrong direction.
- **This may be a real bug with the synthetic camera approach**
- The real camera call after it would still be correct, but tiles fetched by synthetic call might be wrong tiles

### nightTraverse (lines 847-856)
Sets `MeshBasicMaterial` children invisible, patches `MeshLambertMaterial` tiles with night shader. Does NOT hide tile meshes. Ruled out.

### Star/sky brightness, sun halo, atmosphere
Unrelated to tile visibility. Ruled out.

### ENGINE_MOVE_THRESHOLD = 0.05
With EARTH_R=100, any camera movement > 0.05/100 = 0.05% globe radius triggers updatePov. For a 1° pan at D=2R: moves ~3.5 units. Far exceeds threshold. Ruled out as cause.

### polygonOffset on fallback tiles (vendored engine only)
Added to fix z-fighting between level-0 fallback and current-level tiles. Higher-level tiles get factor=-level (pulled toward camera). Only applies to vendored engine. Unrelated to disappearing chunks in npm day engine.

---

## Key npm Engine Code Facts

```
MAX_LEVEL_TO_RENDER_ALL_TILES = 6
TILE_SEARCH_RADIUS_CAMERA_DISTANCE = 3  // octree search radius = altitude * 3
```

`#isInView` is set in EVERY `updatePov` call. `#fetchNeededTiles` is called UNCONDITIONALLY after level assignment in `updatePov` (line 2274) — NOT just in the level setter.

Level setter early-returns `if (level === prevLevel || prevLevel === undefined)` — but this only skips the depthWrite/tile-removal logic, NOT `#fetchNeededTiles` (which is called explicitly after).

Tiles are added: `d.obj = tile` (immediately), then `this.add(tile)` only after texture loads.
At level ≤ 6: `#isInView` filter STILL APPLIES (it's set by updatePov, and the filter is `isInView || () => true`).

---

## Unresolved Hypotheses (Most Likely Remaining Causes)

### H1: Synthetic camera frustum is wrong (parent transform issue)
If `react-globe.gl` camera has a parent with non-identity transform, `synth.updateMatrixWorld()` (called inside npm engine's `#isInView` lazy init) produces the wrong `matrixWorldInverse`. The synthetic frustum points wrong. Wrong tiles fetched by synthetic call; correct tiles still fetched by real call. Net effect: synthetic call does nothing useful.

**Fix**: Instead of cloning the camera, manually set the synthetic camera's matrixWorld = real camera's matrixWorld, then only change the projection matrix.

### H2: `applyHorizonTilePovs` only covers forward/back axis in close mode
In close mode, `applyHorizonTilePovs` creates synthetic cameras along `lookDir` tilted by `±fovHalf * 0.7/0.8`. This covers nadir/horizon but NOT left/right screen edges. Tiles at left/right edges in close mode would still be missed.

**Fix**: Extend `applyHorizonTilePovs` to also include left/right synthetic cameras, or add a separate left/right coverage pass.

### H3: `cullEngineTiles` is wrong for non-standard engine transforms
If the day tile engine group has an unexpected world matrix (scaling or rotation from react-globe.gl internals), `engine.worldToLocal(cam.position)` would give the wrong camera position in local space, causing incorrect horizon test results. Some front-hemisphere tiles could be misidentified as back-hemisphere.

**Fix**: Test by removing `cullEngineTiles` for the day engine and see if issue resolves.

### H4: Tile loading delay is the real "disappearing"
The user may be interpreting "tiles not yet loaded at screen edges as they pan" as tiles disappearing. Even with the synthetic wide-FOV pre-fetch, if the user pans faster than tiles load, edge tiles appear blank.

**Fix**: Increase synthetic FOV further (e.g., +120° or use 179°), or pre-fetch in MORE directions.

---

## What To Try Next

**Option A (Most targeted)**: Fix the synthetic camera's world matrix:
```typescript
const synth = new THREE.PerspectiveCamera(
  Math.min(175, (camera as THREE.PerspectiveCamera).fov + 75),
  (camera as THREE.PerspectiveCamera).aspect,
  (camera as THREE.PerspectiveCamera).near,
  (camera as THREE.PerspectiveCamera).far
);
synth.matrixWorld.copy(camera.matrixWorld);
synth.matrixWorldInverse.copy(camera.matrixWorldInverse);
synth.updateProjectionMatrix();
dayTileEngineRef.current!.updatePov(synth);
```

**Option B (Test cullEngineTiles)**: Temporarily disable `cullEngineTiles` for day engine:
Comment out line 825: `if (dayTileEngineRef.current) cullEngineTiles(dayTileEngineRef.current, EARTH_R, camera);`
If tiles stop disappearing, culling is the problem.

**Option C (Nuclear isInView fix for day engine)**: Instead of synthetic camera, call updatePov with 5 cameras: real + 4 corner-pointing cameras. Similar to how `applyHorizonTilePovs` works. This guarantees all 4 screen corners have tiles fetched.

**Option D (Extend applyHorizonTilePovs for left/right)**: In close mode, add left/right synthetic cameras alongside the existing nadir/horizon ones.

---

## Recent Commits (This Session's Work)

The fallback rendering fixes were committed as: `0355d0d` "Fix tile fallback rendering: keep lower-level tiles as visible backdrop"

Changes in that commit:
- Level setter: removed `#innerBackLayer.visible = level > 0`, removed depthWrite manipulation
- Zoom-out: replaced `emptyObject` with `deallocate` (fixes GPU memory leak)
- Fetch completion guard: `capturedLevel <= this.#level` (was `===`) — allows fallback tiles
- Tile creation: added `polygonOffset` based on level for depth priority

The `#isInView` sphere test fix + synthetic camera fix are uncommitted changes in the current working tree.

---

## Files Modified (Uncommitted)

- `src/vendor/SlippyMapGlobe.ts`: sphere intersection `#isInView`, `_tmpSphere` scratch, `tileRadius` on TileMeta
- `src/components/GlobeComponent.tsx`: synthetic wide-FOV pre-call for day engine in `updatePov.day` perfSpan
