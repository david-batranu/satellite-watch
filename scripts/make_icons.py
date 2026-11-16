#!/usr/bin/env python3
"""Satellite Watch — PWA icon generator (Pillow).

Renders the icon set for the "Satellite Watch" AR sky app: a deep-navy radial
night sky, a tilted cyan orbit with a small satellite riding above it.

Everything is drawn at 4x the target resolution and downsampled with
``Image.LANCZOS`` so the marks stay crisp at 192 px and legible at 32 px.
The output is deterministic, so re-running the script is safe.

Usage (from the repository root)::

    python3 scripts/make_icons.py
    # or: npm run icons

Writes::

    public/icons/icon-192.png        any purpose
    public/icons/icon-512.png        any purpose
    public/icons/maskable-512.png    maskable (opaque, artwork inside 72% zone)
    public/icons/apple-touch-180.png apple touch icon (opaque)
    public/favicon.svg               compact hand-written SVG mark

Requires Pillow (the DSH bundled interpreter has it):

    /Users/david/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3

Design notes
------------
* The background is the same radial gradient as the app boot splash
  (``#0d1c30`` at 50%/38% -> ``#05070d`` at the 62% stop), so the icon and the
  splash feel like one family.
* The satellite glyph is ~45% of the canvas width for the "any" icons.
  Foreground artwork (orbit, satellite, orbit dot) stays inside the central 80%
  (about 78% of the canvas diameter at full scale, glow included), and the
  maskable variant is scaled to 0.90 so that all of it fits inside the central
  72% safe zone (measured ~70% of the diameter).
* The maskable icon has an opaque full-bleed background (no transparency).
* No text is used anywhere.
"""

from __future__ import annotations

import math
import random
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:  # pragma: no cover - environment problem, not a code path
    raise SystemExit(
        "Pillow is required to render the icons. On this machine run the script with "
        "the bundled interpreter:\n"
        "  /Users/david/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3 "
        "scripts/make_icons.py"
    ) from None

# ---------------------------------------------------------------------------
# Output locations and render settings
# ---------------------------------------------------------------------------

SUPERSAMPLE = 4  # draw at 4x, then LANCZOS-downsample

ROOT = Path(__file__).resolve().parent.parent
ICONS_DIR = ROOT / "public" / "icons"
FAVICON_PATH = ROOT / "public" / "favicon.svg"

# ---------------------------------------------------------------------------
# Palette
# ---------------------------------------------------------------------------

NAVY_CENTER = (13, 28, 48)  # #0d1c30
NAVY_EDGE = (5, 7, 13)  # #05070d
CYAN = (103, 232, 249)  # #67e8f9
STAR = (203, 213, 225)  # #cbd5e1
SATELLITE = (226, 232, 240)  # #e2e8f0
BODY_TOP = (242, 247, 252)  # lit top edge of the satellite bus
BODY_BOTTOM = (197, 209, 224)  # shaded underside
PANEL_CELL = (30, 58, 95)  # #1e3a5f
PANEL_BASE = (10, 21, 35)  # backing between cells
CELL_EDGE = (63, 136, 164)  # cyan blended over the cell fill
ANTENNA_CORE = (240, 253, 255)  # near-white centre of the orbit dot

# Background gradient: centre and stop position, mirroring the boot splash CSS
# radial-gradient(circle at 50% 38%, #0d1c30 0%, #05070d 62%).
GRADIENT_CENTER = (0.50, 0.38)
GRADIENT_STOP = 0.62

# ---------------------------------------------------------------------------
# Geometry, expressed as fractions of the canvas (design space)
# ---------------------------------------------------------------------------

# Orbit (an arc of a tilted ellipse; the satellite sits in front of it).
ORBIT_RX = 0.355
ORBIT_RY = 0.075
ORBIT_CY = 0.035  # ellipse centre sits slightly below the icon centre
ORBIT_TILT = -20.0  # degrees, screen space
ORBIT_STROKE = 0.024  # ~2.5% of the canvas width
ORBIT_START = 200.0  # arc sweep in ellipse-local degrees
ORBIT_END = 340.0
ORBIT_DOT = 305.0  # bright dot rides the visible part of the arc
DOT_R = 0.019

