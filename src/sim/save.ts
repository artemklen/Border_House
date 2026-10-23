import type { SimState } from "./types";

export class SaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaveError";
  }
}

/** Совместима только версия 1. Чужая или битая запись не подменяет текущую партию: вызывающий код обязан оставить прежнее состояние, если метод бросил SaveError. */
export function serialize(state: SimState): string {
  return JSON.stringify({ version: 1, state });
}

export function deserialize(raw: string): SimState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SaveError("Файл сохранения повреждён: это не JSON.");
  }
  if (!parsed || typeof parsed !== "object") throw new SaveError("Файл сохранения повреждён.");
  const file = parsed as { version?: unknown; state?: SimState };
  if (file.version !== 1) throw new SaveError("Несовместимая версия сохранения. Эта сборка читает только версию 1.");
  const state = file.state;
  if (!state || !Array.isArray(state.worlds) || !Array.isArray(state.houses) || typeof state.tick !== "number" || typeof state.rngState !== "number") {
    throw new SaveError("Файл сохранения повреждён: нет состояния симуляции.");
  }
  return state;
}
