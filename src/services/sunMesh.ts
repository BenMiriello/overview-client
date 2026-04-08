import * as THREE from 'three';
import { getSunPosition } from './astronomy';

export const SUN_CORE_SCALE = 800;
export const SUN_HALO_SCALE = 4000;

const HALO_OPACITY_DEFAULT = 0.05; // barely-there glow when sun is unblocked
const HALO_OPACITY_ECLIPSE = 0.6;  // visible corona when Earth blocks the sun

function makeRadialTexture(
  innerColor: [number, number, number],
  outerAlphaFalloff: number,
  size = 128,
): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const r = size / 2;
  const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
  const [cr, cg, cb] = innerColor;
  grad.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, 1)`);
  grad.addColorStop(outerAlphaFalloff, `rgba(${cr}, ${cg}, ${cb}, 0.4)`);
  grad.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createSunGroup(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'sun';

  // Core: tight bright disc
  const coreTex = makeRadialTexture([255, 255, 240], 0.35);
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

  // Halo: broad warm glow. Opacity is updated each frame by `updateSunHalo`.
  const haloTex = makeRadialTexture([255, 230, 180], 0.15);
  const haloMat = new THREE.SpriteMaterial({
    map: haloTex,
    blending: THREE.AdditiveBlending,
    depthTest: true,
    depthWrite: false,
    transparent: true,
    opacity: HALO_OPACITY_DEFAULT,
  });
  const halo = new THREE.Sprite(haloMat);
  halo.scale.setScalar(SUN_HALO_SCALE);
  halo.name = 'sunHalo';
  group.add(halo);

  return group;
}

/**
 * Set the halo's opacity from a continuous occlusion fraction in [0, 1] —
 * 0 = sun fully visible, 1 = photosphere fully hidden by Earth. The corona is
 * overwhelmed by the photosphere when the sun is unblocked, so we keep the
 * glow faint by default and ramp it up smoothly as the sun is covered.
 */
export function updateSunHalo(group: THREE.Group, occludedFraction: number): void {
  const halo = group.getObjectByName('sunHalo') as THREE.Sprite | undefined;
  if (!halo) return;
  const f = THREE.MathUtils.clamp(occludedFraction, 0, 1);
  const opacity = HALO_OPACITY_DEFAULT + (HALO_OPACITY_ECLIPSE - HALO_OPACITY_DEFAULT) * f;
  (halo.material as THREE.SpriteMaterial).opacity = opacity;
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
