/**
 * Apparent orbit lines for the Sun and planets.
 *
 * Each body's path against the background stars over the coming year, sampled in
 * equatorial coordinates (equator of date) and later projected with the *current*
 * sky rotation. That is the planetarium notion of a planet orbit: a line fixed to
 * the star background showing where the body travels over time — including the
 * retrograde loops of the inner planets and Mars.
 *
 * The Moon is excluded: it laps the sky thirteen times a year, so a one-year path
 * would be a meaningless smear rather than an orbit line.
 */

import { Equator, Observer as AstronomyObserver } from 'astronomy-engine';
import type { Observer, SolarBodyId } from '../types';
import { SOLAR_BODIES } from './skyBodies';
import type { Matrix3 } from './frame';
import { DEG2RAD } from '../lib/angles';
import { hexToRgbUnit } from '../lib/color';

export const BODY_PATH_SPAN_DAYS = 365;
export const BODY_PATH_SAMPLES = 180;

export interface BodyPath {
  id: SolarBodyId;
  name: string;
  color: string;
  /** Right ascension (hours) and declination (degrees, equator of date) per sample. */
  coords: Float32Array;
  samples: number;
}

/** Number of line-segment vertices a path set needs for a given sample count. */
export function bodyPathVertexCount(paths: readonly BodyPath[]): number {
  let count = 0;
  for (const path of paths) count += Math.max(0, path.samples - 1) * 2;
  return count;
}

export interface BodyPathGeometryOptions {
  /** Selected body gets a brighter line. */
  selectedBody: SolarBodyId | null;
  skyRadius: number;
  maxVertices: number;
  /** Colour intensity of unselected paths. */
  dim: number;
  /** Colour intensity of the selected body's path. */
  bright: number;
}

/**
 * Sample the apparent path of every planet (and the Sun, which traces the
 * ecliptic) over the coming year.
 *
 * Samples are equally spaced in time; the curve is smooth enough at 180 points
 * that retrograde turns (a few weeks) are still resolved.
 */
export function computeBodyPaths(date: Date, observer: Observer): BodyPath[] {
  const aeObserver = new AstronomyObserver(observer.lat, observer.lon, observer.heightM);
  const startMs = date.getTime();
  const stepMs = (BODY_PATH_SPAN_DAYS * 86_400_000) / (BODY_PATH_SAMPLES - 1);
  const paths: BodyPath[] = [];

  for (const def of SOLAR_BODIES) {
    if (def.id === 'moon') continue;
    const coords = new Float32Array(BODY_PATH_SAMPLES * 2);
    let valid = true;
    for (let i = 0; i < BODY_PATH_SAMPLES; i++) {
      const sampleDate = new Date(startMs + i * stepMs);
      const equator = Equator(def.body, sampleDate, aeObserver, true, true);
      if (!Number.isFinite(equator.ra) || !Number.isFinite(equator.dec)) {
        valid = false;
        break;
      }
      coords[i * 2] = equator.ra;
      coords[i * 2 + 1] = equator.dec;
    }
    if (valid) {
      paths.push({
        id: def.id,
        name: def.name,
        color: def.color,
        coords,
        samples: BODY_PATH_SAMPLES,
      });
    }
  }
  return paths;
}

/**
 * Project the sampled paths into camera-world space for the current sky
 * rotation and write line-segment vertices into `positions`/`colors`.
 *
 * RA/Dec are of date, so the caller passes the equator-of-date → world matrix
 * (not the J2000 one used for stars). Buffers are caller-owned so the hot path
 * does not allocate; returns the number of vertices written.
 */
export function writeBodyPathGeometry(
  paths: readonly BodyPath[],
  worldMatrix: Matrix3,
  options: BodyPathGeometryOptions,
  positions: Float32Array,
  colors: Float32Array,
): number {
  const maxVertices = Math.min(
    Math.max(0, options.maxVertices),
    Math.floor(Math.min(positions.length, colors.length) / 3),
  );
  let vertex = 0;

  const m0 = worldMatrix[0] ?? 1;
  const m1 = worldMatrix[1] ?? 0;
  const m2 = worldMatrix[2] ?? 0;
  const m3 = worldMatrix[3] ?? 0;
  const m4 = worldMatrix[4] ?? 1;
  const m5 = worldMatrix[5] ?? 0;
  const m6 = worldMatrix[6] ?? 0;
  const m7 = worldMatrix[7] ?? 0;
  const m8 = worldMatrix[8] ?? 1;

  for (const path of paths) {
    if (vertex + 2 > maxVertices) break;
    const [r, g, b] = hexToRgbUnit(path.color);
    const isSelected = options.selectedBody === path.id;
    const baseIntensity = isSelected ? options.bright : options.dim;
    const samples = Math.min(path.samples, Math.floor(path.coords.length / 2));

    for (let i = 0; i < samples - 1 && vertex + 2 <= maxVertices; i++) {
      for (let k = 0; k < 2; k++) {
        const index = i + k;
        const ra = (path.coords[index * 2] ?? 0) * 15 * DEG2RAD;
        const dec = (path.coords[index * 2 + 1] ?? 0) * DEG2RAD;
        const cosDec = Math.cos(dec);
        const ex = cosDec * Math.cos(ra);
        const ey = cosDec * Math.sin(ra);
        const ez = Math.sin(dec);
        const wx = m0 * ex + m1 * ey + m2 * ez;
        const wy = m3 * ex + m4 * ey + m5 * ez;
        const wz = m6 * ex + m7 * ey + m8 * ez;
        positions[vertex * 3] = wx * options.skyRadius;
        positions[vertex * 3 + 1] = wy * options.skyRadius;
        positions[vertex * 3 + 2] = wz * options.skyRadius;

        // Fade along the path: "now" dim, a year ahead brighter, so the line
        // reads as a direction of travel.
        const progress = samples > 1 ? index / (samples - 1) : 1;
        const intensity = baseIntensity * (0.7 + 0.3 * progress);
        colors[vertex * 3] = r * intensity;
        colors[vertex * 3 + 1] = g * intensity;
        colors[vertex * 3 + 2] = b * intensity;
        vertex++;
      }
    }
  }

  return vertex;
}
