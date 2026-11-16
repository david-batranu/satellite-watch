/** Detail sheet for the selected sky object. */

import { useEffect, useState } from 'react';
import type { RiseSetTimes } from '../astro/planetPasses';
import type { SelectedDetail } from '../engine/skyEngine';
import {
  formatAltitude,
  formatAstroDistance,
  formatBearing,
  formatDistance,
  formatEventTime,
  formatPhase,
} from '../lib/format';
import { useEngine } from '../state/engineContext';
import { useAppStore } from '../state/store';
import type { SatellitePass, SolarBodyId } from '../types';
import { Section, Sheet, Row } from './Sheet';
import { Button, SkeletonList, Stat, Toggle } from './controls';

const KIND_LABEL: Record<string, string> = {
  satellite: 'Satellite',
  body: 'Solar system',
  star: 'Star',
  constellation: 'Constellation',
  asterism: 'Asterism',
};

const GLYPH: Record<string, string> = {
  satellite: '✧',
  star: '✦',
  constellation: '❖',
  asterism: '❖',
  body: '●',
};

function glyphFor(detail: SelectedDetail | null): string {
  if (!detail) return '◎';
  if (detail.kind === 'body') {
    if (detail.bodyId === 'moon') return '☾';
    if (detail.bodyId === 'sun') return '☀';
    return '●';
  }
  return GLYPH[detail.kind] ?? '◎';
}

function passBarWidth(pass: SatellitePass): number {
  const hour = new Date(pass.culminationMs).getHours();
  const spread = 1 + ((hour * 37) % 60);
  return Math.max(10, Math.min(100, (pass.maxEl / 90) * 100 + spread * 0.15));
}

