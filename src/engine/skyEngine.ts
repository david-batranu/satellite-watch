/**
 * SkyEngine — the integration layer.
 *
 * Owns the render loop and ties together: sensors (orientation), geolocation,
 * the star/constellation catalogue, solar-system bodies, the satellite worker,
 * the WebGL sky and the 2D HUD. React only renders chrome around it; nothing in
 * here triggers React renders at frame rate.
 *
 * Sky time is `Date.now() + settings.timeOffsetMs`, which is what makes the
 * "time travel" slider work.
 */

import { computeSolarBodies, darknessLevel, moonPhaseName } from '../astro/skyBodies';
import {
  applyRefractionVector,
  computeSkyRotation,
  eqdToWorldMatrix,
  type Matrix3,
  type SkyRotation,
} from '../astro/frame';
import { loadSkyData, type SkyData } from '../astro/starCatalog';
import { QUICK_BODY_TARGETS, QUICK_CONSTELLATIONS, SKY } from '../config';
import { clamp, normalizeDeg, RAD2DEG } from '../lib/angles';
import { bvToRgb, sizeForMagnitude } from '../lib/starColor';
import { LabelLayer, type BodyMarker, type LabelFrame, type LabelItem } from '../render/labelLayer';
import type { CameraView } from '../render/projection';
import { SkyRenderer, SKY_RADIUS, type LayerVisibility } from '../render/skyRenderer';
import {
  OPTIONAL_GROUPS,
  applyLiveRefresh,
  catalogAgeMs,
  fetchLiveElements,
  loadCatalog,
  loadGroupCatalog,
  shouldAutoRefresh,
  type CatalogSource,
  type OptionalGroupId,
  type SatelliteCatalog,
} from '../satellites/catalog';
import {
  QUICK_SATELLITES,
  SATELLITE_GROUP_META,
  satelliteColor,
  satelliteDisplayName,
} from '../satellites/groups';
import { sampleSkyTrack } from '../satellites/passes';
import { createEntries, describeSatellite, type SatelliteEntry } from '../satellites/propagation';
import type { WorkerInMessage, WorkerOutMessage } from '../satellites/worker';
import { GeolocationService, type GeolocationPhase } from '../sensors/geolocation';
import { cameraAzAlt, quatFromAzAlt } from '../sensors/orientationMath';
import { SensorManager, type SensorStatus } from '../sensors/sensorManager';
import type { Settings } from '../state/settings';
import { Constellation } from 'astronomy-engine';
import { computeBodyPaths, writeBodyPathGeometry, type BodyPath } from '../astro/bodyPaths';
import { parseTargetId, targetId } from './targets';
import type {
  AsterismFigure,
  ConstellationFigure,
  Observer,
  Quat,
  SatelliteRecord,
  SatelliteSkyState,
  SolarBodyId,
  SolarBodyState,
  TargetKind,
  TargetRef,
  Vec3,
} from '../types';

export type CameraState = 'off' | 'starting' | 'on' | 'denied' | 'unavailable';

export interface TargetSummary {
  /** Namespaced id: `sat:25544`, `body:moon`, `star:123`, `con:Ori`. */
  id: string;
  kind: TargetKind;
  label: string;
  az: number;
  alt: number;
  visible: boolean;
  color: string;
  detail: string | null;
}

export interface EngineSnapshot {
  fps: number;
  sensor: SensorStatus;
  locationPhase: GeolocationPhase;
  accuracyM: number | null;
  satelliteCount: number;
  visibleSatellites: number;
  targets: TargetSummary[];
  selected: TargetSummary | null;
  timeMs: number;
  dataAgeDays: number;
  catalogSource: CatalogSource | null;
  catalogVersion: number;
  camera: CameraState;
  skyDataReady: boolean;
  skyError: string | null;
  satelliteComputeMs: number;
  headingDeg: number;
  altitudeDeg: number;
  manualLook: boolean;
  /** Sun-based visibility class of the sky right now. */
  darkness: 'day' | 'civil' | 'nautical' | 'astronomical';
}

/**
 * Everything the detail sheet needs about the selected target. Computed on
 * demand (the sheet polls it twice a second) rather than shipped in every
 * snapshot.
 */
export interface SelectedDetail {
  kind: TargetKind;
  id: string;
  label: string;
  az: number;
  alt: number;
  visible: boolean;
  color: string;
  /** Satellites. */
  norad?: number;
  groups?: string[];
  rangeKm?: number;
  sunlit?: boolean;
  /** Sun, Moon and planets. */
  bodyId?: SolarBodyId;
  distanceKm?: number;
  distanceAu?: number;
  phaseFraction?: number;
  phaseAngle?: number;
  phaseName?: string;
  constellation?: string;
  constellationName?: string;
  mag?: number;
  /** Stars. */
  starIndex?: number;
  starMag?: number;
  raDeg?: number;
  decDeg?: number;
  /** Constellation and asterism figures. */
  figureId?: string;
  segmentCount?: number;
  pointCount?: number;
}

export interface DataStatus {
  source: CatalogSource | null;
  ageDays: number;
  refreshing: boolean;
  message: string | null;
}

export interface EngineEvents {
  onSnapshot: (snapshot: EngineSnapshot) => void;
  onObserver: (observer: Observer) => void;
  onSelectionRequest: (target: TargetRef | null) => void;
  onFovChange: (fovDeg: number) => void;
  onCameraChange: (camera: CameraState) => void;
  onDataStatus: (status: DataStatus) => void;
}

export interface SkyEngineOptions {
  container: HTMLElement;
  skyCanvas: HTMLCanvasElement;
  hudCanvas: HTMLCanvasElement;
  video: HTMLVideoElement | null;
  settings: Settings;
  observer: Observer | null;
  events: EngineEvents;
}

const ASTRO_INTERVAL_MS = 280;
const SATELLITE_INTERVAL_MS = 450;
const SNAPSHOT_INTERVAL_MS = 900;
const TRACK_INTERVAL_MS = 8_000;
const TRACK_BEFORE_MINUTES = 18;
const TRACK_AFTER_MINUTES = 84;
const TRACK_CAPACITY = 600;
/** GPU point capacity: the base catalogue plus the optional Starlink group. */
const MAX_SATELLITE_CAPACITY = 12_000;
/** Large catalogues propagate less often to keep phones cool. */
const LARGE_CATALOG_INTERVAL_MS = 900;
const LARGE_CATALOG_THRESHOLD = 3000;
/** Vertex capacity for the planet orbit lines (8 bodies × 179 segments × 2). */
const BODY_PATH_MAX_VERTICES = 4096;
/** The sampled paths move slowly; recompute the samples at most this often. */
const BODY_PATH_BUCKET_MS = 6 * 3600 * 1000;

interface PointerState {
  id: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startTime: number;
  moved: boolean;
}

type FigureLike = Pick<ConstellationFigure, 'lines'> | Pick<AsterismFigure, 'lines'>;

/** Flatten RA/Dec stick figures into a point table plus index pairs. */
function flattenFigures(figures: readonly FigureLike[]): {
  points: Float32Array;
  segments: Uint32Array;
} {
  const points: number[] = [];
  const segments: number[] = [];
  for (const figure of figures) {
    for (const line of figure.lines) {
      let previousIndex = -1;
      for (const [ra, dec] of line) {
        points.push(ra, dec);
        const index = points.length / 2 - 1;
        if (previousIndex >= 0) segments.push(previousIndex, index);
        previousIndex = index;
      }
    }
  }
  return {
    points: Float32Array.from(points),
    segments: Uint32Array.from(segments),
  };
}

