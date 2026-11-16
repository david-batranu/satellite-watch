/**
 * Rise/set times for the Sun, Moon and planets.
 *
 * These call astronomy-engine's `SearchRiseSet`, which accounts for the body's
 * apparent radius and standard refraction, so a "sunrise" here matches the
 * published value rather than the geometric horizon crossing.
 */

import { Observer as AstronomyObserver, SearchRiseSet } from 'astronomy-engine';
import { SOLAR_BODIES, solarBodyDef } from './skyBodies';
import type { Observer, SolarBodyId } from '../types';

export interface RiseSetTimes {
  riseMs: number | null;
  setMs: number | null;
}

/**
 * Next rise and next set after `from`, searching up to `limitDays` ahead.
 * `null` means the event does not occur in that window (circumpolar bodies).
 */
export function computeRiseSet(
  id: SolarBodyId,
  from: Date,
  observer: Observer,
  limitDays = 2,
): RiseSetTimes {
  const def = solarBodyDef(id);
  if (!def) return { riseMs: null, setMs: null };
  const aeObserver = new AstronomyObserver(observer.lat, observer.lon, observer.heightM);
  const result: RiseSetTimes = { riseMs: null, setMs: null };
  try {
    const rise = SearchRiseSet(def.body, aeObserver, 1, from, limitDays);
    if (rise) result.riseMs = rise.date.getTime();
  } catch {
    /* no rise in window */
  }
  try {
    const set = SearchRiseSet(def.body, aeObserver, -1, from, limitDays);
    if (set) result.setMs = set.date.getTime();
  } catch {
    /* no set in window */
  }
  return result;
}

/** Rise/set for every solar body. Used when the detail sheet opens. */
export function computeAllRiseSet(from: Date, observer: Observer, limitDays = 2): Map<SolarBodyId, RiseSetTimes> {
  const out = new Map<SolarBodyId, RiseSetTimes>();
  for (const def of SOLAR_BODIES) {
    out.set(def.id, computeRiseSet(def.id, from, observer, limitDays));
  }
  return out;
}