# Satellite glyph.
BODY_HALF_W = 0.075
BODY_HALF_H = 0.059
BODY_RADIUS = 0.020
PANEL_CENTER_X = 0.1615
PANEL_HALF_W = 0.0575  # panel spans x = 0.104 .. 0.219
PANEL_HALF_H = 0.043
PANEL_RADIUS = 0.012
PANEL_OUTLINE = 0.0045
PANEL_INSET = 0.008  # cell field inset from the panel edge
CELL_GAP = 0.0045
CELL_OUTLINE = 0.0022
CELL_COLS = 3
CELL_ROWS = 2
STRUT_WIDTH = 0.013
ANTENNA_BASE = (-0.016, -BODY_HALF_H + 0.004)
ANTENNA_TIP = (-0.043, -0.116)
ANTENNA_WIDTH = 0.0075
ANTENNA_DOT_R = 0.009

# Star field ("a few tiny star dots", 20-45% opacity, clear of the glyph).
STAR_COUNT = 18
STAR_SEED = 0x5A7E11
STAR_EXCLUSION = (0.27, 0.20)  # half-extents of the keep-clear rectangle
STAR_RADIUS = (0.0035, 0.0075)
STAR_ALPHA = (0.20, 0.45)

# Glow sizes (fractions of the respective stroke radius).
ORBIT_GLOW_WIDTH = 2.4
ORBIT_GLOW_ALPHA = 60
ORBIT_GLOW_BLUR = 0.9  # multiplied by the orbit stroke width
DOT_GLOW_WIDTH = 2.6
DOT_GLOW_ALPHA = 120
DOT_GLOW_BLUR = 1.1  # multiplied by the orbit dot radius
DOT_GLOW_MARGIN = DOT_GLOW_WIDTH + DOT_GLOW_BLUR

# Maskable artwork is scaled down so the whole foreground fits the 72% zone.
MASKABLE_SCALE = 0.90
SAFE_ZONE_STANDARD = 0.40  # radius of the central 80% (canvas fractions)
SAFE_ZONE_MASKABLE = 0.36  # radius of the central 72% (canvas fractions)

# In-memory cache for the gradient master (kept across renders).
_GRADIENT_MASTER: Image.Image | None = None


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _mix(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    """Linearly blend two RGB triplets; ``t`` is clamped to 0..1."""
    t = min(1.0, max(0.0, t))
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))  # type: ignore[return-value]


def _rgba(color: tuple[int, int, int], alpha: int = 255) -> tuple[int, int, int, int]:
    return (color[0], color[1], color[2], int(alpha))


def _px(value: float) -> int:
    """Round a pixel width/radius to a positive int (ImageDraw wants ints)."""
    return max(1, int(round(value)))


def _rotate(x: float, y: float, degrees: float) -> tuple[float, float]:
    """Rotate a screen-space point around the origin (y grows downwards)."""
    r = math.radians(degrees)
    cos_r, sin_r = math.cos(r), math.sin(r)
    return x * cos_r - y * sin_r, x * sin_r + y * cos_r


def _new_layer(size: int) -> Image.Image:
    return Image.new("RGBA", (size, size), (0, 0, 0, 0))


# ---------------------------------------------------------------------------
# Background — radial navy gradient matching the boot splash
# ---------------------------------------------------------------------------


def _gradient_master() -> Image.Image:
    """Build the radial gradient once at 512 px and reuse it for every icon."""
    global _GRADIENT_MASTER
    if _GRADIENT_MASTER is not None:
        return _GRADIENT_MASTER

    size = 512
    cx, cy = GRADIENT_CENTER
    # CSS `circle` gradients default to the farthest corner; the 62% colour stop
    # therefore sits at 62% of that radius.
    farthest = math.hypot(max(cx, 1.0 - cx), max(cy, 1.0 - cy))
    stop = GRADIENT_STOP * farthest

    img = Image.new("RGB", (size, size))
    pixels = img.load()
    for y in range(size):
        ny = (y + 0.5) / size - cy
        for x in range(size):
            nx = (x + 0.5) / size - cx
            pixels[x, y] = _mix(NAVY_CENTER, NAVY_EDGE, math.hypot(nx, ny) / stop)

    _GRADIENT_MASTER = img
    return img


def _background(size: int) -> Image.Image:
    """Opaque full-bleed navy radial gradient at the supersampled size."""
    return _gradient_master().resize((size, size), Image.LANCZOS).convert("RGBA")


# ---------------------------------------------------------------------------
# Star field
# ---------------------------------------------------------------------------


