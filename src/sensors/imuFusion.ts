/**
 * Complementary filter fusing devicemotion (accelerometer + gyroscope) with
 * devicemotion-independent device-orientation events.
 *
 * Why a filter at all? Three sources of truth are available on a phone:
 *
 *  1. `deviceorientation` — the OS already fuses gyro/accel/compass, but on
 *     Android it can arrive at 10-20 Hz, which looks steppy at 60 fps.
 *  2. the gyroscope — fast and smooth, but drifts.
 *  3. the accelerometer — absolute gravity reference (tilt only), but noisy.
 *
 * The filter integrates gyro samples for smoothness, pulls tilt towards the
 * accelerometer, and slowly pulls the whole orientation towards the OS fusion
 * (which owns the absolute heading). This is the classic complementary filter,
 * and it also gives us a working AR view on devices that expose only
 * `devicemotion`.
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
  quatSlerp,
  rotateVector,
} from './orientationMath';

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
  /** 0 = raw and responsive, 1 = heavily smoothed. Default 0.5. */
  smoothing?: number;
}

const AXIS_UP: Vec3 = { x: 0, y: 1, z: 0 };
/** Beyond this many seconds without an orientation event we no longer trust it. */
const ORIENTATION_TIMEOUT_MS = 2500;
const MOTION_TIMEOUT_MS = 1200;

export class ImuFusion {
  private q: Quat = quatIdentity();
  private mode: FusionMode = 'imu';
  private hasOrientation = false;
  private lastOrientationMs = 0;
  private lastMotionMs = 0;
  private smoothing: number;

  constructor(options: FusionOptions = {}) {
    this.smoothing = clamp(options.smoothing ?? 0.5, 0, 1);
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
  }

  /** Directly set the orientation (used when switching sources/calibrating). */
  reset(q: Quat = quatIdentity()): void {
    this.q = quatNormalize(q);
    this.hasOrientation = false;
    this.lastOrientationMs = 0;
    this.lastMotionMs = 0;
    this.mode = 'imu';
  }

  /**
   * Feed a deviceorientation reading.
   *
   * The OS fusion is authoritative for heading, so we blend towards it. On the
   * very first sample we snap. When the event is not absolute (alpha relative
   * to an arbitrary start) we blend more gently and report mode "relative":
   * tilt is still correct, heading needs calibration.
   */
  onOrientation(sample: DeviceOrientationSample, screenAngleDeg: number, nowMs: number): Quat {
    const reference = deviceOrientationToCameraQuat(sample, screenAngleDeg);

    if (!this.hasOrientation) {
      this.q = reference;
      this.hasOrientation = true;
    } else {
      // More smoothing → smaller correction per sample.
      const base = sample.absolute ? 0.55 : 0.3;
      const gain = base * (1 - 0.65 * this.smoothing);
      this.q = quatSlerp(this.q, reference, gain);
    }

    this.mode = sample.absolute ? 'absolute' : 'relative';
    this.lastOrientationMs = nowMs;
    return this.q;
  }

  /**
   * Feed a devicemotion reading. Gyro integration happens here; the
   * accelerometer gently corrects tilt. Heading is intentionally not corrected
   * from the accelerometer (gravity says nothing about yaw).
   */
  onMotion(sample: MotionSample, nowMs: number): Quat {
    const dt = this.lastMotionMs > 0 ? (nowMs - this.lastMotionMs) / 1000 : sample.intervalMs / 1000;
    this.lastMotionMs = nowMs;

    // 1. Integrate the gyroscope (device-frame angular velocity).
    if (sample.rotationRate) {
      const omega = sample.rotationRate;
      const magnitude = Math.hypot(omega.x, omega.y, omega.z);
      // Reject spikes and stale/garbage samples.
      if (magnitude > 0.15 && magnitude < 1200 && dt > 0 && dt < 0.25) {
        const dq = quatFromAngularVelocity(omega, dt);
        this.q = quatNormalize(quatMultiply(this.q, dq));
      }
    }

    // 2. Tilt correction from gravity. The accelerometer says which way is up;
    //    rotating the camera's "device up" axis onto world up corrects roll and
    //    pitch while leaving heading untouched.
    const accel = sample.accelerationIncludingGravity;
    if (accel) {
      const g = Math.hypot(accel.x, accel.y, accel.z);
      // Only trust near-1g readings: a phone being waved around is accelerating.
      if (g > 6 && g < 13) {
        const upDevice = { x: accel.x / g, y: accel.y / g, z: accel.z / g };
        const upWorld = rotateVector(this.q, upDevice);
        const cross = {
          x: upWorld.y * AXIS_UP.z - upWorld.z * AXIS_UP.y,
          y: upWorld.z * AXIS_UP.x - upWorld.x * AXIS_UP.z,
          z: upWorld.x * AXIS_UP.y - upWorld.y * AXIS_UP.x,
        };
        const sin = Math.hypot(cross.x, cross.y, cross.z);
        const cos = clamp(upWorld.y, -1, 1);
        const angle = Math.atan2(sin, cos);
        if (angle > 1e-4) {
          const gain = 0.22 * (1 - 0.6 * this.smoothing);
          const correction = quatFromAxisAngle(cross, angle * gain);
          this.q = quatNormalize(quatMultiply(correction, this.q));
        }
      }
    }

    // The orientation event is the authority on heading; if it has gone quiet
    // we are effectively running on the gyro alone.
    if (this.mode !== 'imu' && nowMs - this.lastOrientationMs > ORIENTATION_TIMEOUT_MS) {
      this.mode = 'imu';
    }
    if (this.lastMotionMs - this.lastOrientationMs > MOTION_TIMEOUT_MS && this.mode === 'imu') {
      this.hasOrientation = false;
    }
    return this.q;
  }

  /** True when gyro samples are recent enough to trust the fused orientation. */
  hasRecentMotion(nowMs: number): boolean {
    return this.lastMotionMs > 0 && nowMs - this.lastMotionMs < MOTION_TIMEOUT_MS;
  }

  /** Horizontal gaze direction, handy for diagnostics and UI. */
  gazeDirection(): Vec3 {
    return cameraDirection(this.q);
  }
}
