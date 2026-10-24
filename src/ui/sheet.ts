/** Высоты шторки: свёрнута 168 (внутри 120–212), половина с верхом 380, полная с верхом 64. */
export function snapSheet(height: number, viewport: number): number {
  const collapsed = 168;
  const half = Math.max(collapsed, viewport - 380);
  const full = Math.max(half, viewport - 64);
  const options = [collapsed, half, full];
  return options.reduce((best, item) => (Math.abs(item - height) < Math.abs(best - height) ? item : best), collapsed);
}

export function clampSheet(height: number, viewport: number): number {
  return Math.min(Math.max(120, height), Math.max(120, viewport - 64));
}
