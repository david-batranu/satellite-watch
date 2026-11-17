/** Layers, satellites, sensors, time travel and data refresh. */

import { useState } from 'react';
import { SKY } from '../config';
import { formatAge, formatEventTime, formatTimeOffset } from '../lib/format';
import { SATELLITE_GROUP_LIST } from '../satellites/groups';
import { useEngine } from '../state/engineContext';
import { useAppStore } from '../state/store';
import type { SatelliteGroupId } from '../types';
import { Section, Sheet, Row } from './Sheet';
import { Button, Segmented, Slider, Toggle } from './controls';
import { IconChevron } from './Icons';

export function SettingsSheet() {
  const engine = useEngine();
  const sheet = useAppStore((state) => state.sheet);
  const closeSheet = useAppStore((state) => state.closeSheet);
  const openSheet = useAppStore((state) => state.openSheet);
  const settings = useAppStore((state) => state.settings);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const resetSettings = useAppStore((state) => state.resetSettings);
  const dataStatus = useAppStore((state) => state.dataStatus);
  const snapshot = useAppStore((state) => state.snapshot);
  const showToast = useAppStore((state) => state.showToast);
  const [refreshing, setRefreshing] = useState(false);

  const open = sheet === 'settings';
  const timeOffsetHours = settings.timeOffsetMs / 3_600_000;
  const skyTime = (snapshot?.timeMs ?? Date.now()) + (snapshot ? 0 : settings.timeOffsetMs);

  const toggleGroup = (group: SatelliteGroupId) => {
    const next = settings.satelliteGroups.includes(group)
      ? settings.satelliteGroups.filter((candidate) => candidate !== group)
      : [...settings.satelliteGroups, group];
    if (!next.length) {
      showToast('Keep at least one satellite group enabled');
      return;
    }
    updateSettings({ satelliteGroups: next });
  };

  const refresh = async () => {
    if (!engine || refreshing) return;
    setRefreshing(true);
    const status = await engine.refreshElements();
    setRefreshing(false);
    showToast(status.message ? `Refresh: ${status.message}` : 'Satellite elements updated');
  };

  return (
    <Sheet
      open={open}
      title="Settings"
      subtitle="Layers, sensors and data"
      onClose={closeSheet}
      footer={
        <Button variant="ghost" block onClick={resetSettings}>
          Reset to defaults
        </Button>
      }
    >
      <Section title="Sky layers">
        <Toggle
          label="Stars"
          hint={`Faintest drawn: magnitude ${settings.starMagLimit.toFixed(1)}`}
          checked={settings.showStars}
          onChange={(showStars) => updateSettings({ showStars })}
        />
        <Slider
          label="Star limit"
          value={settings.starMagLimit}
          min={SKY.minStarMagLimit}
          max={SKY.maxStarMagLimit}
          step={0.1}
          format={(value) => `mag ${value.toFixed(1)}`}
          onChange={(starMagLimit) => updateSettings({ starMagLimit })}
        />
        <Toggle
          label="Constellations"
          checked={settings.showConstellations}
          onChange={(showConstellations) => updateSettings({ showConstellations })}
        />
        <Toggle
          label="Asterisms"
          hint="Informal patterns such as the Big Dipper"
          checked={settings.showAsterisms}
          onChange={(showAsterisms) => updateSettings({ showAsterisms })}
        />
        <Toggle
          label="Sun, Moon and planets"
          checked={settings.showPlanets}
          onChange={(showPlanets) => updateSettings({ showPlanets })}
        />
        <Toggle
          label="Planet orbits"
          hint="Apparent path of each planet against the stars over the next year"
          checked={settings.showBodyPaths}
          onChange={(showBodyPaths) => updateSettings({ showBodyPaths })}
        />
        <Toggle
          label="Horizon line"
          checked={settings.showHorizon}
          onChange={(showHorizon) => updateSettings({ showHorizon })}
        />
        <Toggle
          label="Labels"
          checked={settings.showLabels}
          onChange={(showLabels) => updateSettings({ showLabels })}
        />
        <Toggle
          label="Frame rate"
          hint="Show the renderer's FPS in the corner"
          checked={settings.showFps}
          onChange={(showFps) => updateSettings({ showFps })}
        />
        <Slider
          label="Camera field of view"
          value={settings.fovDeg}
          min={SKY.minFovDeg}
          max={SKY.maxFovDeg}
          step={1}
          format={(value) => `${value}° vertical`}
          onChange={(fovDeg) => updateSettings({ fovDeg })}
        />
      </Section>

      <Section
        title="Satellites"
        aside={
          <button type="button" className="badge badge--info" onClick={refresh} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh TLEs'}
          </button>
        }
        note={`Element age: ${formatAge(dataStatus.ageDays)} · ${dataStatus.source === 'live' ? 'refreshed from CelesTrak' : dataStatus.source === 'cache' ? 'on-device cache' : 'built-in snapshot'}`}
      >
        <div className="chip-row" style={{ flexWrap: 'wrap', overflow: 'visible' }}>
          {SATELLITE_GROUP_LIST.map((group) => {
            const enabled = settings.satelliteGroups.includes(group.id);
            return (
              <button
                key={group.id}
                type="button"
                className={`chip ${enabled ? 'chip--selected' : ''}`}
                aria-pressed={enabled}
                onClick={() => toggleGroup(group.id)}
                title={group.description}
              >
                <span className="chip__dot" style={{ background: group.color }} />
                {group.label}
              </button>
            );
          })}
        </div>
        <Toggle
          label="Satellites"
          hint="Show satellites above the horizon"
          checked={settings.showSatellites}
          onChange={(showSatellites) => updateSettings({ showSatellites })}
        />
        <Toggle
          label="Orbit tracks"
          hint="Path of the selected satellite across the sky"
          checked={settings.showOrbits}
          onChange={(showOrbits) => updateSettings({ showOrbits })}
        />
      </Section>

      <Section title="Sensors">
        <Toggle
          label="Manual look"
          hint="Drag to pan instead of using the compass"
          checked={settings.manualLook}
          onChange={(manualLook) => updateSettings({ manualLook })}
        />
        <Row
          label="Calibration"
          hint="Heading, pitch, field of view and sensor status"
          onClick={() => openSheet('calibrate')}
          value={<IconChevron size={16} />}
        />
        <Slider
          label="Camera smoothing"
          value={settings.smoothing}
          min={0}
          max={1}
          step={0.05}
          format={(value) => (value < 0.2 ? 'raw' : value > 0.75 ? 'heavy' : `${Math.round(value * 100)}%`)}
          onChange={(smoothing) => updateSettings({ smoothing })}
        />
        <Toggle
          label="Keep screen awake"
          hint="Holds a screen wake lock while the AR view is open"
          checked={settings.wakeLock}
          onChange={(wakeLock) => updateSettings({ wakeLock })}
        />
      </Section>

      <Section
        title="Time travel"
        note="Shift the clock up to two days ahead to preview passes. Satellites, planets and stars all move together."
      >
        <div className="row row--column">
          <div className="slider-row__head">
            <span className="row__label">Sky time</span>
            <span className="slider-row__value">{formatEventTime(skyTime)}</span>
          </div>
          <Slider
            label="Clock offset"
            value={timeOffsetHours}
            min={-SKY.maxTimeOffsetHours}
            max={SKY.maxTimeOffsetHours}
            step={0.5}
            format={() => formatTimeOffset(settings.timeOffsetMs)}
            onChange={(hours) => updateSettings({ timeOffsetMs: Math.round(hours * 2) * 1_800_000 })}
          />
          <Button variant="default" onClick={() => updateSettings({ timeOffsetMs: 0 })}>
            Back to live time
          </Button>
        </div>
      </Section>

      <Section title="App">
        <Row label="Location" hint="GPS or manual coordinates" onClick={() => openSheet('location')} value={<IconChevron size={16} />} />
        <Row label="Units" hint="Distances in the detail sheet">
          <Segmented
            label="Units"
            value={settings.units}
            options={[
              { value: 'metric', label: 'Metric' },
              { value: 'imperial', label: 'Imperial' },
            ]}
            onChange={(units) => updateSettings({ units })}
          />
        </Row>
        <Toggle
          label="Camera passthrough"
          hint="Use the rear camera as the AR background"
          checked={settings.cameraEnabled}
          onChange={(cameraEnabled) => updateSettings({ cameraEnabled })}
        />
        <Row label="Data sources & privacy" onClick={() => openSheet('credits')} value={<IconChevron size={16} />} />
      </Section>
    </Sheet>
  );
}
