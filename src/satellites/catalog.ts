/**
 * Satellite catalog: the bundled TLE snapshot, an on-device cache, and live
 * refreshes straight from CelesTrak.
 *
 * CelesTrak's `gp.php` endpoint answers CORS preflights with
 * `access-control-allow-origin: *`, so the SPA can refresh elements itself
 * without any backend. Refresh is deliberately conservative: at most once a day
 * automatically, and always user-triggerable.
 */

import { dataUrl } from '../lib/assets';
import { storageGet, storageSet } from '../lib/storage';
import { DEFAULT_ENABLED_GROUPS } from './groups';
import { medianEpochAgeDays, mergeSatelliteRecords, parseSnapshot, parseTleText } from './tle';
import type { SatelliteGroupId, SatelliteRecord, TleSnapshot } from '../types';

export interface SatelliteCatalog {
  records: SatelliteRecord[];
  generatedAt: string;
  source: string;
  counts: Record<string, number>;
}

export type CatalogSource = 'bundled' | 'cache' | 'live';

const BUNDLED_PATH = dataUrl('tle-snapshot.json');
const CACHE_KEY = 'tle-catalog-v1';
const CACHE_TTL_MS = 7 * 24 * 3600_000;
const AUTO_REFRESH_AGE_MS = 24 * 3600_000;
const CELESTRAK_API = 'https://celestrak.org/NORAD/elements/gp.php';

type JsonFetcher = (path: string) => Promise<unknown>;

const fetchJson: JsonFetcher = async (path) => {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
  return response.json();
};

export async function loadBundledCatalog(fetcher: JsonFetcher = fetchJson): Promise<SatelliteCatalog> {
  const snapshot: TleSnapshot = parseSnapshot(await fetcher(BUNDLED_PATH));
  return {
    records: snapshot.satellites,
    generatedAt: snapshot.generatedAt,
    source: snapshot.source,
    counts: snapshot.counts,
  };
}

/**
 * Heavy groups (Starlink is ~10,600 objects) are shipped as separate files and
 * loaded on demand, so the startup download stays small. Records are cached in
 * IndexedDB after the first load and work offline afterwards.
 */
export const OPTIONAL_GROUPS = ['starlink'] as const;
export type OptionalGroupId = (typeof OPTIONAL_GROUPS)[number];

export interface GroupCatalog {
  group: OptionalGroupId;
  records: SatelliteRecord[];
  generatedAt: string;
  count: number;
}

const GROUP_CACHE_PREFIX = 'tle-group-v1:';
const GROUP_CACHE_TTL_MS = 7 * 24 * 3600_000;

function isGroupCatalog(value: unknown): value is GroupCatalog {
  const catalog = value as GroupCatalog | null;
  return (
    !!catalog &&
    typeof catalog.group === 'string' &&
    Array.isArray(catalog.records) &&
    catalog.records.length > 0 &&
    typeof catalog.generatedAt === 'string'
  );
}

/**
 * Bundled catalogue for an optional group, with an IndexedDB cache.
 *
 * The cache is deliberately preferred over the network: the SPA works offline
 * and the bundled file is only downloaded every few days at most.
 */
export async function loadGroupCatalog(
  group: OptionalGroupId,
  fetcher: JsonFetcher = fetchJson,
  now = Date.now(),
): Promise<GroupCatalog> {
  const cacheKey = `${GROUP_CACHE_PREFIX}${group}`;
  try {
    const cached = await storageGet<GroupCatalog>(cacheKey);
    if (isGroupCatalog(cached)) {
      const savedAt = Date.parse(cached.generatedAt);
      if (!Number.isFinite(savedAt) || now - savedAt <= GROUP_CACHE_TTL_MS) return cached;
    }
  } catch {
    /* cache is best-effort */
  }

  const snapshot = parseSnapshot(await fetcher(dataUrl(`${group}.json`)));
  const catalog: GroupCatalog = {
    group,
    records: snapshot.satellites,
    generatedAt: snapshot.generatedAt,
    count: snapshot.satellites.length,
  };
  try {
    await storageSet(cacheKey, catalog);
  } catch {
    /* caching is optional */
  }
  return catalog;
}

function isCatalogLike(value: unknown): value is SatelliteCatalog {
  const catalog = value as SatelliteCatalog | null;
  return (
    !!catalog &&
    Array.isArray(catalog.records) &&
    catalog.records.length > 0 &&
    typeof catalog.generatedAt === 'string'
  );
}

