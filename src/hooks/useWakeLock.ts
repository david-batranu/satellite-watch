/** Keep the screen awake while the AR view is open (best effort). */

import { useEffect } from 'react';

interface WakeLockLike {
  release: () => Promise<void>;
}

interface WakeLockNavigator {
  wakeLock?: { request: (type: 'screen') => Promise<WakeLockLike> };
}

export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof navigator === 'undefined') return;
    const wakeLock = (navigator as unknown as WakeLockNavigator).wakeLock;
    if (!wakeLock) return;

    let sentinel: WakeLockLike | null = null;
    let disposed = false;

    const acquire = async () => {
      if (disposed) return;
      try {
        sentinel = await wakeLock.request('screen');
      } catch {
        /* user gesture or battery saver may block it */
      }
    };

    void acquire();
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !disposed) void acquire();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void sentinel?.release().catch(() => undefined);
      sentinel = null;
    };
  }, [enabled]);
}
