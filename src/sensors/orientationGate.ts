/**
 * Decides which orientation event stream to believe.
 *
 * Chrome on Android fires **both** `deviceorientationabsolute` (alpha measured
 * from north) and `deviceorientation` (alpha relative to an arbitrary start
 * orientation) from the same sensor, at the same rate. Feeding both into the
 * fusion makes it chase two different headings alternately, every frame — which
 * looks exactly like a trembling sky.
 *
 * Rule: once absolute events are seen, ignore the relative stream while it is
 * still alive; fall back to relative if the absolute stream stops.
 */

export type OrientationEventKind = 'absolute' | 'relative';

/** How long the relative stream is ignored after the last absolute event. */
export const ABSOLUTE_PREFERENCE_MS = 2500;

export class OrientationSourceGate {
  private lastAbsoluteAt = -Infinity;
  private absoluteSeen = false;
  private accepted = 0;
  private rateWindowStart = 0;
  private rateCount = 0;
  private rate = 0;

  /** True once an absolute stream has been observed. */
  get hasAbsolute(): boolean {
    return this.absoluteSeen;
  }

  /** True when absolute events arrived recently enough to ignore relative ones. */
  isRelativeSuppressed(nowMs: number): boolean {
    return this.absoluteSeen && nowMs - this.lastAbsoluteAt < ABSOLUTE_PREFERENCE_MS;
  }

  /** Accepted orientation events per second, measured over ~1 s windows. */
  get eventsPerSecond(): number {
    return this.rate;
  }

  /** Number of events accepted since construction (diagnostics). */
  get acceptedCount(): number {
    return this.accepted;
  }

  /**
   * @returns true if the event should be processed.
   */
  accept(kind: OrientationEventKind, nowMs: number): boolean {
    if (kind === 'absolute') {
      this.absoluteSeen = true;
      this.lastAbsoluteAt = nowMs;
    } else if (this.absoluteSeen && nowMs - this.lastAbsoluteAt < ABSOLUTE_PREFERENCE_MS) {
      // A relative reading while absolute data is flowing: discard it.
      return false;
    }

    this.accepted++;
    this.rateCount++;
    if (this.rateWindowStart === 0) {
      this.rateWindowStart = nowMs;
    } else if (nowMs - this.rateWindowStart >= 1000) {
      this.rate = (this.rateCount * 1000) / (nowMs - this.rateWindowStart);
      this.rateWindowStart = nowMs;
      this.rateCount = 0;
    }
    return true;
  }

  reset(): void {
    this.lastAbsoluteAt = -Infinity;
    this.absoluteSeen = false;
    this.accepted = 0;
    this.rateWindowStart = 0;
    this.rateCount = 0;
    this.rate = 0;
  }
}
