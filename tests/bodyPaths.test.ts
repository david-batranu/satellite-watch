import { describe, expect, it } from 'vitest';
import {
  BODY_PATH_SAMPLES,
  BODY_PATH_SPAN_DAYS,
  bodyPathVertexCount,
  computeBodyPaths,
  writeBodyPathGeometry,
} from '../src/astro/bodyPaths';
import { computeSkyRotation, eqdToWorldMatrix } from '../src/astro/frame';
import { SOLAR_BODIES } from '../src/astro/skyBodies';
import { hexToRgbUnit } from '../src/lib/color';
import { DEG2RAD, RAD2DEG } from '../src/lib/angles';
import { SKY_RADIUS } from '../src/render/skyRenderer';
import type { Observer } from '../src/types';

const OBSERVER: Observer = {
  lat: 44.4268,
  lon: 26.1025,
  heightM: 85,
  accuracyM: null,
  source: 'preset',
  updatedAt: 0,
};
const DATE = new Date('2026-11-17T20:55:00Z');
const OBLIQUITY = 23.4392911 * DEG2RAD;

function pathByName(paths: ReturnType<typeof computeBodyPaths>, name: string) {
  const path = paths.find((candidate) => candidate.name === name);
  if (!path) throw new Error(`missing path for ${name}`);
  return path;
}

/** Ecliptic latitude of an RA/Dec sample, degrees. */
function eclipticLatitudeDeg(raHours: number, decDeg: number): number {
  const ra = raHours * 15 * DEG2RAD;
  const dec = decDeg * DEG2RAD;
  return (
    Math.asin(Math.sin(dec) * Math.cos(OBLIQUITY) - Math.cos(dec) * Math.sin(OBLIQUITY) * Math.sin(ra)) *
    RAD2DEG
  );
}

/** Angle between two unit vectors from RA/Dec samples, degrees. */
function separationDeg(
  aRaHours: number,
  aDecDeg: number,
  bRaHours: number,
  bDecDeg: number,
): number {
  const a = { x: Math.cos(aDecDeg * DEG2RAD) * Math.cos(aRaHours * 15 * DEG2RAD), y: Math.cos(aDecDeg * DEG2RAD) * Math.sin(aRaHours * 15 * DEG2RAD), z: Math.sin(aDecDeg * DEG2RAD) };
  const b = { x: Math.cos(bDecDeg * DEG2RAD) * Math.cos(bRaHours * 15 * DEG2RAD), y: Math.cos(bDecDeg * DEG2RAD) * Math.sin(bRaHours * 15 * DEG2RAD), z: Math.sin(bDecDeg * DEG2RAD) };
  const dot = a.x * b.x + a.y * b.y + a.z * b.z;
  return Math.acos(Math.max(-1, Math.min(1, dot))) * RAD2DEG;
}

