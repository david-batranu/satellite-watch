/**
 * First-run gate: explains and requests the three capabilities the AR view needs.
 *
 * Every permission request happens on an explicit tap — required by iOS for
 * motion, and good practice for camera and location everywhere.
 */

import { useState } from 'react';
import { useEngine } from '../state/engineContext';
import { useAppStore } from '../state/store';
import { Button } from './controls';

export function PermissionGate() {
  const onboarded = useAppStore((state) => state.onboarded);
  const setOnboarded = useAppStore((state) => state.setOnboarded);
  const snapshot = useAppStore((state) => state.snapshot);
  const observer = useAppStore((state) => state.observer);
  const cameraState = useAppStore((state) => state.cameraState);
  const showToast = useAppStore((state) => state.showToast);
  const engine = useEngine();
  const [requestingMotion, setRequestingMotion] = useState(false);
  const [requestingCamera, setRequestingCamera] = useState(false);

  if (onboarded) return null;

  const secureContext = typeof window === 'undefined' ? true : window.isSecureContext;
  const sensor = snapshot?.sensor;
  const locationPhase = snapshot?.locationPhase ?? 'idle';

  const locationStatus = observer
    ? locationPhase === 'watching'
      ? 'Location locked'
      : 'Location set'
    : locationPhase === 'denied'
      ? 'Denied'
      : 'Waiting…';

  const motionStatus = sensor
    ? sensor.permission === 'denied'
      ? 'Denied'
      : sensor.orientation === 'absolute'
        ? 'Compass ready'
        : sensor.orientation === 'relative'
          ? 'Tilt only'
          : sensor.permission === 'unsupported'
            ? 'Unsupported'
            : sensor.permission === 'granted'
              ? 'No data yet'
              : 'Not set'
    : 'Not set';

  const cameraStatus =
    cameraState === 'on'
      ? 'Active'
      : cameraState === 'denied'
        ? 'Denied'
        : cameraState === 'unavailable'
          ? 'Unavailable'
          : cameraState === 'starting'
            ? 'Starting…'
            : 'Off';

  const start = () => {
    setOnboarded(true);
    if (!observer) {
      showToast('Set your location in the Location sheet for an accurate sky');
    }
  };

  return (
    <div className="gate">
      <div className="gate__stars" aria-hidden="true" />
      <div className="gate__content">
        <div className="gate__hero">
          <div className="gate__logo" aria-hidden="true">
            ◈
          </div>
          <h1 className="gate__title">Satellite Watch</h1>
          <p className="gate__tagline">
            Point your phone at the sky to find satellites overhead, the planets, and the
            constellations behind them.
          </p>
        </div>

        {!secureContext ? (
          <div className="gate__warning" role="alert">
            <span aria-hidden="true">⚠</span>
            <span>
              Camera and motion sensors need a secure context. Open this page over HTTPS (or on
              localhost) to use the AR view — otherwise you will get the manual sky view.
            </span>
          </div>
        ) : null}

        <div className="permission">
          <div className="permission__glyph" aria-hidden="true">
            ◎
          </div>
          <div className="permission__body">
            <div className="permission__title">
              <span>Location</span>
              <span className={`badge ${observer ? 'badge--good' : 'badge--info'}`}>{locationStatus}</span>
            </div>
            <p className="permission__desc">
              Your GPS position decides which part of the sky is above you. Only used on this
              device.
            </p>
          </div>
          <button
            type="button"
            className="permission__action"
            onClick={() => {
              engine?.requestLocation();
              showToast('Requesting location…');
            }}
          >
            Allow
          </button>
        </div>

        <div className="permission">
          <div className="permission__glyph" aria-hidden="true">
            ✳
          </div>
          <div className="permission__body">
            <div className="permission__title">
              <span>Motion</span>
              <span className={`badge ${sensor?.orientation === 'absolute' ? 'badge--good' : 'badge--info'}`}>
                {motionStatus}
              </span>
            </div>
            <p className="permission__desc">
              Gyroscope, accelerometer and compass keep the markers glued to the sky as you move
              the phone.
            </p>
          </div>
          <button
            type="button"
            className="permission__action"
            disabled={requestingMotion}
            onClick={async () => {
              setRequestingMotion(true);
              const status = await engine?.requestSensors();
              setRequestingMotion(false);
              if (status?.permission === 'denied') showToast('Motion denied — drag to look instead');
            }}
          >
            {requestingMotion ? '…' : 'Allow'}
          </button>
        </div>

        <div className="permission">
          <div className="permission__glyph" aria-hidden="true">
            ▣
          </div>
          <div className="permission__body">
            <div className="permission__title">
              <span>Camera</span>
              <span className={`badge ${cameraState === 'on' ? 'badge--good' : 'badge--info'}`}>
                {cameraStatus}
              </span>
            </div>
            <p className="permission__desc">
              The rear camera becomes the background of the AR view. The video stream stays on your
              device.
            </p>
          </div>
          <button
            type="button"
            className="permission__action"
            disabled={requestingCamera || cameraState === 'on'}
            onClick={async () => {
              setRequestingCamera(true);
              await engine?.setCameraEnabled(true);
              setRequestingCamera(false);
            }}
          >
            {requestingCamera ? '…' : cameraState === 'on' ? 'On' : 'Allow'}
          </button>
        </div>

        <div className="gate__actions">
          <Button variant="primary" block onClick={start}>
            {observer ? 'Start exploring' : 'Continue without GPS'}
          </Button>
          <Button
            variant="ghost"
            block
            onClick={() => {
              setOnboarded(true);
              showToast('Manual look mode — add a location any time');
            }}
          >
            Skip for now
          </Button>
        </div>

        <p className="gate__fineprint">
          Everything runs on-device: no account, no analytics, no uploads. Star data from
          Hipparcos, elements from CelesTrak.
        </p>
      </div>
    </div>
  );
}
