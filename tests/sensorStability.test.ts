import { describe, expect, it } from 'vitest';
import { ImuFusion, type MotionSample } from '../src/sensors/imuFusion';
import { OrientationSourceGate } from '../src/sensors/orientationGate';
import { dampQuaternionTowards, decomposeTwistY, rotationAngle, scaleRotation } from '../src/sensors/quatFilters';
import {
  cameraAzAlt,
  deviceOrientationToCameraQuat,
  quatConjugate,
  quatFromAxisAngle,
  quatMultiply,
  quatNormalize,
  type DeviceOrientationSample,
} from '../src/sensors/orientationMath';
import type { Quat } from '../src/types';

const DEG = Math.PI / 180;
const FRAME_MS = 1000 / 60;

/** Deterministic RNG so the noise-based assertions never flake. */
function makeRng(seed: number) {
  let state = seed >>> 0;
  const uniform = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  return {
    uniform,
    gaussian(): number {
      const u = Math.max(uniform(), 1e-12);
      const v = uniform();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
}

function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Signed difference of two compass-style angles in degrees. */
function angleDeltaDeg(a: number, b: number): number {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

const STATIC_ACCEL = { x: 0, y: 9.81, z: 0 };

function motionSample(
  rate: { x: number; y: number; z: number } | null,
  accel = STATIC_ACCEL,
): MotionSample {
  return { rotationRate: rate, accelerationIncludingGravity: accel, intervalMs: FRAME_MS };
}

function orientationSample(alpha: number, beta: number, gamma: number): DeviceOrientationSample {
  return { alpha, beta, gamma, absolute: true };
}

function referenceAzAlt(alpha: number, beta: number, gamma: number): { az: number; alt: number } {
  return cameraAzAlt(deviceOrientationToCameraQuat(orientationSample(alpha, beta, gamma), 0));
}

describe('quaternion filter building blocks', () => {
  it('splits pure yaw into twist only', () => {
    const q = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 30 * DEG);
    const { yawAngle, swing } = decomposeTwistY(q);
    expect(yawAngle).toBeCloseTo(30 * DEG, 6);
    expect(rotationAngle(swing)).toBeLessThan(1e-6);
  });

  it('splits pure tilt into swing only', () => {
    const q = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, 20 * DEG);
    const { yawAngle, swing } = decomposeTwistY(q);
    expect(Math.abs(yawAngle)).toBeLessThan(1e-6);
    expect(rotationAngle(swing)).toBeCloseTo(20 * DEG, 6);
  });

  it('recomposes a mixed rotation exactly', () => {
    const yaw = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 35 * DEG);
    const tilt = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, -18 * DEG);
    const q = quatNormalize(quatMultiply(tilt, yaw));
    const { yawAngle, swing } = decomposeTwistY(q);
    const recomposed = quatNormalize(
      quatMultiply(swing, quatFromAxisAngle({ x: 0, y: 1, z: 0 }, yawAngle)),
    );
    const error = quatNormalize(quatMultiply(recomposed, quatConjugate(q)));
    expect(Math.abs(error.w)).toBeGreaterThan(0.99999);
  });

  it('scales a rotation', () => {
    const q = quatFromAxisAngle({ x: 0, y: 0, z: 1 }, 60 * DEG);
    expect(rotationAngle(scaleRotation(q, 0.5))).toBeCloseTo(30 * DEG, 6);
    expect(rotationAngle(scaleRotation(q, 0))).toBeLessThan(1e-6);
  });

  it('damps heading and tilt independently of frame rate', () => {
    const target = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 20 * DEG);
    const options = {
      yawTauSlow: 0.3,
      yawTauFast: 0.01,
      tiltTauSlow: 0.1,
      tiltTauFast: 0.005,
      slowSpeedDps: 6,
      fastSpeedDps: 45,
    };
    let at60: Quat = { x: 0, y: 0, z: 0, w: 1 };
    let at30: Quat = { x: 0, y: 0, z: 0, w: 1 };
    for (let i = 0; i < 60; i++) at60 = dampQuaternionTowards(at60, target, 1 / 60, 0, options);
    for (let i = 0; i < 30; i++) at30 = dampQuaternionTowards(at30, target, 1 / 30, 0, options);
    expect(rotationAngle(quatNormalize(quatMultiply(quatConjugate(at60), at30)))).toBeLessThan(0.5 * DEG);
    // Heavy damping at rest: after 1 s it should still not have arrived.
    expect(rotationAngle(at60)).toBeGreaterThan(4 * DEG);
    // At full speed it tracks tightly: the remaining error to the target shrinks.
    const errorBefore = rotationAngle(quatNormalize(quatMultiply(quatConjugate(at60), target)));
    const fast = dampQuaternionTowards(at60, target, 1 / 60, 80, options);
    const errorAfter = rotationAngle(quatNormalize(quatMultiply(quatConjugate(fast), target)));
    expect(errorAfter).toBeLessThan(errorBefore * 0.5);
  });
});

