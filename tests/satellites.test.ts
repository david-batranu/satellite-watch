import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createEntries,
  computeSkyStates,
  isSatelliteSunlit,
  sampleSatellite,
  sunEciUnit,
} from '../src/satellites/propagation';
import { findSatellitePasses, sampleSkyTrack } from '../src/satellites/passes';
import {
  medianEpochAgeDays,
  mergeSatelliteRecords,
  parseSnapshot,
  parseTleEpochMs,
  parseTleText,
  tleChecksumValid,
} from '../src/satellites/tle';
import { gstime } from 'satellite.js';
import { observerBasis } from '../src/lib/enu';
import type { Observer, SatelliteRecord } from '../src/types';

const ISS_TLE1 = '1 25544U 98067A   26320.56058679  .00009493  00000+0  17760-3 0  9997';
const ISS_TLE2 = '2 25544  51.6320 266.0553 0007390  32.4819 327.6623 15.49415609595374';
/** 2026-11-16T20:46:25Z — the epoch used for the independent python-sgp4 cross-check. */
const REFERENCE_TIME = new Date('2026-11-16T20:46:25.000Z');

const bucharest: Observer = {
  lat: 44.4,
  lon: 26.1,
  heightM: 100,
  accuracyM: 10,
  source: 'manual',
  updatedAt: 0,
};

const issRecord: SatelliteRecord = {
  norad: 25544,
  name: 'ISS (ZARYA)',
  groups: ['stations'],
  tle1: ISS_TLE1,
  tle2: ISS_TLE2,
  epoch: parseTleEpochMs(ISS_TLE1),
};

describe('TLE parsing', () => {
  it('validates checksums', () => {
    expect(tleChecksumValid(ISS_TLE1)).toBe(true);
    expect(tleChecksumValid(ISS_TLE2)).toBe(true);
    expect(tleChecksumValid(ISS_TLE1.slice(0, 60) + 'X' + ISS_TLE1.slice(61))).toBe(false);
    expect(tleChecksumValid('too short')).toBe(false);
  });

  it('parses the epoch into a UTC date', () => {
    const epoch = parseTleEpochMs(ISS_TLE1)!;
    // Day 320.56058679 of 2026 = 2026-11-16 13:27:14 UTC.
    expect(new Date(epoch).toISOString()).toMatch(/^2026-11-16T13:2[67]:/);
  });

  it('parses TLE text and skips corrupted entries', () => {
    const corrupted = `${ISS_TLE1.slice(0, 68)}9${ISS_TLE1.slice(69)}`;
    const text = [
      'ISS (ZARYA)',
      ISS_TLE1,
      ISS_TLE2,
      'BROKEN',
      corrupted,
      ISS_TLE2,
      'NOAA 20 (JPSS-1)',
      '1 43013U 17073A   26320.50000000  .00000100  00000+0  64000-4 0  9990',
      '2 43013  98.7200 200.0000 0001200  90.0000 270.0000 14.19500000 50000',
    ].join('\n');
    const records = parseTleText(text, ['stations']);
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records[0]!.norad).toBe(25544);
    expect(records[0]!.name).toBe('ISS (ZARYA)');
    expect(records[0]!.groups).toEqual(['stations']);
  });

  it('rejects absurd epochs', () => {
    const old = ISS_TLE1.replace('26320.56058679', '10001.00000000');
    expect(parseTleText(`OLD\n${old}\n${ISS_TLE2}`, ['stations'], { maxAgeDays: 30 })).toHaveLength(0);
  });

  it('merges catalogs preferring the newer element set', () => {
    const newerTle1 = ISS_TLE1.replace('26320.56058679', '26321.50000000');
    const merged = mergeSatelliteRecords(
      [{ ...issRecord, groups: ['stations'] }],
      [
        {
          ...issRecord,
          groups: ['visual'],
          tle1: newerTle1,
          epoch: parseTleEpochMs(newerTle1),
        },
      ],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.tle1).toBe(newerTle1);
    expect(merged[0]!.groups.sort()).toEqual(['stations', 'visual']);
  });

  it('reads the bundled snapshot', async () => {
    const raw = JSON.parse(await readFile(join(process.cwd(), 'public/data/tle-snapshot.json'), 'utf8'));
    const snapshot = parseSnapshot(raw);
    expect(snapshot.satellites.length).toBeGreaterThan(200);
    expect(snapshot.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const withGroups = snapshot.satellites.filter((s) => s.groups.length > 0);
    expect(withGroups.length).toBeGreaterThan(200);
    const medianAge = medianEpochAgeDays(snapshot.satellites, Date.parse('2026-11-20T00:00:00Z'));
    expect(medianAge).toBeGreaterThan(-1);
    expect(medianAge).toBeLessThan(60);
  });
});

