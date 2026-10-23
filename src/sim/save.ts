import { RECIPES, SHIP_CLASSES } from "./config";
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
export function storeSave(
  storage: { setItem(key: string, value: string): void } | (() => { setItem(key: string, value: string): void }),
  key: string,
  raw: string,
): boolean {
  try {
    const target = typeof storage === "function" ? storage() : storage;
    target.setItem(key, raw);
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
  if (typeof state.seed !== "number" || !Number.isFinite(state.seed)) throw new SaveError("Файл сохранения повреждён: нет зерна генератора.");
  for (const key of LISTS) {
    if (!Array.isArray(state[key])) throw new SaveError(`Файл сохранения повреждён: нет списка «${key}».`);
  }
  if (!state.rules) throw new SaveError("Файл сохранения повреждён: нет правил.");
  const rules = state.rules;
  const ruleOk = requireInt(rules.ticksPerYear, 1, 1000)
    && requireInt(rules.foodPer100, 0, 1000)
    && requireInt(rules.wage, 0, 100000)
    && requireInt(rules.taxPer100, 0, 100000)
    && requireInt(rules.territoryRadius, 0, 100000)
    && requireInt(rules.colonizeFood, 0, 100000)
    && requireInt(rules.colonizeParts, 0, 100000)
    && requireInt(rules.colonizeCost, 0, 1_000_000_000)
    && requireInt(rules.colonizePop, 0, 100000)
    && requireInt(rules.aiInterval, 0, 10000)
    && requireInt(rules.window, 1, 10000)
    && requireInt(rules.stockCapacity, 1, 10_000_000)
    && requireInt(rules.deathStartAge, 0, 1000)
    && requireInt(rules.deathCertainAge, 0, 1000)
    && rules.deathCertainAge >= rules.deathStartAge;
  if (!ruleOk) throw new SaveError("Файл сохранения повреждён: нет правил.");
  if (!Number.isInteger(state.nextSerial) || state.nextSerial < 0) throw new SaveError("Файл сохранения повреждён: нет счётчика.");
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
    if (typeof house.credits !== "number" || !Number.isInteger(house.credits) || house.credits < 0) {
      throw new SaveError("Файл сохранения повреждён: казна дома нечисловая.");
    }
    const flowKeys = ["wages", "taxes", "sales", "purchases", "tariffsIn", "tariffsOut", "upkeep", "construction"] as const;
    if (!house.flow || !house.lastFlow || flowKeys.some((key) => typeof house.flow[key] !== "number" || typeof house.lastFlow[key] !== "number")) {
      throw new SaveError("Файл сохранения повреждён: у дома нет кассы.");
    }
    if (typeof house.name !== "string" || typeof house.crest !== "string") throw new SaveError("Файл сохранения повреждён: у дома нет имени.");
    if (!isMap(house.embargo) || !isMap(house.relation) || !isMap(house.tradeWith) || !isMap(house.lastTradeWith)) {
      throw new SaveError("Файл сохранения повреждён: у дома нет отношений.");
    }
    houseIds.add(house.id);
  }
  if (!state.houses.some((house) => house.player === true)) throw new SaveError("Файл сохранения повреждён: нет дома игрока.");
  if (state.worlds.length === 0) throw new SaveError("Файл сохранения повреждён: нет миров.");
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
    requireGoods(world.lastDemand, "прошлый спрос");
    requireGoods(world.lastProduced, "прошлый выпуск");
    if (!isMap(world.lastImported)) throw new SaveError("Файл сохранения повреждён: нет учёта импорта.");
    if (typeof world.name !== "string" || typeof world.specialty !== "string") throw new SaveError("Файл сохранения повреждён: у мира нет имени.");
    if (typeof world.x !== "number" || typeof world.y !== "number" || !Number.isFinite(world.x) || !Number.isFinite(world.y)) {
      throw new SaveError("Файл сохранения повреждён: у мира нет координат.");
    }
    if (typeof world.population !== "number" || typeof world.capacity !== "number" || typeof world.windowDays !== "number" || typeof world.tariffBps !== "number" || typeof world.popWallet !== "number" || !Number.isInteger(world.popWallet) || world.popWallet < 0 || typeof world.satisfaction !== "number" || !Number.isFinite(world.satisfaction)) {
      throw new SaveError("Файл сохранения повреждён: население или кошелёк мира нечисловые.");
    }
    if (!world.imported || typeof world.imported !== "object") throw new SaveError("Файл сохранения повреждён: нет учёта импорта.");
    if (world.ownerId && !houseIds.has(world.ownerId)) throw new SaveError("Файл сохранения повреждён: мир ссылается на неизвестный дом.");
    for (const building of world.buildings) {
      if (!building || typeof building.kind !== "string" || !Object.hasOwn(RECIPES, building.kind)) throw new SaveError("Файл сохранения повреждён: неизвестное предприятие.");
      if (building.stopReason != null && typeof building.stopReason !== "string") throw new SaveError("Файл сохранения повреждён: у предприятия нет подписи.");
    }
    worldIds.add(world.id);
  }
  const routeIds = new Set<string>();
  for (const route of state.routes) {
    if (!route || typeof route.id !== "string" || typeof route.name !== "string" || !Array.isArray(route.stops) || !houseIds.has(route.houseId)) {
      throw new SaveError("Файл сохранения повреждён: маршрут без остановок.");
    }
    const counters = ["revenue", "cost", "fuelUsed", "lastRevenue", "lastCost", "lastFuelUsed"] as const;
    if (counters.some((key) => typeof route[key] !== "number" || !Number.isFinite(route[key]))) {
      throw new SaveError("Файл сохранения повреждён: учёт маршрута повреждён.");
    }
    for (const stop of route.stops) {
      if (!stop || !worldIds.has(stop.worldId) || !Array.isArray(stop.actions)) throw new SaveError("Файл сохранения повреждён: остановка маршрута неизвестна.");
      for (const action of stop.actions) {
        if (!action || !(GOODS as readonly string[]).includes(action.good) || !["load", "unload", "buy", "sell"].includes(action.mode)) {
          throw new SaveError("Файл сохранения повреждён: действие остановки повреждено.");
        }
        if (!Number.isInteger(action.amount) || action.amount <= 0 || !Number.isInteger(action.price) || action.price < 0 || !Number.isInteger(action.keep) || action.keep < 0) {
          throw new SaveError("Файл сохранения повреждён: действие остановки повреждено.");
        }
      }
    }
    routeIds.add(route.id);
  }
  for (const ship of state.ships) {
    if (!ship || typeof ship.id !== "string" || !ship.cargo || !houseIds.has(ship.houseId)) throw new SaveError("Файл сохранения повреждён: корабль без трюма.");
    if (typeof ship.classId !== "string" || !Object.hasOwn(SHIP_CLASSES, ship.classId)) throw new SaveError("Файл сохранения повреждён: неизвестный класс корабля.");
    if (typeof ship.name !== "string") throw new SaveError("Файл сохранения повреждён: у корабля нет имени.");
    if (GOODS.some((good) => typeof ship.cargo[good] !== "number")) throw new SaveError("Файл сохранения повреждён: трюм корабля неполный.");
    if (!ship.supplyFrom || typeof ship.supplyFrom !== "object") throw new SaveError("Файл сохранения повреждён: у корабля нет учёта груза.");
    normalizeSupply(ship);
    if (ship.routeId && !routeIds.has(ship.routeId)) throw new SaveError("Файл сохранения повреждён: корабль ссылается на неизвестный маршрут.");
    assertShipNavigation(ship, state, worldIds);
  }
  for (const treaty of state.treaties) {
    if (!treaty || typeof treaty.status !== "string" || typeof treaty.kind !== "string" || typeof treaty.proposerId !== "string" || typeof treaty.targetId !== "string") {
      throw new SaveError("Файл сохранения повреждён: договор повреждён.");
    }
    if (typeof treaty.windowDays !== "number" || typeof treaty.endTick !== "number" || typeof treaty.delivered !== "number" || typeof treaty.qtyPerWindow !== "number" || typeof treaty.note !== "string") {
      throw new SaveError("Файл сохранения повреждён: договор повреждён.");
    }
  }
  for (const entry of [...state.journal, ...state.aiLog]) {
    if (!entry || typeof entry.tick !== "number" || typeof entry.text !== "string") {
      throw new SaveError("Файл сохранения повреждён: запись журнала повреждена.");
    }
  }
  for (const person of state.people) {
    if (!person || typeof person.id !== "string" || typeof person.name !== "string" || !houseIds.has(person.houseId) || !Array.isArray(person.traits) || typeof person.ageDays !== "number") {
      throw new SaveError("Файл сохранения повреждён: человек без дома.");
    }
    if (!["head", "heir", "spouse", "kin", "governor"].includes(person.role) || typeof person.loyalty !== "number" || !Number.isFinite(person.loyalty)) {
      throw new SaveError("Файл сохранения повреждён: роль или лояльность человека повреждены.");
    }
  }
}