describe('orientation stability', () => {
  it('keeps a noisy, resting phone still', () => {
    // Regression test for the "trembling sky": OS orientation noise must not
    // reach the camera, and gyro/accelerometer noise must not add to it.
    const rng = makeRng(1234);
    const fusion = new ImuFusion({ smoothing: 0.45 });
    const azimuths: number[] = [];
    const frameSteps: number[] = [];
    let t = 0;
    for (let i = 0; i < 600; i++) {
      t += FRAME_MS;
      fusion.onOrientation(
        orientationSample(90 + rng.gaussian() * 1.5, 78 + rng.gaussian() * 0.4, 4 + rng.gaussian() * 0.4),
        0,
        t,
      );
      fusion.onMotion(
        motionSample({
          x: 0.05 + rng.gaussian() * 0.2,
          y: -0.03 + rng.gaussian() * 0.2,
          z: 0.08 + rng.gaussian() * 0.2,
        }),
        t,
      );
      if (i >= 120) {
        const { az } = cameraAzAlt(fusion.getQuaternion());
        if (azimuths.length > 0) {
          frameSteps.push(Math.abs(angleDeltaDeg(az, azimuths[azimuths.length - 1])));
        }
        azimuths.push(az);
      }
    }
    const sigma = stdDev(azimuths);
    const maxStep = Math.max(...frameSteps);
    // Input heading noise is 1.5°; anything close to that would be visible.
    expect(sigma).toBeLessThan(0.35);
    expect(maxStep).toBeLessThan(0.5);
  });

  it('ignores the duplicate relative stream while absolute events flow', () => {
    // Chrome on Android fires both; the relative alpha has an arbitrary origin.
    // Feeding both made the camera chase two headings every frame.
    const rng = makeRng(4242);
    const gate = new OrientationSourceGate();
    const fusion = new ImuFusion({ smoothing: 0.45 });
    const errors: number[] = [];
    let t = 0;
    for (let i = 0; i < 360; i++) {
      t += FRAME_MS;
      const alpha = 90 + rng.gaussian() * 1.2;
      if (gate.accept('absolute', t)) {
        fusion.onOrientation(orientationSample(alpha, 78, 4), 0, t);
      }
      if (gate.accept('relative', t)) {
        // 75° different yaw origin — the old code followed this half the time.
        fusion.onOrientation(orientationSample(alpha + 75, 78, 4), 0, t);
      }
      if (i >= 120) {
        const expected = referenceAzAlt(90, 78, 4).az;
        errors.push(angleDeltaDeg(cameraAzAlt(fusion.getQuaternion()).az, expected));
      }
    }
    expect(Math.abs(mean(errors))).toBeLessThan(1.5);
    expect(stdDev(errors)).toBeLessThan(0.6);
  });

  it('keeps up with a turn while damping noise', () => {
    const rng = makeRng(777);
    const fusion = new ImuFusion({ smoothing: 0.45 });
    let t = 0;
    let alpha = 90;
    const errors: number[] = [];
    const TURN_DPS = 60;
    for (let i = 0; i < 180; i++) {
      t += FRAME_MS;
      alpha += (TURN_DPS * FRAME_MS) / 1000;
      fusion.onOrientation(orientationSample(alpha + rng.gaussian() * 0.5, 78, 4), 0, t);
      fusion.onMotion(motionSample({ x: 0, y: 0, z: TURN_DPS }), t);
      if (i >= 120) {
        const expected = referenceAzAlt(alpha, 78, 4).az;
        errors.push(angleDeltaDeg(cameraAzAlt(fusion.getQuaternion()).az, expected));
      }
    }
    // Speed-adaptive damping: a few degrees of lag at 60°/s, not tens.
    expect(Math.abs(mean(errors))).toBeLessThan(6);
    expect(stdDev(errors)).toBeLessThan(1.2);
  });

  it('reaches a step change without overshooting', () => {
    const fusion = new ImuFusion({ smoothing: 0.45 });
    fusion.onOrientation(orientationSample(90, 78, 4), 0, 0);
    let t = 0;
    let last = 0;
    const target = referenceAzAlt(120, 78, 4).az;
    let maxError = 0;
    for (let i = 0; i < 120; i++) {
      t += FRAME_MS;
      fusion.onOrientation(orientationSample(120, 78, 4), 0, t);
      const { az } = cameraAzAlt(fusion.getQuaternion());
      last = az;
      maxError = Math.max(maxError, Math.abs(angleDeltaDeg(az, target)));
    }
    // Converged after 2 s, and never overshot the target.
    expect(Math.abs(angleDeltaDeg(last, target))).toBeLessThan(2);
    expect(angleDeltaDeg(last, target)).toBeGreaterThan(-0.5);
    expect(maxError).toBeLessThan(30.5);
  });

  it('does not integrate gyro noise at rest in fallback mode', () => {
    const rng = makeRng(99);
    const fusion = new ImuFusion({ smoothing: 0.45 });
    let t = 0;
    for (let i = 0; i < 120; i++) {
      t += FRAME_MS;
      fusion.onMotion(
        motionSample({
          x: 0.1 + rng.gaussian() * 0.08,
          y: 0.12,
          z: 0.22,
        }),
        t,
      );
    }
    expect(rotationAngle(fusion.getQuaternion())).toBeLessThan(0.25 * DEG);
  });

  it('still integrates a real rotation in fallback mode', () => {
    const fusion = new ImuFusion({ smoothing: 0.45 });
    let t = 0;
    for (let i = 0; i < 60; i++) {
      t += FRAME_MS;
      fusion.onMotion(motionSample({ x: 0, y: 90, z: 0 }), t);
    }
    const { az } = cameraAzAlt(fusion.getQuaternion());
    expect(Math.abs(angleDeltaDeg(az, 0))).toBeGreaterThan(60);
  });
});