/** Reusable output vector for the hot loops; avoids per-object allocation. */
const scratchVec: Vec3 = { x: 0, y: 0, z: 0 };

export class SkyEngine {
  private readonly options: SkyEngineOptions;
  private settings: Settings;
  private observer: Observer | null;

  private renderer: SkyRenderer | null = null;
  private labels: LabelLayer | null = null;
  private readonly sensors = new SensorManager();
  private readonly geo: GeolocationService;

  private skyData: SkyData | null = null;
  private skyError: string | null = null;
  private catalog: SatelliteCatalog | null = null;
  private catalogSource: CatalogSource | null = null;
  private catalogVersion = 0;
  private records: SatelliteRecord[] = [];
  private entries: SatelliteEntry[] = [];
  private indexByNorad = new Map<number, number>();
  private worker: Worker | null = null;
  /** Lazy-loaded heavy groups (currently Starlink) and their load state. */
  private readonly optionalGroups = new Map<OptionalGroupId, 'loading' | 'loaded' | 'error'>();

  private satelliteStates: SatelliteSkyState[] = [];
  private satelliteComputeMs = 0;
  private bodyStates: SolarBodyState[] = [];
  private constellationAzAlt = new Map<string, { az: number; alt: number }>();
  private items: LabelItem[] = [];
  private bodies: BodyMarker[] = [];
  private targets: TargetSummary[] = [];
  private selection: TargetRef | null = null;

  // Star catalogue caches.
  private starEqj = new Float32Array(0);
  private starSizes = new Float32Array(0);
  private starColors = new Float32Array(0);
  private starMag: Float32Array = new Float32Array(0);
  private starNames = new Map<number, string>();
  private starPositionsScratch = new Float32Array(0);
  private starSizesScratch = new Float32Array(0);
  private starColorsScratch = new Float32Array(0);

  private constellationGeometry: ReturnType<typeof flattenFigures> | null = null;
  private asterismGeometry: ReturnType<typeof flattenFigures> | null = null;
  private constellationPositions = new Float32Array(0);
  private asterismPositions = new Float32Array(0);
  private constellationVertices = 0;
  private asterismVertices = 0;

  private satellitePositions = new Float32Array(0);
  private satelliteSizesScratch = new Float32Array(0);
  private satelliteColorsScratch = new Float32Array(0);
  private satelliteBaseSizes = new Float32Array(0);
  private satelliteBaseColors = new Float32Array(0);

  private trackPositions = new Float32Array(TRACK_CAPACITY * 3);
  private trackFor = -1;
  private trackUpdatedAt = 0;

  // Planet orbit lines: RA/Dec samples cached per time/observer bucket, projected
  // onto the current sky rotation every astronomy tick.
  private bodyPathCache: { key: string; paths: BodyPath[] } | null = null;
  private bodyPathPositions = new Float32Array(BODY_PATH_MAX_VERTICES * 3);
  private bodyPathColors = new Float32Array(BODY_PATH_MAX_VERTICES * 3);
  private bodyPathVertexCount = 0;

  // Frame state.
  private worldWidth = 1;
  private worldHeight = 1;
  private dpr = 1;
  private running = false;
  private disposed = false;
  private rafId = 0;
  private lastFrameAt = 0;
  private fps = 0;
  private lastAstroAt = 0;
  private astroDirty = true;
  private lastSatelliteAt = 0;
  private lastSnapshotAt = 0;
  private manualAzDeg = 180;
  private manualAltDeg = 18;
  private manualQuat: Quat = quatFromAzAlt(180, 18);
  private headingDeg = 0;
  private altitudeDeg = 0;
  private cameraState: CameraState = 'off';
  private cameraStream: MediaStream | null = null;

  private pointers = new Map<number, PointerState>();
  private pinchStartDistance = 0;
  private pinchStartFov = 0;
  private fovOverride: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private detachDom: Array<() => void> = [];
  private astroRotation: Matrix3 | null = null;
  private lastSensorStatus: SensorStatus | null = null;
  private topInsetPx = 64;
  private bottomInsetPx = 104;
  private avoidRects: Array<{ x: number; y: number; w: number; h: number }> = [];

