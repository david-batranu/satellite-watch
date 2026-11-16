/**
 * Sensor plumbing for the AR view.
 *
 * Responsibilities:
 *  - request permission where the platform requires a user gesture (iOS 13+),
 *  - subscribe to `deviceorientationabsolute`, `deviceorientation` and
 *    `devicemotion`,
 *  - recover an absolute heading on iOS from `webkitCompassHeading` (Safari
 *    reports alpha relative to an arbitrary start, so we measure the offset
 *    between the compass heading and the device's top edge whenever the phone is
 *    held reasonably flat, then keep that offset),
 *  - fuse gyroscope, accelerometer and OS orientation through ImuFusion,
 *  - apply the user's calibration offsets.
 *
 * If no motion data arrives at all, `getQuaternion()` returns null and the
 * engine falls back to drag-to-look.
 */

import { clamp, normalizeSignedDeg } from '../lib/angles';
import { ImuFusion, type FusionMode, type MotionSample } from './imuFusion';
import {
  deviceOrientationToCameraQuat,
  headingOffsetFromCompass,
  withPitchOffset,
  withYawOffset,
  type DeviceOrientationSample,
} from './orientationMath';
import type { Quat } from '../types';

export type SensorPermission = 'granted' | 'denied' | 'unsupported' | 'unknown';

export interface SensorStatus {
  /** Quality of the heading reference. */
  orientation: 'absolute' | 'relative' | 'unavailable';
  fusion: FusionMode;
  compass: boolean;
  gyroscope: boolean;
  accelerometer: boolean;
  screenAngleDeg: number;
  permission: SensorPermission;
  /** Latest compass heading, when the platform exposes one. */
  compassHeadingDeg: number | null;
  message: string | null;
}

export interface SensorCalibration {
  headingOffsetDeg: number;
  pitchOffsetDeg: number;
  smoothing: number;
  /** Ignore the sensors entirely and use drag-to-look. */
  manual: boolean;
}

interface CompassOrientationEvent extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
}

interface PermissionCapableConstructor {
  requestPermission?: () => Promise<'granted' | 'denied' | 'default'>;
  prototype?: { requestPermission?: () => Promise<'granted' | 'denied' | 'default'> };
}

const ORIENTATION_SILENCE_MS = 2500;
const MOTION_SILENCE_MS = 1500;

type WindowWithOrientation = Window &
  typeof globalThis & {
    DeviceOrientationEvent?: PermissionCapableConstructor;
    DeviceMotionEvent?: PermissionCapableConstructor;
    orientation?: number;
    webkitCompassHeading?: number;
  };

function readScreenAngleDeg(): number {
  if (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.angle === 'number') {
    return screen.orientation.angle;
  }
  const legacy = (window as WindowWithOrientation).orientation;
  return typeof legacy === 'number' ? legacy : 0;
}

function addListener(
  target: EventTarget,
  name: string,
  handler: (event: Event) => void,
): () => void {
  target.addEventListener(name, handler as EventListener);
  return () => target.removeEventListener(name, handler as EventListener);
}

export class SensorManager {
  private readonly fusion = new ImuFusion();
  private calibration: SensorCalibration = {
    headingOffsetDeg: 0,
    pitchOffsetDeg: 0,
    smoothing: 0.5,
    manual: false,
  };
  private started = false;
  private permission: SensorPermission = 'unknown';
  private screenAngleDeg = 0;
  private lastOrientationAt = 0;
  private lastMotionAt = 0;
  private orientationSeen = false;
  private absoluteSeen = false;
  private compassOffsetDeg = 0;
  private compassHeadingDeg: number | null = null;
  private hasCompass = false;
  private hasGyro = false;
  private hasAccel = false;
  private message: string | null = null;
  private detach: Array<() => void> = [];

  async enable(): Promise<SensorStatus> {
    const win = window as WindowWithOrientation;
    if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) {
      this.permission = 'unsupported';
      this.message = 'This device does not expose motion sensors.';
      return this.getStatus();
    }
    if (this.started) return this.getStatus();

