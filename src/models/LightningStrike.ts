// Represents a lightning strike with animation timing
export interface LightningStrike {
  id: string;
  lat: number;
  lng: number;
  timestamp: number; // When the strike was added
  intensity?: number; // Not actually used, but for future expansion
  createdAt: number; // Browser timestamp for animation
  zIndex?: number; // For handling overlaps (higher values appear on top)
}

// Animation phases for lightning
export enum StrikePhase {
  DESCENDING = 'descending', // Line coming down from the sky
  IMPACT = 'impact',        // Moment the line reaches the ground
  CIRCLE = 'circle',        // Full-size circle (no glow, just white)
  FADING = 'fading',        // Shrinking to small point
  LINGERING = 'lingering'   // Small persistent point
}

// Constants for lightning animation
export const LIGHTNING_CONSTANTS = {
  // Sizes
  LINE_START_ALTITUDE: 0.02,   // Line starting altitude (sky) - 50% higher
  LINE_END_ALTITUDE: 0.0005,    // Line ending altitude (surface)
  INITIAL_SIZE: 0.2,            // Initial circle size (original radius)
  FINAL_SIZE: 0.1,              // Final size of lingering point (original size)

  // Durations
  DESCENDING_DURATION: 250,     // Time for line to reach ground (ms)
  IMPACT_DURATION: 250,         // Time between impact and retraction (ms)
  RETRACTION_DURATION: 250,     // Time for line to retract (ms)
  CIRCLE_DURATION: 1500,        // How long the full-size circle lasts (ms)
  FADE_DURATION: 1000,          // How long to fade from full to small (ms)
  LINGER_DURATION: 296750,      // How long to linger as a small point (ms)
                                // Total is 5 minutes (300,000ms)
  MAX_STRIKES: 1000,            // Maximum number of strikes to keep in memory
  Z_INDEX_STEP: 0.00001         // How much to step down for z-indexing
};

// Get the current animation phase based on time
export function getStrikePhase(strike: LightningStrike, currentTime: number): StrikePhase {
  const age = currentTime - strike.createdAt;

  if (age < LIGHTNING_CONSTANTS.DESCENDING_DURATION) {
    return StrikePhase.DESCENDING;
  }

  if (age < LIGHTNING_CONSTANTS.DESCENDING_DURATION + LIGHTNING_CONSTANTS.IMPACT_DURATION) {
    return StrikePhase.IMPACT;
  }

  const circleStart = LIGHTNING_CONSTANTS.DESCENDING_DURATION + LIGHTNING_CONSTANTS.IMPACT_DURATION;
  if (age < circleStart + LIGHTNING_CONSTANTS.CIRCLE_DURATION) {
    return StrikePhase.CIRCLE;
  }

  const fadeStart = circleStart + LIGHTNING_CONSTANTS.CIRCLE_DURATION;
  if (age < fadeStart + LIGHTNING_CONSTANTS.FADE_DURATION) {
    return StrikePhase.FADING;
  }

  return StrikePhase.LINGERING;
}

// Calculate lightning line length for descending phase
export function getLineLength(strike: LightningStrike, currentTime: number): number {
  const age = currentTime - strike.createdAt;
  const phase = getStrikePhase(strike, currentTime);

  // Descending phase - line extends from top to bottom
  if (phase === StrikePhase.DESCENDING) {
    const progress = age / LIGHTNING_CONSTANTS.DESCENDING_DURATION;
    return progress; // 0 to 1 (full length)
  }

  // Impact phase - full length line
  if (phase === StrikePhase.IMPACT) {
    return 1;
  }

  // Retraction phase (beginning of circle phase) - line shrinks from top down
  const retractStart = LIGHTNING_CONSTANTS.DESCENDING_DURATION + LIGHTNING_CONSTANTS.IMPACT_DURATION;
  const retractAge = age - retractStart;

  if (retractAge < LIGHTNING_CONSTANTS.RETRACTION_DURATION) {
    const progress = retractAge / LIGHTNING_CONSTANTS.RETRACTION_DURATION;
    return 1 - progress; // 1 to 0 (disappearing)
  }

  // No line for later phases
  return 0;
}

