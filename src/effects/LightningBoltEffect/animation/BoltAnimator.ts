import { BoltGeometry } from '../simulation';
import { BoltTimeline } from './BoltTimeline';
import { AnimationPhase, AnimationState } from './types';

export class BoltAnimator {
  private geometry: BoltGeometry;
  private timeline: BoltTimeline;
  private speed: number;
  private startTime: number = 0;
  private started: boolean = false;

  private segmentById: Map<number, { depth: number; parentSegmentId: number | null; stepIndex: number; intensity: number; isMainChannel: boolean }>;
  private mainChannelReversed: number[];
  private connectedSegments: Set<number>;

  constructor(geometry: BoltGeometry, timeline: BoltTimeline, speed: number = 1.0) {
    this.geometry = geometry;
    this.timeline = timeline;
    this.speed = Math.max(0.01, speed); // Prevent 0 or negative speeds

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

    // Build set of segments connected to main channel
    this.connectedSegments = new Set(geometry.mainChannelIds);
    const mainChannelSet = new Set(geometry.mainChannelIds);
    for (const seg of geometry.segments) {
      if (!seg.isMainChannel && seg.parentSegmentId !== null) {
        if (mainChannelSet.has(seg.parentSegmentId) || this.connectedSegments.has(seg.parentSegmentId)) {
          this.connectedSegments.add(seg.id);
        }
      }
    }
  }

  start(currentTime: number): void {
    this.startTime = currentTime;
    this.started = true;
  }

  isStarted(): boolean {
    return this.started;
  }

  update(currentTime: number): AnimationState {
    const elapsed = (currentTime - this.startTime) * this.speed;
    return this.computeState(elapsed);
  }

  private computeState(elapsedMs: number): AnimationState {
    const { leaderDuration, connectionPause, returnStrokeDuration, strokeHoldDuration, fadeDuration, interstrokeInterval, subsequentStrokes } = this.timeline;

    const leaderEnd = leaderDuration;
    const pauseEnd = leaderEnd + connectionPause;

    if (elapsedMs < leaderEnd) {
      const progress = elapsedMs / leaderEnd;
      return this.leaderState(progress);
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

    const tipDistance = 5;

    for (const seg of this.geometry.segments) {
      if (seg.stepIndex <= targetStep) {
        visible.add(seg.id);
        const age = targetStep - seg.stepIndex;
        const isTip = age < tipDistance;
        const tipBrightness = isTip ? (1 - age / tipDistance) * 0.8 + 0.2 : 0;
        const trailBrightness = Math.max(0.02, 0.15 * Math.exp(-age * 0.1));
        const b = (isTip ? tipBrightness : trailBrightness) * seg.intensity;
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
        if (this.connectedSegments.has(seg.id)) {
          const parentBrightness = brightness.get(seg.parentSegmentId!) ?? 0;
          brightness.set(seg.id, parentBrightness * 0.5 * Math.exp(-seg.depth * 0.3));
        } else {
          brightness.set(seg.id, 0.02 * Math.exp(-seg.depth * 0.5));
        }
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
      } else if (this.connectedSegments.has(seg.id)) {
        brightness.set(seg.id, 0.4 * Math.exp(-seg.depth * 0.3) * peak * decay);
      } else {
        brightness.set(seg.id, 0.02 * Math.exp(-seg.depth * 0.5) * decay);
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
      let base: number;
      let fadeRate: number;
      if (seg.isMainChannel) {
        base = peak;
        fadeRate = 0.7;
      } else if (this.connectedSegments.has(seg.id)) {
        base = 0.4 * Math.exp(-seg.depth * 0.3) * peak;
        fadeRate = 0.85;
      } else {
        base = 0.02 * Math.exp(-seg.depth * 0.5);
        fadeRate = 1.0;
      }
      brightness.set(seg.id, base * Math.max(0, 1 - fadeProgress * fadeRate));
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
