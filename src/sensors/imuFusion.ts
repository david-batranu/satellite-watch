/**
 * Complementary filter for the AR camera orientation.
 *
 * Three sources are available on a phone:
 *
 *  1. `deviceorientation` / `deviceorientationabsolute` — the OS has already
 *     fused gyro, accelerometer and compass. This is the authority for *heading*
 *     but its compass-derived yaw is noisy (a degree or two, sometimes more).
 *  2. the gyroscope — smooth and fast, but drifts; at rest it reports a small
 *     bias instead of zero.
 *  3. the accelerometer — absolute gravity (tilt only), noisy at the sample
 *     level but stable once smoothed.
 *
 * The previous implementation applied a fixed per-sample correction for all
 * three sources, which passed noise straight through and made the sky tremble.
 * This version:
 *
 *  - filters heading and tilt **separately** with dt-aware, rate-adaptive
 *    damping (`dampQuaternionTowards`) — smooth when still, responsive when
 *    turning,
 *  - integrates the gyro only above a dead band, so sensor noise at rest never
 *    enters the orientation,
 *  - uses the accelerometer only when orientation events have gone stale (i.e.
 *    gyro-only fallback), with smoothed acceleration and a slow time constant,
 *  - never fights two orientation streams: the caller decides which to feed
 *    (see `OrientationSourceGate`).
 */

import { clamp } from '../lib/angles';
import type { Quat, Vec3 } from '../types';
import {
  type DeviceOrientationSample,
  cameraDirection,
  deviceOrientationToCameraQuat,
  quatFromAngularVelocity,
  quatFromAxisAngle,
  quatIdentity,
  quatMultiply,
  quatNormalize,
} from './orientationMath';
import {
  type DampingOptions,
  dampQuaternionTowards,
  normalizeVector,
  smoothingGain,
} from './quatFilters';

export type FusionMode = 'absolute' | 'relative' | 'imu';

export interface MotionSample {
  /** Angular velocity in device axes, degrees per second. */
  rotationRate: Vec3 | null;
  /**
   * Acceleration including gravity, m/s². A device at rest reports the
   * reaction to gravity, so this vector points "up" in device coordinates.
   */
  accelerationIncludingGravity: Vec3 | null;
  /** Sampling interval reported by the event, ms. */
  intervalMs: number;
}

export interface FusionOptions {
  /** 0 = responsive (more jitter), 1 = heavily smoothed (more lag). Default 0.45. */
  smoothing?: number;
}

const AXIS_UP: Vec3 = { x: 0, y: 1, z: 0 };

/** After this long without orientation events, gyro/accel are trusted more. */
const ORIENTATION_STALE_MS = 220;
/** After this long, the OS orientation is considered lost. */
const ORIENTATION_LOST_MS = 2000;
/** After orientation has been lost this long, re-snap on the next event. */
const ORIENTATION_RESET_MS = 4000;

/** Gyro rates below this are treated as sensor noise (degrees/second). */
const GYRO_DEADBAND_FRESH_DPS = 0.6;
const GYRO_DEADBAND_STALE_DPS = 0.3;
const MAX_GYRO_RATE_DPS = 1200;
const MAX_GYRO_DT_S = 0.1;

/** Accelerometer smoothing time constant, seconds. */
const ACCEL_TAU_S = 0.2;
/** Time constant for the slow gravity correction in gyro-only mode, seconds. */
const ACCEL_TILT_TAU_SLOW = 0.7;
const ACCEL_TILT_TAU_FAST = 2.2;

export class ImuFusion {
  private q: Quat = quatIdentity();
  private mode: FusionMode = 'imu';
  private hasOrientation = false;
  private lastOrientationMs = 0;
  private lastMotionMs = 0;
  private smoothing = 0.45;
  private smoothingOptions: DampingOptions = dampingOptionsFor(this.smoothing);
  /** Exponentially smoothed unit gravity vector in device coordinates. */
  private gravityUp: Vec3 | null = null;
  /** Rotation speed estimated from the gyroscope, deg/s (asymmetric filter). */
  private speedDps = 0;

  constructor(options: FusionOptions = {}) {
    this.setSmoothing(options.smoothing ?? 0.45);
  }

  /** Absolute-quality orientation available (compass-backed). */
  get isAbsolute(): boolean {
    return this.mode === 'absolute';
  }

