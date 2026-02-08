export enum AnimationPhase {
  LEADER_STEPPING = 'leader_stepping',
  CONNECTION_PAUSE = 'connection_pause',
  RETURN_STROKE = 'return_stroke',
  STROKE_HOLD = 'stroke_hold',
  FADING = 'fading',
  INTERSTROKE = 'interstroke',
  COMPLETE = 'complete',
}

export interface AnimationState {
  phase: AnimationPhase;
  phaseProgress: number;
  visibleSegments: Set<number>;
  segmentBrightness: Map<number, number>;
  returnStrokePosition: number;
  strokeCount: number;
}
