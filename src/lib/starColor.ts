/**
 * Star colour from the Johnson B−V colour index.
 *
 * B−V maps to effective temperature (Ballesteros 2012) and temperature to a
 * displayable sRGB colour (Tanner Helland's approximation). We deliberately
 * saturate the result a little: a physically correct blackbody ramp looks washed
 * out on a phone screen, while real observers see blue-white Rigel against
 * orange Betelgeuse very clearly.
 */

function temperatureFromBv(bv: number): number {
  const b = Math.max(-0.4, Math.min(2.4, bv));
  const t = 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
  return Math.max(1800, Math.min(40000, t));
}

/** Approximate sRGB for a blackbody temperature in kelvin, components 0..1. */
function blackbodyRgb(kelvin: number): [number, number, number] {
  const t = kelvin / 100;
  let r: number;
  let g: number;
  let b: number;

  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }

  const clamp255 = (v: number) => Math.max(0, Math.min(255, v)) / 255;
  return [clamp255(r), clamp255(g), clamp255(b)];
}

/** Star colour for a B−V index, as linear-ish 0..1 RGB suitable for additive blending. */
export function bvToRgb(bv: number): [number, number, number] {
  const [r, g, b] = blackbodyRgb(temperatureFromBv(bv));
  // Lift the floor so even the coolest stars stay visible against a dark sky.
  const lift = (v: number) => 0.62 + 0.38 * v;
  return [lift(r), lift(g), lift(b)];
}

/** CSS colour for a B−V index. */
export function bvToCss(bv: number): string {
  const [r, g, b] = bvToRgb(bv);
  const to255 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgb(${to255(r)}, ${to255(g)}, ${to255(b)})`;
}

/**
 * Marker radius in CSS pixels for a star or satellite of a given magnitude.
 * Magnitude is logarithmic, so a linear-in-flux rule must be compressed.
 */
export function sizeForMagnitude(mag: number, options: { base: number; min: number; max: number }): number {
  const { base, min, max } = options;
  const size = base * Math.pow(10, -0.16 * (mag - 1));
  return Math.max(min, Math.min(max, size));
}