describe('planet orbit lines: sampling', () => {
  it('samples the Sun and every planet, but not the Moon', () => {
    const paths = computeBodyPaths(DATE, OBSERVER);
    expect(paths).toHaveLength(SOLAR_BODIES.length - 1);
    expect(paths.map((path) => path.id)).not.toContain('moon');
    expect(paths.map((path) => path.id)).toEqual(
      expect.arrayContaining(['sun', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']),
    );
  });

  it('produces finite, valid coordinates for every sample', () => {
    for (const path of computeBodyPaths(DATE, OBSERVER)) {
      expect(path.samples).toBe(BODY_PATH_SAMPLES);
      expect(path.coords).toHaveLength(BODY_PATH_SAMPLES * 2);
      for (let i = 0; i < path.samples; i++) {
        const ra = path.coords[i * 2]!;
        const dec = path.coords[i * 2 + 1]!;
        expect(Number.isFinite(ra)).toBe(true);
        expect(Number.isFinite(dec)).toBe(true);
        expect(ra).toBeGreaterThanOrEqual(0);
        expect(ra).toBeLessThan(24);
        expect(Math.abs(dec)).toBeLessThanOrEqual(90);
      }
    }
  });

  it('the Sun traces the ecliptic over a year', () => {
    const sun = pathByName(computeBodyPaths(DATE, OBSERVER), 'Sun');
    let maxLatitude = 0;
    for (let i = 0; i < sun.samples; i++) {
      maxLatitude = Math.max(
        maxLatitude,
        Math.abs(eclipticLatitudeDeg(sun.coords[i * 2]!, sun.coords[i * 2 + 1]!)),
      );
    }
    // The apparent Sun stays within a few arcseconds of the ecliptic.
    expect(maxLatitude).toBeLessThan(0.02);
  });

  it('covers a full circuit for the Sun and a small arc for Jupiter', () => {
    const paths = computeBodyPaths(DATE, OBSERVER);
    const spanOf = (name: string) => {
      const path = pathByName(paths, name);
      let max = 0;
      for (let i = 0; i < path.samples; i++) {
        for (let j = i + 1; j < path.samples; j++) {
          max = Math.max(
            max,
            separationDeg(
              path.coords[i * 2]!,
              path.coords[i * 2 + 1]!,
              path.coords[j * 2]!,
              path.coords[j * 2 + 1]!,
            ),
          );
        }
      }
      return max;
    };
    // A year of Sun positions wraps the whole ecliptic.
    expect(spanOf('Sun')).toBeGreaterThan(170);
    // Jupiter covers only ~30° of sky in the same year.
    expect(spanOf('Jupiter')).toBeGreaterThan(5);
    expect(spanOf('Jupiter')).toBeLessThan(60);
  });

  it('spans the configured number of days', () => {
    expect(BODY_PATH_SPAN_DAYS).toBeGreaterThanOrEqual(365);
    // Sampling a year at 180 points is a ~2-day cadence.
    expect(BODY_PATH_SAMPLES).toBeGreaterThanOrEqual(120);
  });
});

describe('planet orbit lines: projection', () => {
  const paths = computeBodyPaths(DATE, OBSERVER);
  const rotation = computeSkyRotation(DATE, OBSERVER.lat, OBSERVER.lon);

  it('writes one segment pair per sample gap at unit length', () => {
    const expectedVertices = bodyPathVertexCount(paths);
    expect(expectedVertices).toBe((SOLAR_BODIES.length - 1) * (BODY_PATH_SAMPLES - 1) * 2);

    const positions = new Float32Array(expectedVertices * 3);
    const colors = new Float32Array(expectedVertices * 3);
    const matrix = eqdToWorldMatrix(rotation.localSiderealHours, OBSERVER.lat);
    const count = writeBodyPathGeometry(
      paths,
      matrix,
      { selectedBody: 'mars', skyRadius: SKY_RADIUS, maxVertices: expectedVertices, dim: 0.32, bright: 0.95 },
      positions,
      colors,
    );

    expect(count).toBe(expectedVertices);
    let brightestMars = 0;
    let brightestOther = 0;
    for (let i = 0; i < count; i++) {
      const x = positions[i * 3]!;
      const y = positions[i * 3 + 1]!;
      const z = positions[i * 3 + 2]!;
      expect(Math.hypot(x, y, z)).toBeCloseTo(SKY_RADIUS, 2);
      const r = colors[i * 3]!;
      const g = colors[i * 3 + 1]!;
      const b = colors[i * 3 + 2]!;
      for (const channel of [r, g, b]) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
      // Mars is selected, so its vertices are the bright ones.
      const total = r + g + b;
      if (total > brightestMars) brightestMars = total;
    }
    // Nothing else reaches the selected brightness.
    const dimPositions = new Float32Array(expectedVertices * 3);
    const dimColors = new Float32Array(expectedVertices * 3);
    writeBodyPathGeometry(
      paths,
      matrix,
      { selectedBody: null, skyRadius: SKY_RADIUS, maxVertices: expectedVertices, dim: 0.32, bright: 0.95 },
      dimPositions,
      dimColors,
    );
    for (let i = 0; i < count; i++) {
      const total = dimColors[i * 3]! + dimColors[i * 3 + 1]! + dimColors[i * 3 + 2]!;
      if (total > brightestOther) brightestOther = total;
    }
    expect(brightestMars).toBeGreaterThan(brightestOther * 1.5);
  });

  it('respects the vertex budget', () => {
    const positions = new Float32Array(120 * 3);
    const colors = new Float32Array(120 * 3);
    const count = writeBodyPathGeometry(
      paths,
      eqdToWorldMatrix(rotation.localSiderealHours, OBSERVER.lat),
      { selectedBody: null, skyRadius: SKY_RADIUS, maxVertices: 120, dim: 0.3, bright: 0.9 },
      positions,
      colors,
    );
    expect(count).toBeLessThanOrEqual(120);
    expect(count).toBeGreaterThan(0);
  });
});

describe('colour helper', () => {
  it('parses hex colours', () => {
    expect(hexToRgbUnit('#ff0000')).toEqual([1, 0, 0]);
    expect(hexToRgbUnit('#00ff00')).toEqual([0, 1, 0]);
    expect(hexToRgbUnit('not-a-colour')).toEqual([1, 1, 1]);
  });
});
