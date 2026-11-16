/**
 * 2D HUD layer drawn on a transparent canvas above the WebGL sky.
 *
 * Canvas2D is the right tool here: crisp text at any DPR, cheap collision
 * avoidance for labels, and full control over the heading ribbon, the reticle
 * and the off-screen target arrow. Only ~30 labels are drawn per frame, so this
 * costs far less than a DOM overlay would.
 */

import { angularRadiusToPixels, edgeAnchor, edgeDirection, pixelDistance, projectAzAlt, type CameraView } from './projection';
import type { SolarBodyId, TargetKind } from '../types';

export interface LabelItem {
  /** Stable identity: `sat:25544`, `body:jupiter`, `star:123`, `con:Ori`, `ast:BigDipper`. */
  id: string;
  kind: TargetKind;
  label: string;
  az: number;
  alt: number;
  /** Higher draws first and wins collisions. */
  priority: number;
  color: string;
  selected?: boolean;
}

export interface BodyMarker {
  id: SolarBodyId;
  name: string;
  az: number;
  alt: number;
  color: string;
  /** Apparent angular radius in degrees (used to size the disc). */
  angularRadiusDeg: number;
  /** Moon only: 0 = new, 180 = full. */
  phaseAngle: number;
  phaseFraction: number;
  waxing: boolean;
}

export interface LabelFrame {
  view: CameraView;
  items: LabelItem[];
  bodies: BodyMarker[];
  selectedId: string | null;
  /** Camera azimuth/altitude in degrees, for the reticle readout. */
  headingDeg: number;
  altitudeDeg: number;
  showHorizon: boolean;
  showLabels: boolean;
  fps: number | null;
  /** Pixels reserved at the top (status bar) and bottom (target rail). */
  topInset: number;
  bottomInset: number;
  maxLabels: number;
  selectedHint: string | null;
  /** DOM chrome rectangles that labels must not cover. */
  avoidRects?: Array<{ x: number; y: number; w: number; h: number }>;
}

