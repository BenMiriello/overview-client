import { Point3D, LeaderSegment } from './SteppedLeader';

export interface ReturnStrokeSegment {
  points: Point3D[];
  intensity: number;
  thickness: number;
}

export class ReturnStroke {
  private mainChannel: Point3D[] = [];

  constructor(private leaderSegments: LeaderSegment[]) {
    this.findMainChannel();
  }

  private findMainChannel(): void {
    const pathToGround = this.findPathToGround();

    if (pathToGround.length === 0) return;

    this.mainChannel = this.smoothPath(pathToGround);
  }

  private findPathToGround(): Point3D[] {
    const mainSegments = this.leaderSegments.filter(s => !s.isBranch && s.depth === 0);

    if (mainSegments.length === 0) return [];

    const path: Point3D[] = [mainSegments[0].start];

    for (const segment of mainSegments) {
      path.push(segment.end);
    }

    return path;
  }

  private smoothPath(path: Point3D[]): Point3D[] {
    if (path.length < 3) return path;

    const smoothed: Point3D[] = [path[0]];

    for (let i = 1; i < path.length - 1; i++) {
      const prev = path[i - 1];
      const curr = path[i];
      const next = path[i + 1];

      smoothed.push({
        x: curr.x * 0.6 + (prev.x + next.x) * 0.2,
        y: curr.y * 0.6 + (prev.y + next.y) * 0.2,
        z: curr.z * 0.6 + (prev.z + next.z) * 0.2
      });
    }

    smoothed.push(path[path.length - 1]);
    return smoothed;
  }

  getStroke(): ReturnStrokeSegment {
    return {
      points: this.mainChannel,
      intensity: 1.0,
      thickness: 3.0
    };
  }

  getFlashEffect(): {center: Point3D, radius: number, intensity: number} | null {
    if (this.mainChannel.length < 2) return null;

    const midIndex = Math.floor(this.mainChannel.length / 2);
    return {
      center: this.mainChannel[midIndex],
      radius: 0.5,
      intensity: 2.0
    };
  }
}
