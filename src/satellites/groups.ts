/** Display metadata for satellite groups. Colours are reused by the renderer. */

import type { SatelliteGroupId, SatelliteRecord } from '../types';

export interface SatelliteGroupMeta {
  id: SatelliteGroupId;
  label: string;
  shortLabel: string;
  color: string;
  defaultEnabled: boolean;
  description: string;
}

export const SATELLITE_GROUP_META: Record<SatelliteGroupId, SatelliteGroupMeta> = {
  stations: {
    id: 'stations',
    label: 'Space stations',
    shortLabel: 'Stations',
    color: '#67e8f9',
    defaultEnabled: true,
    description: 'ISS, Tiangong and their docked modules — the brightest moves in the sky.',
  },
  visual: {
    id: 'visual',
    label: 'Brightest satellites',
    shortLabel: 'Bright',
    color: '#e2e8f0',
    defaultEnabled: true,
    description: 'The ~150 satellites most often visible to the naked eye.',
  },
  science: {
    id: 'science',
    label: 'Science',
    shortLabel: 'Science',
    color: '#c4b5fd',
    defaultEnabled: true,
    description: 'Hubble, Earth-observation and research spacecraft.',
  },
  weather: {
    id: 'weather',
    label: 'Weather',
    shortLabel: 'Weather',
    color: '#93c5fd',
    defaultEnabled: true,
    description: 'Polar-orbiting weather satellites (NOAA, Metop, Suomi NPP).',
  },
  'gps-ops': {
    id: 'gps-ops',
    label: 'GPS',
    shortLabel: 'GPS',
    color: '#86efac',
    defaultEnabled: true,
    description: 'US Navstar GPS constellation.',
  },
  galileo: {
    id: 'galileo',
    label: 'Galileo',
    shortLabel: 'Galileo',
    color: '#5eead4',
    defaultEnabled: true,
    description: 'European GNSS constellation.',
  },
  beidou: {
    id: 'beidou',
    label: 'BeiDou',
    shortLabel: 'BeiDou',
    color: '#fca5a5',
    defaultEnabled: true,
    description: 'Chinese navigation constellation.',
  },
  starlink: {
    id: 'starlink',
    label: 'Starlink',
    shortLabel: 'Starlink',
    color: '#f472b6',
    defaultEnabled: false,
    description:
      'The Starlink broadband constellation — about 10,600 objects. A large dataset that loads on first use; expect a sky full of fast-moving points.',
  },
  'iridium-NEXT': {
    id: 'iridium-NEXT',
    label: 'Iridium',
    shortLabel: 'Iridium',
    color: '#fbbf24',
    defaultEnabled: false,
    description: 'Iridium NEXT communications satellites — prone to bright flares.',
  },
};

export const SATELLITE_GROUP_LIST: readonly SatelliteGroupMeta[] = [
  SATELLITE_GROUP_META.stations,
  SATELLITE_GROUP_META.visual,
  SATELLITE_GROUP_META.science,
  SATELLITE_GROUP_META.weather,
  SATELLITE_GROUP_META['gps-ops'],
  SATELLITE_GROUP_META.galileo,
  SATELLITE_GROUP_META.beidou,
  SATELLITE_GROUP_META['iridium-NEXT'],
  SATELLITE_GROUP_META.starlink,
];

export const DEFAULT_ENABLED_GROUPS: SatelliteGroupId[] = SATELLITE_GROUP_LIST.filter(
  (group) => group.defaultEnabled,
).map((group) => group.id);

/** Colour for a satellite: its most specific (highest priority) group. */
export function satelliteColor(groups: readonly SatelliteGroupId[]): string {
  for (const meta of SATELLITE_GROUP_LIST) {
    if (groups.includes(meta.id)) return meta.color;
  }
  return '#e2e8f0';
}

/** Famous objects for the quick-target rail. */
export interface QuickTarget {
  norad: number;
  label: string;
}

export const QUICK_SATELLITES: readonly QuickTarget[] = [
  { norad: 25544, label: 'ISS' },
  { norad: 48274, label: 'Tiangong' },
  { norad: 20580, label: 'Hubble' },
];

/**
 * Human-friendly satellite names for labels: Celestrak names carry the module
 * or payload in parentheses, which is noise in a sky label.
 */
const DISPLAY_NAME_OVERRIDES: Record<number, string> = {
  25544: 'ISS',
  49044: 'ISS (Nauka)',
  48274: 'Tiangong',
  53239: 'Wentian',
  54216: 'Mengtian',
  20580: 'Hubble',
};

export function satelliteDisplayName(record: SatelliteRecord): string {
  const override = DISPLAY_NAME_OVERRIDES[record.norad];
  if (override) return override;
  const stripped = record.name
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || record.name;
}
