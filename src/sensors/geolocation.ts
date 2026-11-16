/**
 * Geolocation service: watches the device position and turns it into an
 * observer for the astronomy maths. The last fix is cached so the app opens
 * with a usable sky even before the GPS reports.
 */

import { STORAGE_KEYS } from '../config';
import { storageGetJson, storageSetJson } from '../lib/storage';
import type { Observer, ObserverSource } from '../types';

export type GeolocationPhase =
  | 'idle'
  | 'requesting'
  | 'watching'
  | 'denied'
  | 'unavailable'
  | 'timeout';

export interface GeolocationStatus {
  phase: GeolocationPhase;
  accuracyM: number | null;
  updatedAt: number;
  message: string | null;
}

export interface CachedObserverFile {
  version: 1;
  observer: Observer;
}

function toObserver(position: GeolocationPosition, source: ObserverSource): Observer {
  return {
    lat: position.coords.latitude,
    lon: position.coords.longitude,
    heightM:
      typeof position.coords.altitude === 'number' && Number.isFinite(position.coords.altitude)
        ? position.coords.altitude
        : 0,
    accuracyM:
      typeof position.coords.accuracy === 'number' && Number.isFinite(position.coords.accuracy)
        ? position.coords.accuracy
        : null,
    source,
    updatedAt: position.timestamp || Date.now(),
  };
}

/** Whether a new fix is worth recomputing the sky for. */
function isMeaningfulChange(previous: Observer | null, next: Observer): boolean {
  if (!previous) return true;
  if (next.updatedAt - previous.updatedAt > 15_000) return true;
  const dLat = (next.lat - previous.lat) * 111_320;
  const dLon = (next.lon - previous.lon) * 111_320 * Math.cos((next.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon) > 10;
}

export class GeolocationService {
  private watchId: number | null = null;
  private lastObserver: Observer | null = null;
  private status: GeolocationStatus = {
    phase: 'idle',
    accuracyM: null,
    updatedAt: 0,
    message: null,
  };

  constructor(
    private readonly onObserver: (observer: Observer) => void,
    private readonly onStatus: (status: GeolocationStatus) => void,
  ) {}

  getLast(): Observer | null {
    return this.lastObserver;
  }

  getStatus(): GeolocationStatus {
    return this.status;
  }

  /** Load the cached fix, if any. */
  async loadCached(): Promise<Observer | null> {
    try {
      const file = await storageGetJson<CachedObserverFile>(STORAGE_KEYS.location);
      if (file?.observer && Number.isFinite(file.observer.lat) && Number.isFinite(file.observer.lon)) {
        return { ...file.observer, source: 'cached' };
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  async start(): Promise<void> {
    if (this.watchId !== null) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      this.updateStatus({
        phase: 'unavailable',
        accuracyM: null,
        updatedAt: Date.now(),
        message: 'This browser does not support geolocation.',
      });
      return;
    }

    const cached = await this.loadCached();
    if (cached) {
      this.lastObserver = cached;
      this.onObserver(cached);
    }

    this.updateStatus({
      phase: 'requesting',
      accuracyM: cached?.accuracyM ?? null,
      updatedAt: Date.now(),
      message: 'Waiting for a GPS fix…',
    });

    try {
      this.watchId = navigator.geolocation.watchPosition(
        (position) => this.handlePosition(position),
        (error) => this.handleError(error),
        {
          enableHighAccuracy: true,
          maximumAge: 5_000,
          timeout: 20_000,
        },
      );
    } catch (error) {
      this.updateStatus({
        phase: 'unavailable',
        accuracyM: null,
        updatedAt: Date.now(),
        message: error instanceof Error ? error.message : 'Geolocation failed to start.',
      });
    }
  }

  private handlePosition(position: GeolocationPosition): void {
    const observer = toObserver(position, 'gps');
    const previous = this.lastObserver;
    this.lastObserver = observer;
    if (isMeaningfulChange(previous, observer)) {
      this.onObserver(observer);
      void storageSetJson<CachedObserverFile>(STORAGE_KEYS.location, { version: 1, observer });
    }
    this.updateStatus({
      phase: 'watching',
      accuracyM: observer.accuracyM,
      updatedAt: observer.updatedAt,
      message: null,
    });
  }

  private handleError(error: GeolocationPositionError): void {
    const phase: GeolocationPhase =
      error.code === error.PERMISSION_DENIED
        ? 'denied'
        : error.code === error.TIMEOUT
          ? 'timeout'
          : 'unavailable';
    const message =
      phase === 'denied'
        ? 'Location access denied — set your location manually.'
        : phase === 'timeout'
          ? 'No GPS fix yet — still trying in the background.'
          : 'Location is unavailable — set it manually.';
    this.updateStatus({ phase, accuracyM: null, updatedAt: Date.now(), message });
  }

  private updateStatus(status: GeolocationStatus): void {
    this.status = status;
    this.onStatus(status);
  }

  /** Manual override (and preset cities) also update the cached fix. */
  setManual(observer: Observer): void {
    this.lastObserver = observer;
    this.onObserver(observer);
    void storageSetJson<CachedObserverFile>(STORAGE_KEYS.location, { version: 1, observer });
    this.updateStatus({
      phase: 'watching',
      accuracyM: null,
      updatedAt: observer.updatedAt,
      message: null,
    });
  }

  stop(): void {
    if (this.watchId !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(this.watchId);
    }
    this.watchId = null;
  }
}
