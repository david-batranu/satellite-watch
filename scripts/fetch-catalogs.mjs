#!/usr/bin/env node
/**
 * Builds the compact star / constellation datasets bundled with the app.
 *
 * Source: d3-celestial (https://github.com/ofrohn/d3-celestial), a collection of
 * public-domain astronomy datasets derived from Hipparcos (ESA) and the IAU
 * constellation definitions. Attribution is shown in the app's Credits sheet.
 *
 * Output (in public/data/):
 *   stars.json         ~5k stars to magnitude 6: [[raDeg, decDeg, mag, bvColour], ...]
 *   constellations.json 88/89 IAU constellation stick figures + labels
 *   asterisms.json     named naked-eye patterns (Big Dipper, Summer Triangle, ...)
 *
 * All right ascensions are stored in degrees, normalised to [0, 360).
 * Run with: npm run data:catalogs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'public/data');
const BASE = 'https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data';
const SOURCE = 'd3-celestial (Hipparcos / IAU)';

const round2 = (v) => Math.round(v * 100) / 100;
const round1 = (v) => Math.round(v * 10) / 10;

async function download(file) {
  const url = `${BASE}/${file}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'satellite-watch/1.0 (build script)' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/** Normalise a right ascension (degrees, possibly negative) into [0, 360). */
function normRa(deg) {
  const v = ((deg % 360) + 360) % 360;
  return round2(v === 360 ? 0 : v);
}

function coordOk(ra, dec) {
  return (
    Number.isFinite(ra) &&
    Number.isFinite(dec) &&
    ra >= -360 &&
    ra <= 360 &&
    dec >= -90.0001 &&
    dec <= 90.0001
  );
}

function cleanLines(feature) {
  const geom = feature?.geometry;
  if (!geom) return [];
  const multi = geom.type === 'MultiLineString' ? geom.coordinates : [geom.coordinates];
  const lines = [];
  for (const line of multi) {
    if (!Array.isArray(line)) continue;
    const pts = [];
    for (const p of line) {
      if (!Array.isArray(p) || p.length < 2) continue;
      const [ra, dec] = p;
      if (!coordOk(ra, dec)) continue;
      pts.push([normRa(ra), round2(dec)]);
    }
    if (pts.length >= 2) lines.push(pts);
  }
  return lines;
}

async function buildStarsWithNames() {
  // Build names together with the final sorted array in one pass.
  const [catalog, nameData] = await Promise.all([download('stars.6.json'), download('starnames.json')]);
  const rows = [];
  let skipped = 0;

  for (const feature of catalog.features ?? []) {
    const props = feature?.properties ?? {};
    const coords = feature?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) {
      skipped++;
      continue;
    }
    const [ra, dec] = coords;
    const mag = Number(props.mag);
    if (!coordOk(ra, dec) || !Number.isFinite(mag) || mag > 6.05) {
      skipped++;
      continue;
    }
    const bv = Number(props.bv);
    let label = '';
    if (mag <= 4.5) {
      const entry = nameData?.[String(feature.id)];
      if (entry) {
        const constel = typeof entry.c === 'string' ? entry.c.trim() : '';
        const bayer = typeof entry.bayer === 'string' ? entry.bayer.trim() : '';
        const flam = typeof entry.flam === 'string' ? entry.flam.trim() : '';
        const proper = typeof entry.name === 'string' ? entry.name.trim() : '';
        label = proper;
        if (!label && bayer) label = `${bayer} ${constel}`.trim();
        if (!label && flam) label = `${flam} ${constel}`.trim();
      }
    }
    rows.push({
      row: [
        normRa(ra),
        round2(dec),
        round1(mag),
        Number.isFinite(bv) ? round2(Math.max(-0.5, Math.min(2.5, bv))) : 0.65,
      ],
      label,
    });
  }

  rows.sort((a, b) => a.row[2] - b.row[2]);
  const stars = rows.map((r) => r.row);
  const names = {};
  rows.forEach((r, i) => {
    if (r.label) names[i] = r.label;
  });
  return { stars, names, skipped };
}

