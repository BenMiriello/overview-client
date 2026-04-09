// Lightweight perf instrumentation gated behind ?perf=1.
// When inactive, all exported functions are no-ops with near-zero cost.
// When active, accumulates per-frame span timings and prints/displays a
// compact summary 2x/sec. Designed to add minimal overhead to the hot path.

type SpanBucket = { totalMs: number; calls: number };

const ENABLED = (() => {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('perf') === '1';
  } catch {
    return false;
  }
})();

const FRAME_HISTORY_SIZE = 600;
const LONG_FRAME_MS = 33;
const LONG_FRAME_WINDOW_MS = 10_000;
const REPORT_INTERVAL_MS = 2_000;

const frameTimes: number[] = [];
const longFrameTimestamps: number[] = [];
let lastFrameAt = 0;
let frameSpans: Map<string, SpanBucket> = new Map();
let lastReportAt = 0;
let lastReportFrameCount = 0;
let totalFramesSinceReport = 0;
let allocCounters = { vec3: 0, mat4: 0 };
let renderInfo = { calls: 0, triangles: 0, textures: 0, geometries: 0, programs: 0 };
let hudEl: HTMLDivElement | null = null;
let installedAllocPatch = false;

export const perfEnabled = ENABLED;

function ensureHUD(): HTMLDivElement | null {
  if (!ENABLED || typeof document === 'undefined') return null;
  if (hudEl) return hudEl;
  hudEl = document.createElement('div');
  hudEl.id = 'perf-hud';
  hudEl.style.cssText = [
    'position:fixed',
    'top:8px',
    'right:8px',
    'z-index:99999',
    'background:rgba(0,0,0,0.72)',
    'color:#9fe89f',
    'font:10px/1.35 ui-monospace,Menlo,monospace',
    'padding:6px 8px',
    'border-radius:4px',
    'pointer-events:none',
    'white-space:pre',
    'max-width:360px',
  ].join(';');
  hudEl.textContent = '[perf] starting...';
  if (document.body) document.body.appendChild(hudEl);
  else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(hudEl!));
  return hudEl;
}

