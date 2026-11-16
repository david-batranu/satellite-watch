import { describe, expect, it } from 'vitest';
import {
  AstroTime,
  Horizon,
  Observer as AstronomyObserver,
  Rotation_EQJ_EQD,
  RotateVector,
  Vector,
} from 'astronomy-engine';
import {
  applyMatrix3,
  applyRefraction,
  computeSkyRotation,
  eqdToWorldMatrix,
  greenwichSiderealHours,
  localSiderealHours,
  precessionMatrixJ2000ToEqd,
  raDecToEqjUnit,
  refractionDeg,
} from '../src/astro/frame';
import { RAD2DEG } from '../src/lib/angles';
import { worldUnitToAzAlt } from '../src/lib/enu';

describe('sidereal time', () => {
  it('reproduces Greenwich apparent sidereal time at J2000', () => {
    // GMST at 2000-01-01T12:00 UT is 18h 41m 50s.
    expect(greenwichSiderealHours(new Date('2000-01-01T12:00:00Z'))).toBeCloseTo(18.6974, 2);
  });

  it('advances by longitude', () => {
    const date = new Date('2026-11-16T20:46:25Z');
    const greenwich = greenwichSiderealHours(date);
    expect(localSiderealHours(date, 26.1)).toBeCloseTo((greenwich + 26.1 / 15) % 24, 9);
    expect(localSiderealHours(date, -75)).toBeCloseTo((greenwich - 5 + 24) % 24, 9);
  });
});

describe('J2000 → horizontal transform', () => {
  it('puts a star at meridian/declination = latitude at the zenith', () => {
    const lst = 13.7;
    const lat = 44.4;
    const matrix = eqdToWorldMatrix(lst, lat);
    const world = applyMatrix3(matrix, raDecToEqjUnit(lst * 15, lat));
    const { alt } = worldUnitToAzAlt(world);
    expect(alt).toBeCloseTo(90, 6);
  });

  it('extracts the precession matrix with the same convention as RotateVector', () => {
    const date = new Date('2026-11-16T20:46:25Z');
    const matrix = precessionMatrixJ2000ToEqd(date);
    const eqj = raDecToEqjUnit(101.2872, -16.7161);
    const ours = applyMatrix3(matrix, eqj);
    const reference = RotateVector(
      Rotation_EQJ_EQD(date),
      new Vector(eqj.x, eqj.y, eqj.z, new AstroTime(date)),
    );
    expect(ours.x).toBeCloseTo(reference.x, 12);
    expect(ours.y).toBeCloseTo(reference.y, 12);
    expect(ours.z).toBeCloseTo(reference.z, 12);
  });

  it('matches astronomy-engine Horizon for several bright stars', () => {
    const date = new Date('2026-11-16T20:46:25Z');
    const lat = 44.4;
    const lon = 26.1;
    const aeObserver = new AstronomyObserver(lat, lon, 100);
    const rotation = computeSkyRotation(date, lat, lon);

    // J2000 coordinates of well-known stars.
    const stars: Array<[string, number, number]> = [
      ['Sirius', 101.2872, -16.7161],
      ['Vega', 279.2347, 38.7837],
      ['Polaris', 37.9546, 89.2641],
      ['Betelgeuse', 88.7929, 7.4071],
      ['Alpha Centauri', 219.9021, -60.834],
      ['Dubhe', 165.9319, 61.751],
      ['Antares', 247.3519, -26.432],
    ];

    for (const [name, raDeg, decDeg] of stars) {
      const eqj = raDecToEqjUnit(raDeg, decDeg);
      const ours = worldUnitToAzAlt(applyMatrix3(rotation.j2000ToWorld, eqj));

      // Independent path: precess with astronomy-engine, then let Horizon do the
      // spherical trigonometry. Refraction is disabled in both.
      const precessed = RotateVector(Rotation_EQJ_EQD(date), new Vector(eqj.x, eqj.y, eqj.z, new AstroTime(date)));
      const raHours = ((Math.atan2(precessed.y, precessed.x) * RAD2DEG) / 15 + 24) % 24;
      const dec = Math.asin(precessed.z) * RAD2DEG;
      const reference = Horizon(date, aeObserver, raHours, dec, undefined);

      expect(Math.abs(ours.az - reference.azimuth), `${name} azimuth`).toBeLessThan(0.01);
      expect(Math.abs(ours.alt - reference.altitude), `${name} altitude`).toBeLessThan(0.01);
    }
  });

  it('precesses J2000 coordinates to the epoch of observation', () => {
    const date = new Date('2026-11-16T20:46:25Z');
    const rotation = computeSkyRotation(date, 44.4, 26.1);
    const withoutPrecession = eqdToWorldMatrix(rotation.localSiderealHours, 44.4);
    const eqj = raDecToEqjUnit(101.2872, -16.7161);

    const withP = worldUnitToAzAlt(applyMatrix3(rotation.j2000ToWorld, eqj));
    const withoutP = worldUnitToAzAlt(applyMatrix3(withoutPrecession, eqj));
    // Precession since 2000 is about 0.36° in 26 years: small but real.
    expect(Math.abs(withP.az - withoutP.az) + Math.abs(withP.alt - withoutP.alt)).toBeGreaterThan(0.05);
    expect(Math.abs(withP.az - withoutP.az) + Math.abs(withP.alt - withoutP.alt)).toBeLessThan(1.5);
  });
});

describe('atmospheric refraction', () => {
  it('matches the Bennett approximation at well-known altitudes', () => {
    // 34 arcmin at the horizon, ~1 arcmin at 45°, nothing at the zenith.
    expect(refractionDeg(0)).toBeGreaterThan(0.45);
    expect(refractionDeg(0)).toBeLessThan(0.55);
    expect(refractionDeg(45)).toBeCloseTo(0.0169, 3);
    expect(refractionDeg(90)).toBeCloseTo(0, 3);
    expect(refractionDeg(-5)).toBe(0);
  });

  it('preserves azimuth and lifts altitude', () => {
    const direction = { x: 0.3, y: 0.05, z: -0.95 };
    const before = worldUnitToAzAlt(direction);
    const after = worldUnitToAzAlt(applyRefraction(direction));
    expect(after.alt).toBeGreaterThan(before.alt);
    expect(Math.abs(after.az - before.az)).toBeLessThan(1e-6);
    expect(after.alt - before.alt).toBeCloseTo(refractionDeg(before.alt), 6);
  });

  it('leaves objects below the taper untouched', () => {
    const direction = { x: 0, y: -0.5, z: -0.866 };
    expect(applyRefraction(direction)).toBe(direction);
  });
});