async function buildConstellations() {
  const [linesDoc, infoDoc] = await Promise.all([
    download('constellations.lines.json'),
    download('constellations.json'),
  ]);

  const info = new Map();
  for (const f of infoDoc.features ?? []) {
    const props = f.properties ?? {};
    const coords = f.geometry?.coordinates;
    info.set(f.id, {
      name: typeof props.name === 'string' && props.name ? props.name : f.id,
      label: Array.isArray(coords) && coords.length >= 2 ? [normRa(coords[0]), round2(coords[1])] : null,
    });
  }

  const merged = new Map(); // Serpens is split into two features but shares the IAU id
  for (const f of linesDoc.features ?? []) {
    if (!f?.id) continue;
    const lines = cleanLines(f);
    if (!lines.length) continue;
    const existing = merged.get(f.id);
    if (existing) existing.lines.push(...lines);
    else merged.set(f.id, { id: f.id, lines });
  }

  const constellations = [];
  for (const [id, entry] of merged) {
    const meta = info.get(id);
    let label = meta?.label ?? null;
    if (!label) {
      // Fall back to the mean of all vertices.
      let x = 0;
      let y = 0;
      let n = 0;
      for (const line of entry.lines)
        for (const p of line) {
          x += Math.cos((p[0] * Math.PI) / 180);
          y += Math.sin((p[0] * Math.PI) / 180);
          n++;
        }
      if (n) label = [normRa((Math.atan2(y, x) * 180) / Math.PI), 0];
    }
    if (!label) continue;
    constellations.push({ id, name: meta?.name ?? id, label, lines: entry.lines });
  }
  constellations.sort((a, b) => a.name.localeCompare(b.name));
  return constellations;
}

async function buildAsterisms() {
  const doc = await download('asterisms.json');
  const asterisms = [];
  for (const f of doc.features ?? []) {
    const props = f.properties ?? {};
    const name = typeof props.n === 'string' ? props.n.trim() : '';
    const lines = cleanLines(f);
    if (!name || !lines.length) continue;
    const loc = Array.isArray(props.loc) && props.loc.length >= 2 ? props.loc : null;
    asterisms.push({
      id: f.id ?? name.replace(/\s+/g, ''),
      name,
      label: loc && coordOk(loc[0], loc[1]) ? [normRa(loc[0]), round2(loc[1])] : null,
      lines,
    });
  }
  asterisms.sort((a, b) => a.name.localeCompare(b.name));
  return asterisms;
}

function assert(condition, message) {
  if (!condition) throw new Error(`data validation failed: ${message}`);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();

  console.log('→ downloading star catalogue…');
  const { stars, names, skipped } = await buildStarsWithNames();
  assert(stars.length > 4000, `only ${stars.length} stars parsed`);
  assert(stars.every((s) => s[0] >= 0 && s[0] < 360), 'ra out of range');
  assert(stars.every((s) => s[1] >= -90 && s[1] <= 90), 'dec out of range');
  assert(Object.keys(names).length > 100, 'too few star names');

  console.log('→ downloading constellation figures…');
  const constellations = await buildConstellations();
  assert(constellations.length >= 88, `only ${constellations.length} constellations`);

  console.log('→ downloading asterisms…');
  const asterisms = await buildAsterisms();
  assert(asterisms.length > 30, `only ${asterisms.length} asterisms`);

  await writeFile(
    resolve(OUT_DIR, 'stars.json'),
    JSON.stringify({ source: SOURCE, epoch: 'J2000', generatedAt, stars, names }),
  );
  await writeFile(
    resolve(OUT_DIR, 'constellations.json'),
    JSON.stringify({ source: SOURCE, generatedAt, constellations }),
  );
  await writeFile(
    resolve(OUT_DIR, 'asterisms.json'),
    JSON.stringify({ source: SOURCE, generatedAt, asterisms }),
  );

  console.log(
    [
      '',
      `stars:          ${stars.length} (${Object.keys(names).length} named, ${skipped} skipped)`,
      `constellations: ${constellations.length}`,
      `asterisms:      ${asterisms.length}`,
      `written to      ${OUT_DIR}`,
    ].join('\n'),
  );
}

main().catch((err) => {
  console.error('✗ failed:', err.message);
  process.exitCode = 1;
});
