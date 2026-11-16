import { describe, expect, it } from 'vitest';
import { cameraAzAlt, quatFromAzAlt, deviceOrientationToCameraQuat } from '../src/sensors/orientationMath';
import { parseTargetId, targetId } from '../src/engine/targets';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../src/state/settings';
import { satelliteDisplayName, satelliteColor, SATELLITE_GROUP_LIST } from '../src/satellites/groups';
import { darknessLevel, moonPhaseName } from '../src/astro/skyBodies';
import { compassPoint, formatAge, formatBearing, formatTimeOffset } from '../src/lib/format';
import { bvToRgb, sizeForMagnitude } from '../src/lib/starColor';
import type { SolarBodyState, TargetRef, SatelliteRecord } from '../src/types';

describe('target ids', () => {
  const cases: TargetRef[] = [
    { kind: 'satellite', id: '25544' },
    { kind: 'body', id: 'jupiter' },
    { kind: 'star', id: '1023' },
    { kind: 'constellation', id: 'Ori' },
    { kind: 'asterism', id: 'BigDipper' },
  ];

  it('round-trips every target kind', () => {
    for (const target of cases) {
      const id = targetId(target)!;
      expect(parseTargetId(id)).toEqual(target);
    }
  });

  it('rejects nonsense ids', () => {
    expect(targetId(null)).toBeNull();
    expect(parseTargetId('nope')).toBeNull();
    expect(parseTargetId('unknown:1')).toBeNull();
  });
});

describe('manual look quaternion', () => {
  it('round-trips azimuth and altitude', () => {
    for (const az of [0, 45, 137, 250, 359]) {
      for (const alt of [-60, -15, 0, 20, 70]) {
        const q = quatFromAzAlt(az, alt);
        const { az: backAz, alt: backAlt } = cameraAzAlt(q);
        const azError = Math.abs(((backAz - az + 540) % 360) - 180);
        expect(azError).toBeLessThan(0.001);
        expect(Math.abs(backAlt - alt)).toBeLessThan(0.001);
      }
    }
  });

  it('is consistent with the device-orientation model', () => {
    // Upright phone, alpha = -azimuth, beta = 90 + altitude.
    const q = quatFromAzAlt(30, 25);
    const expected = deviceOrientationToCameraQuat(
      { alpha: 330, beta: 115, gamma: 0, absolute: true },
      0,
    );
    expect(cameraAzAlt(q).az).toBeCloseTo(cameraAzAlt(expected).az, 9);
    expect(cameraAzAlt(q).alt).toBeCloseTo(cameraAzAlt(expected).alt, 9);
  });
});

