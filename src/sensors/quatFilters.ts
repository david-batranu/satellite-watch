/**
 * Quaternion filters used by the AR orientation pipeline.
 *
 * The problem these solve: a phone's orientation arrives as a stream of noisy
 * samples at 20–60 Hz. Applying a fixed per-sample correction (what the first
 * implementation did) passes sensor noise straight through and behaves
 * differently at different event rates — the sky visibly trembles, especially in
 * heading where the compass is the noisiest sensor.
 *
 * Two ideas here:
 *
 *  1. **Swing–twist decomposition.** Split a correction into heading (twist
 *     about world up) and tilt (swing). Heading and tilt need very different
 *     smoothing: gravity is stable, the compass is not.
 *  2. **dt-aware, adaptive damping.** The correction applied per frame is
 *     `1 − e^(−dt/τ)`, so the filter is independent of event rate. τ is small
 *     while the user is actually turning (no lag) and large while the phone is
 *     still (no jitter).
 */

import { clamp } from '../lib/angles';
import type { Quat } from '../types';
import {
  quatConjugate,
  quatFromAxisAngle,
  quatIdentity,
  quatMultiply,
  quatNormalize,
} from './orientationMath';

const AXIS_Y = { x: 0, y: 1, z: 0 };

/** Angle of a rotation quaternion, radians in [0, π]. */
export function rotationAngle(q: Quat): number {
  const w = Math.abs(clamp(q.w, -1, 1));
  return 2 * Math.acos(w);
}

export interface TwistSplit {
  /** Signed rotation about world up, radians, in (−π, π]. */
  yawAngle: number;
  /** Remaining rotation (tilt: pitch and roll) as a unit quaternion. */
  swing: Quat;
}

/**
 * Swing–twist decomposition about the world up axis.
 *
 * For a rotation that is *pure* yaw, `swing` is the identity and `yawAngle` is
 * the whole rotation. For pure tilt, `yawAngle` is zero.
 */
export function decomposeTwistY(q: Quat): TwistSplit {
  const length = Math.hypot(q.y, q.w);
  if (length < 1e-9) {
    // 180° rotation about a horizontal axis: all tilt, no heading.
    return { yawAngle: 0, swing: quatNormalize(q) };
  }
  const twist: Quat = { x: 0, y: q.y / length, z: 0, w: q.w / length };
  const swing = quatNormalize(quatMultiply(q, quatConjugate(twist)));
  let yawAngle = 2 * Math.atan2(twist.y, twist.w);
  if (yawAngle > Math.PI) yawAngle -= 2 * Math.PI;
  if (yawAngle <= -Math.PI) yawAngle += 2 * Math.PI;
  return { yawAngle, swing };
}

/** Scale a rotation by `factor`: 0 → identity, 1 → unchanged. */
export function scaleRotation(q: Quat, factor: number): Quat {
  if (factor >= 0.999999) return q;
  if (factor <= 0) return quatIdentity();
  let { x, y, z, w } = q;
  if (w < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }
  const half = Math.acos(clamp(w, -1, 1));
  if (half < 1e-7) return quatIdentity();
  const sinHalf = Math.sin(half);
  return quatFromAxisAngle({ x: x / sinHalf, y: y / sinHalf, z: z / sinHalf }, 2 * half * factor);
}

export interface DampingOptions {
  /** Heading time constant while still, seconds. Larger = smoother/slower. */
  yawTauSlow: number;
  /** Heading time constant while turning fast, seconds. Smaller = less lag. */
  yawTauFast: number;
  /** Tilt time constant while still, seconds. */
  tiltTauSlow: number;
  /** Tilt time constant while moving fast, seconds. */
  tiltTauFast: number;
  /** Below this rotation speed (deg/s) the slow time constants are used. */
  slowSpeedDps: number;
  /** Above this rotation speed (deg/s) the fast time constants are used. */
  fastSpeedDps: number;
}

/**
 * Move `current` towards `target`, damping heading and tilt separately.
 *
 * The rotation that takes `current` to `target` is split into a heading part and
 * a tilt part; each is scaled by its own gain and then applied. This cannot
 * overshoot and is frame-rate independent.
 *
 * `speedDps` — how fast the device is actually rotating, measured from the
 * gyroscope — interpolates the time constants. Adapting on *measured rotation*
 * rather than on the error is what makes this work: sensor noise produces large
 * single-sample errors but no persistent rotation, so it stays in the heavily
 * damped regime; a real turn raises the speed and drops the damping.
 */
export function dampQuaternionTowards(
  current: Quat,
  target: Quat,
  dtSeconds: number,
  speedDps: number,
  options: DampingOptions,
): Quat {
  const dt = clamp(dtSeconds, 0.001, 0.25);
  const delta = quatMultiply(target, quatConjugate(current));
  const { yawAngle, swing } = decomposeTwistY(delta);

  // 0 = still (heavy damping), 1 = turning fast (light damping).
  const printSpeed = clamp(
    (speedDps - options.slowSpeedDps) / Math.max(options.fastSpeedDps - options.slowSpeedDps, 1e-6),
    0,
    1,
  );
  const blend = printSpeed * printSpeed * (3 - 2 * printSpeed);

  const yawTau = geometricInterpolate(options.yawTauSlow, options.yawTauFast, blend);
  const tiltTau = geometricInterpolate(options.tiltTauSlow, options.tiltTauFast, blend);

  const yawGain = 1 - Math.exp(-dt / yawTau);
  const tiltGain = 1 - Math.exp(-dt / tiltTau);

  const yawCorrection = quatFromAxisAngle(AXIS_Y, yawAngle * yawGain);
  const tiltCorrection = scaleRotation(swing, tiltGain);
  return quatNormalize(
    quatMultiply(quatMultiply(tiltCorrection, yawCorrection), current),
  );
}

/** Interpolate geometrically so time constants fall off fast as motion starts. */
function geometricInterpolate(slow: number, fast: number, blend: number): number {
  if (blend <= 0) return slow;
  if (blend >= 1) return fast;
  return slow * Math.pow(fast / slow, blend);
}

/** Exponential smoothing factor for a given time constant and dt. */
export function smoothingGain(dtSeconds: number, tauSeconds: number): number {
  return 1 - Math.exp(-Math.max(dtSeconds, 0) / Math.max(tauSeconds, 1e-6));
}

/** Normalise a vector, returning null for degenerate input. */
export function normalizeVector(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } | null {
  const length = Math.hypot(v.x, v.y, v.z);
  if (!(length > 1e-9)) return null;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}
