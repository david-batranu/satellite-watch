import { describe, expect, it } from 'vitest';
import {
  azAltToWorldUnit,
  ecefToTopocentric,
  geodeticToEcef,
  observerBasis,
  worldUnitToAzAlt,
} from '../src/lib/enu';
import { normalizeDeg, normalizeSignedDeg } from '../src/lib/angles';

const close = (actual: number, expected: number, tolerance: number) =>
  expect(Math.abs(actual - expected)).toBeLessThan(tolerance);

describe('angles', () => {
  it('normalises degrees into [0, 360)', () => {
    expect(normalizeDeg(-10)).toBeCloseTo(350, 10);
    expect(normalizeDeg(370)).toBeCloseTo(10, 10);
    expect(normalizeDeg(360)).toBeCloseTo(0, 10);
    expect(normalizeSignedDeg(-190)).toBeCloseTo(170, 10);
    expect(normalizeSignedDeg(190)).toBeCloseTo(-170, 10);
  });
});

describe('horizontal coordinates ↔ world vectors', () => {
  it('maps the cardinal directions to the documented world frame', () => {
    // +X east, +Y up, +Z south
    const north = azAltToWorldUnit(0, 0);
    expect(north.x).toBeCloseTo(0, 12);
    expect(north.y).toBeCloseTo(0, 12);
    expect(north.z).toBeCloseTo(-1, 12);

    const east = azAltToWorldUnit(90, 0);
    expect(east.x).toBeCloseTo(1, 12);

    const up = azAltToWorldUnit(123, 90);
    expect(up.y).toBeCloseTo(1, 12);

    const southBelow = azAltToWorldUnit(180, -10);
    expect(southBelow.x).toBeCloseTo(0, 12);
    expect(southBelow.y).toBeCloseTo(-0.173648, 6);
    expect(southBelow.z).toBeCloseTo(0.984808, 6);
  });

  it('round-trips azimuth/altitude through the unit sphere', () => {
    for (let az = 0; az < 360; az += 17) {
      for (let alt = -85; alt <= 85; alt += 13) {
        const unit = azAltToWorldUnit(az, alt);
        const back = worldUnitToAzAlt(unit);
        close(back.az, az, 1e-6);
        close(back.alt, alt, 1e-6);
      }
    }
  });

  it('treats arbitrary vectors as directions', () => {
    const v = { x: 2, y: 2, z: -2 }; // north-east, 45° up
    const { az, alt } = worldUnitToAzAlt(v);
    close(az, 45, 1e-9);
    close(alt, 35.264389, 1e-5);
  });
});

describe('WGS84 geodetic → ECEF', () => {
  // Reference values computed independently with the standard WGS84 formula.
  const cases: Array<[number, number, number, [number, number, number]]> = [
    [44.4, 26.1, 100, [4099.101958, 2008.129329, 4440.025651]],
    [0, 0, 0, [6378.137, 0, 0]],
    [51.4779, -0.0015, 45, [3980.600533, -0.104212, 4966.866658]],
    [-33.8688, 151.2093, 50, [-4646.087656, 2553.226337, -3534.400253]],
    [90, 0, 0, [0, 0, 6356.752314]],
    [-45, 170, 500, [-4449.306705, 784.532817, -4487.701962]],
  ];

  it.each(cases)('lat %s lon %s h %s m', (lat, lon, heightM, [x, y, z]) => {
    const ecef = geodeticToEcef(lat, lon, heightM);
    close(ecef.x, x, 1e-5);
    close(ecef.y, y, 1e-5);
    close(ecef.z, z, 1e-5);
  });

  it('always reports a geocentric radius inside the WGS84 bounds', () => {
    for (const lat of [-89, -45, 0, 23, 45, 89]) {
      const ecef = geodeticToEcef(lat, 0, 0);
      const r = Math.hypot(ecef.x, ecef.y, ecef.z);
      expect(r).toBeGreaterThan(6356.7);
      expect(r).toBeLessThan(6378.2);
    }
  });
});

describe('ECEF → topocentric', () => {
  it('places the ISS below the horizon from Bucharest at the reference epoch', () => {
    // ISS ECF position computed with satellite.js for 2026-11-16T20:46:25Z.
    const issEcf = { x: -3877.682, y: 1821.905, z: -5286.298 };
    const basis = observerBasis(44.4, 26.1, 100);
    const pos = ecefToTopocentric(basis, issEcf);
    // Reference computed with an independent ENU implementation.
    close(pos.az, 119.3579, 0.0005);
    close(pos.alt, -72.2537, 0.0005);
    close(pos.rangeKm, 12580.347, 0.01);
  });

  it('looks straight up at a point above the observer', () => {
    const basis = observerBasis(44.4, 26.1, 0);
    const above = {
      x: basis.ecef.x + basis.up.x * 500,
      y: basis.ecef.y + basis.up.y * 500,
      z: basis.ecef.z + basis.up.z * 500,
    };
    const pos = ecefToTopocentric(basis, above);
    close(pos.alt, 90, 1e-9);
    close(pos.rangeKm, 500, 1e-9);
  });

  it('finds a point on the horizon at the correct bearing', () => {
    const basis = observerBasis(0, 0, 0);
    // Move east from the equator, 10 km, at the same height.
    const east = { x: basis.ecef.x, y: basis.ecef.y + 10, z: basis.ecef.z };
    const pos = ecefToTopocentric(basis, east);
    close(pos.az, 90, 1e-3);
    expect(Math.abs(pos.alt)).toBeLessThan(0.05);
  });
});
