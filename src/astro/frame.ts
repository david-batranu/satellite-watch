/**
 * Sky frames: J2000 equatorial → local horizontal.
 *
 * Chain used for stars and constellation figures:
 *   1. catalog RA/Dec (J2000, degrees) → unit vector in EQJ
 *   2. precession rotation EQJ → EQD (equator/equinox of date), from astronomy-engine
 *   3. EQD → world, using local apparent sidereal time and the observer's latitude
 *
 * The world frame is +X east, +Y up, +Z south (see lib/enu.ts).
 *
 * `SiderealTime()` from astronomy-engine returns Greenwich apparent sidereal
 * time, so the observer's longitude must be folded in — this is a classic source
 * of ~1° errors at mid latitudes and is covered by tests.
 */

import { Rotation_EQJ_EQD, SiderealTime } from 'astronomy-engine';
import { DEG2RAD, RAD2DEG, clamp } from '../lib/angles';
import { worldUnitToAzAlt } from '../lib/enu';
import type { AzAlt, Vec3 } from '../types';

/** Greenwich apparent sidereal time, hours in [0, 24). */
export function greenwichSiderealHours(date: Date): number {
  const hours = SiderealTime(date) % 24;
  return hours < 0 ? hours + 24 : hours;
}

/** Local apparent sidereal time, hours in [0, 24). */
export function localSiderealHours(date: Date, lonDeg: number): number {
  const hours = (greenwichSiderealHours(date) + lonDeg / 15) % 24;
  return hours < 0 ? hours + 24 : hours;
}

/** 3×3 rotation, row-major, mapping a column vector. */
export type Matrix3 = Float64Array;

export function identityMatrix3(): Matrix3 {
  return Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
}

export function multiplyMatrix3(a: Matrix3, b: Matrix3): Matrix3 {
  const out = new Float64Array(9);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] =
        (a[row * 3] ?? 0) * (b[col] ?? 0) +
        (a[row * 3 + 1] ?? 0) * (b[3 + col] ?? 0) +
        (a[row * 3 + 2] ?? 0) * (b[6 + col] ?? 0);
    }
  }
  return out;
}

export function applyMatrix3(m: Matrix3, v: Vec3): Vec3 {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
    z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
  };
}

/**
 * Precession (and nutation) from J2000 mean equator to equator of date.
 *
 * astronomy-engine stores `RotationMatrix.rot` column-major relative to our
 * row-major convention (its `RotateVector` computes `out[i] = Σ rot[j][i]·v[j]`),
 * hence the transpose below. `tests/frame.test.ts` pins this against
 * `RotateVector` so the two can never silently diverge.
 */
export function precessionMatrixJ2000ToEqd(date: Date): Matrix3 {
  const rot = Rotation_EQJ_EQD(date).rot;
  const m = new Float64Array(9);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      m[row * 3 + col] = Number(rot[col]?.[row] ?? 0);
    }
  }
  return m;
}

/** Unit vector in the J2000 equatorial frame from catalog RA/Dec (degrees). */
export function raDecToEqjUnit(raDeg: number, decDeg: number): Vec3 {
  const ra = raDeg * DEG2RAD;
  const dec = decDeg * DEG2RAD;
  const cosDec = Math.cos(dec);
  return { x: cosDec * Math.cos(ra), y: cosDec * Math.sin(ra), z: Math.sin(dec) };
}

/** Horizontal coordinates of an exact equatorial (of-date) direction. */
export function eqdToWorldMatrix(localSiderealHoursValue: number, latDeg: number): Matrix3 {
  const l = localSiderealHoursValue * 15 * DEG2RAD;
  const phi = latDeg * DEG2RAD;
  const sinL = Math.sin(l);
  const cosL = Math.cos(l);
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  // Rows are the world components (east, up, south) of the EQD basis vectors.
  return Float64Array.from([
    // east
    -sinL,
    cosL,
    0,
    // up
    cosL * cosPhi,
    sinL * cosPhi,
    sinPhi,
    // south = -north
    cosL * sinPhi,
    sinL * sinPhi,
    -cosPhi,
  ]);
}

