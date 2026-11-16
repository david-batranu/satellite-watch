/**
 * User settings model.
 *
 * Kept dependency-free so the engine, the store and the persistence layer all
 * agree on the shape (and so it can be sanitised when loaded from storage).
 */

import { DEFAULT_ENABLED_GROUPS, SATELLITE_GROUP_LIST } from '../satellites/groups';
import { SATELLITE_GROUPS, type SatelliteGroupId } from '../types';
import { clamp } from '../lib/angles';
import { SKY } from '../config';

export interface Settings {
  /** Faintest star drawn. */
  starMagLimit: number;
  showStars: boolean;
  showConstellations: boolean;
  showAsterisms: boolean;
  showSatellites: boolean;
  showPlanets: boolean;
  showHorizon: boolean;
  showOrbits: boolean;
  showLabels: boolean;
  showFps: boolean;
  cameraEnabled: boolean;
  satelliteGroups: SatelliteGroupId[];
  /** Vertical field of view of the camera overlay, degrees. */
  fovDeg: number;
  /** Sensor smoothing 0..1. */
  smoothing: number;
  /** Fine calibration, degrees. */
  headingOffsetDeg: number;
  pitchOffsetDeg: number;
  /** Drag-to-look instead of the sensors. */
  manualLook: boolean;
  manualAzDeg: number;
  manualAltDeg: number;
  units: 'metric' | 'imperial';
  /** Time travel for planning: added to the real clock. */
  timeOffsetMs: number;
  wakeLock: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  starMagLimit: SKY.defaultStarMagLimit,
  showStars: true,
  showConstellations: true,
  showAsterisms: false,
  showSatellites: true,
  showPlanets: true,
  showHorizon: true,
  showOrbits: true,
  showLabels: true,
  showFps: false,
  cameraEnabled: true,
  satelliteGroups: [...DEFAULT_ENABLED_GROUPS],
  fovDeg: SKY.defaultFovDeg,
  smoothing: SKY.defaultSmoothing,
  headingOffsetDeg: 0,
  pitchOffsetDeg: 0,
  manualLook: false,
  manualAzDeg: 180,
  manualAltDeg: 20,
  units: 'metric',
  timeOffsetMs: 0,
  wakeLock: true,
};

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Merge persisted settings with defaults, clamping anything out of range. */
export function sanitizeSettings(raw: unknown): Settings {
  const input = (raw ?? {}) as Partial<Settings>;
  const groups = Array.isArray(input.satelliteGroups)
    ? input.satelliteGroups.filter((group): group is SatelliteGroupId =>
        (SATELLITE_GROUPS as readonly string[]).includes(group),
      )
    : [...DEFAULT_SETTINGS.satelliteGroups];

  return {
    starMagLimit: clamp(
      numberOr(input.starMagLimit, DEFAULT_SETTINGS.starMagLimit),
      SKY.minStarMagLimit,
      SKY.maxStarMagLimit,
    ),
    showStars: boolOr(input.showStars, DEFAULT_SETTINGS.showStars),
    showConstellations: boolOr(input.showConstellations, DEFAULT_SETTINGS.showConstellations),
    showAsterisms: boolOr(input.showAsterisms, DEFAULT_SETTINGS.showAsterisms),
    showSatellites: boolOr(input.showSatellites, DEFAULT_SETTINGS.showSatellites),
    showPlanets: boolOr(input.showPlanets, DEFAULT_SETTINGS.showPlanets),
    showHorizon: boolOr(input.showHorizon, DEFAULT_SETTINGS.showHorizon),
    showOrbits: boolOr(input.showOrbits, DEFAULT_SETTINGS.showOrbits),
    showLabels: boolOr(input.showLabels, DEFAULT_SETTINGS.showLabels),
    showFps: boolOr(input.showFps, DEFAULT_SETTINGS.showFps),
    cameraEnabled: boolOr(input.cameraEnabled, DEFAULT_SETTINGS.cameraEnabled),
    satelliteGroups: groups.length ? groups : [...DEFAULT_SETTINGS.satelliteGroups],
    fovDeg: clamp(numberOr(input.fovDeg, DEFAULT_SETTINGS.fovDeg), SKY.minFovDeg, SKY.maxFovDeg),
    smoothing: clamp(numberOr(input.smoothing, DEFAULT_SETTINGS.smoothing), 0, 1),
    headingOffsetDeg: clamp(
      numberOr(input.headingOffsetDeg, DEFAULT_SETTINGS.headingOffsetDeg),
      -180,
      180,
    ),
    pitchOffsetDeg: clamp(numberOr(input.pitchOffsetDeg, DEFAULT_SETTINGS.pitchOffsetDeg), -60, 60),
    manualLook: boolOr(input.manualLook, DEFAULT_SETTINGS.manualLook),
    manualAzDeg: numberOr(input.manualAzDeg, DEFAULT_SETTINGS.manualAzDeg),
    manualAltDeg: clamp(numberOr(input.manualAltDeg, DEFAULT_SETTINGS.manualAltDeg), -85, 85),
    units: input.units === 'imperial' ? 'imperial' : 'metric',
    timeOffsetMs: clamp(
      numberOr(input.timeOffsetMs, DEFAULT_SETTINGS.timeOffsetMs),
      -SKY.maxTimeOffsetHours * 3_600_000,
      SKY.maxTimeOffsetHours * 3_600_000,
    ),
    wakeLock: boolOr(input.wakeLock, DEFAULT_SETTINGS.wakeLock),
  };
}

/** Human label for a group id. */
export function satelliteGroupLabel(id: SatelliteGroupId): string {
  return SATELLITE_GROUP_LIST.find((group) => group.id === id)?.label ?? id;
}
