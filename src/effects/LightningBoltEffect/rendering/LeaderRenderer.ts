import * as THREE from 'three';
import { LeaderSegment } from '../physics';

export class LeaderRenderer {
  private group: THREE.Group;
  private material: THREE.LineBasicMaterial;

  constructor() {
    this.group = new THREE.Group();
    this.material = new THREE.LineBasicMaterial({
      color: 0xaaaaff,
      transparent: true,
      opacity: 0.8,
      linewidth: 2
    });
  }

  render(segments: LeaderSegment[]): THREE.Group {
    this.clear();

    const segmentsByDepth = new Map<number, LeaderSegment[]>();

    for (const segment of segments) {
      const depth = segment.depth;
      if (!segmentsByDepth.has(depth)) {
        segmentsByDepth.set(depth, []);
      }
      segmentsByDepth.get(depth)!.push(segment);
    }

    for (const [depth, depthSegments] of segmentsByDepth) {
      const points: THREE.Vector3[] = [];

      for (const segment of depthSegments) {
        points.push(
          new THREE.Vector3(segment.start.x, segment.start.y, segment.start.z),
          new THREE.Vector3(segment.end.x, segment.end.y, segment.end.z)
        );
      }

      if (points.length > 0) {
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = this.material.clone();
        material.opacity = 0.8 - depth * 0.2;
        material.color = new THREE.Color(0.7 - depth * 0.1, 0.7 - depth * 0.1, 1.0);

        const line = new THREE.LineSegments(geometry, material);
        line.renderOrder = 1000 - depth;
        this.group.add(line);
      }
    }

    return this.group;
  }

  clear(): void {
    while (this.group.children.length > 0) {
      const child = this.group.children[0];
      if (child instanceof THREE.LineSegments) {
        child.geometry.dispose();
        if (child.material instanceof THREE.Material) {
          child.material.dispose();
        }
      }
      this.group.remove(child);
    }
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
  }
}