interface HitTarget {
  id: string;
  kind: TargetKind;
  x: number;
  y: number;
  radius: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const LABEL_FONT = `600 11px ${FONT_STACK}`;
const LABEL_TEXT_FONT = `500 11px ${FONT_STACK}`;
const CONSTELLATION_FONT = `600 10px ${FONT_STACK}`;
const HEADING_FONT = `700 11px ${FONT_STACK}`;
const MICRO_FONT = `500 10px ${FONT_STACK}`;

const COLORS = {
  labelBg: 'rgba(4, 9, 20, 0.62)',
  labelBorder: 'rgba(148, 163, 184, 0.16)',
  labelText: 'rgba(226, 232, 240, 0.95)',
  selectedBg: 'rgba(8, 30, 48, 0.85)',
  accent: '#67e8f9',
  horizon: 'rgba(56, 189, 248, 0.28)',
  cardinal: 'rgba(148, 197, 235, 0.72)',
  ribbonBg: 'rgba(3, 7, 18, 0.36)',
  constellation: 'rgba(147, 197, 253, 0.72)',
  asterism: 'rgba(196, 181, 253, 0.72)',
};

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export class LabelLayer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private hitTargets: HitTarget[] = [];

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.canvas = canvas;
    this.ctx = ctx;
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.dpr = Math.min(Math.max(1, dpr), 2.5);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
  }

  /** Closest tappable target to a screen position, or null. */
  hitTest(x: number, y: number, tolerance = 14): HitTarget | null {
    let best: HitTarget | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const target of this.hitTargets) {
      const distance = pixelDistance({ x, y }, target);
      if (distance <= target.radius + tolerance && distance < bestDistance) {
        best = target;
        bestDistance = distance;
      }
    }
    return best;
  }

  draw(frame: LabelFrame): void {
    const ctx = this.ctx;
    const { width, height } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    this.hitTargets = [];

    if (frame.showHorizon) this.drawHorizon(frame);
    this.drawBodies(frame);
    if (frame.showLabels) this.drawLabels(frame);
    if (frame.showLabels) this.drawOffscreenArrow(frame);
    this.drawReticle(frame);
    this.drawHeadingRibbon(frame);
    if (frame.fps !== null) this.drawFps(frame);
  }

  // -------------------------------------------------------------------------
  // Horizon and cardinals
  // -------------------------------------------------------------------------

  private drawHorizon(frame: LabelFrame): void {
    const ctx = this.ctx;
    const { view } = frame;
    ctx.save();
    ctx.strokeStyle = COLORS.horizon;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 7]);
    ctx.beginPath();
    let drawing = false;
    const startAz = frame.headingDeg - 110;
    const endAz = frame.headingDeg + 110;
    for (let az = startAz; az <= endAz; az += 2.5) {
      const point = projectAzAlt(view, az, 0);
      if (!point || !point.onScreen) {
        drawing = false;
        continue;
      }
      if (!drawing) {
        ctx.moveTo(point.x, point.y);
        drawing = true;
      } else {
        ctx.lineTo(point.x, point.y);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Cardinal letters sitting on the horizon line.
    ctx.font = HEADING_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = COLORS.cardinal;
    const cardinals: Array<[number, string]> = [
      [0, 'N'],
      [90, 'E'],
      [180, 'S'],
      [270, 'W'],
    ];
    for (const [az, label] of cardinals) {
      const point = projectAzAlt(view, az, 0);
      if (!point || !point.onScreen) continue;
      ctx.fillText(label, point.x, point.y - 6);
    }
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Sun, Moon and planets
  // -------------------------------------------------------------------------

  private drawBodies(frame: LabelFrame): void {
    const ctx = this.ctx;
    const { view } = frame;
    for (const body of frame.bodies) {
      const point = projectAzAlt(view, body.az, body.alt);
      if (!point || !point.onScreen) continue;

      const isSun = body.id === 'sun';
      const isMoon = body.id === 'moon';
      const minRadius = isSun ? 10 : isMoon ? 8.5 : 4.2;
      const maxRadius = isSun ? 22 : isMoon ? 17 : 7.5;
      const radius = Math.max(
        minRadius,
        Math.min(maxRadius, angularRadiusToPixels(view, body.angularRadiusDeg)),
      );

      ctx.save();
      // Soft glow.
      const glowRadius = radius * (isSun ? 5 : isMoon ? 4 : 3.2);
      const glow = ctx.createRadialGradient(point.x, point.y, radius * 0.35, point.x, point.y, glowRadius);
      glow.addColorStop(0, this.withAlpha(body.color, isSun ? 0.5 : 0.34));
      glow.addColorStop(0.45, this.withAlpha(body.color, isSun ? 0.16 : 0.1));
      glow.addColorStop(1, this.withAlpha(body.color, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(point.x, point.y, glowRadius, 0, Math.PI * 2);
      ctx.fill();

      if (isMoon && body.phaseFraction < 0.985) {
        this.drawMoonPhase(ctx, point.x, point.y, radius, body);
      } else {
        const core = ctx.createRadialGradient(
          point.x - radius * 0.2,
          point.y - radius * 0.2,
          radius * 0.1,
          point.x,
          point.y,
          radius,
        );
        core.addColorStop(0, '#ffffff');
        core.addColorStop(0.55, this.withAlpha(body.color, 0.98));
        core.addColorStop(1, this.withAlpha(body.color, 0.75));
        ctx.fillStyle = core;
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      this.hitTargets.push({
        id: `body:${body.id}`,
        kind: 'body',
        x: point.x,
        y: point.y,
        radius: Math.max(radius, 10),
      });
    }
  }

  /**
   * Phase-correct Moon disc. The terminator is drawn as an ellipse whose
   * horizontal radius shrinks to zero at quarter phase, giving crescents and
   * gibbous shapes from the same path.
   */
  private drawMoonPhase(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    radius: number,
    body: BodyMarker,
  ): void {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.clip();

    // Dark limb.
    ctx.fillStyle = 'rgba(24, 33, 48, 0.92)';
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);

    const fraction = Math.max(0, Math.min(1, body.phaseFraction));
    const terminatorRadius = radius * Math.abs(1 - 2 * fraction);
    ctx.scale(body.waxing ? 1 : -1, 1);
    const px = body.waxing ? x : -x;

    ctx.beginPath();
    ctx.arc(px, y, radius, -Math.PI / 2, Math.PI / 2, false);
    ctx.ellipse(
      px,
      y,
      terminatorRadius,
      radius,
      0,
      Math.PI / 2,
      -Math.PI / 2,
      fraction > 0.5,
    );
    ctx.closePath();
    const lit = ctx.createRadialGradient(px - radius * 0.25, y - radius * 0.25, radius * 0.1, px, y, radius);
    lit.addColorStop(0, 'rgba(248, 250, 252, 1)');
    lit.addColorStop(0.75, 'rgba(226, 232, 240, 0.96)');
    lit.addColorStop(1, 'rgba(203, 213, 225, 0.88)');
    ctx.fillStyle = lit;
    ctx.fill();
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Labels with collision avoidance
  // -------------------------------------------------------------------------

  private drawLabels(frame: LabelFrame): void {
    const ctx = this.ctx;
    const { view } = frame;
    const sorted = [...frame.items].sort((a, b) => b.priority - a.priority);

    // Seeded with DOM chrome plus a box around the reticle so the crosshair and
    // its az/alt readout never get buried in text.
    const occupied: Box[] = [...(frame.avoidRects ?? [])];
    const centerX = this.width / 2;
    const centerY = this.height / 2;
    // The selected target's own label is allowed to sit beside the reticle: it
    // is the one label the user is actively looking for. Everything else must
    // stay out of this box.
    const centerBox: Box = { x: centerX - 58, y: centerY - 42, w: 116, h: 86 };
    // Keep labels clear of the heading ribbon and the bottom target rail.
    const minY = frame.topInset + 34;
    const maxY = this.height - frame.bottomInset - 4;
    let drawn = 0;

    for (const item of sorted) {
      if (drawn >= frame.maxLabels) break;
      const point = projectAzAlt(view, item.az, item.alt);
      if (!point || !point.onScreen) continue;

      const isConstellation = item.kind === 'constellation' || item.kind === 'asterism';
      const font = isConstellation ? CONSTELLATION_FONT : item.selected ? LABEL_FONT : LABEL_TEXT_FONT;

      ctx.save();
      ctx.font = font;
      let text = item.label;
      const textWidth = ctx.measureText(text).width;
      let pillWidth = textWidth + 16;
      if (pillWidth > 150) {
        // Truncate long satellite names.
        while (pillWidth > 150 && text.length > 4) {
          text = `${text.slice(0, -2)}…`;
          pillWidth = ctx.measureText(text).width + 16;
        }
      }
      ctx.restore();

      const pillHeight = isConstellation ? 16 : 20;
      const candidates: Box[] = [];
      const gapX = 12;
      const gapY = 9;
      // Right of the marker, then left, then below, then above.
      const rightX = point.x + gapX;
      const leftX = point.x - gapX - pillWidth;
      candidates.push({ x: rightX, y: point.y - pillHeight / 2, w: pillWidth, h: pillHeight });
      candidates.push({ x: leftX, y: point.y - pillHeight / 2, w: pillWidth, h: pillHeight });
      candidates.push({ x: point.x - pillWidth / 2, y: point.y + gapY, w: pillWidth, h: pillHeight });
      candidates.push({ x: point.x - pillWidth / 2, y: point.y - gapY - pillHeight, w: pillWidth, h: pillHeight });

      let placed: Box | null = null;
      const isSelected = item.selected === true;
      for (const candidate of candidates) {
        if (candidate.x < 6 || candidate.x + candidate.w > this.width - 6) continue;
        if (candidate.y < minY || candidate.y + candidate.h > maxY) continue;
        if (!isSelected && overlaps(centerBox, candidate)) continue;
        if (occupied.some((box) => overlaps(box, candidate))) continue;
        placed = candidate;
        break;
      }
      if (!placed) continue;

      occupied.push(placed);
      drawn++;
      this.hitTargets.push({
        id: item.id,
        kind: item.kind,
        x: placed.x + placed.w / 2,
        y: placed.y + placed.h / 2,
        radius: Math.min(placed.w, placed.h) / 2,
      });
      // Marker itself is tappable too.
      this.hitTargets.push({ id: item.id, kind: item.kind, x: point.x, y: point.y, radius: 12 });

      ctx.save();
      if (isConstellation) {
        ctx.font = CONSTELLATION_FONT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = item.kind === 'asterism' ? COLORS.asterism : COLORS.constellation;
        ctx.shadowColor = 'rgba(2, 6, 23, 0.85)';
        ctx.shadowBlur = 4;
        ctx.fillText(text, placed.x + 6, placed.y + placed.h / 2);
        ctx.restore();
        continue;
      }

      roundRect(ctx, placed.x, placed.y, placed.w, placed.h, 7);
      ctx.fillStyle = isSelected ? COLORS.selectedBg : COLORS.labelBg;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = isSelected ? COLORS.accent : COLORS.labelBorder;
      ctx.stroke();

      // Coloured dot for the object type.
      ctx.beginPath();
      ctx.arc(placed.x + 8, placed.y + placed.h / 2, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = item.color;
      ctx.fill();

      ctx.font = isSelected ? LABEL_FONT : LABEL_TEXT_FONT;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = isSelected ? '#f0fdff' : COLORS.labelText;
      ctx.fillText(text, placed.x + 15, placed.y + placed.h / 2 + 0.5);
      ctx.restore();
    }
  }

  // -------------------------------------------------------------------------
  // Selected target: ring, or off-screen arrow
  // -------------------------------------------------------------------------

  private drawOffscreenArrow(frame: LabelFrame): void {
    const id = frame.selectedId;
    if (!id) return;
    const item = frame.items.find((candidate) => candidate.id === id);
    if (!item) return;
    const point = projectAzAlt(frame.view, item.az, item.alt);
    if (point && point.onScreen) {
      this.drawSelectionRing(point.x, point.y, item.color);
      return;
    }

    const ctx = this.ctx;
    const direction = edgeDirection(frame.view, {
      x: Math.cos((item.alt * Math.PI) / 180) * Math.sin((item.az * Math.PI) / 180),
      y: Math.sin((item.alt * Math.PI) / 180),
      z: -Math.cos((item.alt * Math.PI) / 180) * Math.cos((item.az * Math.PI) / 180),
    });
    const anchor = edgeAnchor(frame.view, direction, 46);
    const angle = Math.atan2(direction.y, direction.x);
    const hint = frame.selectedHint ?? item.label;

    ctx.save();
    ctx.translate(anchor.x, anchor.y);

    // Arrow head.
    ctx.save();
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(16, 0);
    ctx.lineTo(-6, -9);
    ctx.lineTo(-6, 9);
    ctx.closePath();
    ctx.fillStyle = COLORS.accent;
    ctx.shadowColor = 'rgba(103, 232, 249, 0.6)';
    ctx.shadowBlur = 10;
    ctx.fill();
    ctx.restore();

    // Label pill, positioned away from the screen edge.
    ctx.font = LABEL_FONT;
    const text = direction.behind ? `${hint} · behind you` : hint;
    const width = Math.min(210, ctx.measureText(text).width + 22);
    const rawX = anchor.x - width / 2 - direction.x * 34;
    const pillX = Math.min(Math.max(rawX, 8 - anchor.x), this.width - width - 8 - anchor.x);
    const pillY = -22 - direction.y * 20;
    roundRect(ctx, pillX, pillY, width, 22, 11);
    ctx.fillStyle = 'rgba(4, 12, 24, 0.86)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(103, 232, 249, 0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#e0fbff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let labelText = text;
    while (ctx.measureText(labelText).width > width - 16 && labelText.length > 6) {
      labelText = `${labelText.slice(0, -2)}…`;
    }
    ctx.fillText(labelText, pillX + width / 2, pillY + 11.5);
    ctx.restore();
  }

  private drawSelectionRing(x: number, y: number, color: string): void {
    const ctx = this.ctx;
    const pulse = (Math.sin(performance.now() / 320) + 1) / 2;
    ctx.save();
    ctx.strokeStyle = this.withAlpha(color, 0.9);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(x, y, 13 + pulse * 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = COLORS.accent;
    ctx.globalAlpha = 0.35 + pulse * 0.25;
    ctx.beginPath();
    ctx.arc(x, y, 20 + pulse * 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Reticle, heading ribbon, FPS
  // -------------------------------------------------------------------------

  private drawReticle(frame: LabelFrame): void {
    const ctx = this.ctx;
    const cx = this.width / 2;
    const cy = this.height / 2;
    ctx.save();
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.32)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, 15, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 24, cy);
    ctx.lineTo(cx - 19, cy);
    ctx.moveTo(cx + 19, cy);
    ctx.lineTo(cx + 24, cy);
    ctx.moveTo(cx, cy - 24);
    ctx.lineTo(cx, cy - 19);
    ctx.moveTo(cx, cy + 19);
    ctx.lineTo(cx, cy + 24);
    ctx.stroke();

    // Live az/alt under the reticle.
    const az = Math.round(frame.headingDeg);
    const alt = Math.round(frame.altitudeDeg);
    const text = `${String(az).padStart(3, '0')}°  ${alt >= 0 ? '+' : ''}${alt}°`;
    ctx.font = MICRO_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.72)';
    ctx.fillText(text, cx, cy + 28);
    ctx.restore();
  }

  private drawHeadingRibbon(frame: LabelFrame): void {
    const ctx = this.ctx;
    const top = frame.topInset;
    const height = 24;
    const pixelsPerDegree = 4.2;
    const cx = this.width / 2;

    ctx.save();
    // Ribbon backdrop with soft edges.
    const backdrop = ctx.createLinearGradient(0, 0, this.width, 0);
    backdrop.addColorStop(0, 'rgba(3, 7, 18, 0)');
    backdrop.addColorStop(0.18, COLORS.ribbonBg);
    backdrop.addColorStop(0.82, COLORS.ribbonBg);
    backdrop.addColorStop(1, 'rgba(3, 7, 18, 0)');
    ctx.fillStyle = backdrop;
    ctx.fillRect(0, top, this.width, height);

    ctx.beginPath();
    ctx.rect(0, top, this.width, height);
    ctx.clip();

    const heading = frame.headingDeg;
    const halfSpan = cx / pixelsPerDegree + 6;
    const start = Math.floor(heading - halfSpan);
    const end = Math.ceil(heading + halfSpan);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let az = start; az <= end; az++) {
      if (az % 5 !== 0) continue;
      const x = cx + (az - heading) * pixelsPerDegree;
      if (x < -20 || x > this.width + 20) continue;
      const normalized = ((az % 360) + 360) % 360;
      const isMajor = normalized % 30 === 0;
      const isCardinal = normalized % 90 === 0;

      ctx.strokeStyle = isCardinal
        ? 'rgba(186, 230, 253, 0.55)'
        : isMajor
          ? 'rgba(148, 197, 235, 0.32)'
          : 'rgba(148, 163, 184, 0.18)';
      ctx.lineWidth = isCardinal ? 1.4 : 1;
      const tickHeight = isCardinal ? 9 : isMajor ? 6 : 3.5;
      ctx.beginPath();
      ctx.moveTo(x, top + height - tickHeight);
      ctx.lineTo(x, top + height);
      ctx.stroke();

      if (isMajor) {
        const label =
          normalized === 0
            ? 'N'
            : normalized === 90
              ? 'E'
              : normalized === 180
                ? 'S'
                : normalized === 270
                  ? 'W'
                  : `${normalized}`;
        ctx.font = isCardinal ? HEADING_FONT : MICRO_FONT;
        ctx.fillStyle = isCardinal ? 'rgba(224, 251, 255, 0.95)' : 'rgba(148, 163, 184, 0.72)';
        ctx.fillText(label, x, top + 8);
      }
    }

    // Centre marker.
    ctx.fillStyle = COLORS.accent;
    ctx.beginPath();
    ctx.moveTo(cx, top + height - 1);
    ctx.lineTo(cx - 4, top + height + 4);
    ctx.lineTo(cx + 4, top + height + 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawFps(frame: LabelFrame): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = MICRO_FONT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.8)';
    ctx.fillText(`${frame.fps?.toFixed(0) ?? 0} fps`, this.width - 10, frame.topInset + 30);
    ctx.restore();
  }

  private withAlpha(color: string, alpha: number): string {
    if (color.startsWith('#')) {
      const hex = color.slice(1);
      const bigint = Number.parseInt(hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex, 16);
      const r = (bigint >> 16) & 255;
      const g = (bigint >> 8) & 255;
      const b = bigint & 255;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    return color;
  }
}
