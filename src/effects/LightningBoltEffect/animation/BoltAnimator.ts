import { BoltGeometry } from '../simulation';
import { BoltTimeline } from './BoltTimeline';
import { AnimationPhase, AnimationState } from './types';

export class BoltAnimator {
  private geometry: BoltGeometry;
  private timeline: BoltTimeline;
  private startTime: number = 0;
  private started: boolean = false;

  private segmentById: Map<number, { depth: number; parentSegmentId: number | null; stepIndex: number; intensity: number; isMainChannel: boolean }>;
  private mainChannelReversed: number[];

  constructor(geometry: BoltGeometry, timeline: BoltTimeline) {
    this.geometry = geometry;
    this.timeline = timeline;

    this.segmentById = new Map();
    for (const seg of geometry.segments) {
      this.segmentById.set(seg.id, {
        depth: seg.depth,
        parentSegmentId: seg.parentSegmentId,
        stepIndex: seg.stepIndex,
        intensity: seg.intensity,
        isMainChannel: seg.isMainChannel,
      });
    }

    // Main channel from ground upward (reversed for return stroke)
    this.mainChannelReversed = [...geometry.mainChannelIds].reverse();
  }

  start(currentTime: number): void {
    this.startTime = currentTime;
    this.started = true;
  }

  isStarted(): boolean {
    return this.started;
  }

  update(currentTime: number): AnimationState {
    const elapsed = currentTime - this.startTime;
    return this.computeState(elapsed);
  }

  private computeState(elapsedMs: number): AnimationState {
    const { leaderDuration, connectionPause, returnStrokeDuration, strokeHoldDuration, fadeDuration, interstrokeInterval, subsequentStrokes } = this.timeline;

    const leaderEnd = leaderDuration;
    const pauseEnd = leaderEnd + connectionPause;

    if (elapsedMs < leaderEnd) {
      return this.leaderState(elapsedMs / leaderEnd);
    }

    if (elapsedMs < pauseEnd) {
      return this.connectionPauseState();
    }

    const strokeCycle = returnStrokeDuration + strokeHoldDuration + fadeDuration;
    const fullCycle = strokeCycle + interstrokeInterval;
    const postPause = elapsedMs - pauseEnd;
    const strokeIndex = Math.floor(postPause / fullCycle);

    if (strokeIndex >= subsequentStrokes) {
      return this.completeState();
    }

    const withinCycle = postPause - strokeIndex * fullCycle;

    if (withinCycle < returnStrokeDuration) {
      return this.returnStrokeState(withinCycle / returnStrokeDuration, strokeIndex);
    }

    if (withinCycle < returnStrokeDuration + strokeHoldDuration) {
      const holdProgress = (withinCycle - returnStrokeDuration) / strokeHoldDuration;
      return this.strokeHoldState(holdProgress, strokeIndex);
    }

    if (withinCycle < strokeCycle) {
      const fadeProgress = (withinCycle - returnStrokeDuration - strokeHoldDuration) / fadeDuration;
      return this.fadingState(fadeProgress, strokeIndex);
    }

    return this.interstrokeState(strokeIndex);
  }

  private leaderState(progress: number): AnimationState {
    const targetStep = Math.floor(progress * this.timeline.totalSteps);
    const visible = new Set<number>();
    const brightness = new Map<number, number>();

    for (const seg of this.geometry.segments) {
      if (seg.stepIndex <= targetStep) {
        visible.add(seg.id);
        const age = targetStep - seg.stepIndex;
        const b = Math.max(0.3, 1 - age * 0.02) * seg.intensity;
        brightness.set(seg.id, b);
      }
    }

    return {
      phase: AnimationPhase.LEADER_STEPPING,
      phaseProgress: progress,
      visibleSegments: visible,
      segmentBrightness: brightness,
      returnStrokePosition: 0,
      strokeCount: 0,
    };
  }

  private connectionPauseState(): AnimationState {
    const visible = new Set<number>();
    const brightness = new Map<number, number>();

    for (const seg of this.geometry.segments) {
      visible.add(seg.id);
      brightness.set(seg.id, seg.isMainChannel ? 0.5 : 0.3);
    }

    return {
      phase: AnimationPhase.CONNECTION_PAUSE,
      phaseProgress: 1,
      visibleSegments: visible,
      segmentBrightness: brightness,
      returnStrokePosition: 0,
      strokeCount: 0,
    };
  }

