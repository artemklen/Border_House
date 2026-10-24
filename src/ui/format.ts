import type { Flow } from "../sim/types";

const INCOME = new Set<keyof Flow>(["taxes", "sales", "tariffsIn", "compensation"]);

export const FLOW_KEYS: Array<keyof Flow> = [
  "sales",
  "purchases",
  "tariffsIn",
  "tariffsOut",
  "taxes",
  "wages",
  "upkeep",
  "construction",
  "penalties",
  "compensation",
];

export function flowSign(key: keyof Flow): 1 | -1 {
  return INCOME.has(key) ? 1 : -1;
}

export function netFlow(flow: Flow): number {
  return FLOW_KEYS.reduce((sum, key) => sum + flow[key] * flowSign(key), 0);
}

export function groupInt(value: number): string {
  const n = Math.trunc(value);
  const body = Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return n < 0 ? `−${body}` : body;
}

export const FLOW_LABELS: Array<[keyof Flow, string]> = [
  ["sales", "продажи"],
  ["purchases", "закупки"],
  ["tariffsIn", "полученные пошлины"],
  ["tariffsOut", "уплаченные пошлины"],
  ["taxes", "налоги"],
  ["wages", "зарплаты"],
  ["upkeep", "содержание, денежный сток"],
  ["construction", "плата за стройку населению"],
  ["penalties", "штрафы из залога"],
  ["compensation", "полученные компенсации"],
];

export function signedInt(value: number): string {
  if (value < 0) return `−${groupInt(Math.abs(value))}`;
  if (value > 0) return `+${groupInt(value)}`;
  return "0";
}
