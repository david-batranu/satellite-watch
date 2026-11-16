import { describe, expect, it } from 'vitest';
import { ImuFusion, type MotionSample } from '../src/sensors/imuFusion';
import { cameraAzAlt, deviceOrientationToCameraQuat } from '../src/sensors/orientationMath';

const close = (actual: number, expected: number, tolerance: number) =>
  expect(Math.abs(actual - expected)).toBeLessThan(tolerance);

const still = (): MotionSample => ({
  rotationRate: null,
  accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 },
  intervalMs: 16,
});

describe('ImuFusion', () => {
  it('snaps to the first orientation sample', () => {
    const fusion = new ImuFusion();
    const now = 1000;
    fusion.onOrientation({ alpha: 0, beta: 90, gamma: 0, absolute: true }, 0, now);
    const { az, alt } = cameraAzAlt(fusion.getQuaternion());
    close(az, 0, 1e-9);
    close(alt, 0, 1e-9);
    expect(fusion.getMode()).toBe('absolute');
    expect(fusion.isAbsolute).toBe(true);
  });

  it('reports relative mode when alpha is not absolute', () => {
    const fusion = new ImuFusion();
    fusion.onOrientation({ alpha: 30, beta: 90, gamma: 0, absolute: false }, 0, 1000);
    expect(fusion.getMode()).toBe('relative');
    expect(fusion.isAbsolute).toBe(false);
  });

  it('integrates gyroscope rotation between orientation samples', () => {
    const fusion = new ImuFusion({ smoothing: 0 });
    // Start upright looking north.
    fusion.onOrientation({ alpha: 0, beta: 90, gamma: 0, absolute: true }, 0, 0);

    // Rotate at 90°/s about the device +Y axis (which is world up here) for 1 s.
    let now = 0;
    for (let i = 0; i < 60; i++) {
      now += 1000 / 60;
      fusion.onMotion(
        {
          rotationRate: { x: 0, y: 90, z: 0 },
          accelerationIncludingGravity: null,
          intervalMs: 1000 / 60,
        },
        now,
      );
    }

    // A positive rotation about +Y turns north towards west: azimuth 270°.
    const { az } = cameraAzAlt(fusion.getQuaternion());
    close(az, 270, 1.5);
  });

  it('pulls tilt towards gravity and leaves yaw untouched', () => {
    const fusion = new ImuFusion({ smoothing: 0 });
    // Start tilted 45° down (camera looking 45° below the horizon).
    const tilted = deviceOrientationToCameraQuat({ alpha: 0, beta: 45, gamma: 0, absolute: true }, 0);
    fusion.reset(tilted);
    fusion.onOrientation({ alpha: 0, beta: 45, gamma: 0, absolute: true }, 0, 0);

    let now = 0;
    for (let i = 0; i < 400; i++) {
      now += 16;
      fusion.onMotion(
        {
          rotationRate: null,
          // Phone is now lying flat: device +Z points at the sky.
          accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 },
          intervalMs: 16,
        },
        now,
      );
    }

    const { alt } = cameraAzAlt(fusion.getQuaternion());
    // Looking straight down again: azimuth is degenerate at the nadir, so only
    // altitude is asserted here.
    close(alt, -90, 6);
  });

  it('falls back to imu mode when orientation events stop', () => {
    const fusion = new ImuFusion();
    fusion.onOrientation({ alpha: 0, beta: 90, gamma: 0, absolute: true }, 0, 0);
    expect(fusion.getMode()).toBe('absolute');
    let now = 0;
    for (let i = 0; i < 100; i++) {
      now += 50;
      fusion.onMotion(still(), now);
    }
    expect(fusion.getMode()).toBe('imu');
    expect(fusion.hasRecentMotion(now)).toBe(true);
  });

  it('rejects acceleration spikes and absurd rotation rates', () => {
    const fusion = new ImuFusion({ smoothing: 0 });
    fusion.onOrientation({ alpha: 0, beta: 90, gamma: 0, absolute: true }, 0, 0);
    const before = fusion.getQuaternion();
    fusion.onMotion(
      {
        rotationRate: { x: 5000, y: -4000, z: 9000 },
        accelerationIncludingGravity: { x: 40, y: 0, z: 0 },
        intervalMs: 16,
      },
      16,
    );
    const after = fusion.getQuaternion();
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(after.z).toBeCloseTo(before.z, 6);
    expect(after.w).toBeCloseTo(before.w, 6);
  });
});
