import { isContractStatus } from "./contracts";
import { RECIPES, SHIP_CLASSES } from "./config";
import { emptyDevelopment } from "./specialty";
import { GOODS } from "./goods";
import type { SimState } from "./types";

export class SaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaveError";
  }
}

/** Версия 4 хранит путь развития мира. Версии 1–3 поднимаются: у старых миров путь пустой, бонуса нет. */
export function serialize(state: SimState): string {
  return JSON.stringify({ version: state.version, state });
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
  if (file.version !== 1 && file.version !== 2 && file.version !== 3 && file.version !== 4) throw new SaveError("Несовместимая версия сохранения. Эта сборка читает версии 1, 2, 3 и 4.");
  const state = file.state;
  if (!state || !Number.isInteger(state.tick) || state.tick < 0 || typeof state.rngState !== "number") {
    throw new SaveError("Файл сохранения повреждён: нет состояния симуляции.");
  }
  migrateSave(state, file.version);
  assertPlayable(state);
  return state;
}

function migrateSave(state: SimState, version: number): void {
  if (version === 1) {
    if (!Array.isArray(state.contracts)) state.contracts = [];
    if (Array.isArray(state.houses)) {
      for (const house of state.houses) {
        if (house && !Number.isInteger(house.reserved)) house.reserved = 0;
        for (const book of [house?.flow, house?.lastFlow]) {
          if (!book) continue;
          if (!Number.isInteger(book.penalties)) book.penalties = 0;
          if (!Number.isInteger(book.compensation)) book.compensation = 0;
        }
      }
    }
  }
  if (version < 3) {
    if (Array.isArray(state.worlds)) {
      for (const world of state.worlds) {
        if (!world) continue;
        if (!world.port || !Array.isArray(world.port.queue) || !Array.isArray(world.port.berth)) {
          world.port = {
            berthLevel: 0,
            speedLevel: 0,
            project: null,
            queue: [],
            berth: [],
            handled: 0,
            upkeepPaid: true,
          };
        }
      }
    }
    if (Array.isArray(state.routes)) {
      for (const route of state.routes) {
        if (!route) continue;
        if (!Number.isInteger(route.minLoad)) route.minLoad = 0;
        if (!Number.isInteger(route.maxWait)) route.maxWait = 0;
        if (!Number.isInteger(route.waitDays)) route.waitDays = 0;
        if (!Number.isInteger(route.movedWindow)) route.movedWindow = 0;
        if (!Number.isInteger(route.lastMoved)) route.lastMoved = 0;
        if (!Number.isInteger(route.daysFlying)) route.daysFlying = 0;
        if (!Number.isInteger(route.daysPort)) route.daysPort = 0;
        if (!Number.isInteger(route.daysWaiting)) route.daysWaiting = 0;
      }
    }
    if (Array.isArray(state.ships)) {
      for (const ship of state.ships) {
        if (!ship) continue;
        if (!Number.isInteger(ship.portArrived)) ship.portArrived = 0;
        if (!Number.isInteger(ship.portMoved)) ship.portMoved = 0;
        if (!Number.isInteger(ship.portAllowance)) ship.portAllowance = 0;
        if (!Number.isInteger(ship.loadWait)) ship.loadWait = 0;
      }
    }
  }
  if (version < 4) {
    state.version = 4;
    if (Array.isArray(state.worlds)) {
      for (const world of state.worlds) {
        if (!world) continue;
        if (!world.development || (world.development.path !== null && world.development.path !== "agrarian" && world.development.path !== "industrial" && world.development.path !== "transit")) {
          world.development = emptyDevelopment();
        }
      }
    }
  }
}

const LISTS = ["houses", "worlds", "ships", "routes", "treaties", "contracts", "people", "journal", "aiLog"] as const;

function requireGoods(value: unknown, label: string): void {
  if (!value || typeof value !== "object") throw new SaveError(`Файл сохранения повреждён: нет поля «${label}».`);
  const pile = value as Record<string, unknown>;
  if (GOODS.some((good) => typeof pile[good] !== "number")) throw new SaveError(`Файл сохранения повреждён: поле «${label}» неполное.`);
}

function requirePrices(value: unknown, label: string): void {
  requireGoods(value, label);
  const pile = value as Record<string, number>;
  if (GOODS.some((good) => !Number.isInteger(pile[good]) || pile[good] < 1)) {
    throw new SaveError(`Файл сохранения повреждён: поле «${label}» неполное.`);
  }
}

