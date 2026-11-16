/** React context giving UI components access to the live SkyEngine. */

import { createContext, useContext } from 'react';
import type { SkyEngine } from '../engine/skyEngine';

export const EngineContext = createContext<SkyEngine | null>(null);

export function useEngine(): SkyEngine | null {
  return useContext(EngineContext);
}
