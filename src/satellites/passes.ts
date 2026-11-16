/**
 * Pass prediction and sky-track sampling for satellites.
 *
 * A "pass" is the interval during which a satellite is above the horizon. The
 * search is deliberately simple (coarse scan + bisection refinement) and runs on
 * the main thread only when a satellite is selected, so it never competes with
 * the render loop.
 */

import { gstime } from 'satellite.js';
import { observerBasis } from '../lib/enu';
import type { Observer, SatellitePass } from '../types';
import {
  isSatelliteSunlit,
  sampleSatellite,
  sunEciUnit,
  type SatelliteEntry,
  type SatelliteSample,
} from './propagation';

export interface PassSearchOptions {
  /** How far ahead to search, in hours. */
  hours?: number;
  /** Coarse scan resolution, in seconds. */
  stepSeconds?: number;
  /** Elevation considered "up", in degrees. */
  minElevationDeg?: number;
  /** Stop after this many passes. */
  maxPasses?: number;
}

export interface TrackPoint {
  ms: number;
  az: number;
  el: number;
}

function sampleAt(
  entry: SatelliteEntry,
  ms: number,
  basis: ReturnType<typeof observerBasis>,
): SatelliteSample | null {
  return sampleSatellite(entry, new Date(ms), basis, gstime(new Date(ms)));
}

/** Bisect a horizon crossing between two samples, to roughly one second. */
function refineCrossing(
  entry: SatelliteEntry,
  basis: ReturnType<typeof observerBasis>,
  tLowMs: number,
  tHighMs: number,
  minElevationDeg: number,
): number {
  let low = tLowMs;
  let high = tHighMs;
  const lowAbove = (sampleAt(entry, low, basis)?.topocentric.alt ?? -90) >= minElevationDeg;
  for (let i = 0; i < 16; i++) {
    const mid = (low + high) / 2;
    const above = (sampleAt(entry, mid, basis)?.topocentric.alt ?? -90) >= minElevationDeg;
    if (above === lowAbove) low = mid;
    else high = mid;
  }
  return Math.round((low + high) / 2);
}

/** Golden-section search for the maximum elevation inside a pass. */
function findCulmination(
  entry: SatelliteEntry,
  basis: ReturnType<typeof observerBasis>,
  riseMs: number,
  setMs: number,
): { ms: number; el: number; rangeKm: number; sample: SatelliteSample | null } {
  let lo = riseMs;
  let hi = setMs;
  const phi = (Math.sqrt(5) - 1) / 2;
  let best = { ms: (riseMs + setMs) / 2, el: -90, rangeKm: Number.NaN, sample: null as SatelliteSample | null };

  for (let i = 0; i < 28 && hi - lo > 250; i++) {
    const a = hi - phi * (hi - lo);
    const b = lo + phi * (hi - lo);
    const sampleA = sampleAt(entry, a, basis);
    const sampleB = sampleAt(entry, b, basis);
    const elA = sampleA?.topocentric.alt ?? -90;
    const elB = sampleB?.topocentric.alt ?? -90;
    if (elA > elB) hi = b;
    else lo = a;
  }

  const mid = Math.round((lo + hi) / 2);
  const sample = sampleAt(entry, mid, basis);
  if (sample) {
    best = {
      ms: mid,
      el: sample.topocentric.alt,
      rangeKm: sample.topocentric.rangeKm,
      sample,
    };
  }
  return best;
}

/**
 * Upcoming passes for a satellite, soonest first.
 *
 * Passes already in progress at `fromMs` are not reported here (the live
 * az/el readout already covers "it is above you right now").
 */
export function findSatellitePasses(
  entry: SatelliteEntry,
  fromMs: number,
  observer: Observer,
  options: PassSearchOptions = {},
): SatellitePass[] {
  if (!entry.valid) return [];
  const hours = options.hours ?? 12;
  const stepMs = (options.stepSeconds ?? 45) * 1000;
  const minEl = options.minElevationDeg ?? 0;
  const maxPasses = options.maxPasses ?? 3;
  const basis = observerBasis(observer.lat, observer.lon, observer.heightM);

  const passes: SatellitePass[] = [];
  const endMs = fromMs + hours * 3_600_000;

  let tPrev = fromMs;
  let samplePrev = sampleAt(entry, tPrev, basis);
  let above = (samplePrev?.topocentric.alt ?? -90) >= minEl;

  // If it is already up, skip forward until it sets so we only report new passes.
  if (above) {
    let t = tPrev + stepMs;
    while (t < endMs && above) {
      const sample = sampleAt(entry, t, basis);
      above = (sample?.topocentric.alt ?? -90) >= minEl;
      tPrev = t;
      samplePrev = sample;
      t += stepMs;
    }
  }

  let riseCandidate: number | null = null;

  for (let t = tPrev + stepMs; t <= endMs && passes.length < maxPasses; t += stepMs) {
    const sample = sampleAt(entry, t, basis);
    const alt = sample?.topocentric.alt ?? -90;
    const prevAlt = samplePrev?.topocentric.alt ?? -90;

    if (prevAlt < minEl && alt >= minEl) {
      riseCandidate = refineCrossing(entry, basis, tPrev, t, minEl);
    } else if (prevAlt >= minEl && alt < minEl && riseCandidate !== null) {
      const setMs = refineCrossing(entry, basis, tPrev, t, minEl);
      const culmination = findCulmination(entry, basis, riseCandidate, setMs);
      passes.push({
        riseMs: riseCandidate,
        culminationMs: culmination.ms,
        setMs,
        maxEl: Math.max(0, culmination.el),
        rangeAtCulminationKm: culmination.rangeKm,
        sunlit: culmination.sample
          ? isSatelliteSunlit(culmination.sample.eci, sunEciUnit(new Date(culmination.ms)))
          : false,
      });
      riseCandidate = null;
    }

    tPrev = t;
    samplePrev = sample;
  }

  return passes;
}

/**
 * The satellite's path across the local sky over a time window, used to draw
 * the orbit arc in the AR view. Points below the horizon are discarded.
 */
export function sampleSkyTrack(
  entry: SatelliteEntry,
  fromMs: number,
  observer: Observer,
  options: { beforeMinutes?: number; afterMinutes?: number; stepSeconds?: number; minElevationDeg?: number } = {},
): TrackPoint[] {
  if (!entry.valid) return [];
  const beforeMinutes = options.beforeMinutes ?? 20;
  const afterMinutes = options.afterMinutes ?? 80;
  const stepMs = (options.stepSeconds ?? 20) * 1000;
  const minEl = options.minElevationDeg ?? -2;
  const basis = observerBasis(observer.lat, observer.lon, observer.heightM);

  const points: TrackPoint[] = [];
  const startMs = fromMs - beforeMinutes * 60_000;
  const endMs = fromMs + afterMinutes * 60_000;

  for (let t = startMs; t <= endMs; t += stepMs) {
    const sample = sampleAt(entry, t, basis);
    if (!sample) continue;
    const { alt, az } = sample.topocentric;
    if (alt < minEl) continue;
    points.push({ ms: t, az, el: alt });
  }
  return points;
}
