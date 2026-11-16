/** Compass / sensor calibration: the difference between "close" and "aligned". */

import { SKY } from '../config';
import { useEngine } from '../state/engineContext';
import { useAppStore } from '../state/store';
import { Section, Sheet, Row } from './Sheet';
import { Button, Slider, Toggle } from './controls';

const ORIENTATION_LABEL: Record<string, string> = {
  absolute: 'Absolute (compass)',
  relative: 'Relative — calibrate',
  unavailable: 'Unavailable',
};

const PERMISSION_LABEL: Record<string, string> = {
  granted: 'Granted',
  denied: 'Denied',
  unsupported: 'Unsupported',
  unknown: 'Not requested',
};

export function CalibrationSheet() {
  const engine = useEngine();
  const sheet = useAppStore((state) => state.sheet);
  const closeSheet = useAppStore((state) => state.closeSheet);
  const settings = useAppStore((state) => state.settings);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const snapshot = useAppStore((state) => state.snapshot);
  const showToast = useAppStore((state) => state.showToast);

  const open = sheet === 'calibrate';
  const sensor = snapshot?.sensor;

  return (
    <Sheet
      open={open}
      title="Calibration"
      subtitle="Align the digital sky with the real one"
      onClose={closeSheet}
      footer={
        <Button
          variant="primary"
          block
          onClick={() => {
            engine?.recenterSensors();
            showToast('Sensors recentred');
          }}
        >
          Recentre sensors
        </Button>
      }
    >
      <Section
        title="How to align"
        note="Hold the phone upright and point it at a bright object you can identify — the Moon, Jupiter or a bright star. Then nudge the heading slider until its marker sits on the real object. Pitch should only need a small correction."
      >
        <Slider
          label="Heading correction"
          value={settings.headingOffsetDeg}
          min={-180}
          max={180}
          step={1}
          format={(value) => `${value > 0 ? '+' : ''}${value.toFixed(0)}°`}
          onChange={(headingOffsetDeg) => updateSettings({ headingOffsetDeg })}
        />
        <Slider
          label="Pitch correction"
          value={settings.pitchOffsetDeg}
          min={-30}
          max={30}
          step={0.5}
          format={(value) => `${value > 0 ? '+' : ''}${value.toFixed(1)}°`}
          onChange={(pitchOffsetDeg) => updateSettings({ pitchOffsetDeg })}
        />
        <Slider
          label="Lens field of view"
          value={settings.fovDeg}
          min={SKY.minFovDeg}
          max={SKY.maxFovDeg}
          step={1}
          format={(value) => `${value}°`}
          onChange={(fovDeg) => updateSettings({ fovDeg })}
        />
        <Toggle
          label="Manual look"
          hint="Ignore the compass and drag the sky yourself"
          checked={settings.manualLook}
          onChange={(manualLook) => updateSettings({ manualLook })}
        />
      </Section>

      <Section title="Sensor status">
        <Row
          label="Heading reference"
          value={ORIENTATION_LABEL[sensor?.orientation ?? 'unavailable']}
        />
        <Row label="Compass" value={sensor?.compass ? 'Available' : 'Not available'} />
        <Row label="Gyroscope" value={sensor?.gyroscope ? 'Streaming' : 'Not available'} />
        <Row label="Accelerometer" value={sensor?.accelerometer ? 'Streaming' : 'Not available'} />
        <Row
          label="Orientation rate"
          value={sensor?.orientationHz ? `${sensor.orientationHz} Hz` : '—'}
        />
        {sensor?.relativeSuppressed ? (
          <Row label="Relative stream" value="Ignored (absolute in use)" />
        ) : null}
        <Row label="Motion permission" value={PERMISSION_LABEL[sensor?.permission ?? 'unknown']} />
        <Row label="Screen orientation" value={`${sensor?.screenAngleDeg ?? 0}°`} />
        <Row label="Fusion mode" value={(sensor?.fusion ?? 'imu').toUpperCase()} />
        {sensor?.message ? <p className="section__note">{sensor.message}</p> : null}
      </Section>

      <Section
        title="If the view does not move"
        note="iOS requires a tap on a button before it reveals motion data. If you denied the prompt, reload the page and allow Motion & Orientation access. On a desktop there are no sensors at all — manual look is used instead."
      >
        <Button
          variant="default"
          block
          onClick={async () => {
            const status = await engine?.requestSensors();
            showToast(
              status?.permission === 'granted'
                ? 'Motion sensors enabled'
                : status?.message ?? 'Motion sensors unavailable',
            );
          }}
        >
          Enable motion sensors
        </Button>
      </Section>
    </Sheet>
  );
}
