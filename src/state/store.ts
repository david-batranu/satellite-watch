/**
 * Zustand store: settings, location, selection, UI sheets and the latest engine
 * snapshot.
 *
 * The engine pushes snapshots at ~1 Hz; everything high-frequency stays inside
 * the engine, so React only re-renders the chrome.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CameraState, DataStatus, EngineSnapshot } from '../engine/skyEngine';
import type { GeolocationPhase } from '../sensors/geolocation';
import type { Observer, TargetRef } from '../types';
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from './settings';
import { STORAGE_KEYS } from '../config';

export type SheetId = 'none' | 'detail' | 'settings' | 'location' | 'calibrate' | 'credits';

interface AppState {
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
  resetSettings: () => void;

  observer: Observer | null;
  setObserver: (observer: Observer) => void;
  locationPhase: GeolocationPhase;
  accuracyM: number | null;

  snapshot: EngineSnapshot | null;
  setSnapshot: (snapshot: EngineSnapshot) => void;
  dataStatus: DataStatus;
  setDataStatus: (status: DataStatus) => void;
  cameraState: CameraState;
  setCameraState: (state: CameraState) => void;

  selection: TargetRef | null;
  setSelection: (target: TargetRef | null) => void;

  sheet: SheetId;
  openSheet: (sheet: SheetId) => void;
  closeSheet: () => void;

  onboarded: boolean;
  setOnboarded: (value: boolean) => void;

  toast: string | null;
  showToast: (message: string) => void;
  clearToast: () => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      updateSettings: (patch) => set({ settings: sanitizeSettings({ ...get().settings, ...patch }) }),
      resetSettings: () => set({ settings: { ...DEFAULT_SETTINGS } }),

      observer: null,
      setObserver: (observer) => set({ observer }),
      locationPhase: 'idle',
      accuracyM: null,

      snapshot: null,
      setSnapshot: (snapshot) =>
        set({
          snapshot,
          locationPhase: snapshot.locationPhase,
          accuracyM: snapshot.accuracyM,
        }),
      dataStatus: { source: null, ageDays: 0, refreshing: false, message: null },
      setDataStatus: (dataStatus) => set({ dataStatus }),
      cameraState: 'off',
      setCameraState: (cameraState) => set({ cameraState }),

      selection: null,
      setSelection: (selection) => set({ selection }),

      sheet: 'none',
      openSheet: (sheet) => set({ sheet }),
      closeSheet: () => set({ sheet: 'none' }),

      onboarded: false,
      setOnboarded: (onboarded) => set({ onboarded }),

      toast: null,
      showToast: (toast) => set({ toast }),
      clearToast: () => set({ toast: null }),
    }),
    {
      name: STORAGE_KEYS.settings,
      version: 1,
      partialize: (state) => ({
        settings: state.settings,
        onboarded: state.onboarded,
        observer: state.observer,
      }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<AppState>;
        return {
          ...current,
          settings: sanitizeSettings(saved.settings),
          onboarded: typeof saved.onboarded === 'boolean' ? saved.onboarded : false,
          observer:
            saved.observer && Number.isFinite(saved.observer.lat) && Number.isFinite(saved.observer.lon)
              ? saved.observer
              : null,
        };
      },
    },
  ),
);

/** Convenience selectors. */
export const selectSettings = (state: AppState): Settings => state.settings;
export const selectSelection = (state: AppState): TargetRef | null => state.selection;
