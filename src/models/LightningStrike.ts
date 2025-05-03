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
  CORE_SIZE: 0.1, // Size of the persistent central point (radius in degrees)
  INITIAL_GLOW_SIZE: 0.8, // Initial size of glow effect (4x the core)
  FINAL_GLOW_SIZE: 0.1, // Minimum glow size when contracting
  FLASH_DURATION: 600, // How long for the initial flash (ms)
  CONTRACTION_DURATION: 4400, // How long to contract from full to small (ms)
  LINGER_DURATION: 1000,
  MAX_STRIKES: 1000, // Maximum number of strikes to keep in memory
  FLICKER_SPEED: 200, // Speed of flickering (ms)
  FLICKER_INTENSITY: 0.3, // How much the size fluctuates during flicker (0-1)
  FLICKER_DURATION: 1200, // How long the flicker effect lasts (ms)
};

// Generate a random flicker effect (0-1 value)
export function getFlickerFactor(strike: LightningStrike, currentTime: number): number {
  const age = currentTime - strike.createdAt;
  
  // Only apply flicker during the initial period
  if (age > LIGHTNING_CONSTANTS.FLICKER_DURATION) {
    return 0;
  }
  
  // Create a pseudorandom flicker based on strike ID and time
  const flickerTimeBase = Math.floor(age / LIGHTNING_CONSTANTS.FLICKER_SPEED);
  const flickerSeed = strike.id.charCodeAt(0) + flickerTimeBase;
  const flickerRandom = Math.sin(flickerSeed) * 0.5 + 0.5; // 0-1 value
  
  // Decrease flicker intensity as time passes
  const flickerFadeout = 1 - (age / LIGHTNING_CONSTANTS.FLICKER_DURATION);
  
  return flickerRandom * LIGHTNING_CONSTANTS.FLICKER_INTENSITY * flickerFadeout;
}

// Calculate current core size (always constant)
export function getCoreSize(): number {
  return LIGHTNING_CONSTANTS.CORE_SIZE;
}

// Calculate current glow size based on time since creation
export function getGlowSize(strike: LightningStrike, currentTime: number): number {
  const age = currentTime - strike.createdAt;
  
  // Add flicker effect
  const flickerFactor = getFlickerFactor(strike, currentTime);
  
  // First phase: expanding quickly to full size with flicker
  if (age < LIGHTNING_CONSTANTS.FLASH_DURATION) {
    const expandProgress = Math.min(age / (LIGHTNING_CONSTANTS.FLASH_DURATION / 2), 1);
    const baseSize = LIGHTNING_CONSTANTS.INITIAL_GLOW_SIZE * expandProgress;
    return baseSize * (1 + flickerFactor);
  }
  
  // Second phase: contract to final size with flicker
  const contractAge = age - LIGHTNING_CONSTANTS.FLASH_DURATION;
  if (contractAge < LIGHTNING_CONSTANTS.CONTRACTION_DURATION) {
    const contractProgress = contractAge / LIGHTNING_CONSTANTS.CONTRACTION_DURATION;
    const baseSize = LIGHTNING_CONSTANTS.INITIAL_GLOW_SIZE - 
      (LIGHTNING_CONSTANTS.INITIAL_GLOW_SIZE - LIGHTNING_CONSTANTS.FINAL_GLOW_SIZE) * contractProgress;
    return baseSize * (1 + flickerFactor);
  }
  
  // Third phase: no glow (will be hidden in the render function)
  return 0;
}

// Calculate core opacity based on time since creation
export function getCoreOpacity(strike: LightningStrike, currentTime: number): number {
  const age = currentTime - strike.createdAt;
  
  // First phase: full opacity
  if (age < LIGHTNING_CONSTANTS.FLASH_DURATION + LIGHTNING_CONSTANTS.CONTRACTION_DURATION) {
    return 1.0;
  }
  
  // Final phase: very slow fade out over the linger duration
  const lingerAge = age - LIGHTNING_CONSTANTS.FLASH_DURATION - LIGHTNING_CONSTANTS.CONTRACTION_DURATION;
  const lingerProgress = Math.min(lingerAge / LIGHTNING_CONSTANTS.LINGER_DURATION, 1);
  
  // Start from full opacity and fade out very slowly
  return 1.0 - (0.7 * lingerProgress);
}

// Calculate glow opacity based on time since creation
export function getGlowOpacity(strike: LightningStrike, currentTime: number): number {
  const age = currentTime - strike.createdAt;
  
  // Apply flicker to opacity as well
  const flickerFactor = getFlickerFactor(strike, currentTime);
  
  // First phase: flashing
  if (age < LIGHTNING_CONSTANTS.FLASH_DURATION) {
    return 1.0 + (flickerFactor * 0.2); // Allow slight over-bright during flicker
  }
  
  // Second phase: fading during contraction
  const contractAge = age - LIGHTNING_CONSTANTS.FLASH_DURATION;
  if (contractAge < LIGHTNING_CONSTANTS.CONTRACTION_DURATION) {
    const fadeProgress = contractAge / LIGHTNING_CONSTANTS.CONTRACTION_DURATION;
    return Math.max((1.0 - fadeProgress * 0.5) + flickerFactor * 0.1, 0.3);
  }
  
  // Third phase: completely transparent (will be hidden in render function)
  return 0;
}

// Check if the strike should be removed (too old)
export function isStrikeExpired(strike: LightningStrike, currentTime: number): boolean {
  const age = currentTime - strike.createdAt;
  return age > (LIGHTNING_CONSTANTS.FLASH_DURATION + 
                LIGHTNING_CONSTANTS.CONTRACTION_DURATION + 
                LIGHTNING_CONSTANTS.LINGER_DURATION);
}
