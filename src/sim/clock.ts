/** 1× = 2 дня симуляции в секунду. 3× и 8× — те же правила, больше дней за кадр. */
export const SPEED_PER_SECOND = { 1: 2, 2: 6, 3: 16 } as const;
export type SpeedId = keyof typeof SPEED_PER_SECOND;

export interface Clock {
  accumulator: number;
  paused: boolean;
  speed: SpeedId;
}

export function createClock(): Clock {
  return { accumulator: 0, paused: true, speed: 1 };
}

/**
 * Возвращает, сколько полных дней выполнить.
 * Остаток секунд сохраняется, поэтому редкие кадры не выбрасывают и не дублируют дни.
 */
export function takeTicks(clock: Clock, dtSeconds: number, maxSteps: number): number {
  if (clock.paused || dtSeconds <= 0) {
    if (clock.paused) clock.accumulator = 0;
    return 0;
  }
  clock.accumulator += dtSeconds * SPEED_PER_SECOND[clock.speed];
  let steps = 0;
  const limit = Math.max(0, maxSteps);
  while (clock.accumulator >= 1 && steps < limit) {
    clock.accumulator -= 1;
    steps += 1;
  }
  return steps;
}
