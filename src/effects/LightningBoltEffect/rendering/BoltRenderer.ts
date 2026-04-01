import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { BoltGeometry, Vec3 } from '../simulation';
import { AnimationState, AnimationPhase } from '../animation';
import { LightningMaterials } from './LightningMaterials';
import { CoordinateTransform } from '../CoordinateTransform';

// Continuing current colors: transition from white -> orange -> red during decay
const WHITE = new THREE.Color(1.0, 1.0, 1.0);
const ORANGE = new THREE.Color(1.0, 0.6, 0.2);
const DIM_RED = new THREE.Color(0.8, 0.3, 0.1);

interface DepthGroup {
  segmentIds: number[];
  positions: Float32Array;
  colors: Float32Array;
  geometry: LineSegmentsGeometry;
  line: LineSegments2;
  depth: number;
}

function getDepthBucket(depth: number): number {
  return Math.round(depth * 10) / 10;
}

export class BoltRenderer {
  private group: THREE.Group;
  private materials: LightningMaterials;
  private depthGroups: Map<number, DepthGroup> = new Map();

  private segmentIndexMap: Map<number, { depthBucket: number; indexInGroup: number }> = new Map();

  private transform: CoordinateTransform | null = null;

  constructor(scene: THREE.Scene, baseLineWidth?: number) {
    this.group = new THREE.Group();
    this.materials = new LightningMaterials(baseLineWidth);
    scene.add(this.group);
  }

  setGeometry(geometry: BoltGeometry, worldStart: Vec3, worldEnd: Vec3): void {
    this.clear();

    this.transform = new CoordinateTransform(worldStart, worldEnd);

    const byDepthBucket = new Map<number, typeof geometry.segments>();
    for (const seg of geometry.segments) {
      const bucket = getDepthBucket(seg.depth);
      let arr = byDepthBucket.get(bucket);
      if (!arr) {
        arr = [];
        byDepthBucket.set(bucket, arr);
      }
      arr.push(seg);
    }

    const sortedBuckets = [...byDepthBucket.keys()].sort((a, b) => a - b);

    for (const bucket of sortedBuckets) {
      const segs = byDepthBucket.get(bucket)!;
      const depthGroup = this.createDepthGroup(segs, bucket);
      this.depthGroups.set(bucket, depthGroup);
      depthGroup.line.renderOrder = 1000 - Math.floor(bucket * 10);
      this.group.add(depthGroup.line);
    }
  }

  render(state: AnimationState): void {
    const BRIGHTNESS_THRESHOLD = 0.05;
    // MaxEquation blending prevents accumulation at junctions, so full brightness is safe.
    const MAX_BRIGHTNESS = 0.9;

    // Compute continuing current color based on phase
    const continuingColor = this.getContinuingCurrentColor(state);

    for (const [bucket, group] of this.depthGroups) {
      const { colors, segmentIds, geometry: geom } = group;
      const mat = this.materials.getMaterialForDepth(bucket);
      const baseColor = new THREE.Color(mat.color);

      // Blend base color with continuing current color during decay phases
      const blendedColor = this.blendWithContinuingCurrent(baseColor, continuingColor, state);

      for (let i = 0; i < segmentIds.length; i++) {
        const segId = segmentIds[i];
        const rawBrightness = state.segmentBrightness.get(segId) ?? 0;
        const visible = state.visibleSegments.has(segId);
        const alpha = (visible && rawBrightness >= BRIGHTNESS_THRESHOLD)
          ? Math.min(rawBrightness, MAX_BRIGHTNESS)
          : 0;

        const r = blendedColor.r * alpha;
        const g = blendedColor.g * alpha;
        const b = blendedColor.b * alpha;

        const ci = i * 6;
        colors[ci]     = r;
        colors[ci + 1] = g;
        colors[ci + 2] = b;
        colors[ci + 3] = r;
        colors[ci + 4] = g;
        colors[ci + 5] = b;
      }

      geom.setColors(colors);
      geom.getAttribute('instanceColorStart').needsUpdate = true;
      geom.getAttribute('instanceColorEnd').needsUpdate = true;
    }
  }

  private getContinuingCurrentColor(state: AnimationState): THREE.Color {
    // Only apply continuing current color during stroke hold and fading
    if (state.phase === AnimationPhase.STROKE_HOLD) {
      // During hold: transition white -> orange
      const t = state.phaseProgress;
      return WHITE.clone().lerp(ORANGE, t * 0.7);
    } else if (state.phase === AnimationPhase.FADING) {
      // During fade: transition orange -> dim red
      const t = state.phaseProgress;
      return ORANGE.clone().lerp(DIM_RED, t);
    }
    return WHITE;
  }

  private blendWithContinuingCurrent(
    baseColor: THREE.Color,
    continuingColor: THREE.Color,
    state: AnimationState
  ): THREE.Color {
    // Only blend during post-stroke phases
    if (state.phase === AnimationPhase.STROKE_HOLD ||
        state.phase === AnimationPhase.FADING) {
      // Stronger blend as we progress through decay
      const blendAmount = state.phase === AnimationPhase.FADING
        ? 0.5 + state.phaseProgress * 0.5
        : state.phaseProgress * 0.4;
      return baseColor.clone().lerp(continuingColor, blendAmount);
    }
    return baseColor;
  }

  setLineWidthScale(scale: number): void {
    this.materials.setLineWidthScale(scale);
  }

  updateResolution(width: number, height: number): void {
    this.materials.updateResolution(width, height);
  }

  getGroup(): THREE.Group {
    return this.group;
  }

  dispose(): void {
    this.clear();
    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }
    this.materials.dispose();
  }

  private clear(): void {
    for (const [, group] of this.depthGroups) {
      group.geometry.dispose();
      this.group.remove(group.line);
    }
    this.depthGroups.clear();
    this.segmentIndexMap.clear();
  }

  private toWorld(normalized: Vec3): Vec3 {
    if (!this.transform) {
      return normalized;
    }
    return this.transform.toWorld(normalized);
  }

  private createDepthGroup(segments: BoltGeometry['segments'], depthBucket: number): DepthGroup {
    const n = segments.length;
    const positions = new Float32Array(n * 6);
    const colors = new Float32Array(n * 6);
    const segmentIds: number[] = [];

    for (let i = 0; i < n; i++) {
      const seg = segments[i];
      segmentIds.push(seg.id);

      const ws = this.toWorld(seg.start);
      const we = this.toWorld(seg.end);

      positions[i * 6] = ws.x;
      positions[i * 6 + 1] = ws.y;
      positions[i * 6 + 2] = ws.z;
      positions[i * 6 + 3] = we.x;
      positions[i * 6 + 4] = we.y;
      positions[i * 6 + 5] = we.z;

      this.segmentIndexMap.set(seg.id, { depthBucket, indexInGroup: i });
    }

    const geom = new LineSegmentsGeometry();
    geom.setPositions(positions);
    geom.setColors(colors);

    const mat = this.materials.getMaterialForDepth(depthBucket);
    const line = new LineSegments2(geom, mat);
    line.computeLineDistances();

    return { segmentIds, positions, colors, geometry: geom, line, depth: depthBucket };
  }
}