def _star_specs() -> tuple[tuple[float, float, float, float], ...]:
    """Deterministic scatter, kept away from the glyph and the icon edges."""
    rnd = random.Random(STAR_SEED)
    ex, ey = STAR_EXCLUSION
    stars: list[tuple[float, float, float, float]] = []
    while len(stars) < STAR_COUNT:
        x = rnd.uniform(0.055, 0.945)
        y = rnd.uniform(0.055, 0.945)
        if abs(x - 0.5) < ex and abs(y - 0.5) < ey:
            continue  # never over the satellite glyph
        radius = rnd.uniform(*STAR_RADIUS)
        alpha = rnd.uniform(*STAR_ALPHA)
        stars.append((x, y, radius, alpha))
    return tuple(stars)


_STARS = _star_specs()


def _star_layer(size: int) -> Image.Image:
    """Tiny star dots, lightly softened so LANCZOS keeps them round and quiet."""
    layer = _new_layer(size)
    draw = ImageDraw.Draw(layer)
    for x, y, radius, alpha in _STARS:
        px, py = x * size, y * size
        r = radius * size
        draw.ellipse([px - r, py - r, px + r, py + r], fill=_rgba(STAR, 255 * alpha))
    return layer.filter(ImageFilter.GaussianBlur(size * 0.00045))


# ---------------------------------------------------------------------------
# Orbit arc, dot and their glows
# ---------------------------------------------------------------------------


def _orbit_points_fraction(scale: float, steps: int = 240) -> list[tuple[float, float]]:
    """Arc points relative to the canvas centre, in canvas fractions."""
    points: list[tuple[float, float]] = []
    for i in range(steps + 1):
        t = math.radians(ORBIT_START + (ORBIT_END - ORBIT_START) * i / steps)
        x = ORBIT_RX * math.cos(t)
        y = ORBIT_CY + ORBIT_RY * math.sin(t)
        x, y = _rotate(x, y, ORBIT_TILT)
        points.append((x * scale, y * scale))
    return points


def _orbit_points_px(size: int, scale: float) -> tuple[list[tuple[float, float]], float]:
    half = size / 2.0
    points = [(half + x * size, half + y * size) for x, y in _orbit_points_fraction(scale)]
    return points, ORBIT_STROKE * size * scale


def _orbit_dot_px(size: int, scale: float) -> tuple[float, float]:
    x, y = _orbit_dot_fraction(scale)
    return size / 2.0 + x * size, size / 2.0 + y * size


def _orbit_dot_fraction(scale: float) -> tuple[float, float]:
    t = math.radians(ORBIT_DOT)
    x = ORBIT_RX * math.cos(t)
    y = ORBIT_CY + ORBIT_RY * math.sin(t)
    x, y = _rotate(x, y, ORBIT_TILT)
    return x * scale, y * scale


def _ribbon_polygon(
    points: list[tuple[float, float]], width: float
) -> list[tuple[float, float]]:
    """Build a filled outline for a thick stroke of constant width.

    ``ImageDraw.line`` bevels/beads on tightly curved polylines, so the orbit is
    drawn as an explicitly offset ribbon instead: offset every sample along the
    curve normal, then close the polygon with round caps.
    """
    half = width / 2.0
    normals: list[tuple[float, float]] = []
    count = len(points)
    for i in range(count):
        if i == 0:
            dx = points[1][0] - points[0][0]
            dy = points[1][1] - points[0][1]
        elif i == count - 1:
            dx = points[-1][0] - points[-2][0]
            dy = points[-1][1] - points[-2][1]
        else:
            dx = points[i + 1][0] - points[i - 1][0]
            dy = points[i + 1][1] - points[i - 1][1]
        length = math.hypot(dx, dy) or 1.0
        normals.append((-dy / length, dx / length))

    outer = [(x + nx * half, y + ny * half) for (x, y), (nx, ny) in zip(points, normals)]
    inner = [(x - nx * half, y - ny * half) for (x, y), (nx, ny) in zip(points, normals)]
    return outer + inner[::-1]


def _draw_thick_arc(
    layer: Image.Image,
    points: list[tuple[float, float]],
    width: float,
    fill: tuple[int, int, int, int],
) -> None:
    draw = ImageDraw.Draw(layer)
    draw.polygon(_ribbon_polygon(points, width), fill=fill)
    radius = width / 2.0
    for x, y in (points[0], points[-1]):
        draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=fill)


