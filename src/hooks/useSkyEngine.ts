/** Creates the SkyEngine once and keeps it in sync with the store. */

import { useEffect, useRef, useState, type RefObject } from 'react';
import { DEFAULT_OBSERVER } from '../config';
import type { SkyEngine } from '../engine/skyEngine';
import { readDemoOptions } from '../lib/demo';
import { useAppStore } from '../state/store';

export interface SkyEngineRefs {
  containerRef: RefObject<HTMLDivElement | null>;
  skyCanvasRef: RefObject<HTMLCanvasElement | null>;
  hudCanvasRef: RefObject<HTMLCanvasElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
}

export interface SkyEngineHandle {
  engine: SkyEngine | null;
  ready: boolean;
  error: string | null;
}

export function useSkyEngine(refs: SkyEngineRefs): SkyEngineHandle {
  const [engine, setEngine] = useState<SkyEngine | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const engineRef = useRef<SkyEngine | null>(null);
  const bootedRef = useRef(false);

  const settings = useAppStore((state) => state.settings);
  const selection = useAppStore((state) => state.selection);
  const observer = useAppStore((state) => state.observer);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    let cancelled = false;
    let instance: SkyEngine | null = null;

    // The engine (three.js, astronomy-engine, satellite.js, the catalogue) is a
    // separate chunk: the permission gate paints instantly while this loads.
    const boot = async () => {
    const { SkyEngine: SkyEngineClass, parseTargetId } = await import('../engine/skyEngine');
    if (cancelled) return;
    const container = refs.containerRef.current;
    const skyCanvas = refs.skyCanvasRef.current;
    const hudCanvas = refs.hudCanvasRef.current;
    if (!container || !skyCanvas || !hudCanvas) return;

    // Demo mode configures the store before the engine is constructed, so the
    // engine starts with the deterministic observer/time/orientation.
    const demo = readDemoOptions();
    if (demo.active) {
      const store = useAppStore.getState();
      store.setOnboarded(true);
      store.updateSettings({
        cameraEnabled: demo.camera,
        manualLook: true,
        ...(demo.az !== null ? { manualAzDeg: demo.az } : {}),
        ...(demo.alt !== null ? { manualAltDeg: demo.alt } : {}),
        ...(demo.timeMs !== null ? { timeOffsetMs: demo.timeMs - Date.now() } : {}),
        ...(demo.fov !== null ? { fovDeg: demo.fov } : {}),
      });
      store.setObserver({
        lat: demo.lat ?? DEFAULT_OBSERVER.lat,
        lon: demo.lon ?? DEFAULT_OBSERVER.lon,
        heightM: DEFAULT_OBSERVER.heightM,
        accuracyM: null,
        source: 'preset',
        updatedAt: Date.now(),
      });
      if (demo.target) {
        const target = parseTargetId(demo.target);
        if (target) store.setSelection(target);
      }
      if (demo.sheet) store.openSheet(demo.sheet);
    }

    const initial = useAppStore.getState();
    instance = new SkyEngineClass({
      container,
      skyCanvas,
      hudCanvas,
      video: refs.videoRef.current,
      settings: initial.settings,
      observer: initial.observer,
      events: {
        onSnapshot: (snapshot) => useAppStore.getState().setSnapshot(snapshot),
        onObserver: (nextObserver) => useAppStore.getState().setObserver(nextObserver),
        onSelectionRequest: (target) => {
          const store = useAppStore.getState();
          store.setSelection(target);
          if (target) store.openSheet('detail');
          else if (store.sheet === 'detail') store.closeSheet();
        },
        onFovChange: (fovDeg) => useAppStore.getState().updateSettings({ fovDeg }),
        onCameraChange: (camera) => useAppStore.getState().setCameraState(camera),
        onDataStatus: (status) => useAppStore.getState().setDataStatus(status),
      },
    });

    engineRef.current = instance;
    // Expose the engine for debugging and for the headless screenshot harness.
    (window as unknown as { __skyEngine?: SkyEngine }).__skyEngine = instance;
    setEngine(instance);
    await instance.init();
    if (!cancelled) setReady(true);
    };

    void boot().catch((initError: unknown) => {
      console.error('[app] engine failed to start', initError);
      setError(initError instanceof Error ? initError.message : 'Engine failed to start');
    });

    return () => {
      cancelled = true;
      instance?.dispose();
      engineRef.current = null;
      bootedRef.current = false;
      setEngine(null);
    };
    // Refs are stable for the app's lifetime; boot exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    engine?.setSettings(settings);
  }, [engine, settings]);

  useEffect(() => {
    engine?.setSelection(selection);
  }, [engine, selection]);

  useEffect(() => {
    if (engine && observer) engine.setObserver(observer);
    // Only react to actual location changes, not to new object identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, observer?.lat, observer?.lon, observer?.heightM]);

  return { engine, ready, error };
}