    this.permission = 'granted';
    this.message = null;

    // iOS 13+ requires an explicit, gesture-initiated permission request.
    const orientationCtor = win.DeviceOrientationEvent;
    const motionCtor = win.DeviceMotionEvent;
    try {
      const requestOrientation = orientationCtor?.requestPermission;
      if (typeof requestOrientation === 'function') {
        const result = await requestOrientation.call(orientationCtor);
        if (result !== 'granted') {
          this.permission = 'denied';
          this.message = 'Motion access was denied — drag to look around instead.';
          return this.getStatus();
        }
      }
      const requestMotion = motionCtor?.requestPermission;
      if (typeof requestMotion === 'function') {
        // Motion permission is a bonus: gyro smoothing and no-compass fallback.
        try {
          await requestMotion.call(motionCtor);
        } catch {
          /* ignore: orientation may still work */
        }
      }
    } catch (error) {
      this.permission = 'denied';
      this.message =
        error instanceof Error && error.message
          ? `Motion permission failed: ${error.message}`
          : 'Motion permission was denied — drag to look around instead.';
      return this.getStatus();
    }

    this.start();
    return this.getStatus();
  }

  private start(): void {
    this.started = true;
    this.screenAngleDeg = readScreenAngleDeg();
    this.fusion.setSmoothing(this.calibration.smoothing);

    const orientationHandler = (event: Event, absolute: boolean) => {
      this.handleOrientation(event as CompassOrientationEvent, absolute);
    };

    this.detach.push(
      addListener(window, 'deviceorientationabsolute', (event) => orientationHandler(event, true)),
      addListener(window, 'deviceorientation', (event) => orientationHandler(event, false)),
      addListener(window, 'devicemotion', (event) => this.handleMotion(event as DeviceMotionEvent)),
    );

    const orientationChange = () => {
      this.screenAngleDeg = readScreenAngleDeg();
    };
    if (typeof screen !== 'undefined' && screen.orientation) {
      this.detach.push(addListener(screen.orientation, 'change', orientationChange));
    }
    this.detach.push(addListener(window, 'orientationchange', orientationChange));
  }

  private handleOrientation(event: CompassOrientationEvent, absoluteEvent: boolean): void {
    const alpha = typeof event.alpha === 'number' ? event.alpha : 0;
    const beta = typeof event.beta === 'number' ? event.beta : 0;
    const gamma = typeof event.gamma === 'number' ? event.gamma : 0;
    const isAbsolute = absoluteEvent || event.absolute === true;
    this.screenAngleDeg = readScreenAngleDeg();

    const sample: DeviceOrientationSample = { alpha, beta, gamma, absolute: isAbsolute };

    const heading = event.webkitCompassHeading;
    if (typeof heading === 'number' && Number.isFinite(heading)) {
      this.compassHeadingDeg = heading;
      const raw = deviceOrientationToCameraQuat(sample, this.screenAngleDeg);
      const candidate = headingOffsetFromCompass(raw, heading);
      if (candidate !== null) {
        this.hasCompass = true;
        // Low-pass the offset: compass readings jitter by a degree or two.
        const delta = normalizeSignedDeg(candidate - this.compassOffsetDeg);
        this.compassOffsetDeg = normalizeSignedDeg(this.compassOffsetDeg + delta * 0.12);
      }
    }

    if (isAbsolute) this.absoluteSeen = true;
    this.orientationSeen = true;
    this.lastOrientationAt = performance.now();
    this.fusion.onOrientation(sample, this.screenAngleDeg, this.lastOrientationAt);
  }

  private handleMotion(event: DeviceMotionEvent): void {
    const rate = event.rotationRate;
    let rotationRate: MotionSample['rotationRate'] = null;
    if (rate) {
      const x = rate.beta;
      const y = rate.gamma;
      const z = rate.alpha;
      if (typeof x === 'number' || typeof y === 'number' || typeof z === 'number') {
        rotationRate = { x: x ?? 0, y: y ?? 0, z: z ?? 0 };
        if (Math.abs(x ?? 0) + Math.abs(y ?? 0) + Math.abs(z ?? 0) > 0.01) this.hasGyro = true;
      }
    }
    const accel = event.accelerationIncludingGravity;
    let acceleration: MotionSample['accelerationIncludingGravity'] = null;
    if (accel && typeof accel.x === 'number' && typeof accel.y === 'number' && typeof accel.z === 'number') {
      acceleration = { x: accel.x, y: accel.y, z: accel.z };
      this.hasAccel = true;
    }

    const now = performance.now();
    const intervalMs = Number.isFinite(event.interval) && event.interval > 0 ? event.interval : 16;
    this.fusion.onMotion({ rotationRate, accelerationIncludingGravity: acceleration, intervalMs }, now);
    if (rotationRate || acceleration) this.lastMotionAt = now;
  }

  /** Camera quaternion, or null when no usable sensor signal is available. */
  getQuaternion(now = performance.now()): Quat | null {
    if (this.calibration.manual) return null;
    const orientationFresh = this.lastOrientationAt > 0 && now - this.lastOrientationAt < ORIENTATION_SILENCE_MS;
    const motionFresh = this.lastMotionAt > 0 && now - this.lastMotionAt < MOTION_SILENCE_MS;
    if (!orientationFresh && !motionFresh) return null;

    let quaternion = this.fusion.getQuaternion();
    // Relative alpha (iOS without an absolute event) needs the compass offset.
    const yawCorrection =
      this.hasCompass && !this.absoluteSeen ? this.compassOffsetDeg : 0;
    quaternion = withPitchOffset(quaternion, this.calibration.pitchOffsetDeg);
    quaternion = withYawOffset(quaternion, yawCorrection + this.calibration.headingOffsetDeg);
    return quaternion;
  }

  getStatus(now = performance.now()): SensorStatus {
    const orientationFresh =
      this.lastOrientationAt > 0 && now - this.lastOrientationAt < ORIENTATION_SILENCE_MS;
    const orientation: SensorStatus['orientation'] = !this.orientationSeen
      ? 'unavailable'
      : this.hasCompass || this.absoluteSeen
        ? 'absolute'
        : 'relative';

    let message = this.message;
    if (!message) {
      if (this.permission === 'denied') message = 'Motion access denied — drag to look around.';
      else if (!this.orientationSeen) message = 'No motion sensors — drag to look around.';
      else if (!orientationFresh) message = 'Sensors went quiet — drag to look around.';
      else if (!this.absoluteSeen && !this.hasCompass) {
        message = 'No compass — drag to aim, or calibrate north.';
      } else if (!this.absoluteSeen && this.hasCompass) {
        message = 'Compass locked from heading — fine-tune in Calibration if needed.';
      }
    }

    return {
      orientation,
      fusion: this.fusion.getMode(),
      compass: this.hasCompass || this.absoluteSeen,
      gyroscope: this.hasGyro,
      accelerometer: this.hasAccel,
      screenAngleDeg: this.screenAngleDeg,
      permission: this.permission,
      compassHeadingDeg: this.compassHeadingDeg,
      message,
    };
  }

  setCalibration(patch: Partial<SensorCalibration>): void {
    this.calibration = { ...this.calibration, ...patch };
    this.calibration.headingOffsetDeg = clamp(this.calibration.headingOffsetDeg, -180, 180);
    this.calibration.pitchOffsetDeg = clamp(this.calibration.pitchOffsetDeg, -60, 60);
    this.calibration.smoothing = clamp(this.calibration.smoothing, 0, 1);
    this.fusion.setSmoothing(this.calibration.smoothing);
  }

  /** Fix accumulated gyro drift / re-lock the compass. */
  recenter(): void {
    this.compassOffsetDeg = 0;
    this.fusion.reset();
  }

  disable(): void {
    for (const detach of this.detach) detach();
    this.detach = [];
    this.started = false;
    this.orientationSeen = false;
    this.lastOrientationAt = 0;
    this.lastMotionAt = 0;
    this.fusion.reset();
  }

  dispose(): void {
    this.disable();
  }
}