  constructor(options: SkyEngineOptions) {
    this.options = options;
    this.settings = options.settings;
    this.observer = options.observer;
    this.manualAzDeg = options.settings.manualAzDeg;
    this.manualAltDeg = options.settings.manualAltDeg;
    this.manualQuat = quatFromAzAlt(this.manualAzDeg, this.manualAltDeg);
    this.geo = new GeolocationService(
      (observer) => this.handleObserver(observer),
      () => undefined,
    );
    this.sensors.setCalibration({
      headingOffsetDeg: options.settings.headingOffsetDeg,
      pitchOffsetDeg: options.settings.pitchOffsetDeg,
      smoothing: options.settings.smoothing,
      manual: options.settings.manualLook,
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    try {
      this.skyData = await loadSkyData();
    } catch (error) {
      this.skyData = null;
      this.skyError = error instanceof Error ? error.message : 'Failed to load sky data';
      console.warn('[engine] sky data unavailable', error);
    }
    await this.loadSatellites();
    this.ensureOptionalGroups();

    this.prepareStarBuffers();
    this.createLayers();
    this.observeLayout();
    this.attachPointerHandlers();
    this.createSatelliteWorker();
    this.resize();

    this.running = true;
    this.rafId = requestAnimationFrame(this.loop);

    if (typeof document !== 'undefined') {
      const onVisibility = () => {
        if (document.hidden) this.pause();
        else this.resume();
      };
      document.addEventListener('visibilitychange', onVisibility);
      this.detachDom.push(() => document.removeEventListener('visibilitychange', onVisibility));
    }

    void this.geo.start();
    if (this.settings.cameraEnabled) void this.setCameraEnabled(true);
    this.pushDataStatus();
    void this.maybeAutoRefresh();
  }

  private async loadSatellites(): Promise<void> {
    try {
      const loaded = await loadCatalog();
      this.applyCatalog(loaded.catalog, loaded.source);
    } catch (error) {
      console.warn('[engine] satellite catalogue unavailable', error);
      this.applyCatalog(null, null);
    }
  }

  private applyCatalog(catalog: SatelliteCatalog | null, source: CatalogSource | null): void {
    this.catalog = catalog;
    this.catalogSource = source;
    this.records = catalog?.records ?? [];
    this.entries = createEntries(this.records);
    this.indexByNorad = new Map();
    this.records.forEach((record, index) => this.indexByNorad.set(record.norad, index));
    this.catalogVersion++;
    this.prepareSatelliteBuffers();
    this.configureWorker();
    this.astroDirty = true;
    this.pushDataStatus();
  }

  /**
   * Load any heavy optional group (Starlink) that is enabled but not in memory.
   *
   * Deliberately fire-and-forget: the layer switches on once the data arrives and
   * the worker is reconfigured. The catalogue is cached in IndexedDB after the
   * first load, so later sessions start from disk.
   */
  private ensureOptionalGroups(): void {
    const enabled = new Set(this.settings.satelliteGroups);
    for (const group of OPTIONAL_GROUPS) {
      if (!enabled.has(group)) continue;
      const state = this.optionalGroups.get(group);
      if (state === 'loading' || state === 'loaded') continue;
      this.optionalGroups.set(group, 'loading');
      void this.loadOptionalGroup(group);
    }
  }

  private async loadOptionalGroup(group: OptionalGroupId): Promise<void> {
    try {
      const catalog = await loadGroupCatalog(group);
      if (this.disposed) return;
      this.mergeGroupRecords(group, catalog.records);
      this.optionalGroups.set(group, 'loaded');
    } catch (error) {
      this.optionalGroups.set(group, 'error');
      console.warn(`[engine] optional group "${group}" unavailable`, error);
    }
  }

  /**
   * Append lazily loaded records, keeping indices aligned with the worker (which
   * receives the merged array) and the renderer buffers.
   */
  private mergeGroupRecords(group: OptionalGroupId, records: readonly SatelliteRecord[]): void {
    const known = new Set(this.records.map((record) => record.norad));
    const additions = records.filter((record) => !known.has(record.norad));
    if (additions.length === 0) return;

    const base = this.records.length;
    const newEntries = createEntries(additions).map((entry) => ({
      ...entry,
      index: entry.index + base,
    }));

    this.records = [...this.records, ...additions];
    this.entries = [...this.entries, ...newEntries];
    additions.forEach((record, offset) => this.indexByNorad.set(record.norad, base + offset));
    this.catalogVersion++;
    this.prepareSatelliteBuffers();
    this.configureWorker();
    this.astroDirty = true;
    this.pushDataStatus();
    console.info(`[engine] ${group}: ${additions.length} objects loaded (${this.records.length} total)`);
  }

  private prepareStarBuffers(): void {
    const stars = this.skyData?.stars;
    if (!stars) return;
    const count = stars.count;
    this.starEqj = new Float32Array(count * 3);
    this.starSizes = new Float32Array(count);
    this.starColors = new Float32Array(count * 3);
    this.starMag = stars.mag;
    this.starNames = stars.names;

    for (let i = 0; i < count; i++) {
      const ra = (stars.raDeg[i]! * Math.PI) / 180;
      const dec = (stars.decDeg[i]! * Math.PI) / 180;
      const cosDec = Math.cos(dec);
      this.starEqj[i * 3] = cosDec * Math.cos(ra);
      this.starEqj[i * 3 + 1] = cosDec * Math.sin(ra);
      this.starEqj[i * 3 + 2] = Math.sin(dec);
      this.starSizes[i] = sizeForMagnitude(stars.mag[i]!, { base: 3.9, min: 1.55, max: 10 });
      const [r, g, b] = bvToRgb(stars.colorIndex[i]!);
      this.starColors[i * 3] = r;
      this.starColors[i * 3 + 1] = g;
      this.starColors[i * 3 + 2] = b;
    }

    this.starPositionsScratch = new Float32Array(count * 3);
    this.starSizesScratch = new Float32Array(count);
    this.starColorsScratch = new Float32Array(count * 3);

    this.constellationGeometry = this.skyData ? flattenFigures(this.skyData.constellations) : null;
    this.asterismGeometry = this.skyData ? flattenFigures(this.skyData.asterisms) : null;
    this.constellationPositions = new Float32Array(
      (this.constellationGeometry?.segments.length ?? 0) * 3,
    );
    this.asterismPositions = new Float32Array((this.asterismGeometry?.segments.length ?? 0) * 3);
  }

  private prepareSatelliteBuffers(): void {
    const count = this.records.length;
    this.satellitePositions = new Float32Array(count * 3);
    this.satelliteSizesScratch = new Float32Array(count);
    this.satelliteColorsScratch = new Float32Array(count * 3);
    this.satelliteBaseSizes = new Float32Array(count);
    this.satelliteBaseColors = new Float32Array(count * 3);

    this.records.forEach((record, index) => {
      const isStation = record.groups.includes('stations');
      const isVisual = record.groups.includes('visual');
      // Starlink is a dense layer: keep those points small and dim so the sky
      // stays readable when thousands are enabled.
      const isStarlink = record.groups.length === 1 && record.groups[0] === 'starlink';
      this.satelliteBaseSizes[index] = isStation ? 9.5 : isVisual ? 7.5 : isStarlink ? 5.2 : 6.4;
      const rgb = hexToRgb(satelliteColor(record.groups));
      const dim = isStarlink ? 0.78 : 1;
      this.satelliteBaseColors[index * 3] = rgb[0] * dim;
      this.satelliteBaseColors[index * 3 + 1] = rgb[1] * dim;
      this.satelliteBaseColors[index * 3 + 2] = rgb[2] * dim;
    });
  }

  private createLayers(): void {
    this.renderer = new SkyRenderer(this.options.skyCanvas, {
      stars: Math.max(1000, this.skyData?.stars.count ?? 6000),
      constellationVertices: Math.max(512, (this.constellationGeometry?.segments.length ?? 0) * 2),
      asterismVertices: Math.max(512, (this.asterismGeometry?.segments.length ?? 0) * 2),
      satellites: Math.max(256, this.records.length, MAX_SATELLITE_CAPACITY),
      trackPoints: TRACK_CAPACITY,
      bodyPathVertices: BODY_PATH_MAX_VERTICES,
    });
    this.labels = new LabelLayer(this.options.hudCanvas);
    this.applyLayers();
  }

  private observeLayout(): void {
    this.resize();
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.options.container);
  }

  private resize(): void {
    const rect = this.options.container.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = clamp(
      typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
      1,
      SKY.maxPixelRatio,
    );
    if (width === this.worldWidth && height === this.worldHeight && dpr === this.dpr) return;
    this.worldWidth = width;
    this.worldHeight = height;
    this.dpr = dpr;
    this.renderer?.resize(width, height, dpr);
    this.labels?.resize(width, height, dpr);
  }

  private createSatelliteWorker(): void {
    if (typeof Worker === 'undefined') return;
    try {
      this.worker = new Worker(new URL('../satellites/worker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker.onmessage = (event: MessageEvent<WorkerOutMessage>) => {
        const message = event.data;
        if (message.type === 'positions') {
          this.satelliteStates = message.states;
          this.satelliteComputeMs = message.computeMs;
          this.updateSatelliteGeometry();
          this.astroDirty = true;
        } else if (message.type === 'error') {
          console.warn('[satellite worker]', message.message);
        }
      };
      this.configureWorker();
    } catch (error) {
      console.warn('[engine] satellite worker unavailable', error);
      this.worker = null;
    }
  }

  private configureWorker(): void {
    if (!this.worker || !this.observer || !this.records.length) return;
    this.worker.postMessage({
      type: 'configure',
      records: this.records,
      groups: this.settings.satelliteGroups,
      observer: this.observer,
    } satisfies WorkerInMessage);
  }

  pause(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  resume(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastFrameAt = 0;
    this.rafId = requestAnimationFrame(this.loop);
  }

  dispose(): void {
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.resizeObserver?.disconnect();
    for (const detach of this.detachDom) detach();
    this.detachDom = [];
    this.worker?.terminate();
    this.worker = null;
    this.sensors.dispose();
    this.geo.stop();
    this.stopCamera();
    this.renderer?.dispose();
    this.renderer = null;
    this.labels = null;
  }

  // -------------------------------------------------------------------------
  // External control
  // -------------------------------------------------------------------------

  setSettings(next: Settings): void {
    const previous = this.settings;
    this.settings = next;
    this.sensors.setCalibration({
      headingOffsetDeg: next.headingOffsetDeg,
      pitchOffsetDeg: next.pitchOffsetDeg,
      smoothing: next.smoothing,
      manual: next.manualLook,
    });
    if (next.satelliteGroups !== previous.satelliteGroups) {
      this.worker?.postMessage({
        type: 'groups',
        groups: next.satelliteGroups,
      } satisfies WorkerInMessage);
      this.ensureOptionalGroups();
    }
    if (next.manualLook && !previous.manualLook) {
      const view = cameraAzAlt(this.currentQuaternion());
      this.manualAzDeg = view.az;
      this.manualAltDeg = clamp(view.alt, -85, 85);
      this.manualQuat = quatFromAzAlt(this.manualAzDeg, this.manualAltDeg);
    }
    if (next.cameraEnabled !== previous.cameraEnabled) void this.setCameraEnabled(next.cameraEnabled);
    if (next.fovDeg === (this.fovOverride ?? next.fovDeg)) this.fovOverride = null;
    this.applyLayers();
    this.astroDirty = true;
  }

  private applyLayers(): void {
    const layers: LayerVisibility = {
      stars: this.settings.showStars,
      constellations: this.settings.showConstellations,
      asterisms: this.settings.showAsterisms,
      satellites: this.settings.showSatellites,
      horizon: this.settings.showHorizon,
      orbits: this.settings.showOrbits,
      bodyPaths: this.settings.showBodyPaths,
    };
    this.renderer?.setLayers(layers);
  }

  setObserver(observer: Observer): void {
    this.handleObserver(observer);
  }

  private handleObserver(observer: Observer): void {
    this.observer = observer;
    this.options.events.onObserver(observer);
    this.configureWorker();
    this.astroDirty = true;
    this.trackFor = -1;
    this.pushSnapshot();
  }

  setSelection(target: TargetRef | null): void {
    const changed = this.selection?.id !== target?.id || this.selection?.kind !== target?.kind;
    this.selection = target;
    if (changed) {
      this.trackFor = -1;
      this.astroDirty = true;
      this.pushSnapshot();
    }
  }

  /** Point the manual view at a target (only meaningful in manual mode). */
  aimAt(target: TargetRef | null): void {
    const id = targetId(target);
    if (!id) return;
    const summary =
      this.targets.find((candidate) => candidate.id === id) ??
      (() => {
        const source = this.items.find((candidate) => candidate.id === id);
        return source
          ? {
              id: source.id,
              kind: source.kind,
              label: source.label,
              az: source.az,
              alt: source.alt,
              visible: source.alt > 2,
              color: source.color,
              detail: null,
            }
          : null;
      })();
    if (!summary) return;
    this.manualAzDeg = normalizeDeg(summary.az);
    this.manualAltDeg = clamp(summary.alt, -85, 85);
    this.manualQuat = quatFromAzAlt(this.manualAzDeg, this.manualAltDeg);
  }

  /** Screen rectangles that labels must not overlap (DOM buttons, sheets...). */
  setAvoidRects(rects: Array<{ x: number; y: number; w: number; h: number }>): void {
    this.avoidRects = rects;
  }

  /** Tell the HUD where the DOM chrome sits so labels never draw underneath it. */
  setInsets(topPx: number, bottomPx: number): void {
    this.topInsetPx = Math.max(0, Math.round(topPx));
    this.bottomInsetPx = Math.max(0, Math.round(bottomPx));
  }

  setManualLook(azDeg: number, altDeg: number): void {
    this.manualAzDeg = normalizeDeg(azDeg);
    this.manualAltDeg = clamp(altDeg, -85, 85);
    this.manualQuat = quatFromAzAlt(this.manualAzDeg, this.manualAltDeg);
  }

  getManualLook(): { az: number; alt: number } {
    return { az: this.manualAzDeg, alt: this.manualAltDeg };
  }

  isManualView(): boolean {
    return this.isManualLook();
  }

  async requestSensors(): Promise<SensorStatus> {
    const status = await this.sensors.enable();
    this.lastSensorStatus = status;
    this.pushSnapshot();
    return status;
  }

  /** Re-trigger the geolocation watch (e.g. after the user granted permission). */
  requestLocation(): void {
    void this.geo.start();
  }

  /** Full detail for the selected target, refreshed on demand. */
  getSelectedDetail(): SelectedDetail | null {
    const selection = this.selection;
    if (!selection) return null;
    const summary = this.summaryForTarget(selection);
    const base = {
      kind: selection.kind,
      id: selection.id,
      label: summary?.label ?? selection.id,
      az: summary?.az ?? 0,
      alt: summary?.alt ?? 0,
      visible: (summary?.alt ?? 0) > 2,
      color: summary?.color ?? '#93c5fd',
    };

    switch (selection.kind) {
      case 'satellite': {
        const norad = Number(selection.id);
        const index = this.indexByNorad.get(norad);
        if (index === undefined) return base;
        const record = this.records[index];
        const entry = this.entries[index];
        if (!record || !entry) return base;
        const state = this.satelliteStates.find((candidate) => candidate.index === index);
        let az = state?.az ?? base.az;
        let alt = state?.el ?? base.alt;
        let rangeKm = state?.rangeKm ?? Number.NaN;
        let sunlit = state?.sunlit ?? false;
        if (!state && this.observer) {
          const detail = describeSatellite(entry, new Date(this.getTimeMs()), this.observer);
          if (detail) {
            az = detail.az;
            alt = detail.el;
            rangeKm = detail.rangeKm;
            sunlit = detail.sunlit;
          }
        }
        return {
          ...base,
          label: satelliteDisplayName(record),
          az,
          alt,
          visible: alt > 2,
          norad: record.norad,
          groups: record.groups.map((group) => SATELLITE_GROUP_META[group]?.label ?? group),
          rangeKm,
          sunlit,
        };
      }
      case 'body': {
        const body = this.bodyStates.find((candidate) => candidate.id === selection.id);
        if (!body) return base;
        return {
          ...base,
          label: body.name,
          az: body.az,
          alt: body.alt,
          visible: body.alt > 2,
          bodyId: body.id,
          distanceKm: body.distanceKm,
          distanceAu: body.distanceAu,
          phaseFraction: body.phaseFraction,
          phaseAngle: body.phaseAngle,
          phaseName: body.id === 'moon' ? moonPhaseName(body.phaseAngle) : undefined,
          constellation: body.constellation,
          constellationName: body.constellationName,
          mag: body.mag,
          color: body.color,
        };
      }
      case 'star': {
        const index = Number(selection.id);
        const stars = this.skyData?.stars;
        if (!stars || !Number.isInteger(index) || index < 0 || index >= stars.count) return base;
        const name = stars.names.get(index) ?? `Star ${index}`;
        const raDeg = stars.raDeg[index]!;
        const decDeg = stars.decDeg[index]!;
        let constellation: string | undefined;
        let constellationName: string | undefined;
        try {
          const info = Constellation(raDeg / 15, decDeg);
          constellation = info.symbol;
          constellationName = info.name;
        } catch {
          /* ignore */
        }
        return {
          ...base,
          label: name,
          starIndex: index,
          starMag: stars.mag[index]!,
          raDeg,
          decDeg,
          constellation,
          constellationName,
        };
      }
      case 'constellation':
      case 'asterism': {
        const figures =
          selection.kind === 'constellation' ? this.skyData?.constellations : this.skyData?.asterisms;
        const figure = figures?.find((candidate) => candidate.id === selection.id);
        if (!figure) return base;
        const positions = selection.kind === 'constellation'
          ? this.constellationAzAlt.get(figure.id)
          : null;
        const pointCount = new Set<string>();
        let segmentCount = 0;
        for (const line of figure.lines) {
          for (const point of line) pointCount.add(`${point[0].toFixed(3)},${point[1].toFixed(3)}`);
          segmentCount += Math.max(0, line.length - 1);
        }
        return {
          ...base,
          label: figure.name,
          az: positions?.az ?? base.az,
          alt: positions?.alt ?? base.alt,
          visible: (positions?.alt ?? base.alt) > 5,
          figureId: figure.id,
          segmentCount,
          pointCount: pointCount.size,
        };
      }
      default:
        return base;
    }
  }

  getSensorStatus(): SensorStatus {
    return this.lastSensorStatus ?? this.sensors.getStatus();
  }

  recenterSensors(): void {
    this.sensors.recenter();
  }

  getRecords(): SatelliteRecord[] {
    return this.records;
  }

  getEntries(): SatelliteEntry[] {
    return this.entries;
  }

  getObserver(): Observer | null {
    return this.observer;
  }

  getTimeMs(): number {
    return Date.now() + this.settings.timeOffsetMs;
  }

  getCatalogVersion(): number {
    return this.catalogVersion;
  }

  async refreshElements(): Promise<DataStatus> {
    if (!this.catalog) {
      return { source: null, ageDays: 0, refreshing: false, message: 'No catalogue loaded' };
    }
    this.pushDataStatus({ refreshing: true });
    try {
      const live = await fetchLiveElements(this.settings.satelliteGroups);
      const merged = await applyLiveRefresh(this.catalog, live);
      this.applyCatalog(merged, 'live');
      const status: DataStatus = {
        source: 'live',
        ageDays: catalogAgeMs(merged) / 86_400_000,
        refreshing: false,
        message: live.failedGroups.length ? `Partial refresh: ${live.failedGroups.join(', ')}` : null,
      };
      this.pushDataStatus(status);
      return status;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Refresh failed';
      console.warn('[engine] TLE refresh failed', error);
      const status: DataStatus = {
        source: this.catalogSource,
        ageDays: catalogAgeMs(this.catalog) / 86_400_000,
        refreshing: false,
        message,
      };
      this.pushDataStatus(status);
      return status;
    }
  }

  private async maybeAutoRefresh(): Promise<void> {
    if (!this.catalog || !shouldAutoRefresh(this.catalog)) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    await this.refreshElements();
  }

  async setCameraEnabled(enabled: boolean): Promise<void> {
    if (!enabled) {
      this.stopCamera();
      return;
    }
    const video = this.options.video;
    if (!video || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.setCameraState('unavailable');
      return;
    }
    if (this.cameraStream) return;
    this.setCameraState('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      this.cameraStream = stream;
      video.srcObject = stream;
      video.muted = true;
      video.setAttribute('playsinline', 'true');
      await video.play();
      this.setCameraState('on');
    } catch (error) {
      console.warn('[engine] camera unavailable', error);
      this.setCameraState('denied');
    }
  }

  private stopCamera(): void {
    const video = this.options.video;
    if (this.cameraStream) {
      for (const track of this.cameraStream.getTracks()) track.stop();
      this.cameraStream = null;
    }
    if (video) video.srcObject = null;
    this.setCameraState('off');
  }

  private setCameraState(state: CameraState): void {
    if (this.cameraState === state) return;
    this.cameraState = state;
    this.options.events.onCameraChange(state);
  }

  // -------------------------------------------------------------------------
  // Frame loop
  // -------------------------------------------------------------------------

  private readonly loop = (timestamp: number): void => {
    if (!this.running || this.disposed) return;
    if (!this.lastFrameAt) this.lastFrameAt = timestamp;
    const delta = timestamp - this.lastFrameAt;
    this.lastFrameAt = timestamp;
    if (delta > 0 && delta < 1000) {
      const instant = 1000 / delta;
      this.fps = this.fps ? this.fps * 0.9 + instant * 0.1 : instant;
    }

    const nowMs = this.getTimeMs();
    const view = this.buildView();
    const gaze = cameraAzAlt(view.quat);
    this.headingDeg = gaze.az;
    this.altitudeDeg = gaze.alt;

    if (this.astroDirty || nowMs - this.lastAstroAt > ASTRO_INTERVAL_MS) {
      this.updateAstro(nowMs);
      this.lastAstroAt = nowMs;
      this.astroDirty = false;
    }

    const satelliteInterval =
      this.records.length > LARGE_CATALOG_THRESHOLD ? LARGE_CATALOG_INTERVAL_MS : SATELLITE_INTERVAL_MS;
    if (nowMs - this.lastSatelliteAt > satelliteInterval) {
      this.lastSatelliteAt = nowMs;
      this.tickSatellites(nowMs);
    }

    this.renderer?.render(view);
    this.drawHud(view);

    if (Date.now() - this.lastSnapshotAt > SNAPSHOT_INTERVAL_MS) {
      this.lastSnapshotAt = Date.now();
      this.pushSnapshot();
    }

    this.rafId = requestAnimationFrame(this.loop);
  };

  private currentQuaternion(): Quat {
    const sensorQuat = this.settings.manualLook ? null : this.sensors.getQuaternion();
    return sensorQuat ?? this.manualQuat;
  }

  private buildView(): CameraView {
    return {
      quat: this.currentQuaternion(),
      fovYDeg: this.fovOverride ?? this.settings.fovDeg,
      width: this.worldWidth,
      height: this.worldHeight,
    };
  }

  private tickSatellites(nowMs: number): void {
    if (!this.worker || !this.observer) return;
    this.worker.postMessage({ type: 'tick', timeMs: nowMs } satisfies WorkerInMessage);
  }

  /** Main-thread fallback when Workers are unavailable. */
  private computeSatellitesOnMainThread(nowMs: number): void {
    if (!this.observer) return;
    const states: SatelliteSkyState[] = [];
    for (const entry of this.entries) {
      if (!entry.valid) continue;
      if (!entry.record.groups.some((group) => this.settings.satelliteGroups.includes(group))) continue;
      const detail = describeSatellite(entry, new Date(nowMs), this.observer);
      if (!detail || detail.el < -1) continue;
      states.push({
        index: entry.index,
        az: detail.az,
        el: detail.el,
        rangeKm: detail.rangeKm,
        sunlit: detail.sunlit,
      });
    }
    this.satelliteStates = states;
    this.updateSatelliteGeometry();
  }

  // -------------------------------------------------------------------------
  // Astronomy updates
  // -------------------------------------------------------------------------

  private updateAstro(nowMs: number): void {
    const observer = this.observer;
    if (!observer) {
      this.items = [];
      return;
    }
    const date = new Date(nowMs);
    this.bodyStates = computeSolarBodies(date, observer);
    const rotation = computeSkyRotation(date, observer.lat, observer.lon);
    this.astroRotation = rotation.j2000ToWorld;

    if (!this.worker) this.computeSatellitesOnMainThread(nowMs);

    this.updateStars(rotation.j2000ToWorld);
    this.updateLineGeometry(
      this.constellationGeometry,
      this.constellationPositions,
      rotation.j2000ToWorld,
      true,
    );
    this.updateLineGeometry(
      this.asterismGeometry,
      this.asterismPositions,
      rotation.j2000ToWorld,
      false,
    );
    this.renderer?.updateConstellationLines(this.constellationPositions, this.constellationVertices);
    this.renderer?.updateAsterismLines(this.asterismPositions, this.asterismVertices);
    this.updateBodyPaths(date, rotation);

    this.buildBodies();
    this.buildItems(nowMs);
    this.updateTrack(nowMs);
  }

  /**
   * Draw each planet's apparent path against the stars for the next year.
   *
   * Samples are recomputed only when the time/observer bucket changes (they
   * drift by well under a degree per bucket); the projection onto the current
   * sky rotation runs every astronomy tick so the lines stay glued to the stars
   * while the night rotates.
   */
  private updateBodyPaths(date: Date, rotation: SkyRotation): void {
    const observer = this.observer;
    if (!this.settings.showBodyPaths || !observer) {
      if (this.bodyPathVertexCount !== 0) {
        this.bodyPathVertexCount = 0;
        this.renderer?.updateBodyPaths(null, null, 0);
      }
      return;
    }

    const key = `${Math.floor(date.getTime() / BODY_PATH_BUCKET_MS)}|${observer.lat.toFixed(2)}|${observer.lon.toFixed(2)}`;
    if (!this.bodyPathCache || this.bodyPathCache.key !== key) {
      this.bodyPathCache = { key, paths: computeBodyPaths(date, observer) };
    }

    const selectedBody =
      this.selection && this.selection.kind === 'body' ? (this.selection.id as SolarBodyId) : null;
    const matrix = eqdToWorldMatrix(rotation.localSiderealHours, observer.lat);
    this.bodyPathVertexCount =
      writeBodyPathGeometry(
        this.bodyPathCache.paths,
        matrix,
        {
          selectedBody,
          skyRadius: SKY_RADIUS,
          maxVertices: BODY_PATH_MAX_VERTICES,
          dim: 0.85,
          bright: 1.7,
        },
        this.bodyPathPositions,
        this.bodyPathColors,
      ) || 0;
    this.renderer?.updateBodyPaths(
      this.bodyPathPositions,
      this.bodyPathColors,
      this.bodyPathVertexCount,
    );
  }

  private updateStars(matrix: Matrix3): void {
    const positions = this.starPositionsScratch;
    const outSizes = this.starSizesScratch;
    const outColors = this.starColorsScratch;
    const magLimit = this.settings.starMagLimit;
    const count = this.starMag.length;
    let out = 0;

    for (let i = 0; i < count; i++) {
      if (this.starMag[i]! > magLimit) continue;
      const x = this.starEqj[i * 3]!;
      const y = this.starEqj[i * 3 + 1]!;
      const z = this.starEqj[i * 3 + 2]!;
      const wx = matrix[0]! * x + matrix[1]! * y + matrix[2]! * z;
      const wy = matrix[3]! * x + matrix[4]! * y + matrix[5]! * z;
      const wz = matrix[6]! * x + matrix[7]! * y + matrix[8]! * z;
      if (wy < -0.035) continue; // the ground hides stars below the horizon

      applyRefractionVector(wx, wy, wz, scratchVec);
      positions[out * 3] = scratchVec.x * SKY_RADIUS;
      positions[out * 3 + 1] = scratchVec.y * SKY_RADIUS;
      positions[out * 3 + 2] = scratchVec.z * SKY_RADIUS;
      outSizes[out] = this.starSizes[i]!;
      outColors[out * 3] = this.starColors[i * 3]!;
      outColors[out * 3 + 1] = this.starColors[i * 3 + 1]!;
      outColors[out * 3 + 2] = this.starColors[i * 3 + 2]!;
      out++;
    }

    this.renderer?.updateStars(positions, outSizes, outColors, out);
  }

  private updateLineGeometry(
    geometry: ReturnType<typeof flattenFigures> | null,
    target: Float32Array,
    matrix: Matrix3,
    isConstellation: boolean,
  ): void {
    let vertices = 0;
    if (geometry) {
      const { points, segments } = geometry;
      for (let s = 0; s < segments.length && (vertices + 2) * 3 <= target.length; s += 2) {
        const a = segments[s]!;
        const b = segments[s + 1]!;
        // Read both endpoints out before writing: eqjToWorldRefracted reuses a
        // shared scratch array, so aliasing p1/p2 would collapse every segment.
        const p1 = eqjToWorldRefracted(matrix, points[a * 2]!, points[a * 2 + 1]!);
        const p1x = p1[0];
        const p1y = p1[1];
        const p1z = p1[2];
        const p2 = eqjToWorldRefracted(matrix, points[b * 2]!, points[b * 2 + 1]!);
        if (p1y < -0.03 || p2[1] < -0.03) continue;
        target[vertices * 3] = p1x * SKY_RADIUS;
        target[vertices * 3 + 1] = p1y * SKY_RADIUS;
        target[vertices * 3 + 2] = p1z * SKY_RADIUS;
        vertices++;
        target[vertices * 3] = p2[0] * SKY_RADIUS;
        target[vertices * 3 + 1] = p2[1] * SKY_RADIUS;
        target[vertices * 3 + 2] = p2[2] * SKY_RADIUS;
        vertices++;
      }
    }
    if (isConstellation) this.constellationVertices = vertices;
    else this.asterismVertices = vertices;
  }

  // -------------------------------------------------------------------------
  // Bodies, labels and targets
  // -------------------------------------------------------------------------

  private buildBodies(): void {
    this.bodies = this.bodyStates.map((body) => ({
      id: body.id,
      name: body.name,
      az: body.az,
      alt: body.alt,
      color: body.color,
      angularRadiusDeg: body.id === 'sun' ? 0.266 : body.id === 'moon' ? 0.259 : 0.0035,
      phaseAngle: body.phaseAngle,
      phaseFraction: body.phaseFraction,
      waxing: body.waxing,
    }));
  }

  private buildItems(nowMs: number): void {
    const items: LabelItem[] = [];
    const selectedId = targetId(this.selection);

    if (this.settings.showPlanets) {
    for (const body of this.bodyStates) {
      if (body.alt < -2.5) continue;
      const isMajor = body.id === 'sun' || body.id === 'moon';
      items.push({
        id: `body:${body.id}`,
        kind: 'body',
        label: body.name,
        az: body.az,
        alt: body.alt,
        priority: isMajor ? 130 : 100,
        color: body.color,
        selected: selectedId === `body:${body.id}`,
      });
    }
    }

    const matrix = this.astroRotation;
    if (this.skyData && matrix) {
      const stars = this.skyData.stars;
      for (let i = 0; this.settings.showStars && i < stars.count; i++) {
        const name = this.starNames.get(i);
        if (!name) continue;
        const mag = stars.mag[i]!;
        if (mag > 3.9) continue;
        const world = eqjToWorldRefracted(matrix, stars.raDeg[i]!, stars.decDeg[i]!);
        if (world[1] < 0.05) continue;
        items.push({
          id: `star:${i}`,
          kind: 'star',
          label: name,
          az: normalizeDeg(Math.atan2(world[0], -world[2]) * RAD2DEG),
          alt: Math.asin(clamp(world[1], -1, 1)) * RAD2DEG,
          priority: 40 - mag * 5,
          color: '#cbd5e1',
          selected: selectedId === `star:${i}`,
        });
      }

      this.constellationAzAlt.clear();
      for (const figure of this.skyData.constellations) {
        const world = eqjToWorldRefracted(matrix, figure.labelRa, figure.labelDec);
        const alt = Math.asin(clamp(world[1], -1, 1)) * RAD2DEG;
        const az = normalizeDeg(Math.atan2(world[0], -world[2]) * RAD2DEG);
        this.constellationAzAlt.set(figure.id, { az, alt });
        if (alt < 4) continue;
        items.push({
          id: `con:${figure.id}`,
          kind: 'constellation',
          label: figure.name,
          az,
          alt,
          priority: 8,
          color: '#93c5fd',
          selected: selectedId === `con:${figure.id}`,
        });
      }

      if (this.settings.showAsterisms) {
        for (const figure of this.skyData.asterisms) {
          if (figure.labelRa === null || figure.labelDec === null) continue;
          const world = eqjToWorldRefracted(matrix, figure.labelRa, figure.labelDec);
          const alt = Math.asin(clamp(world[1], -1, 1)) * RAD2DEG;
          if (alt < 4) continue;
          items.push({
            id: `ast:${figure.id}`,
            kind: 'asterism',
            label: figure.name,
            az: normalizeDeg(Math.atan2(world[0], -world[2]) * RAD2DEG),
            alt,
            priority: 7,
            color: '#c4b5fd',
            selected: selectedId === `ast:${figure.id}`,
          });
        }
      }
    }

    if (this.settings.showSatellites) {
    for (const state of this.satelliteStates) {
      const record = this.records[state.index];
      if (!record || state.el < 5) continue;
      const isSelected = selectedId === `sat:${record.norad}`;
      // Starlink is a dense layer (hundreds above the horizon): labelling every
      // object would bury the sky under pills. Label only the selected one.
      const isStarlink = record.groups.length === 1 && record.groups[0] === 'starlink';
      items.push({
        id: `sat:${record.norad}`,
        kind: 'satellite',
        // Hundreds of Starlink objects are above the horizon at once: keep them
        // tappable markers, not labelled pills (the selected one is labelled).
        label: isStarlink && !isSelected ? '' : satelliteDisplayName(record),
        unlabeled: isStarlink && !isSelected,
        az: state.az,
        alt: state.el,
        priority: isStarlink && !isSelected ? 5 : state.el > 20 ? 70 : 55,
        color: satelliteColor(record.groups),
        selected: isSelected,
      });
    }
    }

    if (selectedId) {
      const existing = items.find((item) => item.id === selectedId);
      if (existing) {
        existing.priority = 1000;
        existing.selected = true;
      } else {
        const summary = this.summaryForTarget(this.selection);
        if (summary) {
          items.push({
            id: summary.id,
            kind: summary.kind,
            label: summary.label,
            az: summary.az,
            alt: summary.alt,
            priority: 1000,
            color: summary.color,
            selected: true,
          });
        }
      }
    }

    this.items = items;
    this.buildTargets(nowMs);
  }

  private buildTargets(nowMs: number): void {
    const list: TargetSummary[] = [];

    for (const quick of QUICK_BODY_TARGETS) {
      const body = this.bodyStates.find((candidate) => candidate.id === quick.id);
      if (!body) continue;
      list.push({
        id: `body:${body.id}`,
        kind: 'body',
        label: body.name || quick.label,
        az: body.az,
        alt: body.alt,
        visible: body.alt > 2,
        color: body.color,
        detail: `${body.alt.toFixed(0)}° up`,
      });
    }

    for (const quick of QUICK_SATELLITES) {
      const index = this.indexByNorad.get(quick.norad);
      if (index === undefined) continue;
      const record = this.records[index];
      if (!record) continue;
      const state = this.satelliteStates.find((candidate) => candidate.index === index);
      if (state) {
        list.push({
          id: `sat:${record.norad}`,
          kind: 'satellite',
          label: quick.label,
          az: state.az,
          alt: state.el,
          visible: state.el > 5,
          color: satelliteColor(record.groups),
          detail: `${state.el.toFixed(0)}° up`,
        });
      } else if (this.observer && this.entries[index]) {
        const detail = describeSatellite(this.entries[index]!, new Date(nowMs), this.observer);
        if (detail) {
          list.push({
            id: `sat:${record.norad}`,
            kind: 'satellite',
            label: quick.label,
            az: detail.az,
            alt: detail.el,
            visible: false,
            color: satelliteColor(record.groups),
            detail: 'below horizon',
          });
        }
      }
    }

    for (const quick of QUICK_CONSTELLATIONS) {
      const position = this.constellationAzAlt.get(quick.id);
      if (!position) continue;
      list.push({
        id: `con:${quick.id}`,
        kind: 'constellation',
        label: quick.label,
        az: position.az,
        alt: position.alt,
        visible: position.alt > 5,
        color: '#93c5fd',
        detail: `${position.alt.toFixed(0)}° up`,
      });
    }

    this.targets = list;
  }

  private summaryForTarget(target: TargetRef | null): TargetSummary | null {
    if (!target) return null;
    const id = targetId(target);
    if (!id) return null;
    const item = this.items.find((candidate) => candidate.id === id);
    if (item) {
      return {
        id: item.id,
        kind: item.kind,
        label: item.label,
        az: item.az,
        alt: item.alt,
        visible: item.alt > 2,
        color: item.color,
        detail: null,
      };
    }
    return this.targets.find((candidate) => candidate.id === id) ?? null;
  }

  // -------------------------------------------------------------------------
  // Satellites rendering + track
  // -------------------------------------------------------------------------

  private updateSatelliteGeometry(): void {
    if (!this.renderer) return;
    const positions = this.satellitePositions;
    const sizes = this.satelliteSizesScratch;
    const colors = this.satelliteColorsScratch;
    let out = 0;

    for (const state of this.satelliteStates) {
      const index = state.index;
      if (!this.records[index]) continue;
      const azRad = (state.az * Math.PI) / 180;
      const altRad = (state.el * Math.PI) / 180;
      const cosAlt = Math.cos(altRad);
      positions[out * 3] = cosAlt * Math.sin(azRad) * SKY_RADIUS;
      positions[out * 3 + 1] = Math.sin(altRad) * SKY_RADIUS;
      positions[out * 3 + 2] = -cosAlt * Math.cos(azRad) * SKY_RADIUS;
      const dim = state.sunlit ? 1 : 0.45;
      sizes[out] = this.satelliteBaseSizes[index] ?? 6.4;
      colors[out * 3] = (this.satelliteBaseColors[index * 3] ?? 1) * dim;
      colors[out * 3 + 1] = (this.satelliteBaseColors[index * 3 + 1] ?? 1) * dim;
      colors[out * 3 + 2] = (this.satelliteBaseColors[index * 3 + 2] ?? 1) * dim;
      out++;
    }
    this.renderer.updateSatellites(positions, sizes, colors, out);
  }

  private updateTrack(nowMs: number): void {
    const selection = this.selection;
    if (
      !selection ||
      selection.kind !== 'satellite' ||
      !this.observer ||
      !this.settings.showOrbits
    ) {
      this.renderer?.updateTrack(null, 0);
      this.trackFor = -1;
      return;
    }
    const index = this.indexByNorad.get(Number(selection.id));
    if (index === undefined) return;
    if (this.trackFor === index && nowMs - this.trackUpdatedAt < TRACK_INTERVAL_MS) return;
    const entry = this.entries[index];
    if (!entry) return;

    const points = sampleSkyTrack(entry, nowMs, this.observer, {
      beforeMinutes: TRACK_BEFORE_MINUTES,
      afterMinutes: TRACK_AFTER_MINUTES,
      stepSeconds: 20,
    });
    if (!points.length) {
      this.renderer?.updateTrack(null, 0);
    } else {
      const count = Math.min(points.length, TRACK_CAPACITY);
      for (let i = 0; i < count; i++) {
        const point = points[i]!;
        const azRad = (point.az * Math.PI) / 180;
        const altRad = (point.el * Math.PI) / 180;
        const cosAlt = Math.cos(altRad);
        this.trackPositions[i * 3] = cosAlt * Math.sin(azRad) * SKY_RADIUS;
        this.trackPositions[i * 3 + 1] = Math.sin(altRad) * SKY_RADIUS;
        this.trackPositions[i * 3 + 2] = -cosAlt * Math.cos(azRad) * SKY_RADIUS;
      }
      this.renderer?.updateTrack(this.trackPositions, count);
    }
    this.trackFor = index;
    this.trackUpdatedAt = nowMs;
  }

  // -------------------------------------------------------------------------
  // HUD, snapshots, data status
  // -------------------------------------------------------------------------

  private drawHud(view: CameraView): void {
    if (!this.labels) return;
    const frame: LabelFrame = {
      view,
      items: this.items,
      // Bodies below the horizon are hidden by the ground, exactly like stars.
      bodies: this.settings.showPlanets ? this.bodies.filter((body) => body.alt > -1.2) : [],
      selectedId: targetId(this.selection),
      headingDeg: this.headingDeg,
      altitudeDeg: this.altitudeDeg,
      showHorizon: this.settings.showHorizon,
      showLabels: this.settings.showLabels,
      fps: this.settings.showFps ? this.fps : null,
      topInset: this.topInsetPx,
      bottomInset: this.bottomInsetPx,
      maxLabels: SKY.maxLabels,
      selectedHint: this.selectedHint(),
      avoidRects: this.avoidRects,
    };
    this.labels.draw(frame);
  }

  private selectedHint(): string | null {
    const summary = this.summaryForTarget(this.selection);
    if (!summary) return null;
    if (summary.kind === 'satellite') {
      return `${summary.label} · ${summary.alt >= 0 ? `${summary.alt.toFixed(0)}° up` : 'below horizon'}`;
    }
    return summary.label;
  }

  private pushSnapshot(): void {
    if (this.disposed) return;
    const sensor = this.sensors.getStatus();
    this.lastSensorStatus = sensor;
    const geoStatus = this.geo.getStatus();
    const ageDays = this.catalog ? catalogAgeMs(this.catalog) / 86_400_000 : 0;
    this.options.events.onSnapshot({
      fps: this.fps,
      sensor,
      locationPhase: geoStatus.phase,
      accuracyM: geoStatus.accuracyM ?? this.observer?.accuracyM ?? null,
      satelliteCount: this.records.length,
      visibleSatellites: this.satelliteStates.length,
      targets: this.targets,
      selected: this.summaryForTarget(this.selection),
      timeMs: this.getTimeMs(),
      dataAgeDays: ageDays,
      catalogSource: this.catalogSource,
      catalogVersion: this.catalogVersion,
      camera: this.cameraState,
      skyDataReady: this.skyData !== null,
      skyError: this.skyError,
      satelliteComputeMs: this.satelliteComputeMs,
      headingDeg: this.headingDeg,
      altitudeDeg: this.altitudeDeg,
      manualLook: this.settings.manualLook || sensor.orientation === 'unavailable',
      darkness: darknessLevel(this.bodyStates),
    });
  }

  private pushDataStatus(overrides: Partial<DataStatus> = {}): void {
    this.options.events.onDataStatus({
      source: this.catalogSource,
      ageDays: this.catalog ? catalogAgeMs(this.catalog) / 86_400_000 : 0,
      refreshing: false,
      message: null,
      ...overrides,
    });
  }

  // -------------------------------------------------------------------------
  // Pointer interaction
  // -------------------------------------------------------------------------

  private attachPointerHandlers(): void {
    // The HUD canvas is the topmost canvas and covers the viewport; UI controls
    // are separate DOM above it, so taps on empty sky land here.
    const container = this.options.hudCanvas;

    const onDown = (event: PointerEvent) => {
      if (this.pointers.size >= 2) return;
      this.pointers.set(event.pointerId, {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        startTime: performance.now(),
        moved: false,
      });
      if (this.pointers.size === 2) {
        const values = [...this.pointers.values()];
        const a = values[0]!;
        const b = values[1]!;
        this.pinchStartDistance = Math.hypot(a.lastX - b.lastX, a.lastY - b.lastY);
        this.pinchStartFov = this.fovOverride ?? this.settings.fovDeg;
      }
      try {
        container.setPointerCapture(event.pointerId);
      } catch {
        /* not all environments support capture */
      }
    };

    const onMove = (event: PointerEvent) => {
      const state = this.pointers.get(event.pointerId);
      if (!state) return;
      const dx = event.clientX - state.lastX;
      const dy = event.clientY - state.lastY;
      if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) > 8) {
        state.moved = true;
      }
      state.lastX = event.clientX;
      state.lastY = event.clientY;

      if (this.pointers.size === 2) {
        const values = [...this.pointers.values()];
        const a = values[0]!;
        const b = values[1]!;
        if (this.pinchStartDistance > 10) {
          const distance = Math.hypot(a.lastX - b.lastX, a.lastY - b.lastY);
          const fov = clamp(
            this.pinchStartFov / (distance / this.pinchStartDistance),
            SKY.minFovDeg,
            SKY.maxFovDeg,
          );
          this.fovOverride = fov;
          this.options.events.onFovChange(fov);
        }
        return;
      }

      if (this.isManualLook()) {
        const degreesPerPixel = (this.fovOverride ?? this.settings.fovDeg) / this.worldHeight;
        this.manualAzDeg = normalizeDeg(this.manualAzDeg - dx * degreesPerPixel);
        this.manualAltDeg = clamp(this.manualAltDeg + dy * degreesPerPixel, -85, 85);
        this.manualQuat = quatFromAzAlt(this.manualAzDeg, this.manualAltDeg);
        this.trackFor = -1;
      }
    };

    const onUp = (event: PointerEvent) => {
      const state = this.pointers.get(event.pointerId);
      this.pointers.delete(event.pointerId);
      if (this.pointers.size < 2) this.pinchStartDistance = 0;
      if (!state) return;
      const duration = performance.now() - state.startTime;
      if (!state.moved && duration < 450) this.handleTap(event.clientX, event.clientY);
    };

    const onCancel = (event: PointerEvent) => {
      this.pointers.delete(event.pointerId);
      if (this.pointers.size < 2) this.pinchStartDistance = 0;
    };

    container.addEventListener('pointerdown', onDown);
    container.addEventListener('pointermove', onMove);
    container.addEventListener('pointerup', onUp);
    container.addEventListener('pointercancel', onCancel);
    this.detachDom.push(
      () => container.removeEventListener('pointerdown', onDown),
      () => container.removeEventListener('pointermove', onMove),
      () => container.removeEventListener('pointerup', onUp),
      () => container.removeEventListener('pointercancel', onCancel),
    );
  }

  private isManualLook(): boolean {
    return this.settings.manualLook || this.sensors.getQuaternion() === null;
  }

  private handleTap(x: number, y: number): void {
    const hit = this.labels?.hitTest(x, y, 16) ?? null;
    this.options.events.onSelectionRequest(hit ? parseTargetId(hit.id) : null);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export { parseTargetId, targetId } from './targets';

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const expanded =
    value.length === 3
      ? value
          .split('')
          .map((char) => char + char)
          .join('')
      : value;
  const parsed = Number.parseInt(expanded, 16);
  if (!Number.isFinite(parsed)) return [1, 1, 1];
  return [((parsed >> 16) & 255) / 255, ((parsed >> 8) & 255) / 255, (parsed & 255) / 255];
}

/**
 * EQJ RA/Dec (degrees) → world direction, with refraction, written into a
 * reusable 3-array. Hot path: called for every constellation vertex each tick.
 */
const eqjScratch: [number, number, number] = [0, 0, 0];
function eqjToWorldRefracted(matrix: Matrix3, raDeg: number, decDeg: number): [number, number, number] {
  const ra = (raDeg * Math.PI) / 180;
  const dec = (decDeg * Math.PI) / 180;
  const cosDec = Math.cos(dec);
  const ex = cosDec * Math.cos(ra);
  const ey = cosDec * Math.sin(ra);
  const ez = Math.sin(dec);
  const wx = matrix[0]! * ex + matrix[1]! * ey + matrix[2]! * ez;
  const wy = matrix[3]! * ex + matrix[4]! * ey + matrix[5]! * ez;
  const wz = matrix[6]! * ex + matrix[7]! * ey + matrix[8]! * ez;
  applyRefractionVector(wx, wy, wz, scratchVec);
  eqjScratch[0] = scratchVec.x;
  eqjScratch[1] = scratchVec.y;
  eqjScratch[2] = scratchVec.z;
  return eqjScratch;
}
