import { describe, expect, it } from 'vitest';
import { Euler, Quaternion, Vector3 } from 'three';
import {
  cameraAzAlt,
  cameraDirection,
  deviceOrientationToCameraQuat,
  headingOffsetFromCompass,
  quatConjugate,
  quatFromAxisAngle,
  quatFromUpVector,
  quatMultiply,
  quatNormalize,
  quatSlerp,
  rotateVector,
  withYawOffset,
  type DeviceOrientationSample,
} from '../src/sensors/orientationMath';

const close = (actual: number, expected: number, tolerance: number) =>
  expect(Math.abs(actual - expected)).toBeLessThan(tolerance);

const sample = (alpha: number, beta: number, gamma: number, absolute = true): DeviceOrientationSample => ({
  alpha,
  beta,
  gamma,
  absolute,
});

describe('device orientation → camera quaternion', () => {
  it('looks straight down when the phone lies flat, screen up', () => {
    const dir = cameraDirection(deviceOrientationToCameraQuat(sample(0, 0, 0), 0));
    expect(dir.y).toBeCloseTo(-1, 9);
    // Azimuth at the nadir is degenerate; only altitude is meaningful.
    close(cameraAzAlt(deviceOrientationToCameraQuat(sample(0, 0, 0), 0)).alt, -90, 1e-6);
  });

  it('looks north when held upright in portrait', () => {
    const { az, alt } = cameraAzAlt(deviceOrientationToCameraQuat(sample(0, 90, 0), 0));
    close(az, 0, 1e-6);
    close(alt, 0, 1e-6);
  });

  it('follows alpha counter-clockwise around the horizon', () => {
    const west = cameraAzAlt(deviceOrientationToCameraQuat(sample(90, 90, 0), 0));
    close(west.az, 270, 1e-6);
    close(west.alt, 0, 1e-6);

    const south = cameraAzAlt(deviceOrientationToCameraQuat(sample(180, 90, 0), 0));
    close(south.az, 180, 1e-6);

    const east = cameraAzAlt(deviceOrientationToCameraQuat(sample(270, 90, 0), 0));
    close(east.az, 90, 1e-6);
  });

  it('tilts down when beta drops from 90° towards flat', () => {
    const { az, alt } = cameraAzAlt(deviceOrientationToCameraQuat(sample(0, 45, 0), 0));
    close(az, 0, 1e-6);
    close(alt, -45, 1e-6);
  });

  it('keeps the azimuth through a 90° screen rotation but rolls the view', () => {
    const portrait = cameraAzAlt(deviceOrientationToCameraQuat(sample(0, 90, 0), 0));
    const landscape = cameraAzAlt(deviceOrientationToCameraQuat(sample(0, 90, 0), 90));
    close(landscape.az, portrait.az, 1e-6);
    close(landscape.alt, portrait.alt, 1e-6);

    // Roll is visible in the world direction of the device's "up on screen" axis.
    const uprightUp = rotateVector(deviceOrientationToCameraQuat(sample(0, 90, 0), 0), { x: 0, y: 1, z: 0 });
    const rotatedUp = rotateVector(deviceOrientationToCameraQuat(sample(0, 90, 0), 90), { x: 0, y: 1, z: 0 });
    expect(Math.abs(uprightUp.y - rotatedUp.y)).toBeGreaterThan(0.5);
  });

  it('matches the three.js reference implementation for arbitrary samples', () => {
    const qOne = new Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
    const zee = new Vector3(0, 0, 1);
    for (const [alpha, beta, gamma, screen] of [
      [12, 33, -8, 0],
      [200, 120, 15, 0],
      [350, -70, -33, 90],
      [45, 80, 10, 180],
      [300, 10, 60, 270],
      [0, 179, 0, 0],
    ] as const) {
      const ours = deviceOrientationToCameraQuat(sample(alpha, beta, gamma), screen);

      const euler = new Euler(
        (beta * Math.PI) / 180,
        (alpha * Math.PI) / 180,
        (-gamma * Math.PI) / 180,
        'YXZ',
      );
      const reference = new Quaternion().setFromEuler(euler).multiply(qOne);
      reference.multiply(new Quaternion().setFromAxisAngle(zee, (-screen * Math.PI) / 180));
      reference.normalize();

      // Compare the resulting look directions (quaternion sign is irrelevant).
      const oursDir = cameraDirection(ours);
      const refDir = new Vector3(0, 0, -1).applyQuaternion(reference);
      expect(oursDir.x).toBeCloseTo(refDir.x, 9);
      expect(oursDir.y).toBeCloseTo(refDir.y, 9);
      expect(oursDir.z).toBeCloseTo(refDir.z, 9);
    }
  });
});

