/**
 * SGP4 propagation and topocentric conversion for satellites.
 *
 * Pipeline: TLE → satellite.js SGP4 (TEME/ECI, km) → ECF via GMST → local
 * ENU → azimuth/elevation/range. The ECI position is also used to decide whether
 * the satellite is in sunlight or inside the Earth's shadow.
 *
 * Verified in tests against python-sgp4: the ISS reference position agrees to
 * about 15 m (the difference between the WGS72 and WGS84 constants).
 */

import { AstroTime, Body, GeoVector, Rotation_EQJ_EQD, RotateVector, Vector } from 'astronomy-engine';
import { eciToEcf, gstime, propagate, twoline2satrec } from 'satellite.js';
import type { SatRec } from 'satellite.js';
import {
  EARTH_RADIUS_KM,
  ecefToTopocentric,
  observerBasis,
  type ObserverBasis,
  type TopocentricPosition,
} from '../lib/enu';
import type { Observer, SatelliteRecord, SatelliteSkyState, Vec3 } from '../types';

export interface SatelliteEntry {
  /** Index into the catalog array; stable across group toggles. */
  index: number;
  record: SatelliteRecord;
  satrec: SatRec | null;
  valid: boolean;
}

function isValidSatrec(satrec: SatRec | null): satrec is SatRec {
  if (!satrec) return false;
  if ((satrec.error ?? 0) !== 0) return false;
  return (
    Number.isFinite(satrec.no) &&
    satrec.no > 0 &&
    Number.isFinite(satrec.jdsatepoch) &&
    Number.isFinite(satrec.ecco) &&
    satrec.ecco >= 0 &&
    satrec.ecco < 1
  );
}

/** Parse TLEs into SGP4 records once; malformed entries are marked invalid. */
export function createEntries(records: readonly SatelliteRecord[]): SatelliteEntry[] {
  return records.map((record, index) => {
    let satrec: SatRec | null = null;
    try {
      satrec = twoline2satrec(record.tle1, record.tle2);
    } catch {
      satrec = null;
    }
    const valid = isValidSatrec(satrec);
    return { index, record, satrec: valid ? satrec : null, valid };
  });
}

