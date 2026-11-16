/**
 * Loading and validation of the bundled sky datasets (stars, constellation
 * figures, asterisms).
 *
 * The data lives in `public/data/*.json` so it is served as a static asset,
 * cached by the service worker, and can be regenerated without touching the
 * JavaScript bundle (see `scripts/fetch-catalogs.mjs`).
 */

import type { AsterismFigure, ConstellationFigure, StarCatalog } from '../types';

export interface SkyData {
  stars: StarCatalog;
  constellations: ConstellationFigure[];
  asterisms: AsterismFigure[];
  source: string;
  generatedAt: string | null;
}

export type DataFetcher = (path: string) => Promise<unknown>;

const defaultFetcher: DataFetcher = async (path) => {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
  return response.json();
};

interface RawStarsFile {
  source?: string;
  generatedAt?: string;
  stars?: unknown;
  names?: unknown;
}

interface RawConstellationsFile {
  constellations?: unknown;
}

interface RawAsterismsFile {
  asterisms?: unknown;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseStars(raw: unknown): StarCatalog {
  const file = raw as RawStarsFile;
  const rows = file?.stars;
  if (!Array.isArray(rows)) throw new Error('stars.json: missing "stars" array');

  const count = rows.length;
  const raDeg = new Float32Array(count);
  const decDeg = new Float32Array(count);
  const mag = new Float32Array(count);
  const colorIndex = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const row = rows[i];
    if (!Array.isArray(row) || row.length < 4) continue;
    const [ra, dec, m, ci] = row as number[];
    if (!isFiniteNumber(ra) || !isFiniteNumber(dec) || !isFiniteNumber(m)) continue;
    raDeg[i] = ((ra % 360) + 360) % 360;
    decDeg[i] = dec;
    mag[i] = m;
    colorIndex[i] = isFiniteNumber(ci) ? ci : 0.65;
  }

  const names = new Map<number, string>();
  const rawNames = file.names;
  if (rawNames && typeof rawNames === 'object') {
    for (const [key, value] of Object.entries(rawNames as Record<string, unknown>)) {
      const index = Number(key);
      if (Number.isInteger(index) && index >= 0 && index < count && typeof value === 'string') {
        names.set(index, value);
      }
    }
  }

  return { raDeg, decDeg, mag, colorIndex, names, count };
}

type RawLine = Array<[number, number]>;

function parseLines(value: unknown): RawLine[] {
  if (!Array.isArray(value)) return [];
  const lines: RawLine[] = [];
  for (const rawLine of value) {
    if (!Array.isArray(rawLine)) continue;
    const points: RawLine = [];
    for (const point of rawLine) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const [ra, dec] = point as number[];
      if (!isFiniteNumber(ra) || !isFiniteNumber(dec)) continue;
      points.push([ra, dec]);
    }
    // A single-point line cannot be drawn, so skip it.
    if (points.length >= 2) lines.push(points);
  }
  return lines;
}

function parseConstellations(raw: unknown): ConstellationFigure[] {
  const file = raw as RawConstellationsFile;
  if (!Array.isArray(file?.constellations)) {
    throw new Error('constellations.json: missing "constellations" array');
  }
  const out: ConstellationFigure[] = [];
  for (const entry of file.constellations as unknown[]) {
    const item = entry as Record<string, unknown>;
    const id = typeof item?.id === 'string' ? item.id : '';
    const name = typeof item?.name === 'string' ? item.name : id;
    const label = item?.label;
    const lines = parseLines(item?.lines);
    if (!id || !lines.length) continue;
    const labelRa = Array.isArray(label) && isFiniteNumber(label[0]) ? (label[0] as number) : 0;
    const labelDec = Array.isArray(label) && isFiniteNumber(label[1]) ? (label[1] as number) : 0;
    out.push({ id, name, labelRa, labelDec, lines });
  }
  if (out.length < 80) throw new Error(`constellations.json: only ${out.length} figures parsed`);
  return out;
}

function parseAsterisms(raw: unknown): AsterismFigure[] {
  const file = raw as RawAsterismsFile;
  if (!Array.isArray(file?.asterisms)) return [];
  const out: AsterismFigure[] = [];
  for (const entry of file.asterisms as unknown[]) {
    const item = entry as Record<string, unknown>;
    const id = typeof item?.id === 'string' ? item.id : '';
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    const lines = parseLines(item?.lines);
    const label = item?.label;
    if (!id || !name || !lines.length) continue;
    out.push({
      id,
      name,
      labelRa: Array.isArray(label) && isFiniteNumber(label[0]) ? (label[0] as number) : null,
      labelDec: Array.isArray(label) && isFiniteNumber(label[1]) ? (label[1] as number) : null,
      lines,
    });
  }
  return out;
}

let cache: Promise<SkyData> | null = null;

/** Load (once) and validate the sky datasets. */
export function loadSkyData(fetcher: DataFetcher = defaultFetcher, base = '/data'): Promise<SkyData> {
  if (cache) return cache;
  cache = (async () => {
    const [starsRaw, constellationsRaw, asterismsRaw] = await Promise.all([
      fetcher(`${base}/stars.json`),
      fetcher(`${base}/constellations.json`),
      fetcher(`${base}/asterisms.json`).catch(() => null),
    ]);
    const starsFile = starsRaw as RawStarsFile;
    return {
      stars: parseStars(starsRaw),
      constellations: parseConstellations(constellationsRaw),
      asterisms: asterismsRaw ? parseAsterisms(asterismsRaw) : [],
      source: typeof starsFile?.source === 'string' ? starsFile.source : 'd3-celestial',
      generatedAt: typeof starsFile?.generatedAt === 'string' ? starsFile.generatedAt : null,
    };
  })();
  // A failed load must not poison the cache.
  cache.catch(() => {
    cache = null;
  });
  return cache;
}

/** For tests and for a hard reset after a data refresh. */
export function resetSkyDataCache(): void {
  cache = null;
}
