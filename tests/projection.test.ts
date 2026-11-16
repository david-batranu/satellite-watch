import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import {
  angularRadiusToPixels,
  directionFromAzAlt,
  edgeAnchor,
  edgeDirection,
  projectAzAlt,
  projectDirection,
  type CameraView,
} from '../src/render/projection';
import { deviceOrientationToCameraQuat } from '../src/sensors/orientationMath';

const makeView = (overrides: Partial<CameraView> = {}): CameraView => ({
  quat: { x: 0, y: 0, z: 0, w: 1 }, // looking north, level
  fovYDeg: 65,
  width: 390,
  height: 844,
  ...overrides,
});

describe('projection', () => {
  it('places the view direction at the centre of the screen', () => {
    const view = makeView();
    const point = projectDirection(view, { x: 0, y: 0, z: -1 })!;
    expect(point.x).toBeCloseTo(195, 6);
    expect(point.y).toBeCloseTo(422, 6);
    expect(point.onScreen).toBe(true);
  });

  it('rejects directions behind the camera', () => {
    const view = makeView();
    expect(projectDirection(view, { x: 0, y: 0, z: 1 })).toBeNull();
  });

  it('maps the field of view edges to the screen edges', () => {
    const fovY = 65;
    const view = makeView({ fovYDeg: fovY });
    // Straight up/down at exactly half the vertical FOV.
    const half = Math.tan(((fovY / 2) * Math.PI) / 180);
    const top = projectDirection(view, { x: 0, y: half, z: -1 })!;
    const bottom = projectDirection(view, { x: 0, y: -half, z: -1 })!;
    expect(top.y).toBeCloseTo(0, 6);
    expect(bottom.y).toBeCloseTo(844, 6);

    const aspect = 390 / 844;
    const right = projectDirection(view, { x: half * aspect, y: 0, z: -1 })!;
    expect(right.x).toBeCloseTo(390, 6);
  });

  it('matches three.js camera projection for arbitrary orientations', () => {
    const camera = new PerspectiveCamera(65, 390 / 844, 0.01, 1e6);
    const view = makeView({
      quat: deviceOrientationToCameraQuat({ alpha: 33, beta: 78, gamma: -12, absolute: true }, 0),
    });
    camera.quaternion.set(view.quat.x, view.quat.y, view.quat.z, view.quat.w);
    camera.updateMatrixWorld(true);

    const directions: Array<[number, number, number]> = [
      [0, 0, -1],
      [0.3, 0.4, -0.86],
      [-0.6, -0.2, -0.77],
      [0.9, 0.1, -0.42],
      [-0.05, 0.95, -0.3],
    ];
    for (const [x, y, z] of directions) {
      const length = Math.hypot(x, y, z);
      const dir = { x: x / length, y: y / length, z: z / length };
      const theirs = new Vector3(dir.x, dir.y, dir.z).multiplyScalar(1000).project(camera);
      const ours = projectDirection(view, dir);
      if (Math.abs(theirs.x) > 50 || Math.abs(theirs.y) > 50) continue; // behind camera
      expect(ours).not.toBeNull();
      const expectedX = (theirs.x * 0.5 + 0.5) * view.width;
      const expectedY = (1 - (theirs.y * 0.5 + 0.5)) * view.height;
      expect(ours!.x).toBeCloseTo(expectedX, 5);
      expect(ours!.y).toBeCloseTo(expectedY, 5);
    }
  });

  it('projects the horizon where a level camera expects it', () => {
    const level = makeView();
    expect(projectAzAlt(level, 0, 0)!.y).toBeCloseTo(422, 6);
    // Camera pitched 20° up (beta = 90 + altitude): the horizon drops below centre.
    const up = makeView({
      quat: deviceOrientationToCameraQuat({ alpha: 0, beta: 110, gamma: 0, absolute: true }, 0),
    });
    const horizon = projectAzAlt(up, 0, 0)!;
    expect(horizon.y).toBeGreaterThan(422);
    expect(horizon.onScreen).toBe(true);

    // Pitched 20° down: the horizon rises above centre.
    const down = makeView({
      quat: deviceOrientationToCameraQuat({ alpha: 0, beta: 70, gamma: 0, absolute: true }, 0),
    });
    expect(projectAzAlt(down, 0, 0)!.y).toBeLessThan(422);
  });

  it('sizes angular radii consistently with the field of view', () => {
    const view = makeView();
    // The half vertical FOV maps to half the screen height.
    expect(angularRadiusToPixels(view, 65 / 2)).toBeCloseTo(844 / 2, 6);
    expect(angularRadiusToPixels(view, 0.25)).toBeGreaterThan(1);
  });

  it('points edge arrows towards off-screen targets', () => {
    const view = makeView();
    // Target to the right of the view: arrow should point +x.
    const right = directionFromAzAlt(45, 0);
    const dir = edgeDirection(view, right);
    expect(dir.x).toBeGreaterThan(0.9);
    expect(dir.behind).toBe(false);

    const anchor = edgeAnchor(view, dir, 24);
    expect(anchor.x).toBeGreaterThan(195);
    expect(anchor.x).toBeLessThanOrEqual(390);

    // Target behind the camera: arrow is mirrored, and flagged.
    const behind = edgeDirection(view, directionFromAzAlt(180, 0));
    expect(behind.behind).toBe(true);
  });
});
