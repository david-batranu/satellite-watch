import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadSkyData, resetSkyDataCache, type DataFetcher, type SkyData } from '../src/astro/starCatalog';

/** Read the real generated datasets from public/data so tests cover the shipped files. */
const diskFetcher: DataFetcher = async (path: string) => {
  const relative = path.replace(/^\//, '');
  return JSON.parse(await readFile(join(process.cwd(), 'public', relative), 'utf8'));
};

describe('sky data', () => {
  let data: SkyData;

  beforeEach(async () => {
    resetSkyDataCache();
    data = await loadSkyData(diskFetcher);
  });

  it('loads a full star catalogue', () => {
    expect(data.stars.count).toBeGreaterThan(4000);
    expect(data.stars.raDeg.length).toBe(data.stars.count);
    for (let i = 0; i < data.stars.count; i++) {
      const ra = data.stars.raDeg[i];
      const dec = data.stars.decDeg[i];
      expect(ra).toBeGreaterThanOrEqual(0);
      expect(ra).toBeLessThan(360);
      expect(dec).toBeGreaterThanOrEqual(-90);
      expect(dec).toBeLessThanOrEqual(90);
      expect(Number.isFinite(data.stars.mag[i])).toBe(true);
    }
  });

  it('names the brightest stars', () => {
    let siriusIndex = -1;
    for (let i = 0; i < data.stars.count; i++) {
      if (Math.abs(data.stars.raDeg[i] - 101.287) < 0.05 && Math.abs(data.stars.decDeg[i] + 16.716) < 0.05) {
        siriusIndex = i;
        break;
      }
    }
    expect(siriusIndex).toBeGreaterThanOrEqual(0);
    expect(data.stars.mag[siriusIndex]).toBeLessThan(-1);
    expect(data.stars.names.get(siriusIndex)).toContain('Sirius');
    expect(data.stars.names.size).toBeGreaterThan(500);
  });

  it('contains every IAU constellation with drawable figures', () => {
    expect(data.constellations.length).toBeGreaterThanOrEqual(88);
    const ids = new Set(data.constellations.map((c) => c.id));
    for (const id of ['And', 'Ori', 'UMa', 'Cru', 'Sco', 'Sgr', 'Peg', 'Cas']) {
      expect(ids.has(id), id).toBe(true);
    }
    const orion = data.constellations.find((c) => c.id === 'Ori');
    expect(orion?.name).toBe('Orion');
    expect(orion?.lines.length).toBeGreaterThanOrEqual(3);
    for (const constellation of data.constellations) {
      expect(constellation.lines.length).toBeGreaterThan(0);
      expect(Number.isFinite(constellation.labelRa)).toBe(true);
      expect(Number.isFinite(constellation.labelDec)).toBe(true);
    }
  });

  it('includes named asterisms for the quick-target list', () => {
    expect(data.asterisms.length).toBeGreaterThan(30);
    const names = data.asterisms.map((a) => a.name);
    expect(names).toContain('Big Dipper');
    for (const asterism of data.asterisms) {
      expect(asterism.lines.length).toBeGreaterThan(0);
    }
  });

  it('caches the load and reports the data source', async () => {
    const again = await loadSkyData(diskFetcher);
    expect(again).toBe(data);
    expect(data.source).toMatch(/d3-celestial/i);
  });

  it('rejects malformed payloads with a useful message', async () => {
    resetSkyDataCache();
    const broken: DataFetcher = async (path) =>
      path.endsWith('stars.json') ? { stars: 'nope' } : diskFetcher(path);
    await expect(loadSkyData(broken)).rejects.toThrow(/stars\.json/);
  });
});
