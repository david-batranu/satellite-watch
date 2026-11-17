import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ENABLED_GROUPS, SATELLITE_GROUP_LIST, SATELLITE_GROUP_META, satelliteColor } from '../src/satellites/groups';
import { OPTIONAL_GROUPS, loadGroupCatalog } from '../src/satellites/catalog';
import { parseSnapshot } from '../src/satellites/tle';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/state/settings';
import { SATELLITE_GROUPS, type TleSnapshot } from '../src/types';

/** Minimal, valid snapshot payload for the loader tests. */
function payload(records: Array<{ norad: number; name: string }>): TleSnapshot {
  const now = Date.now();
  return {
    generatedAt: new Date(now).toISOString(),
    source: 'https://celestrak.org/NORAD/elements/gp.php',
    groups: ['starlink'],
    counts: { starlink: records.length },
    satellites: records.map((record) => ({
      norad: record.norad,
      name: record.name,
      groups: ['starlink'],
      tle1: `1 ${String(record.norad).padStart(5, '0')}U 19074B   26320.96290404  .00183364  00000+0  14402-2 0  9995`,
      tle2: `2 ${String(record.norad).padStart(5, '0')}  53.1456  44.5949 0002737   7.7459 352.3601 15.70448124388085`,
      epoch: now,
    })),
  };
}

describe('starlink group', () => {
  it('is a known group, disabled by default, with display metadata', () => {
    expect(SATELLITE_GROUPS).toContain('starlink');
    expect(SATELLITE_GROUP_META.starlink.defaultEnabled).toBe(false);
    expect(SATELLITE_GROUP_LIST.map((group) => group.id)).toContain('starlink');
    expect(DEFAULT_ENABLED_GROUPS).not.toContain('starlink');
    expect(satelliteColor(['starlink'])).toBe(SATELLITE_GROUP_META.starlink.color);
  });

  it('is a lazily loaded optional group', () => {
    expect(OPTIONAL_GROUPS).toContain('starlink');
  });

  it('survives settings sanitisation, and stays out of the defaults', () => {
    const settings = sanitizeSettings({ satelliteGroups: ['stations', 'starlink'] });
    expect(settings.satelliteGroups).toEqual(['stations', 'starlink']);
    expect(DEFAULT_SETTINGS.satelliteGroups).not.toContain('starlink');
    // Persisted settings from a session with Starlink enabled must round-trip.
    expect(sanitizeSettings(settings).satelliteGroups).toContain('starlink');
  });
});

describe('optional group loader', () => {
  it('fetches the group file and validates it', async () => {
    const requested: string[] = [];
    const fetcher = async (path: string) => {
      requested.push(path);
      return payload([
        { norad: 44714, name: 'STARLINK-1008' },
        { norad: 44715, name: 'STARLINK-1009' },
      ]);
    };
    const catalog = await loadGroupCatalog('starlink', fetcher);
    expect(requested[0]).toMatch(/\/data\/starlink\.json$/);
    expect(catalog.group).toBe('starlink');
    expect(catalog.count).toBe(2);
    expect(catalog.records.map((record) => record.name)).toEqual(['STARLINK-1008', 'STARLINK-1009']);
    expect(catalog.records[0]!.groups).toEqual(['starlink']);
  });

  it('rejects payloads without usable satellites', async () => {
    await expect(loadGroupCatalog('starlink', async () => ({}) as never)).rejects.toThrow();
  });
});

describe('bundled starlink catalogue', () => {
  const file = JSON.parse(
    readFileSync(resolve('public/data/starlink.json'), 'utf8'),
  ) as TleSnapshot;

  it('parses into a large, valid record set', () => {
    const snapshot = parseSnapshot(file);
    expect(snapshot.satellites.length).toBeGreaterThan(5000);
    expect(snapshot.counts.starlink).toBe(snapshot.satellites.length);
    expect(snapshot.groups).toEqual(['starlink']);
    expect(snapshot.satellites.length).toBe(file.satellites.length);
  });

  it('has valid TLE structure, epochs and no duplicate NORAD ids', () => {
    const snapshot = parseSnapshot(file);
    const ids = new Set<number>();
    for (const record of snapshot.satellites) {
      expect(record.tle1.startsWith('1 ')).toBe(true);
      expect(record.tle2.startsWith('2 ')).toBe(true);
      expect(record.tle1.length).toBeGreaterThanOrEqual(69);
      expect(record.tle2.length).toBeGreaterThanOrEqual(69);
      expect(record.norad).toBe(Number(record.tle1.slice(2, 7)));
      expect(record.epoch).not.toBeNull();
      expect(record.groups).toEqual(['starlink']);
      expect(ids.has(record.norad)).toBe(false);
      ids.add(record.norad);
    }
    // Element sets must be recent enough to be useful for an AR view.
    const ageDays = (Date.now() - (snapshot.satellites[0]!.epoch ?? 0)) / 86_400_000;
    expect(ageDays).toBeLessThan(30);
  });
});
