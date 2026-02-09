import { BoltGeometry, DetailLevel } from '../simulation';

export interface BoltTimeline {
  leaderDuration: number;
  connectionPause: number;
  returnStrokeDuration: number;
  strokeHoldDuration: number;
  fadeDuration: number;
  subsequentStrokes: number;
  interstrokeInterval: number;

  totalSteps: number;
  connectionStep: number;
  mainChannelLength: number;
}

const TIMELINE_PRESETS: Record<DetailLevel, Omit<BoltTimeline, 'totalSteps' | 'connectionStep' | 'mainChannelLength'>> = {
  [DetailLevel.GLOBE]: {
    leaderDuration: 250,
    connectionPause: 20,
    returnStrokeDuration: 40,
    strokeHoldDuration: 60,
    fadeDuration: 300,
    subsequentStrokes: 1,
    interstrokeInterval: 40,
  },
  [DetailLevel.SHOWCASE]: {
    leaderDuration: 800,
    connectionPause: 30,
    returnStrokeDuration: 60,
    strokeHoldDuration: 100,
    fadeDuration: 500,
    subsequentStrokes: 1,
    interstrokeInterval: 50,
  },
};

export function createTimeline(geometry: BoltGeometry, detailLevel: DetailLevel): BoltTimeline {
  const preset = TIMELINE_PRESETS[detailLevel];

  let mainChannelLength = 0;
  const mainSet = new Set(geometry.mainChannelIds);
  for (const seg of geometry.segments) {
    if (mainSet.has(seg.id)) {
      const dx = seg.end.x - seg.start.x;
      const dy = seg.end.y - seg.start.y;
      const dz = seg.end.z - seg.start.z;
      mainChannelLength += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
  }

  return {
    ...preset,
    totalSteps: geometry.totalSteps,
    connectionStep: geometry.connectionStep,
    mainChannelLength,
  };
}