def _draw_orbit(layer: Image.Image, size: int, scale: float) -> None:
    points, width = _orbit_points_px(size, scale)
    _draw_thick_arc(layer, points, width, _rgba(CYAN))


def _orbit_glow(size: int, scale: float) -> Image.Image:
    layer = _new_layer(size)
    points, width = _orbit_points_px(size, scale)
    _draw_thick_arc(layer, points, width * ORBIT_GLOW_WIDTH, _rgba(CYAN, ORBIT_GLOW_ALPHA))
    return layer.filter(ImageFilter.GaussianBlur(width * ORBIT_GLOW_BLUR))


def _glow_points(size: int, scale: float) -> Image.Image:
    """Soft halos for the orbit dot and the antenna tip."""
    layer = _new_layer(size)
    draw = ImageDraw.Draw(layer)
    dot_x, dot_y = _orbit_dot_px(size, scale)
    dot_r = DOT_R * size * scale
    glow_r = dot_r * DOT_GLOW_WIDTH
    draw.ellipse(
        [dot_x - glow_r, dot_y - glow_r, dot_x + glow_r, dot_y + glow_r],
        fill=_rgba(CYAN, DOT_GLOW_ALPHA),
    )

    half = size / 2.0
    tip_x = half + ANTENNA_TIP[0] * size * scale
    tip_y = half + ANTENNA_TIP[1] * size * scale
    tip_r = ANTENNA_DOT_R * size * scale * DOT_GLOW_WIDTH
    draw.ellipse(
        [tip_x - tip_r, tip_y - tip_r, tip_x + tip_r, tip_y + tip_r],
        fill=_rgba(CYAN, DOT_GLOW_ALPHA // 2),
    )
    return layer.filter(ImageFilter.GaussianBlur(dot_r * DOT_GLOW_BLUR))


def _draw_orbit_dot(layer: Image.Image, size: int, scale: float) -> None:
    draw = ImageDraw.Draw(layer)
    x, y = _orbit_dot_px(size, scale)
    r = DOT_R * size * scale
    draw.ellipse([x - r, y - r, x + r, y + r], fill=_rgba(CYAN))
    core = r * 0.42
    draw.ellipse([x - core, y - core, x + core, y + core], fill=_rgba(ANTENNA_CORE))


# ---------------------------------------------------------------------------
# Satellite glyph
# ---------------------------------------------------------------------------


def _draw_satellite(layer: Image.Image, size: int, scale: float) -> None:
    draw = ImageDraw.Draw(layer)
    half = size / 2.0
    unit = size * scale  # pixel value of one design-space unit

    def s(v: float) -> float:
        """Design-space fraction -> supersampled pixel coordinate."""
        return half + v * unit

    def line_width(v: float) -> int:
        return _px(v * unit)

    # Struts connect the body to both solar-panel wings.
    for side in (-1, 1):
        x0 = s(side * (BODY_HALF_W - 0.005))
        x1 = s(side * (PANEL_CENTER_X - PANEL_HALF_W - 0.006))
        draw.line([(x0, half), (x1, half)], fill=_rgba(CYAN), width=line_width(STRUT_WIDTH))

    # Solar panels: dark-blue cells with thin cyan outlines on a dark backing.
    for side in (-1, 1):
        left = s(side * (PANEL_CENTER_X - PANEL_HALF_W))
        right = s(side * (PANEL_CENTER_X + PANEL_HALF_W))
        x0, x1 = sorted((left, right))
        y0, y1 = s(-PANEL_HALF_H), s(PANEL_HALF_H)
        draw.rounded_rectangle(
            [x0, y0, x1, y1],
            radius=_px(PANEL_RADIUS * unit),
            fill=_rgba(PANEL_BASE),
            outline=_rgba(CYAN),
            width=line_width(PANEL_OUTLINE),
        )

        # Cell field, centred inside the panel outline.
        panel_centre = side * PANEL_CENTER_X
        inner_w = PANEL_HALF_W - PANEL_INSET
        inner_h = PANEL_HALF_H - PANEL_INSET
        cell_w = (2.0 * inner_w - (CELL_COLS - 1) * CELL_GAP) / CELL_COLS
        cell_h = (2.0 * inner_h - (CELL_ROWS - 1) * CELL_GAP) / CELL_ROWS
        cell_radius = _px(0.0035 * unit)
        for row in range(CELL_ROWS):
            for col in range(CELL_COLS):
                cx0 = panel_centre - inner_w + col * (cell_w + CELL_GAP)
                cy0 = -inner_h + row * (cell_h + CELL_GAP)
                draw.rounded_rectangle(
                    [s(cx0), s(cy0), s(cx0 + cell_w), s(cy0 + cell_h)],
                    radius=cell_radius,
                    fill=_rgba(PANEL_CELL),
                    outline=_rgba(CELL_EDGE),
                    width=_px(CELL_OUTLINE * unit),
                )

    # Antenna: one thin cyan whip with a small dot, leaning left off the body.
    base_x, base_y = s(ANTENNA_BASE[0]), s(ANTENNA_BASE[1])
    tip_x, tip_y = s(ANTENNA_TIP[0]), s(ANTENNA_TIP[1])
    draw.line([(base_x, base_y), (tip_x, tip_y)], fill=_rgba(CYAN), width=line_width(ANTENNA_WIDTH))
    tip_r = ANTENNA_DOT_R * unit
    draw.ellipse([tip_x - tip_r, tip_y - tip_r, tip_x + tip_r, tip_y + tip_r], fill=_rgba(CYAN))


def _body_layer(size: int, scale: float) -> Image.Image:
    """White-ish satellite bus with a subtle top-lit gradient.

    The body is its own layer so the gradient keeps full RGB values right up to
    the anti-aliased edge (no dark fringe when it is composited over the orbit).
    """
    unit = size * scale
    half = size / 2.0
    x0, x1 = half - BODY_HALF_W * unit, half + BODY_HALF_W * unit
    y0, y1 = half - BODY_HALF_H * unit, half + BODY_HALF_H * unit

    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [x0, y0, x1, y1], radius=_px(BODY_RADIUS * unit), fill=255
    )

    span = max(1.0, y1 - y0)
    strip = Image.new("RGB", (1, size))
    for py in range(size):
        t = min(1.0, max(0.0, (py - y0) / span))
        if t < 0.5:
            strip.putpixel((0, py), _mix(BODY_TOP, SATELLITE, t * 2.0))
        else:
            strip.putpixel((0, py), _mix(SATELLITE, BODY_BOTTOM, (t - 0.5) * 2.0))

    body = strip.resize((size, size), Image.NEAREST).convert("RGBA")
    body.putalpha(mask)
    return body


