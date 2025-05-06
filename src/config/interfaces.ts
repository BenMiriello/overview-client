/**
 * UI visibility levels for configuration options
 */
export const VISIBILITY = {
  HIDDEN: 'hidden',
  ADVANCED: 'advanced',
  USER: 'user'
} as const;

export type ConfigVisibility = typeof VISIBILITY[keyof typeof VISIBILITY];

export interface ConfigLayer {
  [key: string]: any;
}