// Wrap THREE.Vector3 / Matrix4 constructors with a Proxy that counts
// allocations. Only runs once, when ?perf=1 is set. Proxy preserves
// the original prototype chain so `instanceof` keeps working.
// Note: this only catches allocations made via the THREE namespace
// import, not direct sub-imports of the class file. Good enough for
// our use because all code in this repo imports from 'three'.
export async function installAllocCounters(): Promise<void> {
  if (!ENABLED || installedAllocPatch) return;
  installedAllocPatch = true;
  try {
    const THREE: any = await import('three');
    const OrigVec3 = THREE.Vector3;
    const OrigMat4 = THREE.Matrix4;
    THREE.Vector3 = new Proxy(OrigVec3, {
      construct(target, args, newTarget) {
        allocCounters.vec3++;
        return Reflect.construct(target, args, newTarget);
      },
    });
    THREE.Matrix4 = new Proxy(OrigMat4, {
      construct(target, args, newTarget) {
        allocCounters.mat4++;
        return Reflect.construct(target, args, newTarget);
      },
    });
  } catch {
    // ignore
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

// Wrap a synchronous callable. Adds the elapsed time to the named bucket
// for the current frame. When perf is disabled, runs the callable directly.
export function span<T>(name: string, fn: () => T): T {
  if (!ENABLED) return fn();
  const start = performance.now();
  try {
    return fn();
  } finally {
    const dt = performance.now() - start;
    let bucket = frameSpans.get(name);
    if (!bucket) {
      bucket = { totalMs: 0, calls: 0 };
      frameSpans.set(name, bucket);
    }
    bucket.totalMs += dt;
    bucket.calls += 1;
  }
}

// Capture THREE.WebGLRenderer.info after a render call.
// Call this right after renderer.render(scene, camera).
export function captureRenderInfo(renderer: any): void {
  if (!ENABLED || !renderer?.info) return;
  const info = renderer.info;
  renderInfo.calls = info.render?.calls ?? 0;
  renderInfo.triangles = info.render?.triangles ?? 0;
  renderInfo.textures = info.memory?.textures ?? 0;
  renderInfo.geometries = info.memory?.geometries ?? 0;
  renderInfo.programs = info.programs?.length ?? 0;
}

// Mark the boundary of a rendered frame. Call once per main RAF tick.
// Tracks frame time, manages history windows, and emits the report line
// at the configured interval.
export function frameMark(): void {
  if (!ENABLED) return;
  const now = performance.now();
  if (lastFrameAt > 0) {
    const dt = now - lastFrameAt;
    frameTimes.push(dt);
    if (frameTimes.length > FRAME_HISTORY_SIZE) frameTimes.shift();
    if (dt > LONG_FRAME_MS) longFrameTimestamps.push(now);
    while (longFrameTimestamps.length > 0 && now - longFrameTimestamps[0] > LONG_FRAME_WINDOW_MS) {
      longFrameTimestamps.shift();
    }
    totalFramesSinceReport++;
  }
  lastFrameAt = now;

  if (lastReportAt === 0) lastReportAt = now;
  if (now - lastReportAt >= REPORT_INTERVAL_MS) {
    emitReport(now);
    lastReportAt = now;
    lastReportFrameCount = totalFramesSinceReport;
    totalFramesSinceReport = 0;
    frameSpans = new Map();
    allocCounters = { vec3: 0, mat4: 0 };
  }
}

function emitReport(now: number): void {
  const elapsedSec = (REPORT_INTERVAL_MS / 1000);
  const fps = totalFramesSinceReport / elapsedSec;
  void lastReportFrameCount;
  const sorted = [...frameTimes].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const p99 = percentile(sorted, 99);
  const long10s = longFrameTimestamps.length;

  let heapMB = 0;
  const mem = (performance as any).memory;
  if (mem && typeof mem.usedJSHeapSize === 'number') {
    heapMB = mem.usedJSHeapSize / (1024 * 1024);
  }

  const spanEntries = [...frameSpans.entries()]
    .map(([name, b]) => ({ name, perFrameMs: b.totalMs / Math.max(1, totalFramesSinceReport) }))
    .sort((a, b) => b.perFrameMs - a.perFrameMs);

  const spanStr = spanEntries
    .map(e => `${e.name}=${fmt(e.perFrameMs, 2)}`)
    .join(' ');

  const allocStr = (allocCounters.vec3 + allocCounters.mat4) > 0
    ? ` alloc/f vec3=${Math.round(allocCounters.vec3 / Math.max(1, totalFramesSinceReport))} mat4=${Math.round(allocCounters.mat4 / Math.max(1, totalFramesSinceReport))}`
    : '';

  const ri = renderInfo;
  const glStr = ri.calls > 0
    ? ` draw=${ri.calls} tri=${(ri.triangles / 1000).toFixed(0)}k tex=${ri.textures} geo=${ri.geometries} prog=${ri.programs}`
    : '';

  const line1 = `[perf] fps=${fmt(fps, 0)} p50=${fmt(p50)} p95=${fmt(p95)} p99=${fmt(p99)} long10s=${long10s} heap=${fmt(heapMB, 0)}MB${glStr}${allocStr}`;
  const line2 = spanStr ? `       ${spanStr}` : '';

  // eslint-disable-next-line no-console
  console.log(line1 + (line2 ? '\n' + line2 : ''));

  const hud = ensureHUD();
  if (hud) {
    hud.textContent = line1 + (line2 ? '\n' + line2 : '');
  }
  void now;
}

// Expose a snapshot for the e2e perf-run script to pull via window.__perf.
if (ENABLED && typeof window !== 'undefined') {
  (window as any).__perf = {
    snapshot: () => ({
      frameTimes: [...frameTimes],
      longFrameWindow: longFrameTimestamps.length,
    }),
    reset: () => {
      frameTimes.length = 0;
      longFrameTimestamps.length = 0;
      totalFramesSinceReport = 0;
      lastReportAt = 0;
      lastReportFrameCount = 0;
      frameSpans = new Map();
      allocCounters = { vec3: 0, mat4: 0 };
    },
  };
  void installAllocCounters();
}
