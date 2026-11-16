/**
 * Asset URL helpers.
 *
 * The app is deployed at a sub-path on GitHub Pages (`/satellite-watch/`), so
 * anything fetched at runtime must be resolved against Vite's BASE_URL rather
 * than assuming the site root.
 */

const RAW_BASE = (import.meta.env?.BASE_URL as string | undefined) ?? '/';

/** Normalised base with a trailing slash, e.g. `/` or `/satellite-watch/`. */
export const BASE_URL = RAW_BASE.endsWith('/') ? RAW_BASE : `${RAW_BASE}/`;

/** Absolute URL for a file in `public/`, e.g. `data/stars.json`. */
export function publicUrl(path: string): string {
  return `${BASE_URL}${path.replace(/^\//, '')}`;
}

/** Absolute URL for a dataset in `public/data/`. */
export function dataUrl(file: string): string {
  return publicUrl(`data/${file.replace(/^\//, '')}`);
}
