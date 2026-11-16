/** Application shell: AR surface + on-screen chrome + sheets. */

import { useEffect, useMemo, useRef } from 'react';
import { useSkyEngine } from './hooks/useSkyEngine';
import { useWakeLock } from './hooks/useWakeLock';
import { readDemoOptions } from './lib/demo';
import { EngineContext } from './state/engineContext';
import { useAppStore } from './state/store';
import { ARView } from './ui/ARView';
import { CalibrationSheet } from './ui/CalibrationSheet';
import { CreditsSheet } from './ui/CreditsSheet';
import { DetailSheet } from './ui/DetailSheet';
import { IconCamera, IconCompass, IconSettings } from './ui/Icons';
import { LocationSheet } from './ui/LocationSheet';
import { PermissionGate } from './ui/PermissionGate';
import { QuickTargets } from './ui/QuickTargets';
import { SettingsSheet } from './ui/SettingsSheet';
import { StatusBar } from './ui/StatusBar';
import { Toast } from './ui/Toast';

export default function App() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const skyRef = useRef<HTMLCanvasElement | null>(null);
  const hudRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const chromeRef = useRef<HTMLDivElement | null>(null);
  const fabRef = useRef<HTMLDivElement | null>(null);

  const demo = useMemo(() => readDemoOptions(), []);
  const { engine, error } = useSkyEngine({
    containerRef: rootRef,
    skyCanvasRef: skyRef,
    hudCanvasRef: hudRef,
    videoRef,
  });

  const onboarded = useAppStore((state) => state.onboarded);
  const settings = useAppStore((state) => state.settings);
  const cameraState = useAppStore((state) => state.cameraState);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const openSheet = useAppStore((state) => state.openSheet);
  const showToast = useAppStore((state) => state.showToast);

  useWakeLock(settings.wakeLock && onboarded);

  // Keep the HUD's label area clear of the real DOM chrome.
  useEffect(() => {
    if (!engine) return;
    const measure = () => {
      const top = statusRef.current?.getBoundingClientRect().height ?? 60;
      const bottom = chromeRef.current?.getBoundingClientRect().height ?? 80;
      engine.setInsets(top + 6, bottom + 10);

      const fab = fabRef.current?.getBoundingClientRect();
      engine.setAvoidRects(
        fab && fab.width > 0
          ? [{ x: fab.left - 10, y: fab.top - 10, w: fab.width + 20, h: fab.height + 20 }]
          : [],
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    if (statusRef.current) observer.observe(statusRef.current);
    if (chromeRef.current) observer.observe(chromeRef.current);
    if (fabRef.current) observer.observe(fabRef.current);
    return () => observer.disconnect();
  }, [engine, onboarded]);

  useEffect(() => {
    if (error) showToast(`Sky engine error: ${error}`);
  }, [error, showToast]);

  const toggleCamera = () => {
    const next = !settings.cameraEnabled;
    updateSettings({ cameraEnabled: next });
    showToast(next ? 'Camera passthrough on' : 'Camera off — night-sky view');
  };

  return (
    <EngineContext.Provider value={engine}>
      <div className="app">
        <ARView
          refs={{ root: rootRef, skyCanvas: skyRef, hudCanvas: hudRef, video: videoRef }}
          cameraActive={cameraState === 'on'}
        />

        {demo.hideUi ? null : (
          <>
            <div className="ar-ui">
              <div ref={statusRef}>
                <StatusBar />
              </div>
              <div className="bottom-chrome" ref={chromeRef}>
                <QuickTargets engine={engine} />
              </div>
            </div>

            <div className="fab-column" ref={fabRef}>
              <button
                type="button"
                className="fab"
                onClick={() => openSheet('settings')}
                aria-label="Layers and settings"
              >
                <IconSettings />
              </button>
              <button
                type="button"
                className={`fab ${cameraState === 'on' ? 'fab--active' : ''}`}
                onClick={toggleCamera}
                aria-label={settings.cameraEnabled ? 'Turn camera off' : 'Turn camera on'}
                aria-pressed={settings.cameraEnabled}
              >
                <IconCamera />
              </button>
              <button
                type="button"
                className="fab"
                onClick={() => openSheet('calibrate')}
                aria-label="Calibrate compass"
              >
                <IconCompass />
              </button>
            </div>
          </>
        )}

        <PermissionGate />
        <DetailSheet />
        <SettingsSheet />
        <LocationSheet />
        <CalibrationSheet />
        <CreditsSheet />
        <Toast />
      </div>
    </EngineContext.Provider>
  );
}