export function DetailSheet() {
  const engine = useEngine();
  const sheet = useAppStore((state) => state.sheet);
  const selection = useAppStore((state) => state.selection);
  const observer = useAppStore((state) => state.observer);
  const settings = useAppStore((state) => state.settings);
  const units = settings.units;
  const closeSheet = useAppStore((state) => state.closeSheet);
  const setSelection = useAppStore((state) => state.setSelection);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const showToast = useAppStore((state) => state.showToast);

  const open = sheet === 'detail';
  const [detail, setDetail] = useState<SelectedDetail | null>(null);
  const [passes, setPasses] = useState<SatellitePass[] | null>(null);
  const [riseSet, setRiseSet] = useState<RiseSetTimes | null>(null);

  useEffect(() => {
    if (!open || !engine || !selection) {
      setDetail(null);
      return;
    }
    const update = () => setDetail(engine.getSelectedDetail());
    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, [open, engine, selection?.kind, selection?.id]);

  useEffect(() => {
    if (!open || !engine || !observer || !selection) {
      setPasses(null);
      setRiseSet(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        if (cancelled) return;
        if (selection.kind === 'satellite') {
          const { findSatellitePasses } = await import('../satellites/passes');
          if (cancelled) return;
          const index = engine.getRecords().findIndex((record) => String(record.norad) === selection.id);
          const entry = index >= 0 ? engine.getEntries()[index] : undefined;
          if (entry) {
            const result = findSatellitePasses(entry, engine.getTimeMs(), observer, {
              hours: 12,
              stepSeconds: 45,
              maxPasses: 3,
            });
            if (!cancelled) setPasses(result);
          }
        } else if (selection.kind === 'body') {
          const { computeRiseSet } = await import('../astro/planetPasses');
          if (cancelled) return;
          const result = computeRiseSet(selection.id as SolarBodyId, new Date(engine.getTimeMs()), observer);
          if (!cancelled) setRiseSet(result);
        }
      })();
    }, 70);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, engine, observer, selection?.kind, selection?.id]);

  const subtitle = detail
    ? [KIND_LABEL[detail.kind], detail.groups?.join(' · ') ?? detail.constellationName ?? null]
        .filter(Boolean)
        .join(' · ')
    : null;

  const centre = () => {
    if (!engine || !selection) return;
    engine.aimAt(selection);
    showToast(`Centred on ${detail?.label ?? 'target'}`);
  };

  const clear = () => {
    setSelection(null);
    closeSheet();
  };

  return (
    <Sheet
      open={open}
      title={detail?.label ?? 'Target'}
      subtitle={subtitle}
      onClose={closeSheet}
      footer={
        <>
          <Button variant="ghost" onClick={clear} block>
            Clear
          </Button>
          <Button variant="primary" onClick={centre} block disabled={!engine?.isManualView()}>
            Centre
          </Button>
        </>
      }
    >
      <div className="detail-hero">
        <div className="detail-hero__glyph" aria-hidden="true">
          {glyphFor(detail)}
        </div>
        <div className="detail-hero__text">
          <h3 className="detail-hero__title">
            {detail
              ? `${formatBearing(detail.az)} · ${formatAltitude(detail.alt)}`
              : 'Nothing selected'}
          </h3>
          <p className="detail-hero__sub">
            {detail
              ? detail.visible
                ? 'Above the horizon — look that way'
                : 'Below the horizon right now'
              : 'Tap a marker in the sky to inspect it.'}
          </p>
        </div>
      </div>

      {detail?.kind === 'satellite' ? (
        <>
          <div className="stat-grid">
            <Stat label="Elevation" value={Math.round(detail.alt)} unit="°" />
            <Stat label="Range" value={formatDistance(detail.rangeKm ?? Number.NaN, units)} />
            <Stat
              label="Visibility"
              value={detail.sunlit === undefined ? '—' : detail.sunlit ? 'Sunlit' : 'In shadow'}
            />
            <Stat label="NORAD" value={detail.norad ?? '—'} />
          </div>

          <Section
            title="Next passes"
            aside={<span className="badge badge--info">12 h forecast</span>}
            note="A pass is when the satellite rises above your horizon. Bright numbers mean it may be visible to the naked eye."
          >
            {passes === null ? (
              <SkeletonList count={2} />
            ) : passes.length === 0 ? (
              <p className="row__hint">No passes above the horizon in the next 12 hours.</p>
            ) : (
              <div className="pass-list">
                {passes.map((pass) => (
                  <div className="pass" key={pass.riseMs}>
                    <span className="pass__time">{formatEventTime(pass.riseMs, engine?.getTimeMs() ?? Date.now())}</span>
                    <span className="pass__bar" aria-hidden="true">
                      <span style={{ width: `${passBarWidth(pass)}%` }} />
                    </span>
                    <span className="pass__meta">
                      max {Math.round(pass.maxEl)}°
                      <br />
                      {Math.round((pass.setMs - pass.riseMs) / 60_000)} m
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title="Display">
            <Toggle
              label="Show orbit track"
              hint="Draws this satellite's path across the sky"
              checked={settings.showOrbits}
              onChange={(showOrbits) => updateSettings({ showOrbits })}
            />
          </Section>
        </>
      ) : null}

      {detail?.kind === 'body' ? (
        <>
          <div className="stat-grid">
            <Stat label="Azimuth" value={formatBearing(detail.az)} />
            <Stat label="Altitude" value={formatAltitude(detail.alt)} />
            <Stat label="Distance" value={formatAstroDistance(detail.distanceKm ?? 0, detail.distanceAu ?? 0)} />
            <Stat label="Magnitude" value={detail.mag?.toFixed(1) ?? '—'} />
          </div>
          <Section title="Sky">
            {detail.constellationName ? (
              <Row label="Constellation" value={detail.constellationName} />
            ) : null}
            {detail.phaseName ? <Row label="Moon phase" value={detail.phaseName} /> : null}
            {detail.phaseFraction !== undefined && detail.bodyId !== 'sun' ? (
              <Row label="Illumination" value={formatPhase(detail.phaseFraction)} />
            ) : null}
            <Row
              label="Rises"
              value={riseSet?.riseMs ? formatEventTime(riseSet.riseMs, engine?.getTimeMs() ?? Date.now()) : riseSet ? 'No rise today' : '…'}
            />
            <Row
              label="Sets"
              value={riseSet?.setMs ? formatEventTime(riseSet.setMs, engine?.getTimeMs() ?? Date.now()) : riseSet ? 'No set today' : '…'}
            />
          </Section>
        </>
      ) : null}

      {detail?.kind === 'star' ? (
        <>
          <div className="stat-grid">
            <Stat label="Azimuth" value={formatBearing(detail.az)} />
            <Stat label="Altitude" value={formatAltitude(detail.alt)} />
            <Stat label="Magnitude" value={detail.starMag?.toFixed(2) ?? '—'} />
            <Stat label="Constellation" value={detail.constellation ?? '—'} />
          </div>
          <Section title="Catalogue position (J2000)">
            <Row label="Right ascension" value={`${((detail.raDeg ?? 0) / 15).toFixed(3)} h`} />
            <Row label="Declination" value={`${(detail.decDeg ?? 0).toFixed(2)}°`} />
            {detail.constellationName ? <Row label="Constellation" value={detail.constellationName} /> : null}
          </Section>
        </>
      ) : null}

      {detail?.kind === 'constellation' || detail?.kind === 'asterism' ? (
        <>
          <div className="stat-grid">
            <Stat label="Azimuth" value={formatBearing(detail.az)} />
            <Stat label="Altitude" value={formatAltitude(detail.alt)} />
            <Stat label="Stars in figure" value={detail.pointCount ?? 0} />
            <Stat label="Segments" value={detail.segmentCount ?? 0} />
          </div>
          <Section title="About">
            <Row
              label={detail.kind === 'asterism' ? 'Asterism' : 'Constellation'}
              hint={
                detail.kind === 'asterism'
                  ? 'A named pattern in the sky, not an official constellation.'
                  : 'One of the 88 regions defined by the International Astronomical Union.'
              }
              value={detail.figureId ?? ''}
            />
          </Section>
        </>
      ) : null}
    </Sheet>
  );
}
