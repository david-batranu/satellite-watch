/**
 * WebGL sky dome.
 *
 * Everything that moves through the sky is a point, a line or a sprite placed on
 * a large sphere around the observer; the camera sits at the centre and is
 * rotated by the fused sensor quaternion. The camera feed itself is a <video>
 * element behind the transparent canvas.
 *
 * The renderer owns fixed-capacity buffers, so per-frame updates are just
 * `array.set(...)` + `setDrawRange(...)` — no allocation, no garbage collection
 * pauses on a phone.
 */

import * as THREE from 'three';
import { DEFAULT_FPS } from '../config';
import type { Vec3 } from '../types';
import type { CameraView } from './projection';
import {
  satelliteFragmentShader,
  satelliteVertexShader,
  starFragmentShader,
  starVertexShader,
} from './shaders';

/** Radius of the sky sphere. Only the direction matters. */
export const SKY_RADIUS = 1000;

export interface LayerVisibility {
  stars: boolean;
  constellations: boolean;
  asterisms: boolean;
  satellites: boolean;
  horizon: boolean;
  orbits: boolean;
}

export const DEFAULT_LAYERS: LayerVisibility = {
  stars: true,
  constellations: true,
  asterisms: false,
  satellites: true,
  horizon: true,
  orbits: true,
};

export interface RendererCapacities {
  stars: number;
  constellationVertices: number;
  asterismVertices: number;
  satellites: number;
  trackPoints: number;
}

interface PointCloud {
  points: THREE.Points;
  positions: THREE.BufferAttribute;
  sizes: THREE.BufferAttribute;
  colors: THREE.BufferAttribute;
  geometry: THREE.BufferGeometry;
  capacity: number;
}

function createPointCloud(
  capacity: number,
  vertexShader: string,
  fragmentShader: string,
  pixelRatio: () => number,
): PointCloud {
  const geometry = new THREE.BufferGeometry();
  const positions = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
  const sizes = new THREE.BufferAttribute(new Float32Array(capacity), 1);
  const colors = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
  positions.setUsage(THREE.DynamicDrawUsage);
  sizes.setUsage(THREE.DynamicDrawUsage);
  colors.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positions);
  geometry.setAttribute('aSize', sizes);
  geometry.setAttribute('aColor', colors);
  geometry.setDrawRange(0, 0);

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: { uPixelRatio: { get value() { return pixelRatio(); } } },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 10;
  return { points, positions, sizes, colors, geometry, capacity };
}

interface LineCloud {
  line: THREE.LineSegments;
  geometry: THREE.BufferGeometry;
  positions: THREE.BufferAttribute;
  capacity: number;
}

function createLineCloud(capacity: number, color: number, opacity: number): LineCloud {
  const geometry = new THREE.BufferGeometry();
  const positions = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
  positions.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positions);
  geometry.setDrawRange(0, 0);
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const line = new THREE.LineSegments(geometry, material);
  line.frustumCulled = false;
  line.renderOrder = 5;
  return { line, geometry, positions, capacity };
}

