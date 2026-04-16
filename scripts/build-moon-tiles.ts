/**
 * Slices the NASA SVS "CGI Moon Kit" 16K Hapke-normalized color TIFF
 * into a SlippyMapGlobe-compatible equirectangular tile pyramid.
 *
 * Source (public domain):
 *   https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_16bit_srgb_16k.tif
 *
 * Output: client/public/moon-tiles/{level}/{y}/{x}.jpg, levels 0..5,
 * matching SlippyMapGlobe's gx=2*2^L, gy=2^L equirectangular convention.
 *
 * Run: npx tsx scripts/build-moon-tiles.ts
 */

import sharp from 'sharp';
import path from 'node:path';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const ROOT = path.resolve(import.meta.dirname, '..');
const ASSETS = path.join(ROOT, 'vendor-assets');
const INPUT = path.join(ASSETS, 'lroc_color_16bit_srgb_16k.tif');
const SOURCE_URL = 'https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_16bit_srgb_16k.tif';
const OUT_ROOT = path.join(ROOT, 'public/moon-tiles');
const SENTINEL = path.join(OUT_ROOT, '.complete');
const MAX_LEVEL = 5;
const TILE = 256;
const JPEG_Q = 85;

async function downloadSource(): Promise<void> {
  fs.mkdirSync(ASSETS, { recursive: true });
  const t0 = performance.now();
  console.log('[moon-tiles] Downloading 909 MB source TIFF from SVS (CGI Moon Kit, Hapke-normalized)...');
  console.log(`            ${SOURCE_URL}`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  let received = 0;
  let lastLogged = 0;
  const reader = res.body.getReader();
  const stream = new Readable({
    async read() {
      const { done, value } = await reader.read();
      if (done) { this.push(null); return; }
      received += value.byteLength;
      if (total && received - lastLogged > 50 * 1024 * 1024) {
        lastLogged = received;
        console.log(`            ${(received / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`);
      }
      this.push(value);
    },
  });
  const tmp = INPUT + '.partial';
  await pipeline(stream, fs.createWriteStream(tmp));
  fs.renameSync(tmp, INPUT);
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`[moon-tiles] Source download complete. (${elapsed}s)`);
}

async function logSourceMetadata(): Promise<void> {
  const meta = await sharp(INPUT, { limitInputPixels: false }).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const mPerPxEq = (2 * Math.PI * 1737400) / Math.max(1, w);
  const maxNonUpscaleLevel = Math.floor(Math.log2(w / (TILE * 2)));
  console.log(`[moon-tiles] Source: ${w}x${h} ${meta.format}, ${meta.channels}ch`);
  console.log(`[moon-tiles] Resolution: ${mPerPxEq.toFixed(0)} m/px at equator`);
  console.log(`[moon-tiles] Max level without upscaling: ${maxNonUpscaleLevel}`);
}

async function sliceLevel(level: number): Promise<void> {
  const t0 = performance.now();
  const gx = 2 ** (level + 1);
  const gy = 2 ** level;
  const levelW = TILE * gx;
  const levelH = TILE * gy;

  const { data, info } = await sharp(INPUT, { limitInputPixels: false })
    .resize(levelW, levelH, { kernel: 'lanczos3', fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let y = 0; y < gy; y++) {
    const rowDir = path.join(OUT_ROOT, String(level), String(y));
    fs.mkdirSync(rowDir, { recursive: true });
    for (let x = 0; x < gx; x++) {
      await sharp(data, { raw: info })
        .extract({ left: x * TILE, top: y * TILE, width: TILE, height: TILE })
        .jpeg({ quality: JPEG_Q, mozjpeg: true })
        .toFile(path.join(rowDir, `${x}.jpg`));
    }
  }
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`[moon-tiles] Level ${level}: ${gx * gy} tiles (${elapsed}s)`);
}

(async () => {
  const totalT0 = performance.now();
  if (!fs.existsSync(INPUT)) await downloadSource();
  await logSourceMetadata();
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  for (let l = 0; l <= MAX_LEVEL; l++) await sliceLevel(l);
  fs.writeFileSync(SENTINEL, new Date().toISOString() + '\n');
  const totalElapsed = ((performance.now() - totalT0) / 1000).toFixed(1);
  console.log(`[moon-tiles] Done. Total: ${totalElapsed}s`);
})().catch((e) => { console.error('[moon-tiles] FAILED:', e); process.exit(1); });
