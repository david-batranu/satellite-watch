/**
 * Two-line element (TLE) helpers: checksums, epoch parsing, text parsing and
 * merging of catalogs from different sources.
 *
 * The same rules are implemented in `scripts/fetch-tle.mjs` for the build-time
 * snapshot; keeping validation in one place here means a malformed live refresh
 * can never corrupt the in-memory catalog.
 */

import type { SatelliteGroupId, SatelliteRecord, TleSnapshot } from '../types';

/** Standard TLE modulo-10 checksum over the first 68 characters. */
export function tleChecksumValid(line: string): boolean {
  if (typeof line !== 'string' || line.length < 69) return false;
  let sum = 0;
  for (let i = 0; i < 68; i++) {
    const c = line[i];
    if (c >= '0' && c <= '9') sum += c.charCodeAt(0) - 48;
    else if (c === '-') sum += 1;
  }
  const expected = line[68];
  return expected >= '0' && expected <= '9' && sum % 10 === Number(expected);
}

/** NORAD catalogue number from line 1. */
export function noradIdFromLine(line: string): number {
  return Number((line ?? '').slice(2, 7));
}

/**
 * TLE epoch → ms since the Unix epoch.
 * Columns 19-20 are a two-digit year, 21-32 the fractional day of year.
 */
export function parseTleEpochMs(tle1: string): number | null {
  if (typeof tle1 !== 'string' || tle1.length < 32) return null;
  const yearPart = tle1.slice(18, 20).trim();
  const dayPart = tle1.slice(20, 32).trim();
  const yy = Number(yearPart);
  const day = Number(dayPart);
  if (!Number.isFinite(yy) || !Number.isFinite(day) || day < 1 || day > 367) return null;
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  const ms = Date.UTC(year, 0, 1) + (day - 1) * 86_400_000;
  return Number.isFinite(ms) ? ms : null;
}

/** Clean up names coming from Celestrak (padding, stray control characters). */
export function cleanSatelliteName(raw: string): string {
  return (raw ?? '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a raw 3LE/TLE text blob (as served by Celestrak) into records.
 * Lines that fail the checksum are skipped rather than throwing.
 */
export function parseTleText(
  text: string,
  groups: SatelliteGroupId[] = [],
  options: { maxAgeDays?: number; now?: number } = {},
): SatelliteRecord[] {
  const lines = text.split(/\r?\n/);
  const records: SatelliteRecord[] = [];
  const now = options.now ?? Date.now();
  const maxAgeDays = options.maxAgeDays ?? 120;

  for (let i = 0; i + 2 < lines.length; i++) {
    const name = lines[i];
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    if (!line1?.startsWith('1 ') || !line2?.startsWith('2 ')) continue;
    if (!tleChecksumValid(line1) || !tleChecksumValid(line2)) continue;
    const norad = noradIdFromLine(line1);
    if (!Number.isFinite(norad) || norad <= 0) continue;
    if (noradIdFromLine(line2) !== norad) continue;
    const epoch = parseTleEpochMs(line1);
    if (epoch !== null && maxAgeDays > 0) {
      const ageDays = (now - epoch) / 86_400_000;
      // Reject absurd epochs (bad data / wrong century), keep slightly future ones.
      if (ageDays > maxAgeDays || ageDays < -7) continue;
    }
    records.push({
      norad,
      name: cleanSatelliteName(name) || `NORAD ${norad}`,
      groups: [...groups],
      tle1: line1.trimEnd(),
      tle2: line2.trimEnd(),
      epoch,
    });
    i += 2;
  }
  return records;
}

/**
 * Merge catalogs. The newer element set wins; group tags are unioned so a live
 * refresh of a subset of groups does not lose membership information.
 */
export function mergeSatelliteRecords(
  base: readonly SatelliteRecord[],
  incoming: readonly SatelliteRecord[],
): SatelliteRecord[] {
  const byNorad = new Map<number, SatelliteRecord>();

  const add = (record: SatelliteRecord) => {
    const existing = byNorad.get(record.norad);
    if (!existing) {
      byNorad.set(record.norad, { ...record, groups: [...new Set(record.groups)] });
      return;
    }
    const groups = [...new Set([...existing.groups, ...record.groups])] as SatelliteGroupId[];
    const existingEpoch = existing.epoch ?? 0;
    const incomingEpoch = record.epoch ?? 0;
    byNorad.set(record.norad, {
      ...(incomingEpoch >= existingEpoch ? record : existing),
      groups,
    });
  };

  for (const record of base) add(record);
  for (const record of incoming) add(record);

  return [...byNorad.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Parse and validate `public/data/tle-snapshot.json`. */
export function parseSnapshot(raw: unknown): TleSnapshot {
  const file = raw as Partial<TleSnapshot> | null;
  if (!file || !Array.isArray(file.satellites)) {
    throw new Error('tle-snapshot.json: missing "satellites" array');
  }
  const records: SatelliteRecord[] = [];
  for (const entry of file.satellites as unknown[]) {
    const item = entry as Record<string, unknown>;
    const norad = Number(item?.norad);
    const tle1 = typeof item?.tle1 === 'string' ? item.tle1 : '';
    const tle2 = typeof item?.tle2 === 'string' ? item.tle2 : '';
    if (!Number.isFinite(norad) || !tle1.startsWith('1 ') || !tle2.startsWith('2 ')) continue;
    const groups = Array.isArray(item?.groups)
      ? (item.groups as unknown[]).filter((g): g is SatelliteGroupId => typeof g === 'string')
      : [];
    records.push({
      norad,
      name: cleanSatelliteName(typeof item?.name === 'string' ? item.name : `NORAD ${norad}`),
      groups,
      tle1: tle1.trimEnd(),
      tle2: tle2.trimEnd(),
      epoch: Number.isFinite(Number(item?.epoch)) ? Number(item.epoch) : parseTleEpochMs(tle1),
    });
  }
  if (records.length === 0) throw new Error('tle-snapshot.json: no usable satellites');
  return {
    generatedAt: typeof file.generatedAt === 'string' ? file.generatedAt : new Date(0).toISOString(),
    source: typeof file.source === 'string' ? file.source : 'https://celestrak.org',
    groups: Array.isArray(file.groups) ? (file.groups as string[]) : [],
    counts: (file.counts as Record<string, number>) ?? {},
    satellites: records,
  };
}

/** Index records by NORAD id for fast lookups from the UI. */
export function indexByNorad(records: readonly SatelliteRecord[]): Map<number, number> {
  const map = new Map<number, number>();
  records.forEach((record, index) => map.set(record.norad, index));
  return map;
}

/** Age of the fresh-est element set in days (used for the "data age" chip). */
export function medianEpochAgeDays(records: readonly SatelliteRecord[], now = Date.now()): number {
  const ages = records
    .map((record) => (record.epoch === null ? Number.NaN : (now - record.epoch) / 86_400_000))
    .filter((age) => Number.isFinite(age))
    .sort((a, b) => a - b);
  if (!ages.length) return Number.POSITIVE_INFINITY;
  return ages[Math.floor(ages.length / 2)]!;
}