export interface SkyRotation {
  /** J2000 → world (+X east, +Y up, +Z south). */
  j2000ToWorld: Matrix3;
  /** Local apparent sidereal time, hours. */
  localSiderealHours: number;
  /** Time the rotation was computed for, ms. */
  computedAt: number;
}

/**
 * Build the J2000 → world rotation for an observer.
 *
 * Precession is expensive enough to be worth caching: it changes by less than a
 * hundredth of a degree per hour, so a 10-minute cache is invisible while
 * keeping star updates cheap.
 */
const precessionCache = new Map<number, Matrix3>();
const PRECESSION_BUCKET_MS = 10 * 60 * 1000;

export function computeSkyRotation(
  date: Date,
  latDeg: number,
  lonDeg: number,
  usePrecessionCache = true,
): SkyRotation {
  const ms = date.getTime();
  const bucket = Math.floor(ms / PRECESSION_BUCKET_MS);
  let precession: Matrix3 | undefined;
  if (usePrecessionCache) {
    precession = precessionCache.get(bucket);
  }
  if (!precession) {
    precession = precessionMatrixJ2000ToEqd(date);
    if (usePrecessionCache) {
      // Keep the cache tiny; only a handful of buckets are ever live.
      if (precessionCache.size > 32) precessionCache.clear();
      precessionCache.set(bucket, precession);
    }
  }
  const lst = localSiderealHours(date, lonDeg);
  const eqdToWorld = eqdToWorldMatrix(lst, latDeg);
  return {
    j2000ToWorld: multiplyMatrix3(eqdToWorld, precession),
    localSiderealHours: lst,
    computedAt: ms,
  };
}

/**
 * Atmospheric refraction correction, degrees, after Bennett (1982).
 * Valid above about -1° altitude; tapered to zero below that.
 */
export function refractionDeg(altDeg: number): number {
  if (altDeg < -1.5 || altDeg > 90) return 0;
  const h = clamp(altDeg, -1.5, 90);
  const arcMinutes = 1.02 / Math.tan((h + 10.3 / (h + 5.11)) * DEG2RAD);
  // Linear taper from 0° to -1.5°, where refraction should vanish smoothly.
  const taper = h >= 0 ? 1 : clamp((h + 1.5) / 1.5, 0, 1);
  return (arcMinutes / 60) * taper;
}

/**
 * Lift a world direction by atmospheric refraction, preserving its azimuth,
 * writing into `out`. Non-allocating: the hot render loops call this thousands
 * of times per tick.
 */
export function applyRefractionVector(x: number, y: number, z: number, out: Vec3): void {
  out.x = x;
  out.y = y;
  out.z = z;
  const altRad = Math.asin(clamp(y, -1, 1));
  const correction = refractionDeg(altRad * RAD2DEG);
  if (correction <= 0) return;
  const cosOld = Math.cos(altRad);
  if (cosOld < 1e-4) return; // near the zenith: refraction is negligible
  const newAlt = altRad + correction * DEG2RAD;
  const scale = Math.cos(newAlt) / cosOld;
  out.x = x * scale;
  out.y = Math.sin(newAlt);
  out.z = z * scale;
}

/**
 * Lift a world direction by atmospheric refraction, preserving its azimuth.
 * This is what makes objects near the horizon appear where the eye sees them.
 */
export function applyRefraction(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  const y = v.y / len;
  const altDeg = Math.asin(clamp(y, -1, 1)) * RAD2DEG;
  const correction = refractionDeg(altDeg);
  if (correction <= 0) return v;
  const altRad = Math.asin(clamp(y, -1, 1));
  const refractedRad = altRad + correction * DEG2RAD;
  const cosOld = Math.cos(altRad);
  if (cosOld < 1e-4) return v; // near the zenith: refraction is negligible
  const scale = Math.cos(refractedRad) / cosOld;
  return { x: v.x * scale, y: Math.sin(refractedRad) * len, z: v.z * scale };
}

/** Horizontal coordinates of a world direction. */
export function worldToAzAlt(v: Vec3): AzAlt {
  return worldUnitToAzAlt(v);
}
