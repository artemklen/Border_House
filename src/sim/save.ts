import { GOODS } from "./goods";
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

/** false, если браузер отказал в записи. Исключение не выходит наружу, чтобы игровой цикл не остановился. */
export function storeSave(storage: { setItem(key: string, value: string): void }, key: string, raw: string): boolean {
  try {
    storage.setItem(key, raw);
    return true;
  } catch {
    return false;
  }
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
  if (!state || typeof state.tick !== "number" || typeof state.rngState !== "number") {
    throw new SaveError("Файл сохранения повреждён: нет состояния симуляции.");
  }
  assertPlayable(state);
  return state;
}

const LISTS = ["houses", "worlds", "ships", "routes", "treaties", "people", "journal", "aiLog"] as const;

function requireGoods(value: unknown, label: string): void {
  if (!value || typeof value !== "object") throw new SaveError(`Файл сохранения повреждён: нет поля «${label}».`);
  const pile = value as Record<string, unknown>;
  if (GOODS.some((good) => typeof pile[good] !== "number")) throw new SaveError(`Файл сохранения повреждён: поле «${label}» неполное.`);
}

function assertPlayable(state: SimState): void {
  if (state.version !== 1) throw new SaveError("Файл сохранения повреждён: нет состояния симуляции.");
  for (const key of LISTS) {
    if (!Array.isArray(state[key])) throw new SaveError(`Файл сохранения повреждён: нет списка «${key}».`);
  }
  if (!state.rules || typeof state.rules.ticksPerYear !== "number") throw new SaveError("Файл сохранения повреждён: нет правил.");
  requireGoods(state.rules.basePrice, "базовые цены");
  if (!state.accounts || typeof state.accounts.creditsCreated !== "number" || typeof state.accounts.creditsDestroyed !== "number") {
    throw new SaveError("Файл сохранения повреждён: нет счетов.");
  }
  for (const key of ["goodsCreated", "goodsDestroyed", "transformedIn", "transformedOut"] as const) {
    const pile = state.accounts[key];
    if (!pile || GOODS.some((good) => typeof pile[good] !== "number")) throw new SaveError("Файл сохранения повреждён: счета товаров неполные.");
  }
  const houseIds = new Set<string>();
  for (const house of state.houses) {
    if (!house || typeof house.id !== "string" || houseIds.has(house.id)) throw new SaveError("Файл сохранения повреждён: дом без идентификатора.");
    if (!house.flow || typeof house.flow.wages !== "number" || !house.lastFlow || typeof house.lastFlow.wages !== "number") {
      throw new SaveError("Файл сохранения повреждён: у дома нет кассы.");
    }
    houseIds.add(house.id);
  }
  const worldIds = new Set<string>();
  for (const world of state.worlds) {
    if (!world || typeof world.id !== "string" || !world.stock || !Array.isArray(world.buildings) || worldIds.has(world.id)) {
      throw new SaveError("Файл сохранения повреждён: мир без склада.");
    }
    if (GOODS.some((good) => typeof world.stock[good] !== "number")) throw new SaveError("Файл сохранения повреждён: склад мира неполный.");
    requireGoods(world.prices, "цены");
    requireGoods(world.demand, "спрос");
    requireGoods(world.deposits, "месторождения");
    requireGoods(world.produced, "производство");
    if (typeof world.population !== "number" || typeof world.capacity !== "number" || typeof world.popWallet !== "number") {
      throw new SaveError("Файл сохранения повреждён: население или кошелёк мира нечисловые.");
    }
    if (!world.imported || typeof world.imported !== "object") throw new SaveError("Файл сохранения повреждён: нет учёта импорта.");
    if (world.ownerId && !houseIds.has(world.ownerId)) throw new SaveError("Файл сохранения повреждён: мир ссылается на неизвестный дом.");
    worldIds.add(world.id);
  }
  const routeIds = new Set<string>();
  for (const route of state.routes) {
    if (!route || typeof route.id !== "string" || !Array.isArray(route.stops) || !houseIds.has(route.houseId)) {
      throw new SaveError("Файл сохранения повреждён: маршрут без остановок.");
    }
    for (const stop of route.stops) {
      if (!stop || !worldIds.has(stop.worldId) || !Array.isArray(stop.actions)) throw new SaveError("Файл сохранения повреждён: остановка маршрута неизвестна.");
    }
    routeIds.add(route.id);
  }
  for (const ship of state.ships) {
    if (!ship || typeof ship.id !== "string" || !ship.cargo || !houseIds.has(ship.houseId)) throw new SaveError("Файл сохранения повреждён: корабль без трюма.");
    if (GOODS.some((good) => typeof ship.cargo[good] !== "number")) throw new SaveError("Файл сохранения повреждён: трюм корабля неполный.");
    if (!ship.supplyFrom || typeof ship.supplyFrom !== "object") throw new SaveError("Файл сохранения повреждён: у корабля нет учёта груза.");
    if (ship.routeId && !routeIds.has(ship.routeId)) throw new SaveError("Файл сохранения повреждён: корабль ссылается на неизвестный маршрут.");
  }
  for (const person of state.people) {
    if (!person || typeof person.id !== "string" || !houseIds.has(person.houseId) || !Array.isArray(person.traits)) {
      throw new SaveError("Файл сохранения повреждён: человек без дома.");
    }
  }
}
