/** mulberry32. Состояние — один uint32, его достаточно сохранить. */
export function nextUnit(state: number): { state: number; value: number } {
  let next = (state + 0x6d2b79f5) >>> 0;
  if (next === 0) next = 0x6d2b79f5;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { state: next, value };
}

export function rollInt(state: number, maxExclusive: number): { state: number; value: number } {
  const rolled = nextUnit(state);
  return { state: rolled.state, value: Math.floor(rolled.value * maxExclusive) };
}

export function normalizeSeed(seed: number): number {
  const normalized = seed >>> 0;
  return normalized === 0 ? 1 : normalized;
}
