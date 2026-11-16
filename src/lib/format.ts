/** Presentation helpers: clocks, bearings, distances, ages. */

const COMPASS_POINTS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
] as const;

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dayTimeFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** 16-point compass label for an azimuth. */
export function compassPoint(azDeg: number): string {
  const index = Math.round((((azDeg % 360) + 360) % 360) / 22.5) % 16;
  return COMPASS_POINTS[index]!;
}

/** "123° ESE" */
export function formatBearing(azDeg: number): string {
  const az = ((azDeg % 360) + 360) % 360;
  return `${Math.round(az)}° ${compassPoint(az)}`;
}

/** Signed altitude: "+34°" / "-12°" */
export function formatAltitude(altDeg: number): string {
  const rounded = Math.round(altDeg);
  return `${rounded >= 0 ? '+' : ''}${rounded}°`;
}

/** Local clock time, 24h. */
export function formatClock(ms: number): string {
  return timeFormatter.format(new Date(ms));
}

/** Clock time, prefixed with the weekday when it is not today. */
export function formatEventTime(ms: number, now = Date.now()): string {
  const date = new Date(ms);
  const reference = new Date(now);
  const sameDay =
    date.getFullYear() === reference.getFullYear() &&
    date.getMonth() === reference.getMonth() &&
    date.getDate() === reference.getDate();
  return sameDay ? timeFormatter.format(date) : dayTimeFormatter.format(date);
}

/** "+2 h 15 m" / "live" for the time-travel offset. */
export function formatTimeOffset(offsetMs: number): string {
  if (!offsetMs) return 'live';
  const sign = offsetMs > 0 ? '+' : '−';
  const totalMinutes = Math.round(Math.abs(offsetMs) / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${sign}${days} d${hours ? ` ${hours} h` : ''}`;
  if (hours > 0) return `${sign}${hours} h${minutes ? ` ${minutes} m` : ''}`;
  return `${sign}${minutes} m`;
}

/** "44.43° N, 26.10° E" */
export function formatLatLon(lat: number, lon: number): string {
  const latLabel = `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}`;
  const lonLabel = `${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`;
  return `${latLabel}, ${lonLabel}`;
}

/** Data age: "just now", "5 h", "3 d". */
export function formatAge(days: number): string {
  if (!Number.isFinite(days)) return 'unknown';
  if (days < 1 / 24) return 'just now';
  if (days < 1) return `${Math.round(days * 24)} h`;
  if (days < 30) return `${Math.round(days)} d`;
  return `${Math.round(days / 30)} mo`;
}

/** "42% lit" */
export function formatPhase(fraction: number): string {
  return `${Math.round(fraction * 100)}% lit`;
}

/** Light speed / range helper for satellites. */
export function formatDistance(km: number, units: 'metric' | 'imperial'): string {
  if (!Number.isFinite(km)) return '—';
  if (units === 'imperial') {
    const miles = km * 0.621371;
    return `${miles >= 1000 ? Math.round(miles).toLocaleString('en-US') : miles.toFixed(0)} mi`;
  }
  return `${km >= 1000 ? Math.round(km).toLocaleString('en-US') : km.toFixed(0)} km`;
}

/** Large astronomical distances in AU / million km. */
export function formatAstroDistance(km: number, au: number): string {
  if (au > 0.01) return `${au.toFixed(2)} AU`;
  return `${(km / 1_000_000).toFixed(2)} M km`;
}
