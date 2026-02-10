import { BoltGeometry, BoltSegment, SimulationConfig } from '../simulation';
import { BoltTimeline } from './BoltTimeline';
import { AnimationPhase, AnimationState } from './types';

interface SegmentInfo {
  depth: number;
  parentSegmentId: number | null;
  stepIndex: number;
  intensity: number;
  isMainChannel: boolean;
  isDeadEnd: boolean;
  distanceFromMain: number;
}

interface BranchInfo {
  lastStepIndex: number;
  segmentCount: number;
}

export class BoltAnimator {
  private geometry: BoltGeometry;
  private timeline: BoltTimeline;
  private config: SimulationConfig;
  private speed: number;
  private startTime: number = 0;
  private started: boolean = false;

  private segmentById: Map<number, SegmentInfo>;
  private mainChannelReversed: number[];
  private connectedSegments: Set<number>;
  private branchInfo: Map<number, BranchInfo>;
  private peakBrightness: Map<number, number>;

  constructor(geometry: BoltGeometry, timeline: BoltTimeline, config: SimulationConfig, speed: number = 1.0) {
    this.geometry = geometry;
    this.timeline = timeline;
    this.config = config;
    this.speed = Math.max(0.01, speed);

    this.segmentById = new Map();
    for (const seg of geometry.segments) {
      this.segmentById.set(seg.id, {
        depth: seg.depth,
        parentSegmentId: seg.parentSegmentId,
        stepIndex: seg.stepIndex,
        intensity: seg.intensity,
        isMainChannel: seg.isMainChannel,
        isDeadEnd: seg.isDeadEnd,
        distanceFromMain: seg.distanceFromMain,
      });
    }

    this.mainChannelReversed = [...geometry.mainChannelIds].reverse();

    this.connectedSegments = new Set(geometry.mainChannelIds);
    let changed = true;
    while (changed) {
      changed = false;
      for (const seg of geometry.segments) {
        if (!seg.isMainChannel &&
            seg.parentSegmentId !== null &&
            this.connectedSegments.has(seg.parentSegmentId) &&
            !this.connectedSegments.has(seg.id)) {
          this.connectedSegments.add(seg.id);
          changed = true;
        }
      }
    }

    this.branchInfo = this.computeBranchInfo(geometry.segments);
    this.peakBrightness = new Map();
  }

  private computeBranchInfo(segments: BoltSegment[]): Map<number, BranchInfo> {
    const children = new Map<number, number[]>();
    for (const seg of segments) {
      if (seg.parentSegmentId !== null) {
        const kids = children.get(seg.parentSegmentId) || [];
        kids.push(seg.id);
        children.set(seg.parentSegmentId, kids);
      }
    }

    const result = new Map<number, BranchInfo>();

    const computeForBranch = (segId: number): BranchInfo => {
      if (result.has(segId)) return result.get(segId)!;

      const seg = this.segmentById.get(segId)!;
      const kids = children.get(segId) || [];

      if (kids.length === 0) {
        const info = { lastStepIndex: seg.stepIndex, segmentCount: 1 };
        result.set(segId, info);
        return info;
      }

      let maxLastStep = seg.stepIndex;
      let totalCount = 1;
      for (const kid of kids) {
        const kidInfo = computeForBranch(kid);
        if (kidInfo.lastStepIndex > maxLastStep) {
          maxLastStep = kidInfo.lastStepIndex;
        }
        totalCount += kidInfo.segmentCount;
      }

      const info = { lastStepIndex: maxLastStep, segmentCount: totalCount };
      result.set(segId, info);
      return info;
    };

    for (const seg of segments) {
      computeForBranch(seg.id);
    }

    return result;
  }

