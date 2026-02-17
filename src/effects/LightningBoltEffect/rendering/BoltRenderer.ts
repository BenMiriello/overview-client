import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { BoltGeometry, Vec3 } from '../simulation';
import { AnimationState } from '../animation';
import { LightningMaterials } from './LightningMaterials';
import { CoordinateTransform } from '../CoordinateTransform';

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
  private glowGroup: DepthGroup | null = null;

  private segmentIndexMap: Map<number, { depthBucket: number; indexInGroup: number }> = new Map();

  private transform: CoordinateTransform | null = null;

  constructor(scene: THREE.Scene) {
    this.group = new THREE.Group();
    this.materials = new LightningMaterials();
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

    const mainSegs = geometry.segments.filter(s => s.isMainChannel);
    if (mainSegs.length > 0) {
      this.glowGroup = this.createGlowGroup(mainSegs);
      this.glowGroup.line.renderOrder = 999;
      this.group.add(this.glowGroup.line);
    }
  }

  render(state: AnimationState): void {
    const BRIGHTNESS_THRESHOLD = 0.05;

    for (const [bucket, group] of this.depthGroups) {
      const { colors, segmentIds, geometry: geom } = group;
      const mat = this.materials.getMaterialForDepth(bucket);
      const baseColor = new THREE.Color(mat.color);

      for (let i = 0; i < segmentIds.length; i++) {
        const segId = segmentIds[i];
        const rawBrightness = state.segmentBrightness.get(segId) ?? 0;
        const visible = state.visibleSegments.has(segId);
        const alpha = (visible && rawBrightness >= BRIGHTNESS_THRESHOLD) ? rawBrightness : 0;

        const r = baseColor.r * alpha;
        const g = baseColor.g * alpha;
        const b = baseColor.b * alpha;

        const ci = i * 6;
        colors[ci] = r;
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

    if (this.glowGroup) {
      const { colors, segmentIds, geometry: geom } = this.glowGroup;

      for (let i = 0; i < segmentIds.length; i++) {
        const segId = segmentIds[i];
        const rawBrightness = state.segmentBrightness.get(segId) ?? 0;
        const visible = state.visibleSegments.has(segId);
        const alpha = (visible && rawBrightness >= BRIGHTNESS_THRESHOLD) ? rawBrightness * 0.4 : 0;

        const ci = i * 6;
        colors[ci] = 0.67 * alpha;
        colors[ci + 1] = 0.8 * alpha;
        colors[ci + 2] = 1.0 * alpha;
        colors[ci + 3] = 0.67 * alpha;
        colors[ci + 4] = 0.8 * alpha;
        colors[ci + 5] = 1.0 * alpha;
      }

      geom.setColors(colors);
      geom.getAttribute('instanceColorStart').needsUpdate = true;
      geom.getAttribute('instanceColorEnd').needsUpdate = true;
    }
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

    if (this.glowGroup) {
      this.glowGroup.geometry.dispose();
      this.group.remove(this.glowGroup.line);
      this.glowGroup = null;
    }

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

  private createGlowGroup(segments: BoltGeometry['segments']): DepthGroup {
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
    }

    const geom = new LineSegmentsGeometry();
    geom.setPositions(positions);
    geom.setColors(colors);

    const mat = this.materials.getGlowMaterial();
    const line = new LineSegments2(geom, mat);
    line.computeLineDistances();

    return { segmentIds, positions, colors, geometry: geom, line, depth: 0 };
  }
}