  getMode(): FusionMode {
    return this.mode;
  }

  /** Current fused camera orientation. */
  getQuaternion(): Quat {
    return this.q;
  }

  /** Adjust smoothing at runtime (0 = raw, 1 = heavy). */
  setSmoothing(smoothing: number): void {
    this.smoothing = clamp(smoothing, 0, 1);
    this.smoothingOptions = dampingOptionsFor(this.smoothing);
  }

  /** Directly set the orientation (used when switching sources/calibrating). */
  reset(q: Quat = quatIdentity()): void {
    this.q = quatNormalize(q);
    this.hasOrientation = false;
    this.lastOrientationMs = 0;
    this.lastMotionMs = 0;
    this.gravityUp = null;
    this.speedDps = 0;
    this.mode = 'imu';
  }

  private orientationStale(nowMs: number): boolean {
    return !this.hasOrientation || nowMs - this.lastOrientationMs > ORIENTATION_STALE_MS;
  }

  /**
   * Rotation speed used to pick filter time constants. Old gyro data means the
   * device is still (or we have no gyro), so heavy damping is safe.
   */
  private currentSpeedDps(nowMs: number): number {
    if (this.lastMotionMs <= 0 || nowMs - this.lastMotionMs > 400) return 0;
    return this.speedDps;
  }

  /**
   * Feed an OS orientation reading.
   *
   * The first sample snaps (there is nothing to blend from). Afterwards the
   * quaternion is damped towards it with separate heading and tilt time
   * constants, which is what turns compass noise into slow drift instead of
   * visible trembling.
   */
  onOrientation(sample: DeviceOrientationSample, screenAngleDeg: number, nowMs: number): Quat {
    const reference = deviceOrientationToCameraQuat(sample, screenAngleDeg);

    if (!this.hasOrientation) {
      this.q = reference;
      this.hasOrientation = true;
    } else {
      // Re-snap after a long loss so we do not slowly rotate across the gap.
      if (this.lastOrientationMs > 0 && nowMs - this.lastOrientationMs > ORIENTATION_RESET_MS) {
        this.q = reference;
      } else {
        const dt = (nowMs - this.lastOrientationMs) / 1000;
        const speed = this.currentSpeedDps(nowMs);
        this.q = dampQuaternionTowards(this.q, reference, dt, speed, this.smoothingOptions);
      }
    }

    this.mode = sample.absolute ? 'absolute' : 'relative';
    this.lastOrientationMs = nowMs;
    return this.q;
  }

  /**
   * Feed a devicemotion reading.
   *
   * The gyro is integrated above a dead band (so resting noise does not move
   * the sky), and gravity only corrects tilt in the fallback path where the OS
   * orientation has gone quiet — the OS already fuses gravity otherwise, and
   * correcting it again every frame would inject accelerometer noise.
   */
  onMotion(sample: MotionSample, nowMs: number): Quat {
    const dtRaw = this.lastMotionMs > 0 ? (nowMs - this.lastMotionMs) / 1000 : sample.intervalMs / 1000;
    const dt = clamp(dtRaw, 0.001, 0.25);
    this.lastMotionMs = nowMs;

    const stale = this.orientationStale(nowMs);

    // 1. Gyroscope: track rotation speed (drives filter damping) and integrate
    //    above a dead band so resting sensor noise never moves the sky.
    if (sample.rotationRate) {
      const omega = sample.rotationRate;
      const magnitude = Math.hypot(omega.x, omega.y, omega.z);
      if (magnitude < 300) {
        // Fast attack, slow release: responsive as soon as movement starts,
        // smooth again shortly after it stops.
        const speedTau = magnitude > this.speedDps ? 0.05 : 0.4;
        this.speedDps += (magnitude - this.speedDps) * smoothingGain(dt, speedTau);
      }
      const deadband = stale ? GYRO_DEADBAND_STALE_DPS : GYRO_DEADBAND_FRESH_DPS;
      if (magnitude > deadband && magnitude < MAX_GYRO_RATE_DPS && dtRaw < MAX_GYRO_DT_S) {
        const dq = quatFromAngularVelocity(omega, dtRaw);
        this.q = quatNormalize(quatMultiply(this.q, dq));
      }
    }

    // 2. Accelerometer: smooth it, then (fallback mode only) pull tilt to gravity.
    const accel = sample.accelerationIncludingGravity;
    if (accel) {
      const g = Math.hypot(accel.x, accel.y, accel.z);
      // Only trust near-1g readings: a phone being waved around is accelerating.
      if (g > 6 && g < 13) {
        const unit = normalizeVector(accel);
        if (unit) {
          if (!this.gravityUp) {
            this.gravityUp = unit;
          } else {
            const gain = smoothingGain(dt, ACCEL_TAU_S);
            this.gravityUp = normalizeVector({
              x: this.gravityUp.x + (unit.x - this.gravityUp.x) * gain,
              y: this.gravityUp.y + (unit.y - this.gravityUp.y) * gain,
              z: this.gravityUp.z + (unit.z - this.gravityUp.z) * gain,
            });
          }
          if (stale && this.gravityUp) {
            this.correctTiltTowardsGravity(this.gravityUp, dt);
          }
        }
      }
    }

    // Orientation is the authority on heading; if it has gone quiet we are on
    // the gyro alone and must report that.
    if (this.mode !== 'imu' && nowMs - this.lastOrientationMs > ORIENTATION_LOST_MS) {
      this.mode = 'imu';
    }
    if (
      this.mode === 'imu' &&
      this.hasOrientation &&
      nowMs - this.lastOrientationMs > ORIENTATION_LOST_MS
    ) {
      // Allow a clean re-snap if orientation ever comes back.
      this.hasOrientation = false;
    }
    return this.q;
  }

