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

    // Build set of segments connected to main channel with iterative expansion
    this.connectedSegments = new Set(geometry.mainChannelIds);

    // Keep expanding until no new segments added (handles multi-depth branches)
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

    // Debug: log connectivity stats
    const connectedByDepth: Record<number, number> = {};
    for (const seg of geometry.segments) {
      if (this.connectedSegments.has(seg.id)) {
        connectedByDepth[seg.depth] = (connectedByDepth[seg.depth] || 0) + 1;
      }
    }
    console.log('[Animator] Connected segments by depth:', connectedByDepth);
    console.log('[Animator] Total segments:', geometry.segments.length, 'Connected:', this.connectedSegments.size);
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

  private lastLoggedProgress: number = -1;

  private leaderState(progress: number): AnimationState {
    const targetStep = Math.floor(progress * this.timeline.totalSteps);
    const visible = new Set<number>();
    const brightness = new Map<number, number>();

    const TIP_DISTANCE = 5;
    const BRIGHTNESS_CUTOFF = 0.03;

    // Log once at ~50% progress
    const shouldLog = progress >= 0.5 && this.lastLoggedProgress < 0.5;
    if (shouldLog) {
      this.lastLoggedProgress = progress;
      console.log('[Leader] progress:', progress.toFixed(2), 'targetStep:', targetStep, 'totalSteps:', this.timeline.totalSteps);
    }

    // Build connected set dynamically based on what we've reached
    const reachedMainChannel = new Set<number>();
    for (const id of this.geometry.mainChannelIds) {
      const seg = this.segmentById.get(id);
      if (seg && seg.stepIndex <= targetStep) {
        reachedMainChannel.add(id);
      }
    }

    // Connected: main channel + branches with iterative expansion for multi-depth
    const currentlyConnected = new Set(reachedMainChannel);
    let changed = true;
    while (changed) {
      changed = false;
      for (const seg of this.geometry.segments) {
        if (!seg.isMainChannel &&
            seg.stepIndex <= targetStep &&
            seg.parentSegmentId !== null &&
            currentlyConnected.has(seg.parentSegmentId) &&
            !currentlyConnected.has(seg.id)) {
          currentlyConnected.add(seg.id);
          changed = true;
        }
      }
    }

    if (shouldLog) {
      const connectedByDepth: Record<number, number> = {};
      for (const seg of this.geometry.segments) {
        if (currentlyConnected.has(seg.id)) {
          connectedByDepth[seg.depth] = (connectedByDepth[seg.depth] || 0) + 1;
        }
      }
      console.log('[Leader] currentlyConnected by depth:', connectedByDepth);
    }

    for (const seg of this.geometry.segments) {
      if (!currentlyConnected.has(seg.id)) continue;
      if (seg.stepIndex > targetStep) continue;

      const age = targetStep - seg.stepIndex;

      // Base brightness by depth - main channel stays bright, branches dimmer
      const depthFactor = Math.pow(0.7, seg.depth);

      let b: number;
      if (age < TIP_DISTANCE) {
        // Active tip area - brightest
        b = depthFactor * (0.8 + 0.2 * (1 - age / TIP_DISTANCE));
      } else {
        // Trail - main channel stays visible, branches fade based on depth
        if (seg.isMainChannel) {
          // Main channel: slow fade, stays at ~60% minimum
          b = Math.max(0.6, 1 - age * 0.005);
        } else {
          // Branches: fade slower and stay visible at ~35% minimum
          b = Math.max(0.35, depthFactor * (1 - age * 0.01));
        }
      }

      if (b < BRIGHTNESS_CUTOFF) continue;

      visible.add(seg.id);
      brightness.set(seg.id, b * seg.intensity);
    }

    if (shouldLog) {
      const visibleByDepth: Record<number, number> = {};
      const brightnessByDepth: Record<number, number[]> = {};
      for (const seg of this.geometry.segments) {
        if (visible.has(seg.id)) {
          visibleByDepth[seg.depth] = (visibleByDepth[seg.depth] || 0) + 1;
          const b = brightness.get(seg.id) ?? 0;
          if (!brightnessByDepth[seg.depth]) brightnessByDepth[seg.depth] = [];
          brightnessByDepth[seg.depth].push(b);
        }
      }
      console.log('[Leader] visible by depth:', visibleByDepth);
      for (const [depth, values] of Object.entries(brightnessByDepth)) {
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        const min = Math.min(...values);
        const max = Math.max(...values);
        console.log(`[Leader] depth ${depth} brightness: avg=${avg.toFixed(3)}, min=${min.toFixed(3)}, max=${max.toFixed(3)}`);
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

    // Only show the tip area at ground connection - everything else invisible
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

    // Main channel: bright wave traveling up - segments ahead are INVISIBLE
    for (let i = 0; i < mainChannel.length; i++) {
      const segId = mainChannel[i];

      if (i < litCount) {
        // Already passed by return stroke - bright
        visible.add(segId);
        const decayFromWave = (litCount - i) / mainChannel.length;
        brightness.set(segId, Math.max(0.7, 1 - decayFromWave * 0.3) * peak);
        litSet.add(segId);
      } else if (i === litCount) {
        // Return stroke wavefront - brightest
        visible.add(segId);
        brightness.set(segId, 1.0 * peak);
        litSet.add(segId);
      }
      // Ahead of return stroke - don't add to visible (completely invisible)
    }

    // Branches: only connected ones illuminate as their parent segment is lit
    for (const seg of this.geometry.segments) {
      if (!seg.isMainChannel) {
        if (this.connectedSegments.has(seg.id) && litSet.has(seg.parentSegmentId!)) {
          visible.add(seg.id);
          const parentBrightness = brightness.get(seg.parentSegmentId!) ?? 0;
          brightness.set(seg.id, parentBrightness * 0.6 * Math.exp(-seg.depth * 0.2));
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
      } else if (this.connectedSegments.has(seg.id)) {
        visible.add(seg.id);
        brightness.set(seg.id, 0.5 * Math.exp(-seg.depth * 0.2) * peak * decay);
      }
      // Unconnected branches: not visible
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

    // Fade to zero, not 10% of peak
    const fadeFactor = 1 - fadeProgress;

    for (const seg of this.geometry.segments) {
      if (seg.isMainChannel) {
        const b = peak * fadeFactor;
        if (b >= BRIGHTNESS_CUTOFF) {
          visible.add(seg.id);
          brightness.set(seg.id, b);
        }
      } else if (this.connectedSegments.has(seg.id)) {
        const b = 0.5 * Math.exp(-seg.depth * 0.2) * peak * fadeFactor;
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
    // Nothing visible between strokes - complete darkness
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
