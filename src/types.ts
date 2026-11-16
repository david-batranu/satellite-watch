/**
 * Shared domain types.
 *
 * This module is intentionally dependency-free so that pure computational
 * modules (frames, astronomy, propagation) and their unit tests can import it
 * without pulling in React or three.js.
 */

/** Plain 3D vector. World frames are documented where they are used. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Unit quaternion (x, y, z, w). */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Horizontal sky coordinates in degrees. Azimuth is clockwise from north. */
export interface AzAlt {
  az: number;
  alt: number;
}

// ---------------------------------------------------------------------------
// Observer
// ---------------------------------------------------------------------------

export type ObserverSource = 'gps' | 'manual' | 'cached' | 'preset';

export interface Observer {
  /** Degrees north, -90..90. */
  lat: number;
  /** Degrees east, -180..180. */
  lon: number;
  /** Metres above the WGS84 ellipsoid (approx. sea level). */
  heightM: number;
  /** Horizontal accuracy reported by the geolocation API, if any. */
  accuracyM: number | null;
  source: ObserverSource;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Satellites
// ---------------------------------------------------------------------------

export const SATELLITE_GROUPS = [
  'stations',
  'visual',
  'science',
  'weather',
  'gps-ops',
  'galileo',
  'beidou',
  'iridium-NEXT',
] as const;

export type SatelliteGroupId = (typeof SATELLITE_GROUPS)[number];

export interface SatelliteRecord {
  norad: number;
  name: string;
  groups: SatelliteGroupId[];
  tle1: string;
  tle2: string;
  /** Epoch of the elements, ms since Unix epoch (null when unparseable). */
  epoch: number | null;
}

export interface TleSnapshot {
  generatedAt: string;
  source: string;
  groups: string[];
  counts: Record<string, number>;
  satellites: SatelliteRecord[];
}

/** A satellite position as seen from the observer, in the current sky. */
export interface SatelliteSkyState {
  /** Index into the satellite catalog. */
  index: number;
  az: number;
  el: number;
  rangeKm: number;
  /** False when the satellite is inside the Earth's shadow. */
  sunlit: boolean;
}

export interface SatellitePass {
  riseMs: number;
  culminationMs: number;
  setMs: number;
  /** Maximum elevation in degrees. */
  maxEl: number;
  rangeAtCulminationKm: number;
  sunlit: boolean;
}

// ---------------------------------------------------------------------------
// Sun / Moon / planets
// ---------------------------------------------------------------------------

export type SolarBodyId =
  | 'sun'
  | 'moon'
  | 'mercury'
  | 'venus'
  | 'mars'
  | 'jupiter'
  | 'saturn'
  | 'uranus'
  | 'neptune'
  | 'pluto';

export interface SolarBodyState {
  id: SolarBodyId;
  name: string;
  az: number;
  alt: number;
  /** Apparent visual magnitude (approximate for the Moon and planets). */
  mag: number;
  /** CSS colour used for the marker. */
  color: string;
  distanceAu: number;
  distanceKm: number;
  /** Illuminated fraction 0..1 (Sun always 1). */
  phaseFraction: number;
  /**
   * Sun–body–Earth angle in degrees: 0 for a new Moon, 180 for a full Moon.
   * Undefined for the Sun (reported as 0).
   */
  phaseAngle: number;
  /** IAU abbreviation of the constellation the body is in. */
  constellation: string;
  constellationName: string;
  /** Moon only: true when the illuminated limb is growing. */
  waxing: boolean;
}

// ---------------------------------------------------------------------------
// Stars and constellation figures
// ---------------------------------------------------------------------------

export interface StarCatalog {
  /** Right ascension, degrees in [0, 360). */
  raDeg: Float32Array;
  /** Declination, degrees. */
  decDeg: Float32Array;
  mag: Float32Array;
  /** Johnson B-V colour index. */
  colorIndex: Float32Array;
  /** Sparse display names, indexed by star index. */
  names: Map<number, string>;
  count: number;
}

export interface ConstellationFigure {
  id: string;
  name: string;
  labelRa: number;
  labelDec: number;
  /** Stick-figure segments, each an ordered list of [raDeg, decDeg] points. */
  lines: Array<Array<[number, number]>>;
}

export interface AsterismFigure {
  id: string;
  name: string;
  labelRa: number | null;
  labelDec: number | null;
  lines: Array<Array<[number, number]>>;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export type TargetKind = 'satellite' | 'body' | 'star' | 'constellation' | 'asterism';

export interface TargetRef {
  kind: TargetKind;
  id: string;
}