describe('SGP4 propagation', () => {
  it('reproduces the reference ISS position cross-checked with python-sgp4', () => {
    const [entry] = createEntries([issRecord]);
    expect(entry!.valid).toBe(true);

    const basis = observerBasis(bucharest.lat, bucharest.lon, bucharest.heightM);
    const gmst = 0.13159225427105525; // gstime(REFERENCE_TIME), cross-checked in python
    const sample = sampleSatellite(entry!, REFERENCE_TIME, basis, gmst)!;
    expect(sample).not.toBeNull();

    // python-sgp4 (WGS84) gave ECF [-3877.674, 1821.893, -5286.286] km;
    // satellite.js uses WGS72, so allow ~1 km.
    expect(Math.abs(sample.ecf.x - -3877.682)).toBeLessThan(1);
    expect(Math.abs(sample.ecf.y - 1821.905)).toBeLessThan(1);
    expect(Math.abs(sample.ecf.z - -5286.298)).toBeLessThan(1);

    // Independent topocentric reference from an ENU implementation.
    expect(Math.abs(sample.topocentric.az - 119.3579)).toBeLessThan(0.02);
    expect(Math.abs(sample.topocentric.alt - -72.2537)).toBeLessThan(0.02);
    expect(Math.abs(sample.topocentric.rangeKm - 12580.347)).toBeLessThan(1);
  });

  it('produces a plausible low Earth orbit', () => {
    const [entry] = createEntries([issRecord]);
    const basis = observerBasis(bucharest.lat, bucharest.lon, bucharest.heightM);
    const sample = sampleSatellite(entry!, REFERENCE_TIME, basis, 0.13)!;
    const radius = Math.hypot(sample.eci.x, sample.eci.y, sample.eci.z);
    expect(radius).toBeGreaterThan(6600);
    expect(radius).toBeLessThan(6900);
  });

  it('marks invalid TLEs instead of crashing', () => {
    const [entry] = createEntries([
      { ...issRecord, tle1: ISS_TLE1.replace('25544', '00000'), tle2: '2 nonsense' },
    ]);
    expect(entry!.valid).toBe(false);
  });
});

describe('Earth shadow', () => {
  const sun = { x: 1, y: 0, z: 0 };

  it('is sunlit on the day side', () => {
    expect(isSatelliteSunlit({ x: 7000, y: 0, z: 0 }, sun)).toBe(true);
    expect(isSatelliteSunlit({ x: 5000, y: 4000, z: 0 }, sun)).toBe(true);
  });

  it('is in shadow behind the Earth', () => {
    expect(isSatelliteSunlit({ x: -7000, y: 0, z: 0 }, sun)).toBe(false);
    expect(isSatelliteSunlit({ x: -7000, y: 5000, z: 0 }, sun)).toBe(false);
  });

  it('escapes the shadow cylinder on the flanks', () => {
    expect(isSatelliteSunlit({ x: -7000, y: 7000, z: 0 }, sun)).toBe(true);
  });

  it('returns a unit Sun vector', () => {
    const unit = sunEciUnit(REFERENCE_TIME);
    expect(Math.hypot(unit.x, unit.y, unit.z)).toBeCloseTo(1, 9);
  });
});

