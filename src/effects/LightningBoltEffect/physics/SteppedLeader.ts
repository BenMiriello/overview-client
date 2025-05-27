import { AtmosphericField, FieldPoint } from './AtmosphericField';

export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export interface LeaderSegment {
  start: Point3D;
  end: Point3D;
  intensity: number;
  isBranch: boolean;
  depth: number;
}

export class SteppedLeader {
  private field: AtmosphericField;
  private segments: LeaderSegment[] = [];
  private activeHeads: Array<{point: Point3D, depth: number}> = [];
  private stepSize: number = 0.05; // Larger steps for more visible progress
  private seed: number;

  constructor(start: Point3D, private target: Point3D, seed: number = Date.now()) {
    this.field = new AtmosphericField(seed);
    this.seed = seed;
    this.activeHeads.push({point: start, depth: 0});
  }

  step(): boolean {
    if (this.activeHeads.length === 0) return false;

    // Prevent infinite loops
    if (this.segments.length > 200) return false;

    const newHeads: Array<{point: Point3D, depth: number}> = [];
    let connected = false;

    for (const head of this.activeHeads) {
      const direction = this.calculateDirection(head.point);
      const newPoint = this.addPoints(head.point, this.scaleVector(direction, this.stepSize));

      const fieldPoint: FieldPoint = {
        ...newPoint,
        field: this.field.getField(newPoint.x, newPoint.y, newPoint.z)
      };

      this.segments.push({
        start: head.point,
        end: newPoint,
        intensity: 0.3 + fieldPoint.field.electricPotential * 0.2,
        isBranch: head.depth > 0,
        depth: head.depth
      });

      if (this.distance(newPoint, this.target) < this.stepSize * 3) { // More forgiving connection distance
        this.segments.push({
          start: newPoint,
          end: this.target,
          intensity: 1.0,
          isBranch: false,
          depth: 0
        });
        connected = true;
        break; // Stop processing other heads once connected
      }

      newHeads.push({point: newPoint, depth: head.depth});

      if (this.field.shouldBranch(fieldPoint) && head.depth < 3) {
        const branchDir = this.calculateBranchDirection(direction);
        const branchPoint = this.addPoints(head.point, this.scaleVector(branchDir, this.stepSize * 0.7));
        newHeads.push({point: branchPoint, depth: head.depth + 1});
      }
    }

    if (connected) {
      return false; // Signal completion
    }

    this.activeHeads = this.filterHeads(newHeads);
    return this.activeHeads.length > 0;
  }

  private calculateDirection(from: Point3D): Point3D {
    const toTarget = this.normalize(this.subtractPoints(this.target, from));
    const randomAngle = this.random() * Math.PI * 2;
    const randomMagnitude = this.random() * 0.4; // More deviation for visibility

    // Create a proper perpendicular vector using cross product
    let perpVector: Point3D;
    if (Math.abs(toTarget.y) < 0.9) {
      // Use up vector for most cases
      perpVector = this.cross(toTarget, {x: 0, y: 1, z: 0});
    } else {
      // Use right vector when pointing mostly up/down
      perpVector = this.cross(toTarget, {x: 1, y: 0, z: 0});
    }
    perpVector = this.normalize(perpVector);

    // Create second perpendicular vector
    const perpVector2 = this.normalize(this.cross(toTarget, perpVector));

    // Random deviation in the plane perpendicular to target direction
    const deviation = {
      x: perpVector.x * Math.cos(randomAngle) * randomMagnitude + perpVector2.x * Math.sin(randomAngle) * randomMagnitude,
      y: perpVector.y * Math.cos(randomAngle) * randomMagnitude + perpVector2.y * Math.sin(randomAngle) * randomMagnitude,
      z: perpVector.z * Math.cos(randomAngle) * randomMagnitude + perpVector2.z * Math.sin(randomAngle) * randomMagnitude
    };

    return this.normalize({
      x: toTarget.x * 0.7 + deviation.x, // Less bias toward target for more zigzag
      y: toTarget.y * 0.8 + deviation.y,
      z: toTarget.z * 0.7 + deviation.z
    });
  }

  private calculateBranchDirection(mainDirection: Point3D): Point3D {
    const angle = this.random() * Math.PI * 0.5 - Math.PI * 0.25;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    return {
      x: mainDirection.x * cos - mainDirection.z * sin,
      y: mainDirection.y + (this.random() - 0.7) * 0.3,
      z: mainDirection.x * sin + mainDirection.z * cos
    };
  }

  private filterHeads(heads: Array<{point: Point3D, depth: number}>): Array<{point: Point3D, depth: number}> {
    return heads.filter((h, i) => {
      if (h.depth === 0) return true;
      if (h.depth > 2) return this.random() > 0.7;
      return this.random() > 0.3;
    }).slice(0, 10);
  }

  getSegments(): LeaderSegment[] {
    return this.segments;
  }

  private random(): number {
    this.seed = (this.seed * 9301 + 49297) % 233280;
    return this.seed / 233280;
  }

  private distance(a: Point3D, b: Point3D): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  private normalize(v: Point3D): Point3D {
    const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    return len > 0 ? this.scaleVector(v, 1 / len) : {x: 0, y: -1, z: 0};
  }

  private addPoints(a: Point3D, b: Point3D): Point3D {
    return {x: a.x + b.x, y: a.y + b.y, z: a.z + b.z};
  }

  private subtractPoints(a: Point3D, b: Point3D): Point3D {
    return {x: a.x - b.x, y: a.y - b.y, z: a.z - b.z};
  }

  private cross(a: Point3D, b: Point3D): Point3D {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x
    };
  }

  private scaleVector(v: Point3D, s: number): Point3D {
    return {x: v.x * s, y: v.y * s, z: v.z * s};
  }
}