function requireInt(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isMap(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isWorldRef(id: unknown, worldIds: Set<string>): boolean {
  return id === null || (typeof id === "string" && worldIds.has(id));
}

function assertShipNavigation(ship: SimState["ships"][number], state: SimState, worldIds: Set<string>): void {
  const broken = "Файл сохранения повреждён: навигация корабля повреждена.";
  if (!["docked", "transit", "blocked", "building"].includes(ship.status)) throw new SaveError(broken);
  if (!Number.isInteger(ship.stopIndex) || ship.stopIndex < 0) throw new SaveError(broken);
  if (!isWorldRef(ship.worldId, worldIds) || !isWorldRef(ship.fromId, worldIds) || !isWorldRef(ship.toId, worldIds) || !isWorldRef(ship.tollWorldId, worldIds)) {
    throw new SaveError(broken);
  }
  if (ship.status === "transit" && (typeof ship.fromId !== "string" || typeof ship.toId !== "string")) throw new SaveError(broken);
  if (ship.status !== "transit" && typeof ship.worldId !== "string") throw new SaveError(broken);
  if (!Number.isFinite(ship.distanceLeft) || ship.distanceLeft < 0 || !Number.isFinite(ship.legDistance) || ship.legDistance < 0 || !Number.isFinite(ship.traveled) || ship.traveled < 0) {
    throw new SaveError(broken);
  }
  if (!Number.isInteger(ship.remainingDays) || ship.remainingDays < 0) throw new SaveError(broken);
  if (ship.stopReason != null && typeof ship.stopReason !== "string") throw new SaveError(broken);
  if (ship.mission != null) {
    const mission = ship.mission as { type?: unknown; worldId?: unknown };
    if (mission.type !== "colonize" || typeof mission.worldId !== "string" || !worldIds.has(mission.worldId)) throw new SaveError(broken);
  }
  const route = ship.routeId ? state.routes.find((item) => item.id === ship.routeId) : undefined;
  if (route && route.stops.length > 0 && ship.stopIndex >= route.stops.length) throw new SaveError(broken);
}

function normalizeSupply(ship: SimState["ships"][number]): void {
  for (const good of GOODS) {
    const origin = ship.supplyFrom[good] as unknown;
    if (typeof origin === "string") {
      ship.supplyFrom[good] = origin ? { [origin]: ship.cargo[good] } : {};
      continue;
    }
    if (origin == null) continue;
    if (!isMap(origin) || Object.values(origin).some((qty) => typeof qty !== "number")) {
      throw new SaveError("Файл сохранения повреждён: учёт груза повреждён.");
    }
  }
}