describe('orientation source gate', () => {
  it('prefers absolute and suppresses relative while absolute is alive', () => {
    const gate = new OrientationSourceGate();
    expect(gate.accept('absolute', 0)).toBe(true);
    expect(gate.accept('relative', 10)).toBe(false);
    expect(gate.accept('absolute', 20)).toBe(true);
    expect(gate.accept('relative', 100)).toBe(false);
    expect(gate.hasAbsolute).toBe(true);
  });

  it('falls back to relative when absolute data stops', () => {
    const gate = new OrientationSourceGate();
    gate.accept('absolute', 0);
    expect(gate.accept('relative', 1000)).toBe(false);
    expect(gate.accept('relative', 2600)).toBe(true);
    expect(gate.accept('relative', 2620)).toBe(true);
    expect(gate.accept('absolute', 2700)).toBe(true);
    expect(gate.accept('relative', 2710)).toBe(false);
  });

  it('measures the accepted event rate', () => {
    const gate = new OrientationSourceGate();
    for (let i = 0; i < 120; i++) gate.accept('relative', i * (1000 / 60));
    expect(gate.eventsPerSecond).toBeGreaterThan(40);
    expect(gate.eventsPerSecond).toBeLessThan(70);
    expect(gate.acceptedCount).toBe(120);
  });
});