describe('settings', () => {
  it('falls back to defaults for empty input', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('clamps out-of-range values', () => {
    const settings = sanitizeSettings({
      starMagLimit: 42,
      fovDeg: 5,
      smoothing: 5,
      headingOffsetDeg: 900,
      timeOffsetMs: 10 * 86_400_000,
      pitchOffsetDeg: -999,
    });
    expect(settings.starMagLimit).toBeLessThanOrEqual(6);
    expect(settings.fovDeg).toBeGreaterThanOrEqual(32);
    expect(settings.smoothing).toBeLessThanOrEqual(1);
    expect(settings.headingOffsetDeg).toBeLessThanOrEqual(180);
    expect(settings.timeOffsetMs).toBeLessThanOrEqual(48 * 3_600_000);
    expect(settings.pitchOffsetDeg).toBeGreaterThanOrEqual(-60);
  });

  it('drops unknown satellite groups but keeps the rest', () => {
    const settings = sanitizeSettings({
      satelliteGroups: ['stations', 'not-a-group' as never, 'galileo'],
    });
    expect(settings.satelliteGroups).toEqual(['stations', 'galileo']);
    expect(sanitizeSettings({ satelliteGroups: [] }).satelliteGroups.length).toBeGreaterThan(0);
  });

  it('normalises units and booleans', () => {
    expect(sanitizeSettings({ units: 'imperial' }).units).toBe('imperial');
    expect(sanitizeSettings({ units: 'nonsense' as never }).units).toBe('metric');
    expect(sanitizeSettings({ cameraEnabled: false }).cameraEnabled).toBe(false);
    expect(sanitizeSettings({ cameraEnabled: 'yes' as never }).cameraEnabled).toBe(true);
  });
});

describe('satellite presentation', () => {
  const record = (norad: number, name: string, groups: SatelliteRecord['groups']): SatelliteRecord => ({
    norad,
    name,
    groups,
    tle1: '1 ',
    tle2: '2 ',
    epoch: null,
  });

  it('uses friendly names for famous objects', () => {
    expect(satelliteDisplayName(record(25544, 'ISS (ZARYA)', ['stations']))).toBe('ISS');
    expect(satelliteDisplayName(record(48274, 'CSS (TIANHE)', ['stations']))).toBe('Tiangong');
    expect(satelliteDisplayName(record(20580, 'HST', ['science']))).toBe('Hubble');
  });

  it('strips payload parentheticals from other names', () => {
    expect(satelliteDisplayName(record(99999, 'NOAA 20 (JPSS-1)', ['weather']))).toBe('NOAA 20');
    expect(satelliteDisplayName(record(99998, 'SIMPLE', ['visual']))).toBe('SIMPLE');
  });

  it('picks the most specific group colour', () => {
    expect(satelliteColor(['stations', 'visual'])).toBe(
      SATELLITE_GROUP_LIST.find((group) => group.id === 'stations')!.color,
    );
    expect(satelliteColor([])).toBe('#e2e8f0');
  });
});

describe('sky darkness', () => {
  const body = (id: SolarBodyState['id'], alt: number): SolarBodyState => ({
    id,
    name: id,
    az: 180,
    alt,
    mag: 0,
    color: '#fff',
    distanceAu: 1,
    distanceKm: 1,
    phaseFraction: 1,
    phaseAngle: 0,
    constellation: 'Ori',
    constellationName: 'Orion',
    waxing: true,
  });

  it('classifies the sky from the Sun altitude', () => {
    expect(darknessLevel([body('sun', 10)])).toBe('day');
    expect(darknessLevel([body('sun', -3)])).toBe('civil');
    expect(darknessLevel([body('sun', -9)])).toBe('nautical');
    expect(darknessLevel([body('sun', -20)])).toBe('astronomical');
    expect(darknessLevel([])).toBe('astronomical');
  });

  it('names lunar phases', () => {
    expect(moonPhaseName(5)).toBe('New Moon');
    expect(moonPhaseName(90)).toBe('First Quarter');
    expect(moonPhaseName(180)).toBe('Full Moon');
    expect(moonPhaseName(270)).toBe('Last Quarter');
    expect(moonPhaseName(350)).toBe('New Moon');
  });
});

describe('formatting', () => {
  it('formats bearings and compass points', () => {
    expect(compassPoint(0)).toBe('N');
    expect(compassPoint(90)).toBe('E');
    expect(compassPoint(225)).toBe('SW');
    expect(compassPoint(359)).toBe('N');
    expect(formatBearing(123.4)).toBe('123° ESE');
  });

  it('formats time offsets with days', () => {
    expect(formatTimeOffset(0)).toBe('live');
    expect(formatTimeOffset(90 * 60_000)).toBe('+1 h 30 m');
    expect(formatTimeOffset(-30 * 60_000)).toBe('−30 m');
    expect(formatTimeOffset(26 * 3_600_000)).toBe('+1 d 2 h');
  });

  it('formats data age', () => {
    expect(formatAge(0.01)).toBe('just now');
    expect(formatAge(0.5)).toBe('12 h');
    expect(formatAge(3.2)).toBe('3 d');
    expect(formatAge(Number.POSITIVE_INFINITY)).toBe('unknown');
  });
});

describe('star rendering helpers', () => {
  it('keeps colours in range for extreme B−V values', () => {
    for (const bv of [-0.4, 0, 0.65, 1.5, 2.4]) {
      const [r, g, b] = bvToRgb(bv);
      for (const channel of [r, g, b]) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
    // Hot blue star vs cool red star: blue channel must be relatively stronger.
    expect(bvToRgb(-0.2)[2]).toBeGreaterThan(bvToRgb(2.0)[2]);
  });

  it('scales marker size inversely with magnitude but clamps it', () => {
    const options = { base: 3.9, min: 1.4, max: 10 };
    expect(sizeForMagnitude(-1.5, options)).toBeGreaterThan(sizeForMagnitude(2, options));
    expect(sizeForMagnitude(12, options)).toBe(options.min);
    expect(sizeForMagnitude(-12, options)).toBe(options.max);
  });
});
