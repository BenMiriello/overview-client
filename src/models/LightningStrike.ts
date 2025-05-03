// Represents a lightning strike with basic data
export interface LightningStrike {
  id: string;           // Unique identifier
  lat: number;          // Latitude
  lng: number;          // Longitude
  timestamp: number;    // When the strike occurred (server time)
  intensity?: number;   // Optional intensity value (not used yet)
  createdAt: number;    // Browser timestamp for animation
}

// Constants for lightning data management
export const LIGHTNING_CONSTANTS = {
  MAX_STRIKES: 1000     // Maximum number of strikes to keep in memory
};
