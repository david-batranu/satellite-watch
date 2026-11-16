/** Quick-target rail: the objects people actually want to find tonight. */

import type { SkyEngine } from '../engine/skyEngine';
import { useAppStore } from '../state/store';
import type { TargetSummary } from '../engine/skyEngine';

export function QuickTargets({ engine }: { engine: SkyEngine | null }) {
  const snapshot = useAppStore((state) => state.snapshot);
  const selection = useAppStore((state) => state.selection);
  const setSelection = useAppStore((state) => state.setSelection);
  const openSheet = useAppStore((state) => state.openSheet);
  const showToast = useAppStore((state) => state.showToast);

  const targets: TargetSummary[] = snapshot?.targets ?? [];
  if (!targets.length) return <div className="target-rail" aria-hidden="true" />;

  const selectTarget = (target: TargetSummary) => {
    setSelection({ kind: target.kind, id: target.id.split(':')[1] ?? target.id });
    openSheet('detail');
    if (engine?.isManualView()) {
      engine.aimAt({ kind: target.kind, id: target.id.split(':')[1] ?? target.id });
      showToast(`Centred on ${target.label}`);
    }
  };

  return (
    <div className="target-rail" role="group" aria-label="Quick targets">
      {targets.map((target) => {
        const targetRef = { kind: target.kind, id: target.id.split(':')[1] ?? target.id };
        const isSelected =
          selection !== null &&
          selection.kind === targetRef.kind &&
          selection.id === targetRef.id;
        return (
          <button
            key={target.id}
            type="button"
            className={`target ${isSelected ? 'target--selected' : ''} ${target.visible ? '' : 'target--dim'}`}
            onClick={() => selectTarget(target)}
            aria-pressed={isSelected}
            aria-label={`${target.label}, ${target.visible ? `${target.alt.toFixed(0)} degrees above the horizon` : 'below the horizon'}`}
          >
            <span className="target__label">
              <span className="target__dot" style={{ background: target.color }} aria-hidden="true" />
              {target.label}
            </span>
            <span className="target__meta">{target.visible ? target.detail ?? '' : 'below horizon'}</span>
          </button>
        );
      })}
    </div>
  );
}
