/** Colour helpers shared by the renderer and the astronomy layers. */

/** `#rrggbb` → three 0–1 channel values. Falls back to white for bad input. */
export function hexToRgbUnit(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  if (value.length !== 6) return [1, 1, 1];
  const int = Number.parseInt(value, 16);
  if (!Number.isFinite(int)) return [1, 1, 1];
  return [((int >> 16) & 0xff) / 255, ((int >> 8) & 0xff) / 255, (int & 0xff) / 255];
}
