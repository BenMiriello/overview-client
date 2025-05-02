// Represents a lightning strike with animation timing
export interface LightningStrike {
  id: string;
  lat: number;
  lng: number;
  timestamp: number; // When the strike was added
  intensity?: number; // Not actually used, but for future expansion
  createdAt: number; // Browser timestamp for animation
}

// Constants for lightning animation
export const LIGHTNING_CONSTANTS = {
  INITIAL_SIZE: 0.5, // Initial size (radius in degrees)
  FINAL_SIZE: 0.1, // Size after shrinking (1/5 the original size)
  GLOW_SIZE: 0.6, // Size of glow effect
  DISPLAY_DURATION: 500, // How long to display at full size (ms)
  FADE_DURATION: 2500, // How long to fade from full to small
  LINGER_DURATION: 294000, // How long to linger as a small point (ms) 
  // Total duration is 5 minutes (300,000ms = 3000 + 3000 + 294000)
  MAX_STRIKES: 10000, // Maximum number of strikes to keep in memory
};

// Calculate current size based on time since creation
export function getStrikeSize(strike: LightningStrike, currentTime: number): number {
  const age = currentTime - strike.createdAt;
  
  // First phase: full size
  if (age < LIGHTNING_CONSTANTS.DISPLAY_DURATION) {
    return LIGHTNING_CONSTANTS.INITIAL_SIZE;
  }
  
  // Second phase: shrink to final size
  const shrinkAge = age - LIGHTNING_CONSTANTS.DISPLAY_DURATION;
  if (shrinkAge < LIGHTNING_CONSTANTS.FADE_DURATION) {
    const shrinkProgress = shrinkAge / LIGHTNING_CONSTANTS.FADE_DURATION;
    return LIGHTNING_CONSTANTS.INITIAL_SIZE - 
      (LIGHTNING_CONSTANTS.INITIAL_SIZE - LIGHTNING_CONSTANTS.FINAL_SIZE) * shrinkProgress;
  }
  
  // Third phase: maintain small size
  return LIGHTNING_CONSTANTS.FINAL_SIZE;
}

// Calculate current opacity based on time since creation
export function getStrikeOpacity(strike: LightningStrike, currentTime: number): number {
  const age = currentTime - strike.createdAt;
  
  // First phase: full opacity
  if (age < LIGHTNING_CONSTANTS.DISPLAY_DURATION) {
    return 1.0;
  }
  
  // Second phase: partial fade during shrinking
  const shrinkAge = age - LIGHTNING_CONSTANTS.DISPLAY_DURATION;
  if (shrinkAge < LIGHTNING_CONSTANTS.FADE_DURATION) {
    const fadeProgress = shrinkAge / LIGHTNING_CONSTANTS.FADE_DURATION;
    // Fade to 0.7 opacity during the shrink phase
    return 1.0 - (0.3 * fadeProgress);
  }
  
  // Third phase: slow fade out over the linger duration
  const lingerAge = age - LIGHTNING_CONSTANTS.DISPLAY_DURATION - LIGHTNING_CONSTANTS.FADE_DURATION;
  const lingerProgress = Math.min(lingerAge / LIGHTNING_CONSTANTS.LINGER_DURATION, 1);
  
  // Start from 0.7 opacity and fade out completely
  return 0.7 * (1.0 - lingerProgress);
}

// Calculate glow opacity (always less than the main opacity)
export function getGlowOpacity(strike: LightningStrike, currentTime: number): number {
  return getStrikeOpacity(strike, currentTime) * 0.5;
}

// Check if the strike should be removed (too old)
export function isStrikeExpired(strike: LightningStrike, currentTime: number): boolean {
  const age = currentTime - strike.createdAt;
  return age > (LIGHTNING_CONSTANTS.DISPLAY_DURATION + 
                LIGHTNING_CONSTANTS.FADE_DURATION + 
                LIGHTNING_CONSTANTS.LINGER_DURATION);
}
