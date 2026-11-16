/** Status chips: GPS, sensors, sky time, satellites, data freshness. */

import { formatAge, formatEventTime, formatTimeOffset } from '../lib/format';
import { useAppStore } from '../state/store';

const DARKNESS_LABEL: Record<string, string> = {
  day: 'Daylight',
  civil: 'Civil twilight',
  nautical: 'Nautical twilight',
  astronomical: 'Night sky',
};

export function StatusBar() {
  const snapshot = useAppStore((state) => state.snapshot);
  const observer = useAppStore((state) => state.observer);
  const settings = useAppStore((state) => state.settings);
  const dataStatus = useAppStore((state) => state.dataStatus);
  const openSheet = useAppStore((state) => state.openSheet);

  const sensor = snapshot?.sensor;
  const locationPhase = snapshot?.locationPhase ?? 'idle';
  const accuracy = snapshot?.accuracyM ?? null;
  const timeMs = snapshot?.timeMs ?? Date.now() + settings.timeOffsetMs;
  const timeOffset = settings.timeOffsetMs;

  let locationTone = 'chip';
  let locationLabel = 'Locating…';
  if (observer && locationPhase === 'watching') {
    locationTone = accuracy !== null && accuracy <= 100 ? 'chip chip--good' : 'chip chip--warn';
    locationLabel = accuracy !== null ? `GPS ±${Math.round(accuracy)} m` : 'GPS fix';
  } else if (observer) {
    locationTone = 'chip';
    locationLabel = observer.source === 'preset' ? 'Preset location' : 'Location set';
  } else if (locationPhase === 'denied' || locationPhase === 'unavailable') {
    locationTone = 'chip chip--warn';
    locationLabel = 'Set location';
  }

  let sensorTone = 'chip';
  let sensorLabel = 'Motion…';
  if (snapshot?.manualLook) {
    sensorTone = 'chip chip--warn';
    sensorLabel = 'Manual look';
  } else if (sensor?.orientation === 'absolute') {
    sensorTone = 'chip chip--good';
    sensorLabel = 'Compass';
  } else if (sensor?.orientation === 'relative') {
    sensorTone = 'chip chip--warn';
    sensorLabel = 'Relative heading';
  } else if (sensor) {
    sensorTone = 'chip chip--warn';
    sensorLabel = 'No sensors';
  }

  const visible = snapshot?.visibleSatellites ?? 0;
  const total = snapshot?.satelliteCount ?? 0;
  const age = dataStatus.ageDays || snapshot?.dataAgeDays || 0;
  const stale = age > 30;

  return (
    <div className="top-chrome">
      <div className="brand">
        <span className="brand__mark" aria-hidden="true">
          ◈
        </span>
        <span className="brand__name">Satellite Watch</span>
        <span className="chip__meta">{DARKNESS_LABEL[snapshot?.darkness ?? 'astronomical']}</span>
      </div>

      <div className="chip-row" role="groups" aria-label="Status">
        <button type="button" className={locationTone} onClick={() => openSheet('location')}>
          <span className="chip__dot" />
          {locationLabel}
        </button>

        <button type="button" className={sensorTone} onClick={() => openSheet('calibrate')}>
          <span className="chip__icon" aria-hidden="true">
            ✳
          </span>
          {sensorLabel}
        </button>

        <button
          type="button"
          className={`chip ${timeOffset ? 'chip--accent' : ''}`}
          onClick={() => openSheet('settings')}
          aria-label={`Sky time ${formatEventTime(timeMs)}, tap to time travel`}
        >
          <span className="chip__icon" aria-hidden="true">
            ◷
          </span>
          {formatEventTime(timeMs)}
          {timeOffset ? <span className="chip__meta">{formatTimeOffset(timeOffset)}</span> : null}
        </button>

        <button
          type="button"
          className="chip"
          onClick={() => openSheet('settings')}
          aria-label={`${visible} satellites above the horizon, ${total} in catalogue`}
        >
          <span className="chip__icon" aria-hidden="true">
            ✧
          </span>
          {visible}
          <span className="chip__meta">/ {total} sats</span>
        </button>

        <button
          type="button"
          className={`chip ${stale ? 'chip--warn' : ''}`}
          onClick={() => openSheet('settings')}
          aria-label={`Element data age ${formatAge(age)}`}
        >
          data {formatAge(age)}
        </button>
      </div>
    </div>
  );
}