export class SkyRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(65, 1, 0.1, SKY_RADIUS * 8);
  private readonly stars: PointCloud;
  private readonly satellites: PointCloud;
  private readonly constellations: LineCloud;
  private readonly asterisms: LineCloud;
  private readonly horizon: THREE.LineLoop;
  private readonly track: THREE.Line;
  private readonly trackPositions: THREE.BufferAttribute;
  private readonly trackColors: THREE.BufferAttribute;
  private readonly trackCapacity: number;
  private pixelRatio = 1;
  private width = 1;
  private height = 1;
  private disposed = false;
  private readonly layers = { ...DEFAULT_LAYERS };

  constructor(canvas: HTMLCanvasElement, capacities: RendererCapacities) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false,
      powerPreference: 'high-performance',
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.stars = createPointCloud(
      capacities.stars,
      starVertexShader,
      starFragmentShader,
      () => this.pixelRatio,
    );
    this.satellites = createPointCloud(
      capacities.satellites,
      satelliteVertexShader,
      satelliteFragmentShader,
      () => this.pixelRatio,
    );
    this.constellations = createLineCloud(capacities.constellationVertices, 0x7dd3fc, 0.32);
    this.asterisms = createLineCloud(capacities.asterismVertices, 0xa78bfa, 0.26);

    // Horizon circle: alt = 0, sampled around the full compass.
    const horizonGeometry = new THREE.BufferGeometry();
    const horizonPoints = new Float32Array(180 * 3);
    for (let i = 0; i < 180; i++) {
      const az = (i / 180) * Math.PI * 2;
      horizonPoints[i * 3] = Math.sin(az) * SKY_RADIUS;
      horizonPoints[i * 3 + 1] = 0;
      horizonPoints[i * 3 + 2] = -Math.cos(az) * SKY_RADIUS;
    }
    horizonGeometry.setAttribute('position', new THREE.BufferAttribute(horizonPoints, 3));
    this.horizon = new THREE.LineLoop(
      horizonGeometry,
      new THREE.LineBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.22,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.horizon.frustumCulled = false;
    this.horizon.renderOrder = 2;

    this.trackCapacity = capacities.trackPoints;
    const trackGeometry = new THREE.BufferGeometry();
    this.trackPositions = new THREE.BufferAttribute(new Float32Array(capacities.trackPoints * 3), 3);
    this.trackColors = new THREE.BufferAttribute(new Float32Array(capacities.trackPoints * 3), 3);
    this.trackPositions.setUsage(THREE.DynamicDrawUsage);
    this.trackColors.setUsage(THREE.DynamicDrawUsage);
    trackGeometry.setAttribute('position', this.trackPositions);
    trackGeometry.setAttribute('color', this.trackColors);
    trackGeometry.setDrawRange(0, 0);
    this.track = new THREE.Line(
      trackGeometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.track.frustumCulled = false;
    this.track.renderOrder = 6;

    this.scene.add(
      this.stars.points,
      this.satellites.points,
      this.constellations.line,
      this.asterisms.line,
      this.horizon,
      this.track,
    );
    this.applyLayers();
  }

  resize(width: number, height: number, pixelRatio: number): void {
    if (this.disposed) return;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.pixelRatio = Math.min(Math.max(1, pixelRatio), DEFAULT_FPS.maxPixelRatio);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }

  setLayers(layers: Partial<LayerVisibility>): void {
    Object.assign(this.layers, layers);
    this.applyLayers();
  }

  private applyLayers(): void {
    this.stars.points.visible = this.layers.stars;
    this.satellites.points.visible = this.layers.satellites;
    this.constellations.line.visible = this.layers.constellations;
    this.asterisms.line.visible = this.layers.asterisms;
    this.horizon.visible = this.layers.horizon;
    this.track.visible = this.layers.orbits;
  }

  updateStars(positions: Float32Array, sizes: Float32Array, colors: Float32Array, count: number): void {
    const n = Math.min(count, this.stars.capacity);
    if (n <= 0) {
      this.stars.geometry.setDrawRange(0, 0);
      return;
    }
    (this.stars.positions.array as Float32Array).set(positions.subarray(0, n * 3));
    (this.stars.sizes.array as Float32Array).set(sizes.subarray(0, n));
    (this.stars.colors.array as Float32Array).set(colors.subarray(0, n * 3));
    this.stars.positions.needsUpdate = true;
    this.stars.sizes.needsUpdate = true;
    this.stars.colors.needsUpdate = true;
    this.stars.geometry.setDrawRange(0, n);
  }

  updateSatellites(
    positions: Float32Array,
    sizes: Float32Array,
    colors: Float32Array,
    count: number,
  ): void {
    const n = Math.min(count, this.satellites.capacity);
    if (n <= 0) {
      this.satellites.geometry.setDrawRange(0, 0);
      return;
    }
    (this.satellites.positions.array as Float32Array).set(positions.subarray(0, n * 3));
    (this.satellites.sizes.array as Float32Array).set(sizes.subarray(0, n));
    (this.satellites.colors.array as Float32Array).set(colors.subarray(0, n * 3));
    this.satellites.positions.needsUpdate = true;
    this.satellites.sizes.needsUpdate = true;
    this.satellites.colors.needsUpdate = true;
    this.satellites.geometry.setDrawRange(0, n);
  }

  updateConstellationLines(positions: Float32Array, vertexCount: number): void {
    this.updateLines(this.constellations, positions, vertexCount);
  }

  updateAsterismLines(positions: Float32Array, vertexCount: number): void {
    this.updateLines(this.asterisms, positions, vertexCount);
  }

  private updateLines(cloud: LineCloud, positions: Float32Array, vertexCount: number): void {
    const n = Math.min(vertexCount, cloud.capacity);
    if (n <= 0) {
      cloud.geometry.setDrawRange(0, 0);
      return;
    }
    (cloud.positions.array as Float32Array).set(positions.subarray(0, n * 3));
    cloud.positions.needsUpdate = true;
    cloud.geometry.setDrawRange(0, n);
  }

  /** Update the selected satellite's orbit arc. `count` is a vertex count. */
  updateTrack(positions: Float32Array | null, count: number): void {
    if (!positions || count <= 0) {
      this.track.geometry.setDrawRange(0, 0);
      return;
    }
    const n = Math.min(count, this.trackCapacity);
    (this.trackPositions.array as Float32Array).set(positions.subarray(0, n * 3));
    // Fade from dim (past) to bright (future) along the track.
    const colors = this.trackColors.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 1;
      const intensity = 0.35 + 0.65 * t;
      colors[i * 3] = 0.4 * intensity;
      colors[i * 3 + 1] = 0.9 * intensity;
      colors[i * 3 + 2] = 1.0 * intensity;
    }
    this.trackPositions.needsUpdate = true;
    this.trackColors.needsUpdate = true;
    this.track.geometry.setDrawRange(0, n);
  }

  render(view: CameraView): void {
    if (this.disposed) return;
    const camera = this.camera;
    if (camera.fov !== view.fovYDeg) {
      camera.fov = view.fovYDeg;
      camera.updateProjectionMatrix();
    }
    const aspect = this.width / this.height;
    if (Math.abs(camera.aspect - aspect) > 1e-6) {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    }
    camera.quaternion.set(view.quat.x, view.quat.y, view.quat.z, view.quat.w);
    camera.position.set(0, 0, 0);
    camera.updateMatrixWorld(true);
    this.renderer.render(this.scene, camera);
  }

  /** World position for a sky direction at the dome radius. */
  static positionFor(az: number, alt: number, out: Vec3): Vec3 {
    const azRad = (az * Math.PI) / 180;
    const altRad = (alt * Math.PI) / 180;
    const cosAlt = Math.cos(altRad);
    out.x = cosAlt * Math.sin(azRad) * SKY_RADIUS;
    out.y = Math.sin(altRad) * SKY_RADIUS;
    out.z = -cosAlt * Math.cos(azRad) * SKY_RADIUS;
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = (mesh as unknown as { material?: THREE.Material | THREE.Material[] }).material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
    });
    this.renderer.dispose();
  }
}
