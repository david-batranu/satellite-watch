/**
 * Horizontal sky coordinates and Earth-fixed vector maths.
 *
 * ### World frame (three.js, right-handed, Y up)
 *   +X = East, +Y = Up, +Z = South
 * so North is -Z. This makes `azAltToWorldUnit(0, 0)` point at -Z and matches
 * the camera quaternion produced by the device-orientation maths:
 * an upright phone facing north yields a camera looking along -Z.
 *
 * ### ENU frame (astronomy)
 *   east, north, up (metres or kilometres, same as the input vectors)
 *
 * ### ECEF frame (WGS84)
 *   x through 0°N 0°E, y through 0°N 90°E, z through the north pole.
 */

import { DEG2RAD, RAD2DEG, clamp } from './angles';
import type { AzAlt, Vec3 } from '../types';

/** WGS84 semi-major axis, km. */
export const WGS84_A_KM = 6378.137;
/** WGS84 flattening. */
export const WGS84_F = 1 / 298.257223563;
/** WGS84 first eccentricity squared. */
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);
/** Mean Earth radius used for shadow geometry, km. */
export const EARTH_RADIUS_KM = 6371.0;

export interface EnuVector {
  east: number;
  north: number;
  up: number;
}

export interface TopocentricPosition extends AzAlt {
  rangeKm: number;
  enu: EnuVector;
}

/** Unit vector in the world frame for a horizontal sky direction. */
export function azAltToWorldUnit(azDeg: number, altDeg: number): Vec3 {
  const az = azDeg * DEG2RAD;
  const alt = altDeg * DEG2RAD;
  const cosAlt = Math.cos(alt);
  return {
    x: cosAlt * Math.sin(az), // east
    y: Math.sin(alt), // up
    z: -cosAlt * Math.cos(az), // south = -north
  };
}

/** Convenience: sky direction scaled to a radius (all sky objects are at a fixed radius). */
export function azAltToWorld(azDeg: number, altDeg: number, radius: number): Vec3 {
  const u = azAltToWorldUnit(azDeg, altDeg);
  return { x: u.x * radius, y: u.y * radius, z: u.z * radius };
}

/** Convert a world-frame direction to horizontal coordinates. */
export function worldUnitToAzAlt(v: Vec3): AzAlt {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  const up = v.y / len;
  const north = -v.z / len;
  const east = v.x / len;
  return {
    az: (((Math.atan2(east, north) * RAD2DEG) % 360) + 360) % 360,
    alt: Math.asin(clamp(up, -1, 1)) * RAD2DEG,
  };
}

/** Geodetic (WGS84) → ECEF, kilometres. */
export function geodeticToEcef(latDeg: number, lonDeg: number, heightM: number): Vec3 {
  const lat = latDeg * DEG2RAD;
  const lon = lonDeg * DEG2RAD;
  const h = heightM / 1000;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = WGS84_A_KM / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return {
    x: (n + h) * cosLat * Math.cos(lon),
    y: (n + h) * cosLat * Math.sin(lon),
    z: (n * (1 - WGS84_E2) + h) * sinLat,
  };
}

/**
 * Pre-computed local basis for an observer. Reusing this across hundreds of
 * satellite conversions per tick keeps the hot path allocation-free.
 */
export interface ObserverBasis {
  /** Observer position in ECEF, km. */
  ecef: Vec3;
  east: Vec3;
  north: Vec3;
  up: Vec3;
}

export function observerBasis(latDeg: number, lonDeg: number, heightM: number): ObserverBasis {
  const lat = latDeg * DEG2RAD;
  const lon = lonDeg * DEG2RAD;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);
  return {
    ecef: geodeticToEcef(latDeg, lonDeg, heightM),
    east: { x: -sinLon, y: cosLon, z: 0 },
    north: { x: -sinLat * cosLon, y: -sinLat * sinLon, z: cosLat },
    up: { x: cosLat * cosLon, y: cosLat * sinLon, z: sinLat },
  };
}

/** Convert an ECEF point (km) to a topocentric position for the observer. */
export function ecefToTopocentric(basis: ObserverBasis, targetEcef: Vec3): TopocentricPosition {
  const dx = targetEcef.x - basis.ecef.x;
  const dy = targetEcef.y - basis.ecef.y;
  const dz = targetEcef.z - basis.ecef.z;
  const east = dx * basis.east.x + dy * basis.east.y + dz * basis.east.z;
  const north = dx * basis.north.x + dy * basis.north.y + dz * basis.north.z;
  const up = dx * basis.up.x + dy * basis.up.y + dz * basis.up.z;
  const range = Math.hypot(east, north, up);
  const az = (((Math.atan2(east, north) * RAD2DEG) % 360) + 360) % 360;
  const alt = Math.asin(clamp(up / (range || 1), -1, 1)) * RAD2DEG;
  return { az, alt, rangeKm: range, enu: { east, north, up } };
}

/** Convert an ECEF point (km) straight to azimuth/elevation/range. */
export function ecefToAzAltRange(
  latDeg: number,
  lonDeg: number,
  heightM: number,
  targetEcef: Vec3,
): TopocentricPosition {
  return ecefToTopocentric(observerBasis(latDeg, lonDeg, heightM), targetEcef);
}

/** ENU vector → world-frame vector (east, up, -north). */
export function enuToWorldUnit(enu: EnuVector): Vec3 {
  return { x: enu.east, y: enu.up, z: -enu.north };
}
