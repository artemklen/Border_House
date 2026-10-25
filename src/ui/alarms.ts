export type AlarmLevel = "ok" | "low" | "critical";

/** Запас хода казны: норма дольше окна, мало 8–24 дн., критично ≤ 7 дн. Поток ≥ 0 не даёт «критично». */
export function treasuryRaw(runway: number | null, free: number, burn: number, flow: number): AlarmLevel {
  if (runway == null || burn <= 0) return "ok";
  let level: AlarmLevel = "ok";
  if (runway <= 7 || free < burn) level = "critical";
  else if (runway <= 24) level = "low";
  if (flow >= 0 && level === "critical") level = "low";
  return level;
}

/** Еда столицы: норма ≥ 10 дн., мало 4–9, критично ≤ 3. */
export function foodRaw(days: number): AlarmLevel {
  if (days <= 3) return "critical";
  if (days <= 9) return "low";
  return "ok";
}

/**
 * Ухудшение сразу. Улучшение — с гистерезисом:
 * казна выходит из «критично» при ≥ 10 дн. и в норму при ≥ 27;
 * еда — при ≥ 6 и ≥ 12.
 */
export function holdAlarm(kind: "treasury" | "food", previous: AlarmLevel, raw: AlarmLevel, days: number): AlarmLevel {
  const toLow = kind === "treasury" ? 10 : 6;
  const toOk = kind === "treasury" ? 27 : 12;
  if (previous === "critical" && raw !== "critical") {
    if (days < toLow) return "critical";
    if (raw === "ok" && days < toOk) return "low";
    return raw;
  }
  if (previous === "low" && raw === "ok" && days < toOk) return "low";
  return raw;
}

export function worsened(previous: AlarmLevel, next: AlarmLevel): boolean {
  const rank = { ok: 0, low: 1, critical: 2 };
  return rank[next] > rank[previous];
}
