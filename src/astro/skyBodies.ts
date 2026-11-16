/**
 * Sun, Moon and planet positions, computed with astronomy-engine.
 *
 * Everything here uses the observer's actual location: `Equator` with an
 * observer returns topocentric coordinates (the Moon moves by up to a degree
 * between geocentric and topocentric), `Horizon` folds in the local sidereal
 * time and applies atmospheric refraction.
 */

import {
  Body,
  Constellation,
  Equator,
  Horizon,
  Illumination,
  Observer as AstronomyObserver,
} from 'astronomy-engine';
import { auToKm, normalizeSignedDeg } from '../lib/angles';
import type { Observer, SolarBodyId, SolarBodyState } from '../types';

interface SolarBodyDef {
  id: SolarBodyId;
  body: Body;
  name: string;
  color: string;
}

/** Ordered from the most prominent to the least, which is also label priority. */
export const SOLAR_BODIES: readonly SolarBodyDef[] = [
  { id: 'sun', body: Body.Sun, name: 'Sun', color: '#ffd166' },
  { id: 'moon', body: Body.Moon, name: 'Moon', color: '#eef3fb' },
  { id: 'venus', body: Body.Venus, name: 'Venus', color: '#f6e7bd' },
  { id: 'jupiter', body: Body.Jupiter, name: 'Jupiter', color: '#efd9a6' },
  { id: 'mars', body: Body.Mars, name: 'Mars', color: '#e5836a' },
  { id: 'saturn', body: Body.Saturn, name: 'Saturn', color: '#e6d3a0' },
  { id: 'mercury', body: Body.Mercury, name: 'Mercury', color: '#c9c2b6' },
  { id: 'uranus', body: Body.Uranus, name: 'Uranus', color: '#a9e3e8' },
  { id: 'neptune', body: Body.Neptune, name: 'Neptune', color: '#8fb0f0' },
];

const BODY_BY_ID = new Map<SolarBodyId, SolarBodyDef>(SOLAR_BODIES.map((def) => [def.id, def]));

export function solarBodyDef(id: SolarBodyId): SolarBodyDef | undefined {
  return BODY_BY_ID.get(id);
}

export function solarBodyName(id: SolarBodyId): string {
  return BODY_BY_ID.get(id)?.name ?? id;
}

interface ConstellationCacheEntry {
  symbol: string;
  name: string;
  at: number;
}

const constellationCache = new Map<SolarBodyId, ConstellationCacheEntry>();
const CONSTELLATION_TTL_MS = 5 * 60 * 1000;

/** Which constellation does a body sit in? Cached: it changes at most weekly. */
function constellationOf(
  id: SolarBodyId,
  body: Body,
  date: Date,
  observer: AstronomyObserver,
): { symbol: string; name: string } {
  const now = date.getTime();
  const cached = constellationCache.get(id);
  if (cached && now - cached.at < CONSTELLATION_TTL_MS && now >= cached.at) return cached;
  // Constellation boundaries are defined in J2000 coordinates, so ask for EQJ.
  const j2000 = Equator(body, date, observer, false, true);
  const info = Constellation(j2000.ra, j2000.dec);
  const entry = { symbol: info.symbol, name: info.name, at: now };
  constellationCache.set(id, entry);
  return entry;
}

export function resetSolarBodyCaches(): void {
  constellationCache.clear();
}

/**
 * Positions of the Sun, Moon and planets as seen from the observer.
 * Bodies below the horizon are included (with negative altitude) so the UI can
 * tell the user where to look tomorrow.
 */
export function computeSolarBodies(date: Date, observer: Observer): SolarBodyState[] {
  const aeObserver = new AstronomyObserver(observer.lat, observer.lon, observer.heightM);
  const out: SolarBodyState[] = [];
  /** Right ascension (hours) per body, used to tell a waxing from a waning Moon. */
  const raHours = new Map<SolarBodyId, number>();

  for (const def of SOLAR_BODIES) {
    try {
      const equator = Equator(def.body, date, aeObserver, true, true);
      if (Number.isFinite(equator.ra)) raHours.set(def.id, equator.ra);
      const horizon = Horizon(date, aeObserver, equator.ra, equator.dec, 'normal');
      const illumination = Illumination(def.body, date);
      const constellation = constellationOf(def.id, def.body, date, aeObserver);
      const distanceAu = Number.isFinite(illumination.geo_dist) ? illumination.geo_dist : 0;
      out.push({
        id: def.id,
        name: def.name,
        az: ((horizon.azimuth % 360) + 360) % 360,
        alt: horizon.altitude,
        mag: Number.isFinite(illumination.mag) ? illumination.mag : 0,
        color: def.color,
        distanceAu,
        distanceKm: auToKm(distanceAu),
        phaseFraction:
          def.id === 'sun' ? 1 : Number.isFinite(illumination.phase_fraction) ? illumination.phase_fraction : 1,
        phaseAngle: def.id === 'sun' ? 0 : Number.isFinite(illumination.phase_angle) ? illumination.phase_angle : 0,
        constellation: constellation.symbol,
        constellationName: constellation.name,
        waxing: true,
      });
    } catch (error) {
      // Never let one body break the whole sky.
      console.warn(`[skyBodies] failed to compute ${def.id}`, error);
    }
  }

  // Waxing when the Moon is east of the Sun (positive RA difference).
  const sunRa = raHours.get('sun');
  const moonRa = raHours.get('moon');
  if (typeof sunRa === 'number' && typeof moonRa === 'number') {
    const waxing = normalizeSignedDeg((moonRa - sunRa) * 15) > 0;
    const moon = out.find((body) => body.id === 'moon');
    if (moon) moon.waxing = waxing;
  }

  return out;
}

/** Is it dark enough to see satellites? Based on the Sun's altitude. */
export function darknessLevel(
  bodies: readonly SolarBodyState[],
): 'day' | 'civil' | 'nautical' | 'astronomical' {
  const sun = bodies.find((body) => body.id === 'sun');
  if (!sun) return 'astronomical';
  // Civil twilight starts at sunset (0°) and ends at -6°, then nautical -12°,
  // then astronomical -18°.
  if (sun.alt > 0) return 'day';
  if (sun.alt > -6) return 'civil';
  if (sun.alt > -12) return 'nautical';
  return 'astronomical';
}

/** Human label describing the Moon's phase. */
export function moonPhaseName(phaseAngleDeg: number): string {
  const angle = ((phaseAngleDeg % 360) + 360) % 360;
  if (angle < 10 || angle >= 350) return 'New Moon';
  if (angle < 80) return 'Waxing Crescent';
  if (angle < 100) return 'First Quarter';
  if (angle < 170) return 'Waxing Gibbous';
  if (angle < 190) return 'Full Moon';
  if (angle < 260) return 'Waning Gibbous';
  if (angle < 280) return 'Last Quarter';
  return 'Waning Crescent';
}