# ---------------------------------------------------------------------------
# Compositing
# ---------------------------------------------------------------------------


def _render(size_px: int, scale: float = 1.0) -> Image.Image:
    """Render one opaque icon at ``size_px`` using 4x supersampling."""
    size = size_px * SUPERSAMPLE

    layers: list[Image.Image] = [_background(size)]

    layers.append(_star_layer(size))

    layers.append(_orbit_glow(size, scale))

    artwork = _new_layer(size)
    _draw_orbit(artwork, size, scale)
    _draw_satellite(artwork, size, scale)
    layers.append(artwork)

    # The body covers the orbit and the inner ends of the struts/antenna.
    layers.append(_body_layer(size, scale))

    layers.append(_glow_points(size, scale))

    dot = _new_layer(size)
    _draw_orbit_dot(dot, size, scale)
    layers.append(dot)

    image = layers[0]
    for layer in layers[1:]:
        image = Image.alpha_composite(image, layer)
    return image.resize((size_px, size_px), Image.LANCZOS)


def foreground_extent(scale: float) -> float:
    """Max radius (canvas fractions) reached by the foreground artwork + glow.

    Used to prove the maskable mark sits inside the central 72% safe zone.
    """
    orbit_radius = max(math.hypot(x, y) for x, y in _orbit_points_fraction(scale))
    orbit_halo = ORBIT_STROKE * scale * (ORBIT_GLOW_WIDTH / 2.0 + ORBIT_GLOW_BLUR)

    dot_radius = math.hypot(*_orbit_dot_fraction(scale))
    dot_halo = DOT_R * scale * DOT_GLOW_MARGIN

    antenna_radius = math.hypot(*ANTENNA_TIP) * scale
    antenna_halo = ANTENNA_DOT_R * scale * (DOT_GLOW_WIDTH + DOT_GLOW_BLUR)

    panel_corner = math.hypot(
        PANEL_CENTER_X + PANEL_HALF_W + PANEL_OUTLINE, PANEL_HALF_H + PANEL_OUTLINE
    )
    body_corner = math.hypot(BODY_HALF_W, BODY_HALF_H)

    return max(
        orbit_radius + orbit_halo,
        dot_radius + dot_halo,
        antenna_radius + antenna_halo,
        (panel_corner * scale),
        (body_corner * scale),
    )


