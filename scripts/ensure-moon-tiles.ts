/**
 * Fast O(1) guard invoked by predev/prebuild. Short-circuits if the
 * moon-tiles output tree is already complete; otherwise delegates to the
 * full slicer (which will also auto-download the source TIFF if missing).
 *
 * Run: npx tsx scripts/ensure-moon-tiles.ts
 */

import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_ROOT = path.join(ROOT, 'public/moon-tiles');
const SENTINEL = path.join(OUT_ROOT, '.complete');

if (fs.existsSync(SENTINEL)) process.exit(0);

console.log('[moon-tiles] Output not present - running build...');
const r = spawnSync('npx', ['tsx', 'scripts/build-moon-tiles.ts'], { cwd: ROOT, stdio: 'inherit' });
process.exit(r.status ?? 1);