// Calculate circle size based on phase
export function getCircleSize(strike: LightningStrike, currentTime: number): number {
  const age = currentTime - strike.createdAt;
  const phase = getStrikePhase(strike, currentTime);

  // No circle during descending phase
  if (phase === StrikePhase.DESCENDING) {
    return 0;
  }

  // Full size circle appears at impact and stays during circle phase
  if (phase === StrikePhase.IMPACT || phase === StrikePhase.CIRCLE) {
    return LIGHTNING_CONSTANTS.INITIAL_SIZE;
  }

  // Shrinking during fade phase
  if (phase === StrikePhase.FADING) {
    const fadeStart = LIGHTNING_CONSTANTS.DESCENDING_DURATION + 
                      LIGHTNING_CONSTANTS.IMPACT_DURATION + 
                      LIGHTNING_CONSTANTS.CIRCLE_DURATION;
    const fadeAge = age - fadeStart;
    const fadeProgress = fadeAge / LIGHTNING_CONSTANTS.FADE_DURATION;

    return LIGHTNING_CONSTANTS.INITIAL_SIZE - 
      (LIGHTNING_CONSTANTS.INITIAL_SIZE - LIGHTNING_CONSTANTS.FINAL_SIZE) * fadeProgress;
  }

  // Small size during lingering phase
  return LIGHTNING_CONSTANTS.FINAL_SIZE;
}

// Calculate circle opacity based on phase
export function getCircleOpacity(strike: LightningStrike, currentTime: number): number {
  const age = currentTime - strike.createdAt;
  const phase = getStrikePhase(strike, currentTime);

  // No circle during descending phase
  if (phase === StrikePhase.DESCENDING) {
    return 0;
  }

  // Full opacity during impact, circle, and fading phases
  if (phase === StrikePhase.IMPACT || 
      phase === StrikePhase.CIRCLE || 
      phase === StrikePhase.FADING) {
    return 1.0;
  }

  // Slow fade during lingering phase
  if (phase === StrikePhase.LINGERING) {
    const lingerStart = LIGHTNING_CONSTANTS.DESCENDING_DURATION + 
                       LIGHTNING_CONSTANTS.IMPACT_DURATION + 
                       LIGHTNING_CONSTANTS.CIRCLE_DURATION +
                       LIGHTNING_CONSTANTS.FADE_DURATION;
    const lingerAge = age - lingerStart;
    const lingerProgress = Math.min(lingerAge / LIGHTNING_CONSTANTS.LINGER_DURATION, 1);

    // Fade from 1.0 to 0.5 during lingering
    return 1.0 - (0.5 * lingerProgress);
  }

  return 0;
}

// Calculate line opacity
export function getLineOpacity(strike: LightningStrike, currentTime: number): number {
  const phase = getStrikePhase(strike, currentTime);

  // Full opacity during descending and impact
  if (phase === StrikePhase.DESCENDING || phase === StrikePhase.IMPACT) {
    return 1.0;
  }

  // Line fades out during retraction (beginning of circle phase)
  const retractStart = LIGHTNING_CONSTANTS.DESCENDING_DURATION + LIGHTNING_CONSTANTS.IMPACT_DURATION;
  const age = currentTime - strike.createdAt;
  const retractAge = age - retractStart;

  if (retractAge < LIGHTNING_CONSTANTS.RETRACTION_DURATION) {
    const fadeProgress = retractAge / LIGHTNING_CONSTANTS.RETRACTION_DURATION;
    return 1.0 - fadeProgress;
  }

  // No line opacity after retraction
  return 0;
}

// Calculate altitude for z-indexing (to handle overlaps)
export function getStrikeAltitude(strike: LightningStrike, currentTime: number): number {
  // If strike already has a zIndex, use it
  if (strike.zIndex !== undefined) {
    return strike.zIndex;
  }

  // Otherwise, use a very small step down based on creation time
  // This ensures that newer strikes appear on top of older ones
  const ageInMinutes = (currentTime - strike.createdAt) / 60000;

  // We limit how far down they can go to prevent them from getting too low
  const maxDepthMinutes = 10; // After 10 minutes, don't go any lower
  const effectiveAge = Math.min(ageInMinutes, maxDepthMinutes);

  return LIGHTNING_CONSTANTS.LINE_END_ALTITUDE - (effectiveAge * LIGHTNING_CONSTANTS.Z_INDEX_STEP);
}

// Check if the strike should be removed (too old)
export function isStrikeExpired(strike: LightningStrike, currentTime: number): boolean {
  const age = currentTime - strike.createdAt;
  const totalDuration = LIGHTNING_CONSTANTS.DESCENDING_DURATION + 
                        LIGHTNING_CONSTANTS.IMPACT_DURATION + 
                        LIGHTNING_CONSTANTS.CIRCLE_DURATION +
                        LIGHTNING_CONSTANTS.FADE_DURATION +
                        LIGHTNING_CONSTANTS.LINGER_DURATION;

  return age > totalDuration;
}