describe('quaternion helpers', () => {
  it('rotates vectors consistently with its inverse', () => {
    const q = quatNormalize(
      quatMultiply(
        quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 0.7),
        quatFromAxisAngle({ x: 1, y: 0, z: 0 }, -0.4),
      ),
    );
    const v = { x: 0.3, y: -0.5, z: 0.81 };
    const roundTrip = rotateVector(quatConjugate(q), rotateVector(q, v));
    expect(roundTrip.x).toBeCloseTo(v.x, 12);
    expect(roundTrip.y).toBeCloseTo(v.y, 12);
    expect(roundTrip.z).toBeCloseTo(v.z, 12);
  });

  it('interpolates between orientations', () => {
    const a = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 0);
    const b = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2);
    const mid = quatSlerp(a, b, 0.5);
    const dir = rotateVector(mid, { x: 0, y: 0, z: -1 });
    // Halfway between north (-Z) and west (-X) is north-west.
    expect(dir.x).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(dir.z).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(quatSlerp(a, b, 0)).toEqual(a);
    expect(quatSlerp(a, b, 1)).toEqual(b);
  });

  it('applies a yaw offset as an azimuth rotation', () => {
    const base = deviceOrientationToCameraQuat(sample(0, 90, 0), 0);
    const rotated = withYawOffset(base, 30);
    close(cameraAzAlt(rotated).az, 30, 1e-6);
  });

  it('builds an attitude from a gravity vector', () => {
    const upDevice = { x: 0, y: 0.6, z: 0.8 }; // phone tipped forward
    const q = quatFromUpVector(upDevice);
    const worldUpInDevice = rotateVector(quatConjugate(q), { x: 0, y: 1, z: 0 });
    expect(worldUpInDevice.x).toBeCloseTo(0, 9);
    expect(worldUpInDevice.y).toBeCloseTo(0.6, 9);
    expect(worldUpInDevice.z).toBeCloseTo(0.8, 9);
  });
});

describe('compass heading correction', () => {
  it('is zero for a flat phone whose top edge points north', () => {
    const q = deviceOrientationToCameraQuat(sample(0, 0, 0), 0);
    expect(headingOffsetFromCompass(q, 0)).toBeCloseTo(0, 6);
  });

  it('ignores headings while the phone is upright', () => {
    const q = deviceOrientationToCameraQuat(sample(0, 90, 0), 0);
    expect(headingOffsetFromCompass(q, 123)).toBeNull();
  });

  it('recovers the yaw offset that makes the top edge match the compass', () => {
    for (const alpha of [0, 45, 137, 250, 359]) {
      const q = deviceOrientationToCameraQuat(sample(alpha, 10, 5), 0);
      const top = rotateVector(q, { x: 0, y: 1, z: 0 });
      const topAz = ((Math.atan2(top.x, -top.z) * 180) / Math.PI + 360) % 360;
      const desired = (topAz + 47 + 360) % 360;
      const offset = headingOffsetFromCompass(q, desired);
      expect(offset).not.toBeNull();
      // Applying the offset to the top edge must reproduce the compass heading.
      const corrected = withYawOffset(q, offset as number);
      const correctedTop = rotateVector(corrected, { x: 0, y: 1, z: 0 });
      const correctedAz = ((Math.atan2(correctedTop.x, -correctedTop.z) * 180) / Math.PI + 360) % 360;
      close(Math.abs(((correctedAz - desired + 540) % 360) - 180), 0, 1e-6);
    }
  });
});
