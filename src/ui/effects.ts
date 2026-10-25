export interface MapEffect {
  id: number;
  kind: "popup" | "arrive" | "stuck";
  x: number;
  y: number;
  text: string;
  born: number;
  life: number;
}

let sequence = 1;

export function makeEffect(kind: MapEffect["kind"], x: number, y: number, text: string, life: number, now = performance.now()): MapEffect {
  sequence += 1;
  return { id: sequence, kind, x, y, text, born: now, life };
}

export function liveEffects(effects: MapEffect[], now: number): MapEffect[] {
  return effects.filter((effect) => now - effect.born < effect.life);
}

export function motionMs(name: string, fallback: number): number {
  if (typeof document === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
