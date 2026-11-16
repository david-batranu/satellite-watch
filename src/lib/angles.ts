/** Angle, distance and time helpers shared across the app. */

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Normalise an angle in degrees to [0, 360). */
export function normalizeDeg(deg: number): number {
  const v = deg % 360;
  return v < 0 ? v + 360 : v;
}

/** Normalise an angle in degrees to (-180, 180]. */
export function normalizeSignedDeg(deg: number): number {
  const v = normalizeDeg(deg);
  return v > 180 ? v - 360 : v;
}

/** Convert degrees to radians. */
export function rad(deg: number): number {
  return deg * DEG2RAD;
}

/** Convert radians to degrees. */
export function deg(radians: number): number {
  return radians * RAD2DEG;
}

/**
 * Great-circle angular separation between two horizontal coordinates, in
 * degrees. Used to order tap candidates and to decide whether a target is
 * close enough to be "aimed at".
 */
export function angularSeparationDeg(a: { az: number; alt: number }, b: { az: number; alt: number }): number {
  const alt1 = rad(a.alt);
  const alt2 = rad(b.alt);
  const dAz = rad(a.az - b.az);
  const cosSep = Math.sin(alt1) * Math.sin(alt2) + Math.cos(alt1) * Math.cos(alt2) * Math.cos(dAz);
  return deg(Math.acos(clamp(cosSep, -1, 1)));
}

/** 12.3° style formatting. */
export function formatAngle(value: number, digits = 1): string {
  return `${value.toFixed(digits)}°`;
}

/** 3 h 12 m / 4 m 20 s style formatting. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, '0')} m`;
  if (minutes > 0) return `${minutes} m ${String(seconds).padStart(2, '0')} s`;
  return `${seconds} s`;
}

/** Convert astronomical units to kilometres. */
export function auToKm(au: number): number {
  return au * 149_597_870.7;
}
