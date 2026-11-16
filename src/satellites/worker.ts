/// <reference lib="webworker" />
/**
 * Satellite propagation worker.
 *
 * SGP4 is cheap per satellite but there are several hundred of them; running the
 * bulk work here keeps the main thread free for rendering at 60 fps. The
 * protocol is intentionally tiny: configure the catalog once, then tick.
 */

import { DEFAULT_ENABLED_GROUPS } from './groups';
import { computeSkyStates, createEntries, type SatelliteEntry } from './propagation';
import type { Observer, SatelliteGroupId, SatelliteRecord, SatelliteSkyState } from '../types';

export interface WorkerConfigureMessage {
  type: 'configure';
  records: SatelliteRecord[];
  groups: SatelliteGroupId[];
  observer: Observer;
}

export interface WorkerGroupsMessage {
  type: 'groups';
  groups: SatelliteGroupId[];
}

export interface WorkerObserverMessage {
  type: 'observer';
  observer: Observer;
}

export interface WorkerTickMessage {
  type: 'tick';
  timeMs: number;
}

export type WorkerInMessage =
  | WorkerConfigureMessage
  | WorkerGroupsMessage
  | WorkerObserverMessage
  | WorkerTickMessage;

export interface WorkerPositionsMessage {
  type: 'positions';
  timeMs: number;
  states: SatelliteSkyState[];
  computeMs: number;
}

export interface WorkerErrorMessage {
  type: 'error';
  message: string;
}

export type WorkerOutMessage = WorkerPositionsMessage | WorkerErrorMessage;

const scope = self as unknown as DedicatedWorkerGlobalScope;

let entries: SatelliteEntry[] = [];
let activeIndices: number[] = [];
let enabledGroups = new Set<SatelliteGroupId>(DEFAULT_ENABLED_GROUPS);
let observer: Observer | null = null;
let configured = false;

function recomputeActiveIndices(): void {
  activeIndices = [];
  if (!configured) return;
  for (const entry of entries) {
    if (!entry.valid) continue;
    if (entry.record.groups.some((group) => enabledGroups.has(group))) {
      activeIndices.push(entry.index);
    }
  }
}

scope.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  try {
    switch (message.type) {
      case 'configure': {
        entries = createEntries(message.records);
        enabledGroups = new Set(message.groups);
        observer = message.observer;
        configured = true;
        recomputeActiveIndices();
        break;
      }
      case 'groups': {
        enabledGroups = new Set(message.groups);
        recomputeActiveIndices();
        break;
      }
      case 'observer': {
        observer = message.observer;
        break;
      }
      case 'tick': {
        if (!configured || !observer) return;
        const started = performance.now();
        const date = new Date(message.timeMs);
        const states = computeSkyStates(entries, activeIndices, date, observer, {
          minElevationDeg: -1,
        });
        scope.postMessage({
          type: 'positions',
          timeMs: message.timeMs,
          states,
          computeMs: performance.now() - started,
        } satisfies WorkerPositionsMessage);
        break;
      }
      default:
        break;
    }
  } catch (error) {
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    } satisfies WorkerErrorMessage);
  }
};