describe('pass prediction', () => {
  it('finds ISS passes over Bucharest within 24 hours', () => {
    const [entry] = createEntries([issRecord]);
    const passes = findSatellitePasses(entry!, REFERENCE_TIME.getTime(), bucharest, {
      hours: 24,
      stepSeconds: 60,
      maxPasses: 3,
    });

    expect(passes.length).toBeGreaterThan(0);
    for (const pass of passes) {
      expect(pass.riseMs).toBeLessThan(pass.culminationMs);
      expect(pass.culminationMs).toBeLessThan(pass.setMs);
      const durationMinutes = (pass.setMs - pass.riseMs) / 60_000;
      expect(durationMinutes).toBeGreaterThan(0.5);
      expect(durationMinutes).toBeLessThan(20);
      expect(pass.maxEl).toBeGreaterThan(0);
      expect(pass.maxEl).toBeLessThanOrEqual(90);
      expect(pass.rangeAtCulminationKm).toBeGreaterThan(300);
      expect(pass.rangeAtCulminationKm).toBeLessThan(20_000);
    }

    // Passes must be in chronological order and strictly after `from`.
    for (let i = 1; i < passes.length; i++) {
      expect(passes[i]!.riseMs).toBeGreaterThan(passes[i - 1]!.riseMs);
    }
    expect(passes[0]!.riseMs).toBeGreaterThanOrEqual(REFERENCE_TIME.getTime());
  });

  it('reports the rise/set elevations near the horizon', () => {
    const [entry] = createEntries([issRecord]);
    const passes = findSatellitePasses(entry!, REFERENCE_TIME.getTime(), bucharest, {
      hours: 24,
      stepSeconds: 60,
      maxPasses: 1,
    });
    const pass = passes[0];
    if (!pass) return;
    const basis = observerBasis(bucharest.lat, bucharest.lon, bucharest.heightM);
    const riseDate = new Date(pass.riseMs);
    const setDate = new Date(pass.setMs);
    const rise = sampleSatellite(entry!, riseDate, basis, gstime(riseDate));
    const set = sampleSatellite(entry!, setDate, basis, gstime(setDate));
    expect(Math.abs(rise!.topocentric.alt)).toBeLessThan(0.4);
    expect(Math.abs(set!.topocentric.alt)).toBeLessThan(0.4);
  });

  it('draws a sky track through the highest pass', () => {
    const [entry] = createEntries([issRecord]);
    const passes = findSatellitePasses(entry!, REFERENCE_TIME.getTime(), bucharest, {
      hours: 24,
      stepSeconds: 60,
      maxPasses: 2,
    });
    const pass = passes.reduce<(typeof passes)[number] | undefined>(
      (best, candidate) => (!best || candidate.maxEl > best.maxEl ? candidate : best),
      undefined,
    );
    if (!pass) return;
    const track = sampleSkyTrack(entry!, pass.culminationMs, bucharest, {
      beforeMinutes: 30,
      afterMinutes: 30,
      stepSeconds: 10,
    });
    expect(track.length).toBeGreaterThan(5);
    const maxEl = Math.max(...track.map((point) => point.el));
    expect(Math.abs(maxEl - pass.maxEl)).toBeLessThan(1);
    for (let i = 1; i < track.length; i++) {
      expect(track[i]!.ms).toBeGreaterThan(track[i - 1]!.ms);
      expect(track[i]!.el).toBeGreaterThanOrEqual(-2);
    }
  });
});

describe('batch sky states', () => {
  it('returns only satellites above the horizon', async () => {
    const raw = JSON.parse(await readFile(join(process.cwd(), 'public/data/tle-snapshot.json'), 'utf8'));
    const records = parseSnapshot(raw).satellites;
    const entries = createEntries(records);
    const active = entries.filter((entry) => entry.valid).map((entry) => entry.index);
    const states = computeSkyStates(entries, active, REFERENCE_TIME, bucharest, { minElevationDeg: 0 });
    expect(states.length).toBeGreaterThan(0);
    expect(states.length).toBeLessThan(records.length);
    for (const state of states) {
      expect(state.el).toBeGreaterThanOrEqual(0);
      expect(state.rangeKm).toBeGreaterThan(100);
      expect(active).toContain(state.index);
    }
  });
});
