import { beforeEach, describe, expect, it } from 'vitest';
import { computeRiseSet } from '../src/astro/planetPasses';
import { computeSolarBodies, darknessLevel, moonPhaseName, resetSolarBodyCaches, SOLAR_BODIES } from '../src/astro/skyBodies';
import type { Observer } from '../src/types';

const bucharest: Observer = {
  lat: 44.4,
  lon: 26.1,
  heightM: 100,
  accuracyM: 10,
  source: 'manual',
  updatedAt: 0,
};

describe('solar bodies', () => {
  beforeEach(() => resetSolarBodyCaches());

  it('computes every supported body', () => {
    const bodies = computeSolarBodies(new Date('2026-11-16T20:46:25Z'), bucharest);
    expect(bodies.length).toBe(SOLAR_BODIES.length);
    for (const body of bodies) {
      expect(Number.isFinite(body.az)).toBe(true);
      expect(body.az).toBeGreaterThanOrEqual(0);
      expect(body.az).toBeLessThan(360);
      expect(Number.isFinite(body.alt)).toBe(true);
      expect(body.constellation.length).toBeGreaterThanOrEqual(2);
      expect(body.constellationName.length).toBeGreaterThan(2);
      expect(body.phaseFraction).toBeGreaterThanOrEqual(0);
      expect(body.phaseFraction).toBeLessThanOrEqual(1.0000001);
    }
  });

  it('puts the Sun on the meridian at local noon in November', () => {
    // 10:00 UTC = 12:00 local mean time in Bucharest; the Sun transits at about 10:00 UTC.
    const bodies = computeSolarBodies(new Date('2026-11-16T10:00:00Z'), bucharest);
    const sun = bodies.find((b) => b.id === 'sun');
    expect(sun).toBeDefined();
    expect(sun!.alt).toBeCloseTo(26.8, 0);
    expect(sun!.az).toBeCloseTo(180, 0);
    expect(sun!.phaseFraction).toBe(1);
  });

  it('puts the Sun well below the horizon at local midnight', () => {
    const bodies = computeSolarBodies(new Date('2026-11-16T22:00:00Z'), bucharest);
    const sun = bodies.find((b) => b.id === 'sun')!;
    expect(sun.alt).toBeLessThan(-50);
    expect(darknessLevel(bodies)).toBe('astronomical');
  });

  it('reports the Moon phase', () => {
    const bodies = computeSolarBodies(new Date('2026-11-16T20:46:25Z'), bucharest);
    const moon = bodies.find((b) => b.id === 'moon')!;
    expect(moon.phaseAngle).toBeGreaterThan(0);
    expect(moon.phaseAngle).toBeLessThan(180);
    expect(moonPhaseName(moon.phaseAngle)).toMatch(/Crescent|Quarter|Gibbous|Full|New/);
  });

  it('is topocentric: the Moon differs from the geocentric position', () => {
    const nearby = computeSolarBodies(new Date('2026-11-16T20:46:25Z'), { ...bucharest, lat: 44.4001 });
    const reference = computeSolarBodies(new Date('2026-11-16T20:46:25Z'), bucharest);
    const a = nearby.find((b) => b.id === 'moon')!;
    const b = reference.find((b) => b.id === 'moon')!;
    // 11 m of observer movement is tiny but must not produce identical floats.
    expect(a.alt === b.alt && a.az === b.az).toBe(false);
  });
});

describe('rise and set', () => {
  it('finds a plausible sunrise and sunset for a November day in Bucharest', () => {
    const from = new Date('2026-11-16T00:00:00Z');
    const { riseMs, setMs } = computeRiseSet('sun', from, bucharest);
    expect(riseMs).not.toBeNull();
    expect(setMs).not.toBeNull();

    const rise = new Date(riseMs!);
    const set = new Date(setMs!);
    expect(rise.getUTCHours()).toBeGreaterThanOrEqual(4);
    expect(rise.getUTCHours()).toBeLessThanOrEqual(7);
    expect(set.getUTCHours()).toBeGreaterThanOrEqual(13);
    expect(set.getUTCHours()).toBeLessThanOrEqual(16);
    expect(setMs!).toBeGreaterThan(riseMs!);
  });

  it('returns null events for a circumpolar Sun at midsummer north of the Arctic circle', () => {
    const svalbard: Observer = { ...bucharest, lat: 78.2, lon: 15.6 };
    const from = new Date('2026-06-21T00:00:00Z');
    const { riseMs, setMs } = computeRiseSet('sun', from, svalbard);
    expect(riseMs).toBeNull();
    expect(setMs).toBeNull();
  });

  it('finds Moon rise and set in a two-day window', () => {
    const from = new Date('2026-11-16T00:00:00Z');
    const { riseMs, setMs } = computeRiseSet('moon', from, bucharest, 3);
    expect(riseMs !== null || setMs !== null).toBe(true);
  });
});
