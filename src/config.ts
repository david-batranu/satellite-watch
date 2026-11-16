/**
 * Application-wide constants and defaults.
 *
 * Kept in one place so the UI, the engine and the tests agree on limits.
 */

import type { Observer } from './types';

export const APP_NAME = 'Satellite Watch';
export const APP_TAGLINE = 'AR sky guide';

export const SKY = {
  /** Vertical field of view of the camera image, degrees. Pinch to adjust. */
  defaultFovDeg: 68,
  minFovDeg: 32,
  maxFovDeg: 100,
  /** Faintest star drawn (magnitude). */
  defaultStarMagLimit: 5.5,
  minStarMagLimit: 3.5,
  maxStarMagLimit: 6,
  /** Maximum number of text labels on screen at once. */
  maxLabels: 24,
  /** Cap on device pixel ratio: 3x screens cost more than they add here. */
  maxPixelRatio: 2,
  /** Camera sensor smoothing, 0 (raw) .. 1 (heavily smoothed). */
  defaultSmoothing: 0.45,
  /** Time-travel range in the settings sheet. */
  maxTimeOffsetHours: 48,
  /** Elements older than this are flagged in the UI. */
  staleElementsDays: 30,
} as const;

export const DEFAULT_FPS = {
  maxPixelRatio: SKY.maxPixelRatio,
} as const;

/** Fallback observer when no location is available yet (Bucharest). */
export const DEFAULT_OBSERVER: Observer = {
  lat: 44.4268,
  lon: 26.1025,
  heightM: 85,
  accuracyM: null,
  source: 'preset',
  updatedAt: 0,
};

export interface LocationPreset {
  label: string;
  lat: number;
  lon: number;
  heightM: number;
}

export const LOCATION_PRESETS: readonly LocationPreset[] = [
  { label: 'Bucharest', lat: 44.4268, lon: 26.1025, heightM: 85 },
  { label: 'London', lat: 51.5074, lon: -0.1278, heightM: 11 },
  { label: 'New York', lat: 40.7128, lon: -74.006, heightM: 10 },
  { label: 'San Francisco', lat: 37.7749, lon: -122.4194, heightM: 16 },
  { label: 'Tokyo', lat: 35.6762, lon: 139.6503, heightM: 40 },
  { label: 'Sydney', lat: -33.8688, lon: 151.2093, heightM: 58 },
];

/** Bodies offered in the quick-target rail, in display order. */
export const QUICK_BODY_TARGETS = [
  { id: 'moon', label: 'Moon' },
  { id: 'venus', label: 'Venus' },
  { id: 'jupiter', label: 'Jupiter' },
  { id: 'saturn', label: 'Saturn' },
  { id: 'mars', label: 'Mars' },
] as const;

/** Constellations offered in the quick-target rail. */
export const QUICK_CONSTELLATIONS = [
  { id: 'Ori', label: 'Orion' },
  { id: 'UMa', label: 'Big Dipper' },
  { id: 'Cas', label: 'Cassiopeia' },
  { id: 'Sco', label: 'Scorpius' },
  { id: 'Cyg', label: 'Cygnus' },
] as const;

export const STORAGE_KEYS = {
  settings: 'settings-v1',
  location: 'location-v1',
  catalog: 'tle-catalog-v1',
  onboarded: 'onboarded-v1',
} as const;