function assertPlayable(state: SimState): void {
  if (state.version !== 4) throw new SaveError("Файл сохранения повреждён: нет состояния симуляции.");
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
  requirePrices(state.rules.basePrice, "базовые цены");
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
    if (!Number.isInteger(house.reserved) || house.reserved < 0 || house.reserved > house.credits) {
      throw new SaveError("Файл сохранения повреждён: резерв казны вышел за деньги дома.");
    }
    const flowKeys = ["wages", "taxes", "sales", "purchases", "tariffsIn", "tariffsOut", "upkeep", "construction", "penalties", "compensation"] as const;
    if (!house.flow || !house.lastFlow || flowKeys.some((key) => typeof house.flow[key] !== "number" || typeof house.lastFlow[key] !== "number")) {
      throw new SaveError("Файл сохранения повреждён: у дома нет кассы.");
    }
    if (typeof house.flowDays !== "number" || !Number.isInteger(house.flowDays) || house.flowDays < 0) {
      throw new SaveError("Файл сохранения повреждён: окно кассы нечисловое.");
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
    if (GOODS.some((good) => !Number.isInteger(world.stock[good]) || world.stock[good] < 0)) throw new SaveError("Файл сохранения повреждён: склад мира неполный.");
    requirePrices(world.prices, "цены");
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
    if (typeof world.population !== "number" || !Number.isInteger(world.population) || world.population < 0 || typeof world.capacity !== "number" || typeof world.windowDays !== "number" || typeof world.tariffBps !== "number" || typeof world.popWallet !== "number" || !Number.isInteger(world.popWallet) || world.popWallet < 0 || typeof world.satisfaction !== "number" || !Number.isFinite(world.satisfaction)) {
      throw new SaveError("Файл сохранения повреждён: население или кошелёк мира нечисловые.");
    }
    if (world.foodCredit != null && !requireInt(world.foodCredit, 0, 99)) {
      throw new SaveError("Файл сохранения повреждён: накопитель пайка повреждён.");
    }
    if (!isMap(world.imported) || !isGoodsLedger(world.imported) || !isGoodsLedger(world.lastImported)) throw new SaveError("Файл сохранения повреждён: нет учёта импорта.");
    if (world.ownerId && !houseIds.has(world.ownerId)) throw new SaveError("Файл сохранения повреждён: мир ссылается на неизвестный дом.");
    for (const building of world.buildings) {
      if (!building || typeof building.kind !== "string" || !Object.hasOwn(RECIPES, building.kind)) throw new SaveError("Файл сохранения повреждён: неизвестное предприятие.");
      if (!Number.isInteger(building.remainingDays) || building.remainingDays < 0 || !Number.isInteger(building.workers) || building.workers < 0 || typeof building.enabled !== "boolean") {
        throw new SaveError("Файл сохранения повреждён: предприятие без стройки или работников.");
      }
      if (building.stopReason != null && typeof building.stopReason !== "string") throw new SaveError("Файл сохранения повреждён: у предприятия нет подписи.");
    }
    worldIds.add(world.id);
    const port = world.port;
    if (!port || !Array.isArray(port.queue) || !Array.isArray(port.berth) || !requireInt(port.berthLevel, 0, 1) || !requireInt(port.speedLevel, 0, 1) || !requireInt(port.handled, 0, 1_000_000_000) || typeof port.upkeepPaid !== "boolean") {
      throw new SaveError("Файл сохранения повреждён: порт мира повреждён.");
    }
    if (port.project && (port.project.kind !== "berth" && port.project.kind !== "speed" || !requireInt(port.project.remainingDays, 0, 30))) {
      throw new SaveError("Файл сохранения повреждён: стройка порта повреждена.");
    }
    if (port.queue.some((id) => typeof id !== "string") || port.berth.some((id) => typeof id !== "string")) {
      throw new SaveError("Файл сохранения повреждён: очередь порта повреждена.");
    }
    const development = world.development;
    const pathOk = !development?.path || development.path === "agrarian" || development.path === "industrial" || development.path === "transit";
    if (!development || !pathOk || !requireInt(development.level, 0, 2) || typeof development.suspended !== "boolean" || !requireInt(development.invested, 0, 1_000_000_000) || typeof development.upkeepPaid !== "boolean") {
      throw new SaveError("Файл сохранения повреждён: развитие мира повреждено.");
    }
    if (development.path === null && development.level !== 0) throw new SaveError("Файл сохранения повреждён: развитие мира повреждено.");
    const project = development.project;
    if (project && (project.path !== "agrarian" && project.path !== "industrial" && project.path !== "transit" || (project.targetLevel !== 1 && project.targetLevel !== 2) || !requireInt(project.remainingDays, 0, 30) || !requireInt(project.spent, 0, 1_000_000_000) || (project.kind !== "build" && project.kind !== "switch"))) {
      throw new SaveError("Файл сохранения повреждён: стройка развития повреждена.");
    }
  }
  const routeIds = new Set<string>();
  for (const route of state.routes) {
    if (!route || typeof route.id !== "string" || typeof route.name !== "string" || !Array.isArray(route.stops) || !houseIds.has(route.houseId)) {
      throw new SaveError("Файл сохранения повреждён: маршрут без остановок.");
    }
    const counters = ["revenue", "cost", "fuelUsed", "lastRevenue", "lastCost", "lastFuelUsed", "minLoad", "maxWait", "waitDays", "movedWindow", "lastMoved", "daysFlying", "daysPort", "daysWaiting"] as const;
    if (counters.some((key) => typeof route[key] !== "number" || !Number.isFinite(route[key]))) {
      throw new SaveError("Файл сохранения повреждён: учёт маршрута повреждён.");
    }
    if (route.colony != null && typeof route.colony !== "boolean") {
      throw new SaveError("Файл сохранения повреждён: признак колонии повреждён.");
    }
    if (route.pausedFood != null && (!Array.isArray(route.pausedFood) || !route.pausedFood.every(isTradeAction))) {
      throw new SaveError("Файл сохранения повреждён: отложенная погрузка повреждена.");
    }
    for (const stop of route.stops) {
      if (!stop || !worldIds.has(stop.worldId) || !Array.isArray(stop.actions)) throw new SaveError("Файл сохранения повреждён: остановка маршрута неизвестна.");
      if (!stop.actions.every(isTradeAction)) throw new SaveError("Файл сохранения повреждён: действие остановки повреждено.");
    }
    routeIds.add(route.id);
  }
  for (const ship of state.ships) {
    if (!ship || typeof ship.id !== "string" || !ship.cargo || !houseIds.has(ship.houseId)) throw new SaveError("Файл сохранения повреждён: корабль без трюма.");
    if (typeof ship.classId !== "string" || !Object.hasOwn(SHIP_CLASSES, ship.classId)) throw new SaveError("Файл сохранения повреждён: неизвестный класс корабля.");
    if (typeof ship.name !== "string") throw new SaveError("Файл сохранения повреждён: у корабля нет имени.");
    if (GOODS.some((good) => !Number.isInteger(ship.cargo[good]) || ship.cargo[good] < 0)) throw new SaveError("Файл сохранения повреждён: трюм корабля неполный.");
    if (ship.visitMoved != null && (!Array.isArray(ship.visitMoved) || ship.visitMoved.some((moved) => moved != null && (!Number.isInteger(moved) || moved < 0)))) {
      throw new SaveError("Файл сохранения повреждён: учёт стоянки повреждён.");
    }
    if (!ship.supplyFrom || typeof ship.supplyFrom !== "object") throw new SaveError("Файл сохранения повреждён: у корабля нет учёта груза.");
    if (!Number.isInteger(ship.portArrived) || ship.portArrived < 0 || !Number.isInteger(ship.portMoved) || ship.portMoved < 0 || !Number.isInteger(ship.portAllowance) || ship.portAllowance < 0 || !Number.isInteger(ship.loadWait) || ship.loadWait < 0) {
      throw new SaveError("Файл сохранения повреждён: учёт порта корабля повреждён.");
    }
    normalizeSupply(ship);
    if (ship.routeId && !routeIds.has(ship.routeId)) throw new SaveError("Файл сохранения повреждён: корабль ссылается на неизвестный маршрут.");
    assertShipNavigation(ship, state, worldIds);
  }
  for (const treaty of state.treaties) {
    if (!treaty || typeof treaty.status !== "string" || typeof treaty.kind !== "string" || typeof treaty.proposerId !== "string" || typeof treaty.targetId !== "string") {
      throw new SaveError("Файл сохранения повреждён: договор повреждён.");
    }
    if (typeof treaty.windowDays !== "number" || typeof treaty.endTick !== "number" || typeof treaty.delivered !== "number" || typeof treaty.qtyPerWindow !== "number" || typeof treaty.note !== "string" || !requireInt(treaty.tariffBps, 0, 2500) || !requireInt(treaty.duration, 12, 360)) {
      throw new SaveError("Файл сохранения повреждён: договор повреждён.");
    }
  }
  let reservedByHouse = new Map<string, number>();
  const contractIds = new Set<string>();
  for (const contract of state.contracts) {
    if (!contract || !isContractStatus(contract.status) || typeof contract.id !== "string" || contractIds.has(contract.id) || typeof contract.note !== "string") {
      throw new SaveError("Файл сохранения повреждён: контракт повреждён.");
    }
    if (!houseIds.has(contract.sellerId) || !houseIds.has(contract.buyerId) || !worldIds.has(contract.worldId)) {
      throw new SaveError("Файл сохранения повреждён: контракт ссылается на неизвестный дом или мир.");
    }
    if (!(GOODS as readonly string[]).includes(contract.good)) throw new SaveError("Файл сохранения повреждён: у контракта нет товара.");
    const fields = [contract.qtyPerWindow, contract.windows, contract.price, contract.shortfall, contract.deposit, contract.buyerReserve, contract.delivered, contract.paidWindow, contract.windowIndex, contract.windowDays];
    if (fields.some((value) => !Number.isInteger(value) || value < 0) || contract.windows > 6 || contract.shortfall > contract.qtyPerWindow || !requireInt(contract.price, 1, 10000)) {
      throw new SaveError("Файл сохранения повреждён: числа контракта повреждены.");
    }
    if (!Array.isArray(contract.history) || !Array.isArray(contract.trades)) throw new SaveError("Файл сохранения повреждён: у контракта нет истории.");
    for (const item of contract.history) {
      if (!item || !requireInt(item.window, 0, 6) || !requireInt(item.delivered, 0, 100000) || !requireInt(item.paid, 0, 1_000_000_000) || !requireInt(item.penalty, 0, 1_000_000_000)) {
        throw new SaveError("Файл сохранения повреждён: история контракта повреждена.");
      }
    }
    for (const trade of contract.trades) {
      if (!trade || !requireInt(trade.tick, 0, 1_000_000_000) || !requireInt(trade.qty, 1, 100000) || !requireInt(trade.price, 1, 10000)) {
        throw new SaveError("Файл сохранения повреждён: приёмка контракта повреждена.");
      }
    }
    contractIds.add(contract.id);
    if (contract.status === "proposed" || contract.status === "active") {
      reservedByHouse.set(contract.sellerId, (reservedByHouse.get(contract.sellerId) ?? 0) + contract.deposit);
      reservedByHouse.set(contract.buyerId, (reservedByHouse.get(contract.buyerId) ?? 0) + contract.buyerReserve);
    }
  }
  for (const house of state.houses) {
    const reserved = reservedByHouse.get(house.id) ?? 0;
    if (house.reserved !== reserved) throw new SaveError("Файл сохранения повреждён: резерв казны не сходится с контрактами.");
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

function isTradeAction(action: unknown): boolean {
  if (!action || typeof action !== "object") return false;
  const item = action as { good?: unknown; mode?: unknown; amount?: unknown; price?: unknown; keep?: unknown };
  if (typeof item.good !== "string" || !(GOODS as readonly string[]).includes(item.good)) return false;
  if (typeof item.mode !== "string" || !["load", "unload", "buy", "sell"].includes(item.mode)) return false;
  const amount = item.amount;
  const price = item.price;
  const keep = item.keep;
  return Number.isInteger(amount) && (amount as number) > 0 && Number.isInteger(price) && (price as number) >= 0 && Number.isInteger(keep) && (keep as number) >= 0;
}

function requireInt(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isMap(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isGoodsLedger(value: Record<string, unknown>): boolean {
  return Object.values(value).every((entry) => isMap(entry) && GOODS.every((good) => typeof entry[good] === "number"));
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
