import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { BoltGeometry, Vec3 } from '../simulation';
import { AnimationState } from '../animation';
import { LightningMaterials } from './LightningMaterials';

interface DepthGroup {
  segmentIds: number[];
  positions: Float32Array;
  colors: Float32Array;
  geometry: LineSegmentsGeometry;
  line: LineSegments2;
}

export class BoltRenderer {
  private group: THREE.Group;
  private materials: LightningMaterials;
  private depthGroups: Map<number, DepthGroup> = new Map();
  private glowGroup: DepthGroup | null = null;

  private segmentIndexMap: Map<number, { depth: number; indexInGroup: number }> = new Map();

  private worldOrigin: Vec3 = { x: 0, y: 0, z: 0 };
  private worldScale: number = 1;
  private rotationMatrix: THREE.Matrix4 = new THREE.Matrix4();

  constructor(scene: THREE.Scene) {
    this.group = new THREE.Group();
    this.materials = new LightningMaterials();
    scene.add(this.group);
  }

  setGeometry(geometry: BoltGeometry, worldStart: Vec3, worldEnd: Vec3): void {
    this.clear();

    const dx = worldEnd.x - worldStart.x;
    const dy = worldEnd.y - worldStart.y;
    const dz = worldEnd.z - worldStart.z;
    this.worldScale = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this.worldOrigin = {
      x: (worldStart.x + worldEnd.x) / 2,
      y: (worldStart.y + worldEnd.y) / 2,
      z: (worldStart.z + worldEnd.z) / 2,
    };

    // Compute rotation from simulation axis to world direction
    // Simulation runs from Y=+0.5 to Y=-0.5, so axis is (0, -1, 0)
    const worldDir = new THREE.Vector3(dx, dy, dz).normalize();
    const simAxis = new THREE.Vector3(0, -1, 0);

    this.rotationMatrix.identity();
    const dot = simAxis.dot(worldDir);

    if (dot > 0.9999) {
      // Already aligned, keep identity
    } else if (dot < -0.9999) {
      // Opposite direction, rotate 180 degrees around X
      this.rotationMatrix.makeRotationAxis(new THREE.Vector3(1, 0, 0), Math.PI);
    } else {
      // General case: axis-angle rotation
      const axis = new THREE.Vector3().crossVectors(simAxis, worldDir).normalize();
      const angle = Math.acos(dot);
      this.rotationMatrix.makeRotationAxis(axis, angle);
    }

    // Group segments by depth
    const byDepth = new Map<number, typeof geometry.segments>();
    for (const seg of geometry.segments) {
      const depth = Math.min(seg.depth, 3);
      let arr = byDepth.get(depth);
      if (!arr) {
        arr = [];
        byDepth.set(depth, arr);
      }
      arr.push(seg);
    }

    // Create a LineSegments2 for each depth tier
    for (const [depth, segs] of byDepth) {
      const group = this.createDepthGroup(segs, depth);
      this.depthGroups.set(depth, group);
      group.line.renderOrder = 1000 - depth;
      this.group.add(group.line);
    }

    // Create glow line from main channel segments
    const mainSegs = geometry.segments.filter(s => s.isMainChannel);
    if (mainSegs.length > 0) {
      this.glowGroup = this.createGlowGroup(mainSegs);
      this.glowGroup.line.renderOrder = 999;
      this.group.add(this.glowGroup.line);
    }
  }

  render(state: AnimationState): void {
    // Update each depth group's colors based on brightness
    for (const [depth, group] of this.depthGroups) {
      const { colors, segmentIds, geometry: geom } = group;
      const mat = this.materials.getMaterialForDepth(depth);
      const baseColor = new THREE.Color(mat.color);

      for (let i = 0; i < segmentIds.length; i++) {
        const segId = segmentIds[i];
        const brightness = state.segmentBrightness.get(segId) ?? 0;
        const visible = state.visibleSegments.has(segId);
        const alpha = visible ? brightness : 0;

        const r = baseColor.r * alpha;
        const g = baseColor.g * alpha;
        const b = baseColor.b * alpha;

        // Each segment has 2 points, each with RGB = 6 color values
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

    // Update glow
    if (this.glowGroup) {
      const { colors, segmentIds, geometry: geom } = this.glowGroup;

      for (let i = 0; i < segmentIds.length; i++) {
        const segId = segmentIds[i];
        const brightness = state.segmentBrightness.get(segId) ?? 0;
        const visible = state.visibleSegments.has(segId);
        const alpha = visible ? brightness * 0.4 : 0;

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
    // Apply rotation first to align simulation space with world direction
    const v = new THREE.Vector3(normalized.x, normalized.y, normalized.z);
    v.applyMatrix4(this.rotationMatrix);

    // Then scale and translate to world position
    return {
      x: v.x * this.worldScale + this.worldOrigin.x,
      y: v.y * this.worldScale + this.worldOrigin.y,
      z: v.z * this.worldScale + this.worldOrigin.z,
    };
  }

  private createDepthGroup(segments: BoltGeometry['segments'], depth: number): DepthGroup {
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

      this.segmentIndexMap.set(seg.id, { depth, indexInGroup: i });
    }

    const geom = new LineSegmentsGeometry();
    geom.setPositions(positions);
    geom.setColors(colors);

    const mat = this.materials.getMaterialForDepth(depth);
    const line = new LineSegments2(geom, mat);
    line.computeLineDistances();

    return { segmentIds, positions, colors, geometry: geom, line };
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

    return { segmentIds, positions, colors, geometry: geom, line };
  }
}
