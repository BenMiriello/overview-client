import * as THREE from 'three';

// Fetches cloud_cover_low/mid/high from Open-Meteo on a coarse global grid
// and bakes normalized layer weights into an RGB DataTexture.
// R = low fraction, G = mid fraction, B = high fraction.
// When no data is available, defaults to R=1 (all clouds in low layer).

const LAT_COUNT = 18;
const LNG_COUNT = 36;
const GRID_STEP = 10;
const REFRESH_MS = 30 * 60 * 1000;

const LATS = Array.from({ length: LAT_COUNT }, (_, i) => 85 - i * GRID_STEP);
const LNGS = Array.from({ length: LNG_COUNT }, (_, i) => -175 + i * GRID_STEP);

let texture: THREE.DataTexture | null = null;
let timer: number | null = null;
let fetching = false;

function createDefaultTexture(): THREE.DataTexture {
  const data = new Uint8Array(LNG_COUNT * LAT_COUNT * 4);
  for (let i = 0; i < LNG_COUNT * LAT_COUNT; i++) {
    data[i * 4] = 255;       // R = low = 1.0
    data[i * 4 + 1] = 0;     // G = mid = 0
    data[i * 4 + 2] = 0;     // B = high = 0
    data[i * 4 + 3] = 255;   // A
  }
  const tex = new THREE.DataTexture(data, LNG_COUNT, LAT_COUNT, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

async function fetchAndBake(): Promise<void> {
  if (fetching) return;
  fetching = true;
  try {
    const lats: number[] = [];
    const lngs: number[] = [];
    for (const lat of LATS) {
      for (const lng of LNGS) {
        lats.push(lat);
        lngs.push(lng);
      }
    }

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats.join(',')}&longitude=${lngs.join(',')}&current=cloud_cover_low,cloud_cover_mid,cloud_cover_high`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Open-Meteo ${resp.status}`);
    const json = await resp.json();

    if (!Array.isArray(json) || json.length !== lats.length) {
      throw new Error(`Unexpected response: got ${json?.length ?? 'non-array'}, expected ${lats.length}`);
    }

    const pixels = new Uint8Array(LNG_COUNT * LAT_COUNT * 4);
    for (let i = 0; i < json.length; i++) {
      const cur = json[i]?.current;
      const low = (cur?.cloud_cover_low ?? 0) / 100;
      const mid = (cur?.cloud_cover_mid ?? 0) / 100;
      const high = (cur?.cloud_cover_high ?? 0) / 100;
      const total = low + mid + high;

      let r: number, g: number, b: number;
      if (total < 0.01) {
        r = 255; g = 0; b = 0;
      } else {
        r = Math.round((low / total) * 255);
        g = Math.round((mid / total) * 255);
        b = Math.round((high / total) * 255);
      }
      pixels[i * 4] = r;
      pixels[i * 4 + 1] = g;
      pixels[i * 4 + 2] = b;
      pixels[i * 4 + 3] = 255;
    }

    // Box blur to soften grid-cell edges. Longitude wraps, latitude clamps.
    const blurred = new Uint8Array(pixels.length);
    for (let y = 0; y < LAT_COUNT; y++) {
      for (let x = 0; x < LNG_COUNT; x++) {
        let rSum = 0, gSum = 0, bSum = 0, count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= LAT_COUNT) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = ((x + dx) % LNG_COUNT + LNG_COUNT) % LNG_COUNT;
            const idx = (ny * LNG_COUNT + nx) * 4;
            rSum += pixels[idx];
            gSum += pixels[idx + 1];
            bSum += pixels[idx + 2];
            count++;
          }
        }
        const out = (y * LNG_COUNT + x) * 4;
        blurred[out] = Math.round(rSum / count);
        blurred[out + 1] = Math.round(gSum / count);
        blurred[out + 2] = Math.round(bSum / count);
        blurred[out + 3] = 255;
      }
    }

    if (!texture) {
      texture = new THREE.DataTexture(blurred, LNG_COUNT, LAT_COUNT, THREE.RGBAFormat);
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
    } else {
      (texture.image.data as Uint8Array).set(blurred);
    }
    texture.needsUpdate = true;
    console.log('[cloudCover] Open-Meteo layer data refreshed');
  } catch (err) {
    console.warn('[cloudCover] fetch failed:', err);
  } finally {
    fetching = false;
  }
}

export function getLayerTexture(): THREE.DataTexture {
  if (!texture) {
    texture = createDefaultTexture();
  }
  return texture;
}

export function start(): void {
  if (timer !== null) return;
  fetchAndBake();
  timer = window.setInterval(fetchAndBake, REFRESH_MS);
}

export function stop(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
