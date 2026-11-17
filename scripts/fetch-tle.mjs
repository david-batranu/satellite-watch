#!/usr/bin/env node
/**
 * Downloads a curated set of two-line elements (TLEs) from CelesTrak and writes
 * a compact snapshot bundled with the app, so the SPA works offline and on first
 * load without depending on a live network call.
 *
 * The app can refresh the same groups directly from CelesTrak at runtime
 * (the gp.php endpoint sends `access-control-allow-origin: *`), caching the
 * result in IndexedDB.
 *
 * Run with: npm run data:tle
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'public/data');
const API = 'https://celestrak.org/NORAD/elements/gp.php';
const UA = 'satellite-watch/1.0 (open-source sky app; build script)';

/** Groups that are worth showing in an AR sky view, in decreasing priority. */
const GROUPS = [
  'stations', // ISS, Tiangong, ... the headline objects
  'visual', // the ~150 brightest satellites: best naked-eye candidates
  'science', // Hubble, probes, Earth-observation
  'weather', // NOAA / Metop / GOES
  'gps-ops',
  'galileo',
  'beidou',
  'iridium-NEXT',
];

/**
 * Heavy groups are written as separate files and loaded on demand: the initial
 * app download stays small, and the worker only propagates groups that are
 * enabled, so Starlink costs nothing until the user turns the layer on.
 */
const OPTIONAL_GROUPS = ['starlink'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Standard TLE modulo-10 checksum over the first 68 characters. */
function tleChecksum(line) {
  if (line.length < 69) return false;
  let sum = 0;
  for (let i = 0; i < 68; i++) {
    const c = line[i];
    if (c >= '0' && c <= '9') sum += c.charCodeAt(0) - 48;
    else if (c === '-') sum += 1;
  }
  const expected = line[68];
  return expected >= '0' && expected <= '9' && sum % 10 === Number(expected);
}

function epochToMs(line1) {
  // Columns 19-20: two-digit year, 21-32: day of year with fraction.
  const yy = Number(line1.slice(18, 20));
  const day = Number(line1.slice(20, 32));
  if (!Number.isFinite(yy) || !Number.isFinite(day)) return null;
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  const ms = Date.UTC(year, 0, 1) + (day - 1) * 86_400_000;
  return Number.isFinite(ms) ? ms : null;
}

function noradId(line1) {
  return Number(line1.slice(2, 7));
}

async function fetchGroup(group) {
  const url = `${API}?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${group}: HTTP ${res.status}`);
  return parseTleText(await res.text());
}

/** Parse a CelesTrak TLE bulk text response. */
function parseTleText(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

  const records = [];
  for (let i = 0; i + 2 < lines.length; i++) {
    const name = lines[i].trim();
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (!l1.startsWith('1 ') || !l2.startsWith('2 ')) continue;
    if (!tleChecksum(l1) || !tleChecksum(l2)) continue;
    const id = noradId(l1);
    if (!Number.isFinite(id) || id <= 0) continue;
    if (noradId(l2) !== id) continue;
    records.push({
      norad: id,
      name,
      tle1: l1.trimEnd(),
      tle2: l2.trimEnd(),
      epoch: epochToMs(l1),
    });
    i += 2;
  }
  return records;
}

function assert(cond, msg) {
  if (!cond) throw new Error(`validation failed: ${msg}`);
}

/**
 * Environment overrides, useful when CelesTrak throttles the big group queries
 * (a 10k-object group returns HTTP 403 when queried too often):
 *
 *   STARLINK_TLE_FILE=/tmp/starlink.txt TLE_SKIP_BASE=1 node scripts/fetch-tle.mjs
 */
async function writeOptionalGroups() {
  for (const group of OPTIONAL_GROUPS) {
    try {
      const envFile = process.env[`${group.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_TLE_FILE`];
      const records = envFile
        ? parseTleText(await readFile(envFile, 'utf8'))
        : await fetchGroup(group);
      assert(records.length > 100, `${group}: only ${records.length} objects`);
      const payload = {
        generatedAt: new Date().toISOString(),
        source: API,
        groups: [group],
        counts: { [group]: records.length },
        satellites: records
          .map((record) => ({ ...record, groups: [group] }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
      const output = resolve(OUT_DIR, `${group}.json`);
      await writeFile(output, JSON.stringify(payload));
      console.log(`  ${group.padEnd(14)} ${String(records.length).padStart(5)} optional objects → ${output}`);
    } catch (err) {
      // Keep a previously generated file so offline/CI builds still work.
      console.warn(`  ${group.padEnd(14)} FAILED: ${err.message} (keeping existing file)`);
    }
    await sleep(250);
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  if (process.env.TLE_SKIP_BASE === '1') {
    console.log('→ skipping base snapshot (TLE_SKIP_BASE=1)\n');
    console.log('→ optional on-demand groups\n');
    await writeOptionalGroups();
    return;
  }
  console.log('→ downloading TLEs from CelesTrak\n');

  /** @type {Map<number, {norad:number,name:string,tle1:string,tle2:string,epoch:number|null,groups:Set<string>}>} */
  const merged = new Map();
  const counts = {};
  let failures = 0;

  for (const group of GROUPS) {
    try {
      const records = await fetchGroup(group);
      counts[group] = records.length;
      for (const rec of records) {
        const existing = merged.get(rec.norad);
        if (existing) {
          existing.groups.add(group);
        } else {
          merged.set(rec.norad, { ...rec, groups: new Set([group]) });
        }
      }
      console.log(`  ${group.padEnd(14)} ${String(records.length).padStart(5)} tracked`);
    } catch (err) {
      failures++;
      console.warn(`  ${group.padEnd(14)} FAILED: ${err.message}`);
    }
    await sleep(250);
  }

  assert(merged.size > 100, `only ${merged.size} satellites collected`);
  assert(failures < GROUPS.length, 'every group request failed');

  const groupOrder = new Map(GROUPS.map((g, i) => [g, i]));
  const satellites = [...merged.values()]
    .map((s) => ({
      norad: s.norad,
      name: s.name,
      groups: [...s.groups].sort((a, b) => (groupOrder.get(a) ?? 99) - (groupOrder.get(b) ?? 99)),
      tle1: s.tle1,
      tle2: s.tle2,
      epoch: s.epoch,
    }))
    .sort((a, b) => {
      const pa = Math.min(...a.groups.map((g) => groupOrder.get(g) ?? 99));
      const pb = Math.min(...b.groups.map((g) => groupOrder.get(g) ?? 99));
      return pa - pb || a.name.localeCompare(b.name);
    });

  const generationAgeDays = satellites
    .map((s) => (s.epoch == null ? Infinity : (Date.now() - s.epoch) / 86_400_000))
    .filter((d) => Number.isFinite(d))
    .sort((a, b) => a - b);

  const payload = {
    generatedAt: new Date().toISOString(),
    source: API,
    groups: GROUPS,
    counts,
    satellites,
  };
  await writeFile(resolve(OUT_DIR, 'tle-snapshot.json'), JSON.stringify(payload));

  console.log('\n→ optional on-demand groups\n');
  await writeOptionalGroups();

  console.log(
    [
      '',
      `satellites: ${satellites.length} unique objects`,
      `epoch age:  ${generationAgeDays.length ? generationAgeDays[Math.floor(generationAgeDays.length / 2)].toFixed(1) + ' days (median)' : 'unknown'}`,
      `output:     ${resolve(OUT_DIR, 'tle-snapshot.json')}`,
    ].join('\n'),
  );
}

main().catch((err) => {
  console.error('✗ failed:', err.message);
  process.exitCode = 1;
});
