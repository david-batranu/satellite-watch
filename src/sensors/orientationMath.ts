/**
 * Device-orientation → camera-quaternion maths.
 *
 * The W3C DeviceOrientation spec defines alpha/beta/gamma as three intrinsic
 * rotations (Z-X'-Y'') that take the *device* frame into an earth frame where
 * X points east, Y north and Z up. three.js' DeviceOrientationControls is the
 * de-facto reference implementation; the composition below is the same maths
 * expressed with plain quaternions so it can be unit tested without a renderer:
 *
 *   q_device_to_camera = R_y(alpha) · R_x(beta) · R_z(-gamma) · R_x(-90°) · R_z(-screenAngle)
 *
 * The world frame used by the app is three.js-like: +X east, +Y up, +Z south.
 * Camera looks along -Z of its local frame, i.e. rotate(q, (0,0,-1)).
 *
 * Verified cases (see tests/orientationMath.test.ts):
 *   alpha=0,  beta=0,  gamma=0  → camera points straight down (alt -90°)
 *   alpha=0,  beta=90, gamma=0  → camera points north      (az 0°, alt 0°)
 *   alpha=90, beta=90, gamma=0  → camera points west       (az 270°)
 *   landscape (screen angle 90°) preserves the azimuth
 */

import { DEG2RAD, RAD2DEG, clamp } from '../lib/angles';
import { worldUnitToAzAlt } from '../lib/enu';
import type { AzAlt, Quat, Vec3 } from '../types';

export const IDENTITY_QUAT: Quat = { x: 0, y: 0, z: 0, w: 1 };
const AXIS_X: Vec3 = { x: 1, y: 0, z: 0 };
const AXIS_Y: Vec3 = { x: 0, y: 1, z: 0 };
const AXIS_Z: Vec3 = { x: 0, y: 0, z: 1 };

export function quatIdentity(): Quat {
  return { x: 0, y: 0, z: 0, w: 1 };
}