/** Propagate to an inertial position (km) in TEME, or null on failure. */
export function propagateEci(entry: SatelliteEntry, date: Date): Vec3 | null {
  if (!entry.satrec) return null;
  const pv = propagate(entry.satrec, date);
  const position = pv?.position;
  if (!position || typeof position === 'boolean') return null;
  const { x, y, z } = position;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

/** ECI → Earth-fixed (km) using Greenwich mean sidereal time. */
export function eciToEcfPosition(eci: Vec3, gmstRadians: number): Vec3 {
  const ecf = eciToEcf({ x: eci.x, y: eci.y, z: eci.z }, gmstRadians);
  return { x: ecf.x, y: ecf.y, z: ecf.z };
}

export interface SatelliteSample {
  eci: Vec3;
  ecf: Vec3;
  topocentric: TopocentricPosition;
}

/**
 * One satellite sample: SGP4 propagation plus local horizon coordinates.
 * `gmstRadians` can be shared across a whole batch of satellites.
 */
export function sampleSatellite(
  entry: SatelliteEntry,
  date: Date,
  basis: ObserverBasis,
  gmstRadians: number,
): SatelliteSample | null {
  const eci = propagateEci(entry, date);
  if (!eci) return null;
  const ecf = eciToEcfPosition(eci, gmstRadians);
  const topocentric = ecefToTopocentric(basis, ecf);
  if (!Number.isFinite(topocentric.az) || !Number.isFinite(topocentric.alt)) return null;
  return { eci, ecf, topocentric };
}

// ---------------------------------------------------------------------------
// Sunlight / Earth shadow
// ---------------------------------------------------------------------------

const sunCache = { at: 0, unit: { x: 0, y: 0, z: 1 } as Vec3 };

/**
 * Unit vector towards the Sun in the same frame as satellite.js positions
 * (equator of date, approximately TEME). Cached for a minute: the Sun moves
 * ~0.0007° in that time.
 */
export function sunEciUnit(date: Date): Vec3 {
  const now = date.getTime();
  if (Math.abs(now - sunCache.at) < 60_000 && sunCache.at !== 0) return sunCache.unit;

  const geo = GeoVector(Body.Sun, date, false); // J2000 equatorial, AU
  const eqd = RotateVector(
    Rotation_EQJ_EQD(date),
    new Vector(geo.x, geo.y, geo.z, new AstroTime(date)),
  );
  const len = Math.hypot(eqd.x, eqd.y, eqd.z) || 1;
  sunCache.unit = { x: eqd.x / len, y: eqd.y / len, z: eqd.z / len };
  sunCache.at = now;
  return sunCache.unit;
}

/**
 * Is a satellite in sunlight?
 *
 * Cylindrical umbra model: if the satellite is on the sunward side of the
 * terminator plane it is lit; on the night side it is in shadow when its
 * perpendicular distance from the Earth–Sun axis is smaller than the Earth's
 * radius. Good to a few seconds of penumbra at LEO speeds.
 */
export function isSatelliteSunlit(eci: Vec3, sunUnit: Vec3): boolean {
  const along = eci.x * sunUnit.x + eci.y * sunUnit.y + eci.z * sunUnit.z;
  if (along > 0) return true;
  const perpX = eci.x - along * sunUnit.x;
  const perpY = eci.y - along * sunUnit.y;
  const perpZ = eci.z - along * sunUnit.z;
  return Math.hypot(perpX, perpY, perpZ) > EARTH_RADIUS_KM;
}

// ---------------------------------------------------------------------------
// Batch computation (used by the worker)
// ---------------------------------------------------------------------------

export interface SkyStateOptions {
  /** Only satellites above this elevation are returned. */
  minElevationDeg?: number;
}

/**
 * Positions for a set of satellites that are currently above the horizon.
 * Runs off the main thread (see satellites/worker.ts).
 */
export function computeSkyStates(
  entries: readonly SatelliteEntry[],
  activeIndices: readonly number[],
  date: Date,
  observer: Observer,
  options: SkyStateOptions = {},
): SatelliteSkyState[] {
  const minEl = options.minElevationDeg ?? -1;
  const basis = observerBasis(observer.lat, observer.lon, observer.heightM);
  const gmstRadians = gstime(date);
  const sunUnit = sunEciUnit(date);
  const states: SatelliteSkyState[] = [];

  for (const index of activeIndices) {
    const entry = entries[index];
    if (!entry?.valid) continue;
    const sample = sampleSatellite(entry, date, basis, gmstRadians);
    if (!sample) continue;
    if (sample.topocentric.alt < minEl) continue;
    states.push({
      index: entry.index,
      az: sample.topocentric.az,
      el: sample.topocentric.alt,
      rangeKm: sample.topocentric.rangeKm,
      sunlit: isSatelliteSunlit(sample.eci, sunUnit),
    });
  }

  return states;
}

/** Extra numbers used by the detail sheet for a single satellite. */
export interface SatelliteDetail {
  az: number;
  el: number;
  rangeKm: number;
  altitudeKm: number;
  sunlit: boolean;
}

export function describeSatellite(
  entry: SatelliteEntry,
  date: Date,
  observer: Observer,
): SatelliteDetail | null {
  const basis = observerBasis(observer.lat, observer.lon, observer.heightM);
  const sample = sampleSatellite(entry, date, basis, gstime(date));
  if (!sample) return null;
  const sunUnit = sunEciUnit(date);
  return {
    az: sample.topocentric.az,
    el: sample.topocentric.alt,
    rangeKm: sample.topocentric.rangeKm,
    altitudeKm: Math.hypot(sample.eci.x, sample.eci.y, sample.eci.z) - EARTH_RADIUS_KM,
    sunlit: isSatelliteSunlit(sample.eci, sunUnit),
  };
}
