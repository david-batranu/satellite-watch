/**
 * Perspective projection for the sky overlay.
 *
 * The 3D renderer uses a three.js camera, but labels, hit-testing and the
 * off-screen target arrows need the same projection on the CPU. This module is
 * the single source of truth for that maths; a unit test compares it against
 * three.js' own projection so the two cannot silently drift apart.
 *
 * Camera convention: looking down local -Z, +X right, +Y up. The camera
 * quaternion rotates world → view when conjugated.
 */

import { DEG2RAD } from '../lib/angles';
import { quatConjugate, rotateVector } from '../sensors/orientationMath';
import type { Quat, Vec3 } from '../types';

export interface CameraView {
  /** World → camera rotation described as camera → world. */
  quat: Quat;
  /** Vertical field of view, degrees. */
  fovYDeg: number;
  /** Viewport size in CSS pixels. */
  width: number;
  height: number;
}

export interface ProjectedPoint {
  /** Screen position in CSS pixels, origin top-left. */
  x: number;
  y: number;
  /** Normalised device coordinates, -1..1, y up. */
  ndcX: number;
  ndcY: number;
  /** Distance along the camera axis (positive = in front). */
  depth: number;
  onScreen: boolean;
}

export function cameraAspect(view: CameraView): number {
  return view.height > 0 ? view.width / view.height : 1;
}

export function tanHalfFovY(fovYDeg: number): number {
  return Math.tan((fovYDeg * DEG2RAD) / 2);
}

/** Project a world-space direction. Returns null when it is behind the camera. */
export function projectDirection(view: CameraView, direction: Vec3): ProjectedPoint | null {
  const inverse = quatConjugate(view.quat);
  const camera = rotateVector(inverse, direction);
  const depth = -camera.z;
  if (!(depth > 1e-6)) return null;

  const tanY = tanHalfFovY(view.fovYDeg);
  const tanX = tanY * cameraAspect(view);
  const ndcX = camera.x / depth / tanX;
  const ndcY = camera.y / depth / tanY;

  return {
    x: (ndcX * 0.5 + 0.5) * view.width,
    y: (1 - (ndcY * 0.5 + 0.5)) * view.height,
    ndcX,
    ndcY,
    depth,
    onScreen: Math.abs(ndcX) <= 1 && Math.abs(ndcY) <= 1,
  };
}

/** Project a horizontal sky position. */
export function projectAzAlt(view: CameraView, azDeg: number, altDeg: number): ProjectedPoint | null {
  const direction = directionFromAzAlt(azDeg, altDeg);
  return projectDirection(view, direction);
}

/** Unit vector in the world frame (+X east, +Y up, +Z south). */
export function directionFromAzAlt(azDeg: number, altDeg: number): Vec3 {
  const az = azDeg * DEG2RAD;
  const alt = altDeg * DEG2RAD;
  const cosAlt = Math.cos(alt);
  return {
    x: cosAlt * Math.sin(az),
    y: Math.sin(alt),
    z: -cosAlt * Math.cos(az),
  };
}

/** Pixel distance between two projections. */
export function pixelDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Size in pixels of an object with the given angular radius. Used to keep
 * planet and Moon discs at a believable size while never letting them vanish.
 */
export function angularRadiusToPixels(view: CameraView, angularRadiusDeg: number): number {
  const tanY = tanHalfFovY(view.fovYDeg);
  const ndc = Math.tan(angularRadiusDeg * DEG2RAD) / tanY;
  return (ndc * view.height) / 2;
}

/**
 * Where should an edge arrow point for a target that is off screen?
 * Returns a screen-space direction (unit length) and whether the target is
 * behind the camera (in which case the direction is mirrored).
 */
export function edgeDirection(view: CameraView, direction: Vec3): { x: number; y: number; behind: boolean } {
  const camera = rotateVector(quatConjugate(view.quat), direction);
  let x = camera.x;
  let y = camera.y;
  const behind = -camera.z <= 1e-6;
  if (behind) {
    // Mirrored so "turn around" arrows point the intuitive way.
    x = -x;
    y = -y;
  }
  const length = Math.hypot(x, y);
  if (length < 1e-9) return { x: 0, y: -1, behind };
  return { x: x / length, y: y / length, behind };
}

/** Point on the rectangle inset from the viewport edge, along a screen direction. */
export function edgeAnchor(
  view: CameraView,
  direction: { x: number; y: number },
  inset: number,
): { x: number; y: number } {
  const cx = view.width / 2;
  const cy = view.height / 2;
  const radiusX = view.width / 2 - inset;
  const radiusY = view.height / 2 - inset;
  const scaleX = Math.abs(direction.x) > 1e-6 ? radiusX / Math.abs(direction.x) : Infinity;
  const scaleY = Math.abs(direction.y) > 1e-6 ? radiusY / Math.abs(direction.y) : Infinity;
  const scale = Math.min(scaleX, scaleY);
  return { x: cx + direction.x * scale, y: cy + direction.y * scale };
}