/** Hamilton product a * b (apply b first, then a). */
export function quatMultiply(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function quatNormalize(q: Quat): Quat {
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  if (len < 1e-12) return quatIdentity();
  const inv = 1 / len;
  return { x: q.x * inv, y: q.y * inv, z: q.z * inv, w: q.w * inv };
}

export function quatConjugate(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

export function quatFromAxisAngle(axis: Vec3, angleRad: number): Quat {
  const len = Math.hypot(axis.x, axis.y, axis.z);
  if (len < 1e-12) return quatIdentity();
  const half = angleRad / 2;
  const s = Math.sin(half) / len;
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(half) };
}

/** Rotate a vector by a quaternion. */
export function rotateVector(q: Quat, v: Vec3): Vec3 {
  const { x, y, z, w } = q;
  // t = 2 * (q_vec × v)
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return {
    x: v.x + w * tx + (y * tz - z * ty),
    y: v.y + w * ty + (z * tx - x * tz),
    z: v.z + w * tz + (x * ty - y * tx),
  };
}

/** Shortest-path spherical interpolation. */
export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  if (t <= 0) return a;
  if (t >= 1) return b;
  let cosHalf = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  if (cosHalf < 0) {
    cosHalf = -cosHalf;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (cosHalf > 0.9995) {
    return quatNormalize({
      x: a.x + (bx - a.x) * t,
      y: a.y + (by - a.y) * t,
      z: a.z + (bz - a.z) * t,
      w: a.w + (bw - a.w) * t,
    });
  }
  const halfTheta = Math.acos(clamp(cosHalf, -1, 1));
  const sinHalfTheta = Math.sin(halfTheta);
  const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
  const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;
  return quatNormalize({
    x: a.x * ratioA + bx * ratioB,
    y: a.y * ratioA + by * ratioB,
    z: a.z * ratioA + bz * ratioB,
    w: a.w * ratioA + bw * ratioB,
  });
}

/** Angle between two orientations, in degrees. */
export function quatAngleDegrees(a: Quat, b: Quat): number {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(clamp(dot, -1, 1)) * RAD2DEG;
}

// ---------------------------------------------------------------------------
// Device orientation
// ---------------------------------------------------------------------------

export interface DeviceOrientationSample {
  /** Rotation about the device z axis (compass), degrees. */
  alpha: number;
  /** Rotation about the device x axis, degrees. */
  beta: number;
  /** Rotation about the device y axis, degrees. */
  gamma: number;
  /** True when the browser reports the angles relative to true north. */
  absolute: boolean;
}

/** Euler angles in three.js 'YXZ' order → quaternion (R = Ry · Rx · Rz). */
function eulerYXZToQuat(xRad: number, yRad: number, zRad: number): Quat {
  const qy = quatFromAxisAngle(AXIS_Y, yRad);
  const qx = quatFromAxisAngle(AXIS_X, xRad);
  const qz = quatFromAxisAngle(AXIS_Z, zRad);
  return quatMultiply(quatMultiply(qy, qx), qz);
}

/**
 * Convert a device-orientation event into the world→camera quaternion for the
 * rear camera.
 *
 * @param sample  the (absolute) alpha/beta/gamma reading
 * @param screenAngleDeg `screen.orientation.angle` (0, 90, 180, 270)
 */
export function deviceOrientationToCameraQuat(
  sample: DeviceOrientationSample,
  screenAngleDeg: number,
): Quat {
  const qEuler = eulerYXZToQuat(
    sample.beta * DEG2RAD,
    sample.alpha * DEG2RAD,
    -sample.gamma * DEG2RAD,
  );
  // The camera looks out of the back of the device, not out of the top.
  const qBack = quatFromAxisAngle(AXIS_X, -Math.PI / 2);
  // Compensate for how the screen is rotated relative to the device.
  const qScreen = quatFromAxisAngle(AXIS_Z, -screenAngleDeg * DEG2RAD);
  return quatNormalize(quatMultiply(quatMultiply(qEuler, qBack), qScreen));
}

/**
 * Camera orientation for a look direction, with no roll.
 *
 * Used by manual look mode (drag to pan) and the demo harness. Derived from the
 * device-orientation model: an upright phone (beta = 90) looks at the horizon,
 * and alpha runs counter-clockwise, so `alpha = -azimuth`.
 */
export function quatFromAzAlt(azDeg: number, altDeg: number): Quat {
  const alpha = ((-azDeg % 360) + 360) % 360;
  const beta = clamp(90 + altDeg, 0, 180);
  return deviceOrientationToCameraQuat({ alpha, beta, gamma: 0, absolute: true }, 0);
}

/** Camera viewing direction in the world frame. */
export function cameraDirection(q: Quat): Vec3 {
  return rotateVector(q, { x: 0, y: 0, z: -1 });
}

/** Where is the camera looking, in horizontal coordinates? */
export function cameraAzAlt(q: Quat): AzAlt {
  return worldUnitToAzAlt(cameraDirection(q));
}

/** Azimuth of the camera, degrees clockwise from north. */
export function cameraYawDeg(q: Quat): number {
  return cameraAzAlt(q).az;
}

/**
 * Rotate the camera about the world up axis. Positive values increase the
 * azimuth (turn right, clockwise seen from above).
 *
 * Note the sign: a positive rotation about +Y by the right-hand rule carries
 * north (-Z) towards west (-X), which *decreases* the azimuth. The offset is
 * therefore applied with the opposite sign, so `withYawOffset(q, +10)` moves the
 * camera 10° further clockwise from north.
 */
export function withYawOffset(q: Quat, offsetDeg: number): Quat {
  if (!offsetDeg) return q;
  return quatNormalize(quatMultiply(quatFromAxisAngle(AXIS_Y, -offsetDeg * DEG2RAD), q));
}

/**
 * Rotate the camera about the world east axis. Positive values pitch the view
 * down (camera altitude decreases).
 */
export function withPitchOffset(q: Quat, offsetDeg: number): Quat {
  if (!offsetDeg) return q;
  return quatNormalize(quatMultiply(quatFromAxisAngle(AXIS_X, offsetDeg * DEG2RAD), q));
}

/** Roll the camera about its own viewing axis. */
export function withRollOffset(q: Quat, offsetDeg: number): Quat {
  if (!offsetDeg) return q;
  return quatNormalize(quatMultiply(q, quatFromAxisAngle(AXIS_Z, offsetDeg * DEG2RAD)));
}

/**
 * Attitude from gravity alone (accelerometer).
 *
 * `upDevice` is the world "up" direction expressed in device coordinates, so
 * the returned quaternion maps device space to world space and satisfies
 * `rotate(conjugate(q), worldUp) === upDevice`. It is the minimal (shortest-arc)
 * rotation, which leaves yaw at zero — heading must come from a compass or the
 * user.
 */
export function quatFromUpVector(upDevice: Vec3): Quat {
  const len = Math.hypot(upDevice.x, upDevice.y, upDevice.z);
  if (len < 1e-6) return quatIdentity();
  const up = { x: upDevice.x / len, y: upDevice.y / len, z: upDevice.z / len };
  const dot = clamp(up.y, -1, 1);
  if (dot > 0.99999) return quatIdentity();
  if (dot < -0.99999) return quatFromAxisAngle(AXIS_X, Math.PI);
  // Rotation that carries the measured up vector onto world up: up × worldUp.
  const axis = { x: -up.z, y: 0, z: up.x };
  const angle = Math.acos(dot);
  return quatNormalize(quatFromAxisAngle(axis, angle));
}

/** Rotation quaternion for an angular velocity (device axes, deg/s) over dt. */
export function quatFromAngularVelocity(wDegPerSec: Vec3, dtSeconds: number): Quat {
  const rate = Math.hypot(wDegPerSec.x, wDegPerSec.y, wDegPerSec.z);
  if (rate < 1e-6 || dtSeconds <= 0) return quatIdentity();
  return quatFromAxisAngle(wDegPerSec, rate * DEG2RAD * dtSeconds);
}

/**
 * Heading correction implied by a compass reading.
 *
 * `webkitCompassHeading` describes where the top edge of the device points when
 * the device is roughly flat. We compare it with where the top edge points in
 * the fused orientation and return the yaw offset that would align them.
 * Returns null when the device is too tilted for the heading to be meaningful.
 *
 * @param q current camera orientation
 * @param compassHeadingDeg true heading of the device's top edge, degrees
 */
export function headingOffsetFromCompass(q: Quat, compassHeadingDeg: number): number | null {
  const top = rotateVector(q, { x: 0, y: 1, z: 0 });
  // Only meaningful when the top edge is close to horizontal.
  if (Math.abs(top.y) > 0.7) return null;
  const topAz = (((Math.atan2(top.x, -top.z) * RAD2DEG) % 360) + 360) % 360;
  const delta = ((compassHeadingDeg - topAz + 540) % 360) - 180;
  return delta;
}

/** Angle between the camera direction and a sky direction, in degrees. */
export function angleToSkyPoint(q: Quat, directionAzAlt: AzAlt): number {
  const dir = cameraDirection(q);
  const target = {
    x: Math.cos(directionAzAlt.alt * DEG2RAD) * Math.sin(directionAzAlt.az * DEG2RAD),
    y: Math.sin(directionAzAlt.alt * DEG2RAD),
    z: -Math.cos(directionAzAlt.alt * DEG2RAD) * Math.cos(directionAzAlt.az * DEG2RAD),
  };
  const dot = clamp(dir.x * target.x + dir.y * target.y + dir.z * target.z, -1, 1);
  return Math.acos(dot) * RAD2DEG;
}
