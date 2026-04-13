import * as THREE from 'three';
import { getSunPosition } from './astronomy';

export const SUN_CORE_SCALE = 800;
export const SUN_HALO_SCALE = 4000;

const HALO_OPACITY_SPACE   = 0.18; // visible glow against dark star field
const HALO_OPACITY_ECLIPSE = 0.65; // bright corona when Earth blocks the photosphere

function makeSunCoreTexture(size = 256): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const r = size / 2;
  const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
  // Flat-top disc with a fast falloff at the limb — looks like an actual solar disc.
  grad.addColorStop(0,    'rgba(255, 255, 240, 1)');
  grad.addColorStop(0.55, 'rgba(255, 255, 220, 1)');
  grad.addColorStop(0.75, 'rgba(255, 240, 180, 0.6)');
  grad.addColorStop(1.0,  'rgba(255, 220, 150, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeSunHaloTexture(size = 128): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const r = size / 2;
  const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0,    'rgba(255, 230, 180, 1)');
  grad.addColorStop(0.15, 'rgba(255, 220, 160, 0.4)');
  grad.addColorStop(1.0,  'rgba(255, 200, 120, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createSunGroup(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'sun';

  // Core: sharp flat-top disc resembling an actual solar disc.
  const coreTex = makeSunCoreTexture();
  const coreMat = new THREE.SpriteMaterial({
    map: coreTex,
    blending: THREE.AdditiveBlending,
    depthTest: true,
    depthWrite: false,
    transparent: true,
  });
  const core = new THREE.Sprite(coreMat);
  core.scale.setScalar(SUN_CORE_SCALE);
  core.name = 'sunCore';
  group.add(core);

  // Halo: corona glow. Opacity driven each frame by updateSunHalo.
  const haloTex = makeSunHaloTexture();
  const haloMat = new THREE.SpriteMaterial({
    map: haloTex,
    blending: THREE.AdditiveBlending,
    depthTest: true,
    depthWrite: false,
    transparent: true,
    opacity: HALO_OPACITY_SPACE,
  });
  const halo = new THREE.Sprite(haloMat);
  halo.scale.setScalar(SUN_HALO_SCALE);
  halo.name = 'sunHalo';
  group.add(halo);

  return group;
}

/**
 * Updates halo opacity each frame.
 * - occludedFraction [0,1]: how much of the photosphere is hidden by Earth (eclipse progress)
 * - starVisibility [0,1]: scene darkness — 1 = pure dark space, 0 = bright body filling view
 *
 * The corona scales up during eclipse AND is visible in dark space, but dims
 * whenever a bright body washes out the background.
 */
export function updateSunHalo(group: THREE.Group, occludedFraction: number, starVisibility: number): void {
  const halo = group.getObjectByName('sunHalo') as THREE.Sprite | undefined;
  if (!halo) return;
  const f = THREE.MathUtils.clamp(occludedFraction, 0, 1);
  const base = HALO_OPACITY_SPACE + (HALO_OPACITY_ECLIPSE - HALO_OPACITY_SPACE) * f;
  (halo.material as THREE.SpriteMaterial).opacity = base * THREE.MathUtils.clamp(starVisibility, 0, 1);
}

export function updateSunPosition(group: THREE.Group, date: Date): void {
  const pos = getSunPosition(date);
  group.position.copy(pos);
}

export function disposeSunGroup(group: THREE.Group): void {
  group.traverse((obj: any) => {
    if (obj.isSprite) {
      const mat = obj.material as THREE.SpriteMaterial;
      mat.map?.dispose();
      mat.dispose();
    }
  });
}
