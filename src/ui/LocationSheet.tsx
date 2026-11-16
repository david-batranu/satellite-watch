/** Location sheet: GPS status, presets and manual coordinates. */

import { useEffect, useState } from 'react';
import { LOCATION_PRESETS } from '../config';
import { formatLatLon } from '../lib/format';
import { useEngine } from '../state/engineContext';
import { useAppStore } from '../state/store';
import type { Observer } from '../types';
import { Section, Sheet, Row } from './Sheet';
import { Button } from './controls';

const PHASE_LABEL: Record<string, string> = {
  idle: 'Not started',
  requesting: 'Requesting permission…',
  watching: 'Live GPS fix',
  denied: 'Permission denied',
  unavailable: 'Unavailable',
  timeout: 'No fix yet',
};

export function LocationSheet() {
  const engine = useEngine();
  const sheet = useAppStore((state) => state.sheet);
  const closeSheet = useAppStore((state) => state.closeSheet);
  const observer = useAppStore((state) => state.observer);
  const snapshot = useAppStore((state) => state.snapshot);
  const setObserver = useAppStore((state) => state.setObserver);
  const showToast = useAppStore((state) => state.showToast);
  const [latText, setLatText] = useState('');
  const [lonText, setLonText] = useState('');
  const [heightText, setHeightText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const open = sheet === 'location';

  useEffect(() => {
    if (!open || !observer) return;
    setLatText(observer.lat.toFixed(4));
    setLonText(observer.lon.toFixed(4));
    setHeightText(String(Math.round(observer.heightM)));
    setError(null);
  }, [open, observer]);

  const applyManual = () => {
    const lat = Number(latText);
    const lon = Number(lonText);
    const height = Number(heightText || '0');
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      setError('Latitude must be between -90 and 90.');
      return;
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      setError('Longitude must be between -180 and 180.');
      return;
    }
    if (!Number.isFinite(height) || Math.abs(height) > 9000) {
      setError('Elevation must be between -1000 and 9000 m.');
      return;
    }
    const next: Observer = {
      lat,
      lon,
      heightM: height,
      accuracyM: null,
      source: 'manual',
      updatedAt: Date.now(),
    };
    setObserver(next);
    setError(null);
    showToast('Location updated');
    closeSheet();
  };

  const usePreset = (preset: (typeof LOCATION_PRESETS)[number]) => {
    setObserver({
      lat: preset.lat,
      lon: preset.lon,
      heightM: preset.heightM,
      accuracyM: null,
      source: 'preset',
      updatedAt: Date.now(),
    });
    showToast(`Location set to ${preset.label}`);
    closeSheet();
  };

  const phase = snapshot?.locationPhase ?? 'idle';
  const accuracy = snapshot?.accuracyM ?? null;

  return (
    <Sheet open={open} title="Location" subtitle="Your position on Earth" onClose={closeSheet}>
      <Section
        title="GPS"
        aside={
          <span className={`badge ${phase === 'watching' ? 'badge--good' : phase === 'denied' ? 'badge--warn' : 'badge--info'}`}>
            {PHASE_LABEL[phase] ?? phase}
          </span>
        }
      >
        {observer ? (
          <Row
            label="Coordinates"
            hint={observer.source === 'gps' ? 'From the device GPS' : observer.source === 'preset' ? 'Preset city' : 'Entered manually'}
            value={formatLatLon(observer.lat, observer.lon)}
          />
        ) : (
          <Row label="Coordinates" hint="Waiting for a fix — set a preset or enter coordinates below" value="—" />
        )}
        <Row label="Accuracy" value={accuracy !== null ? `±${Math.round(accuracy)} m` : '—'} />
        <Row label="Elevation" value={`${Math.round(observer?.heightM ?? 0)} m`} />
        <Button
          variant="primary"
          block
          onClick={() => {
            engine?.requestLocation();
            showToast('Requesting location…');
          }}
        >
          Use my location
        </Button>
      </Section>

      <Section title="Presets">
        <div className="chip-row" style={{ flexWrap: 'wrap', overflow: 'visible' }}>
          {LOCATION_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="chip"
              onClick={() => usePreset(preset)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Manual coordinates" note="Useful indoors, or when GPS is denied. The sky is computed for exactly this point.">
        <div className="field-row">
          <label className="field">
            <span className="field__label">Latitude °N</span>
            <input
              className="field__input"
              inputMode="decimal"
              value={latText}
              onChange={(event) => setLatText(event.target.value)}
              placeholder="44.4268"
            />
          </label>
          <label className="field">
            <span className="field__label">Longitude °E</span>
            <input
              className="field__input"
              inputMode="decimal"
              value={lonText}
              onChange={(event) => setLonText(event.target.value)}
              placeholder="26.1025"
            />
          </label>
        </div>
        <label className="field" style={{ marginTop: 8 }}>
          <span className="field__label">Elevation m</span>
          <input
            className="field__input"
            inputMode="numeric"
            value={heightText}
            onChange={(event) => setHeightText(event.target.value)}
            placeholder="85"
          />
        </label>
        {error ? <p className="row__hint" style={{ color: 'var(--danger)', marginTop: 8 }}>{error}</p> : null}
        <Button variant="primary" block onClick={applyManual}>
          Apply coordinates
        </Button>
      </Section>
    </Sheet>
  );
}