  private returnStrokeState(progress: number, strokeIndex: number): AnimationState {
    const peak = Math.pow(0.8, strokeIndex);
    const allIds = this.geometry.segments.map(s => s.id);
    const visible = new Set(allIds);
    const brightness = new Map<number, number>();

    const mainChannel = this.mainChannelReversed;
    const litCount = Math.floor(progress * mainChannel.length);

    for (let i = 0; i < mainChannel.length; i++) {
      const segId = mainChannel[i];
      if (i < litCount) {
        const decay = 1 - (litCount - i) * 0.01;
        brightness.set(segId, Math.max(0.8, decay) * peak);
      } else if (i === litCount) {
        brightness.set(segId, 1.0 * peak);
      } else {
        brightness.set(segId, 0.2 * peak);
      }
    }

    for (const seg of this.geometry.segments) {
      if (!seg.isMainChannel) {
        const parentBrightness = brightness.get(seg.parentSegmentId!) ?? 0;
        brightness.set(seg.id, parentBrightness * 0.3 * Math.exp(-seg.depth * 0.5));
      }
    }

    return {
      phase: AnimationPhase.RETURN_STROKE,
      phaseProgress: progress,
      visibleSegments: visible,
      segmentBrightness: brightness,
      returnStrokePosition: progress,
      strokeCount: strokeIndex,
    };
  }

  private strokeHoldState(holdProgress: number, strokeIndex: number): AnimationState {
    const peak = Math.pow(0.8, strokeIndex);
    const allIds = this.geometry.segments.map(s => s.id);
    const visible = new Set(allIds);
    const brightness = new Map<number, number>();

    const decay = Math.exp(-holdProgress * 2);

    for (const seg of this.geometry.segments) {
      if (seg.isMainChannel) {
        brightness.set(seg.id, peak * decay);
      } else {
        brightness.set(seg.id, 0.2 * Math.exp(-seg.depth * 0.5) * peak * decay);
      }
    }

    return {
      phase: AnimationPhase.STROKE_HOLD,
      phaseProgress: holdProgress,
      visibleSegments: visible,
      segmentBrightness: brightness,
      returnStrokePosition: 1,
      strokeCount: strokeIndex,
    };
  }

  private fadingState(fadeProgress: number, strokeIndex: number): AnimationState {
    const peak = Math.pow(0.8, strokeIndex);
    const allIds = this.geometry.segments.map(s => s.id);
    const visible = new Set(allIds);
    const brightness = new Map<number, number>();

    for (const seg of this.geometry.segments) {
      const base = seg.isMainChannel ? peak : 0.2 * Math.exp(-seg.depth * 0.5) * peak;
      const mainFade = seg.isMainChannel ? (1 - fadeProgress * 0.7) : (1 - fadeProgress);
      brightness.set(seg.id, base * Math.max(0, mainFade));
    }

    return {
      phase: AnimationPhase.FADING,
      phaseProgress: fadeProgress,
      visibleSegments: visible,
      segmentBrightness: brightness,
      returnStrokePosition: 1,
      strokeCount: strokeIndex,
    };
  }

  private interstrokeState(strokeIndex: number): AnimationState {
    const allIds = this.geometry.segments.map(s => s.id);
    const visible = new Set(allIds);
    const brightness = new Map<number, number>();

    for (const seg of this.geometry.segments) {
      brightness.set(seg.id, seg.isMainChannel ? 0.1 : 0.05);
    }

    return {
      phase: AnimationPhase.INTERSTROKE,
      phaseProgress: 1,
      visibleSegments: visible,
      segmentBrightness: brightness,
      returnStrokePosition: 1,
      strokeCount: strokeIndex,
    };
  }

  private completeState(): AnimationState {
    return {
      phase: AnimationPhase.COMPLETE,
      phaseProgress: 1,
      visibleSegments: new Set(),
      segmentBrightness: new Map(),
      returnStrokePosition: 1,
      strokeCount: this.timeline.subsequentStrokes,
    };
  }
}