  start(currentTime: number): void {
    this.startTime = currentTime;
    this.started = true;
    this.peakBrightness.clear();
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

  private getDepthFactor(depth: number): number {
    const minFactor = 0.3;
    const decay = Math.exp(-depth * 0.7);
    return minFactor + (1 - minFactor) * decay;
  }

  private leaderState(progress: number): AnimationState {
    const targetStep = Math.floor(progress * this.timeline.totalSteps);
    const visible = new Set<number>();
    const brightness = new Map<number, number>();

    const TIP_DISTANCE = 5;
    const BRIGHTNESS_CUTOFF = 0.03;

    const totalSteps = this.timeline.totalSteps;
    const deadEndFadeDuration = this.config.deadEndFadeDuration * totalSteps;
    const deadEndMinBrightness = this.config.deadEndMinBrightness;

    const reachedMainChannel = new Set<number>();
    for (const id of this.geometry.mainChannelIds) {
      const seg = this.segmentById.get(id);
      if (seg && seg.stepIndex <= targetStep) {
        reachedMainChannel.add(id);
      }
    }

    // Start with main channel segments
    const currentlyConnected = new Set(reachedMainChannel);

    // Also include root segments (multi-leader starting points)
    for (const seg of this.geometry.segments) {
      if (seg.parentSegmentId === null && seg.stepIndex <= targetStep) {
        currentlyConnected.add(seg.id);
      }
    }

    // Expand to include connected branches
    let changed = true;
    while (changed) {
      changed = false;
      for (const seg of this.geometry.segments) {
        if (seg.stepIndex <= targetStep &&
            seg.parentSegmentId !== null &&
            currentlyConnected.has(seg.parentSegmentId) &&
            !currentlyConnected.has(seg.id)) {
          currentlyConnected.add(seg.id);
          changed = true;
        }
      }
    }

    for (const seg of this.geometry.segments) {
      if (!currentlyConnected.has(seg.id)) continue;
      if (seg.stepIndex > targetStep) continue;

      const info = this.segmentById.get(seg.id)!;
      const age = targetStep - seg.stepIndex;
      const depthFactor = this.getDepthFactor(info.depth);

      let b: number;
      if (age < TIP_DISTANCE) {
        b = depthFactor * (0.8 + 0.2 * (1 - age / TIP_DISTANCE));
      } else {
        if (seg.isMainChannel) {
          b = Math.max(0.6, 1 - age * 0.005);
        } else {
          b = Math.max(0.35 * depthFactor, depthFactor * (1 - age * 0.01));
        }
      }

      if (info.isDeadEnd) {
        const branchData = this.branchInfo.get(seg.id);
        const lastStep = branchData?.lastStepIndex ?? seg.stepIndex;
        const stepsSinceLastGrowth = targetStep - lastStep;

        if (stepsSinceLastGrowth > 0) {
          const fadeProgress = stepsSinceLastGrowth / deadEndFadeDuration;
          const fadeFactor = Math.max(deadEndMinBrightness, 1 - fadeProgress);
          b *= fadeFactor;
        }
      }

      if (b < BRIGHTNESS_CUTOFF) continue;

      const prevPeak = this.peakBrightness.get(seg.id) ?? 0;
      if (b > prevPeak) {
        this.peakBrightness.set(seg.id, b);
      } else if (!seg.isMainChannel && b < prevPeak) {
        b = Math.max(b, prevPeak * 0.95);
      }

      visible.add(seg.id);
      brightness.set(seg.id, b * info.intensity);
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

    const tipSegments = this.mainChannelReversed.slice(0, 5);
    for (const segId of tipSegments) {
      visible.add(segId);
      brightness.set(segId, 0.3);
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
    const peak = Math.pow(0.85, strokeIndex);
    const visible = new Set<number>();
    const brightness = new Map<number, number>();

    const mainChannel = this.mainChannelReversed;
    const litCount = Math.floor(progress * mainChannel.length);
    const litSet = new Set<number>();

    for (let i = 0; i < mainChannel.length; i++) {
      const segId = mainChannel[i];

      if (i < litCount) {
        visible.add(segId);
        const decayFromWave = (litCount - i) / mainChannel.length;
        brightness.set(segId, Math.max(0.7, 1 - decayFromWave * 0.3) * peak);
        litSet.add(segId);
      } else if (i === litCount) {
        visible.add(segId);
        brightness.set(segId, 1.0 * peak);
        litSet.add(segId);
      }
    }

    for (const seg of this.geometry.segments) {
      if (!seg.isMainChannel && !seg.isDeadEnd) {
        if (this.connectedSegments.has(seg.id) && litSet.has(seg.parentSegmentId!)) {
          visible.add(seg.id);
          const parentBrightness = brightness.get(seg.parentSegmentId!) ?? 0;
          const depthFactor = this.getDepthFactor(seg.depth);
          brightness.set(seg.id, parentBrightness * 0.6 * depthFactor);
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
    const peak = Math.pow(0.85, strokeIndex);
    const visible = new Set<number>();
    const brightness = new Map<number, number>();

    const decay = Math.exp(-holdProgress * 1.5);

    for (const seg of this.geometry.segments) {
      if (seg.isMainChannel) {
        visible.add(seg.id);
        brightness.set(seg.id, peak * decay);
      } else if (this.connectedSegments.has(seg.id) && !seg.isDeadEnd) {
        visible.add(seg.id);
        const depthFactor = this.getDepthFactor(seg.depth);
        brightness.set(seg.id, 0.5 * depthFactor * peak * decay);
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
    const peak = Math.pow(0.85, strokeIndex);
    const visible = new Set<number>();
    const brightness = new Map<number, number>();
    const BRIGHTNESS_CUTOFF = 0.02;

    const fadeFactor = 1 - fadeProgress;

    for (const seg of this.geometry.segments) {
      if (seg.isMainChannel) {
        const b = peak * fadeFactor;
        if (b >= BRIGHTNESS_CUTOFF) {
          visible.add(seg.id);
          brightness.set(seg.id, b);
        }
      } else if (this.connectedSegments.has(seg.id) && !seg.isDeadEnd) {
        const depthFactor = this.getDepthFactor(seg.depth);
        const b = 0.5 * depthFactor * peak * fadeFactor;
        if (b >= BRIGHTNESS_CUTOFF) {
          visible.add(seg.id);
          brightness.set(seg.id, b);
        }
      }
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
    return {
      phase: AnimationPhase.INTERSTROKE,
      phaseProgress: 1,
      visibleSegments: new Set(),
      segmentBrightness: new Map(),
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