# ---------------------------------------------------------------------------
# Favicon (hand-written compact SVG, same visual language)
# ---------------------------------------------------------------------------

FAVICON_SVG = """\
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Satellite Watch">
  <defs>
    <radialGradient id="bg" cx="50%" cy="38%" r="80%">
      <stop offset="0" stop-color="#0d1c30"/>
      <stop offset=".62" stop-color="#05070d"/>
    </radialGradient>
  </defs>
  <rect width="32" height="32" rx="7" fill="url(#bg)"/>
  <ellipse cx="16" cy="15.9" rx="10.6" ry="2.2" transform="rotate(-20 16 15.9)" fill="none" stroke="#67e8f9" stroke-width="1.3"/>
  <circle cx="21.1" cy="12.13" r="1.2" fill="#67e8f9"/>
  <path d="M12.15 15.9H13.2M18.8 15.9H19.85" stroke="#67e8f9" stroke-width=".8"/>
  <g fill="#1e3a5f" stroke="#67e8f9" stroke-width=".65">
    <rect x="8.35" y="14.1" width="3.8" height="3.6" rx=".6"/>
    <rect x="19.85" y="14.1" width="3.8" height="3.6" rx=".6"/>
  </g>
  <path d="M10.25 14.6v2.6M21.85 14.6v2.6" stroke="#67e8f9" stroke-width=".4" opacity=".5"/>
  <path d="M14.65 13.05 13.35 11.25" stroke="#67e8f9" stroke-width=".9" stroke-linecap="round"/>
  <circle cx="13.35" cy="11.25" r=".8" fill="#67e8f9"/>
  <rect x="13.2" y="13" width="5.6" height="5.8" rx="1.25" fill="#e2e8f0"/>
  <circle cx="6.2" cy="8.6" r=".3" fill="#cbd5e1" opacity=".34"/>
  <circle cx="25.5" cy="21.4" r=".26" fill="#cbd5e1" opacity=".3"/>
</svg>
"""


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    FAVICON_PATH.parent.mkdir(parents=True, exist_ok=True)

    # Fail loudly if the design ever drifts out of the safe zones.
    standard_extent = foreground_extent(1.0)
    maskable_extent = foreground_extent(MASKABLE_SCALE)
    if standard_extent > SAFE_ZONE_STANDARD:
        raise SystemExit(
            f"foreground artwork leaves the 80% zone: {standard_extent:.3f} > {SAFE_ZONE_STANDARD}"
        )
    if maskable_extent > SAFE_ZONE_MASKABLE:
        raise SystemExit(
            "foreground artwork leaves the 72% safe zone: "
            f"{maskable_extent:.3f} > {SAFE_ZONE_MASKABLE}"
        )

    targets = [
        ("icon-192.png", 192, 1.0),
        ("icon-512.png", 512, 1.0),
        ("maskable-512.png", 512, MASKABLE_SCALE),
        ("apple-touch-180.png", 180, 1.0),
    ]

    generated: list[Path] = []
    for name, size, scale in targets:
        path = ICONS_DIR / name
        image = _render(size, scale)
        if image.mode != "RGB":
            image = image.convert("RGB")  # every icon is fully opaque
        if name == "maskable-512.png":
            # Maskable icons must be fully opaque edge to edge.
            alpha = image.convert("RGBA").getextrema()[3]
            if alpha != (255, 255):
                raise SystemExit(f"maskable icon has transparency: alpha range {alpha}")
        image.save(path, format="PNG", optimize=True)
        generated.append(path)

    FAVICON_PATH.write_text(FAVICON_SVG, encoding="utf-8")
    generated.append(FAVICON_PATH)

    print(f"standard foreground radius: {standard_extent:.3f} (80% zone limit 0.400)")
    print(f"maskable foreground radius: {maskable_extent:.3f} (72% zone limit 0.360)")
    for path in generated:
        rel = path.relative_to(ROOT)
        if path.suffix == ".png":
            with Image.open(path) as image:
                width, height = image.size
                mode = image.mode
            print(f"generated {rel}  ({width}x{height} {mode}, {path.stat().st_size} bytes)")
        else:
            print(f"generated {rel}  ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
