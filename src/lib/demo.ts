/**
 * Deterministic demo / screenshot mode.
 *
 * Query parameters (all optional, only with `demo=1`):
 *   demo=1&lat=44.43&lon=26.10&az=180&alt=25&time=2026-11-16T20:46:25Z
 *        &sheet=detail|settings|location|calibrate|credits
 *        &target=sat:25544&fov=68&camera=1&ui=0
 *
 * Used for desktop demos and for the headless screenshots that verify layout.
 */

import type { SheetId } from '../state/store';

export interface DemoOptions {
  active: boolean;
  lat: number | null;
  lon: number | null;
  az: number | null;
  alt: number | null;
  timeMs: number | null;
  sheet: SheetId | null;
  target: string | null;
  fov: number | null;
  camera: boolean;
  hideUi: boolean;
}

function numberParam(params: URLSearchParams, key: string): number | null {
  const raw = params.get(key);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

const SHEETS: readonly string[] = ['detail', 'settings', 'location', 'calibrate', 'credits'];

export function readDemoOptions(search = typeof window === 'undefined' ? '' : window.location.search): DemoOptions {
  const params = new URLSearchParams(search);
  const active = params.get('demo') === '1' || params.has('demo');
  const time = params.get('time');
  const timeMs = time ? Date.parse(time) : null;
  const sheet = params.get('sheet');
  return {
    active,
    lat: numberParam(params, 'lat'),
    lon: numberParam(params, 'lon'),
    az: numberParam(params, 'az'),
    alt: numberParam(params, 'alt'),
    timeMs: Number.isFinite(timeMs) ? timeMs : null,
    sheet: sheet && SHEETS.includes(sheet) ? (sheet as SheetId) : null,
    target: params.get('target'),
    fov: numberParam(params, 'fov'),
    camera: params.get('camera') === '1',
    hideUi: params.get('ui') === '0',
  };
}