/** Cached catalog from a previous session, if it is still useful. */
export async function loadCachedCatalog(now = Date.now()): Promise<SatelliteCatalog | null> {
  const cached = await storageGet<SatelliteCatalog>(CACHE_KEY);
  if (!isCatalogLike(cached)) return null;
  const savedAt = Date.parse(cached.generatedAt);
  if (Number.isFinite(savedAt) && now - savedAt > CACHE_TTL_MS) return null;
  return cached;
}

export async function saveCachedCatalog(catalog: SatelliteCatalog): Promise<void> {
  await storageSet(CACHE_KEY, catalog);
}

export interface LoadedCatalog {
  catalog: SatelliteCatalog;
  source: CatalogSource;
}

/**
 * Best available catalog: fresh cache → bundled snapshot.
 * Live refresh is a separate, explicit step so startup stays fast and offline
 * friendly.
 */
export async function loadCatalog(options: { fetcher?: JsonFetcher } = {}): Promise<LoadedCatalog> {
  try {
    const cached = await loadCachedCatalog();
    if (cached) return { catalog: cached, source: 'cache' };
  } catch {
    /* ignore cache failures */
  }
  const catalog = await loadBundledCatalog(options.fetcher ?? fetchJson);
  return { catalog, source: 'bundled' };
}

/** Age of the newest element set, in milliseconds. */
export function catalogAgeMs(catalog: SatelliteCatalog, now = Date.now()): number {
  const generated = Date.parse(catalog.generatedAt);
  if (Number.isFinite(generated)) return Math.max(0, now - generated);
  const ageDays = medianEpochAgeDays(catalog.records, now);
  return Number.isFinite(ageDays) ? ageDays * 86_400_000 : Number.POSITIVE_INFINITY;
}

/**
 * True when elements are old enough that a background refresh is worthwhile:
 * either the element sets themselves are stale, or the snapshot is more than a
 * day old (TLEs decay quickly, ~2 km of along-track error per day for LEO).
 */
export function shouldAutoRefresh(catalog: SatelliteCatalog, now = Date.now()): boolean {
  const ageDays = medianEpochAgeDays(catalog.records, now);
  if (Number.isFinite(ageDays) && ageDays > 1.5) return true;
  const generated = Date.parse(catalog.generatedAt);
  return Number.isFinite(generated) && now - generated > AUTO_REFRESH_AGE_MS;
}

async function fetchGroupText(group: SatelliteGroupId, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${CELESTRAK_API}?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/plain' },
      cache: 'no-cache',
    });
    if (!response.ok) throw new Error(`${group}: HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export interface LiveRefreshResult {
  records: SatelliteRecord[];
  counts: Record<string, number>;
  failedGroups: SatelliteGroupId[];
}

/**
 * Fetch fresh elements for the given groups. Groups that fail are reported but
 * do not abort the refresh: a partial update still improves accuracy.
 */
export async function fetchLiveElements(
  groups: readonly SatelliteGroupId[] = DEFAULT_ENABLED_GROUPS,
  options: { timeoutMs?: number } = {},
): Promise<LiveRefreshResult> {
  const timeoutMs = options.timeoutMs ?? 12_000;
  const settled = await Promise.allSettled(
    groups.map(async (group) => {
      const text = await fetchGroupText(group, timeoutMs);
      return { group, records: parseTleText(text, [group]) };
    }),
  );

  const records: SatelliteRecord[] = [];
  const counts: Record<string, number> = {};
  const failedGroups: SatelliteGroupId[] = [];

  settled.forEach((result, index) => {
    const group = groups[index]!;
    if (result.status === 'fulfilled' && result.value.records.length > 0) {
      records.push(...result.value.records);
      counts[group] = result.value.records.length;
    } else {
      failedGroups.push(group);
    }
  });

  if (!records.length) throw new Error('CelesTrak refresh failed for every group');
  return { records, counts, failedGroups };
}

/**
 * Merge a live refresh into the current catalog and persist the result.
 * Keeping the base means satellites that dropped out of a group's list are not
 * silently lost.
 */
export async function applyLiveRefresh(
  base: SatelliteCatalog,
  live: LiveRefreshResult,
): Promise<SatelliteCatalog> {
  const merged = mergeSatelliteRecords(base.records, live.records);
  const catalog: SatelliteCatalog = {
    records: merged,
    generatedAt: new Date().toISOString(),
    source: CELESTRAK_API,
    counts: { ...base.counts, ...live.counts },
  };
  await saveCachedCatalog(catalog);
  return catalog;
}