  /** Rotate pitch/roll so the measured "device up" maps onto world up. */
  private correctTiltTowardsGravity(upDevice: Vec3, dt: number): void {
    const rotated = rotateVec(this.q, upDevice);
    const cross = {
      x: rotated.y * AXIS_UP.z - rotated.z * AXIS_UP.y,
      y: rotated.z * AXIS_UP.x - rotated.x * AXIS_UP.z,
      z: rotated.x * AXIS_UP.y - rotated.y * AXIS_UP.x,
    };
    const sin = Math.hypot(cross.x, cross.y, cross.z);
    if (sin < 1e-5) return;
    const cos = clamp(rotated.y, -1, 1);
    const angle = Math.atan2(sin, cos);
    // Slow correction: the accelerometer is only a drift reference here.
    const smoothingFactor = clamp(this.smoothing, 0, 1);
    const tau = ACCEL_TILT_TAU_SLOW + (ACCEL_TILT_TAU_FAST - ACCEL_TILT_TAU_SLOW) * smoothingFactor;
    const gain = smoothingGain(dt, tau);
    const axis = { x: cross.x / sin, y: cross.y / sin, z: cross.z / sin };
    const correction = quatFromAxisAngle(axis, angle * gain);
    this.q = quatNormalize(quatMultiply(correction, this.q));
  }

  /** True when gyro samples are recent enough to trust the fused orientation. */
  hasRecentMotion(nowMs: number): boolean {
    return this.lastMotionMs > 0 && nowMs - this.lastMotionMs < 1500;
  }

  /** Horizontal gaze direction, handy for diagnostics and UI. */
  gazeDirection(): Vec3 {
    return cameraDirection(this.q);
  }
}

/** Map the 0–1 smoothing slider onto filter time constants. */
function dampingOptionsFor(smoothing: number): DampingOptions {
  const s = clamp(smoothing, 0, 1);
  return {
    // Heading needs the strongest filter: it is the noisiest channel (compass)
    // and the one where noise is most visible as a trembling sky.
    yawTauSlow: 0.20 + 0.30 * s,
    yawTauFast: 0.012 + 0.015 * s,
    // Tilt is gravity-stabilised by the OS, so it can follow much faster.
    tiltTauSlow: 0.08 + 0.12 * s,
    tiltTauFast: 0.006 + 0.008 * s,
    slowSpeedDps: 6,
    fastSpeedDps: 45,
  };
}

function rotateVec(q: Quat, v: Vec3): Vec3 {
  // Rotate v by q (standard quaternion vector rotation).
  const { x, y, z } = q;
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return {
    x: v.x + q.w * tx + (y * tz - z * ty),
    y: v.y + q.w * ty + (z * tx - x * tz),
    z: v.z + q.w * tz + (x * ty - y * tx),
  };
}
