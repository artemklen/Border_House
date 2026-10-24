import { destroyGoods, houseOf, moveCredits, note, shipOf, sinkCredits, worldOf } from "./mutate";
import type { CommandResult, Port, Route, Ship, SimState, World } from "./types";

export const PORT_BERTHS = 1;
export const PORT_THROUGHPUT = 80;
export const BERTH_COST = 2400;
export const BERTH_PARTS = 8;
export const BERTH_DAYS = 5;
export const BERTH_UPKEEP = 4;
export const SPEED_COST = 1600;
export const SPEED_PARTS = 6;
export const SPEED_DAYS = 4;
export const SPEED_UPKEEP = 3;
export const SPEED_BONUS = 80;

export function emptyPort(): Port {
  return {
    berthLevel: 0,
    speedLevel: 0,
    project: null,
    queue: [],
    berth: [],
    handled: 0,
    upkeepPaid: true,
  };
}

export function effectiveBerths(port: Port): number {
  return PORT_BERTHS + (port.berthLevel > 0 && port.upkeepPaid ? 1 : 0);
}

export function effectiveThroughput(port: Port): number {
  return PORT_THROUGHPUT + (port.speedLevel > 0 && port.upkeepPaid ? SPEED_BONUS : 0);
}

export function portEstimate(port: Port): string {
  const berths = effectiveBerths(port);
  const throughput = effectiveThroughput(port);
  const berthWord = berths === 1 ? "причал" : "причала";
  return `Оценка пропускной способности: ${berths} ${berthWord}, до ${throughput} ед. груза на причал за день. Общий поток не растёт линейно от длины очереди. Складская ёмкость мира — отдельный предел, расширение порта её не увеличивает.`;
}

export function advancePorts(state: SimState): void {
  for (const world of state.worlds) {
    const port = world.port;
    const owner = world.ownerId ? houseOf(state, world.ownerId) : undefined;
    const windowOpen = owner ? owner.flowDays === 0 : state.tick % state.rules.window === 1;
    if (windowOpen) port.handled = 0;
    if (port.project) {
      port.project.remainingDays -= 1;
      if (port.project.remainingDays <= 0) {
        if (port.project.kind === "berth") port.berthLevel = 1;
        else port.speedLevel = 1;
        const title = port.project.kind === "berth" ? "дополнительный причал" : "ускорение обработки";
        note(state, world.ownerId, `«${world.name}»: ${title} достроен. Складская ёмкость ${world.capacity} не изменилась.`);
        port.project = null;
      }
    }
    const upkeep = (port.berthLevel > 0 ? BERTH_UPKEEP : 0) + (port.speedLevel > 0 ? SPEED_UPKEEP : 0);
    if (upkeep <= 0 || !owner) {
      port.upkeepPaid = true;
      continue;
    }
    port.upkeepPaid = sinkCredits(state, { kind: "house", id: owner.id }, upkeep);
    if (port.upkeepPaid) owner.flow.upkeep += upkeep;
    else note(state, owner.id, `«${world.name}»: содержание порта ${upkeep} кред. не оплачено. Сегодня работает базовый причал, без купленной скорости.`);
  }
}

export function arrangePorts(state: SimState): void {
  for (const world of state.worlds) {
    const port = world.port;
    const waiting = state.ships.filter((ship) => ship.worldId === world.id && shipNeedsPort(state, ship, world));
    const ids = new Set(waiting.map((ship) => ship.id));
    port.berth = port.berth.filter((id) => ids.has(id));
    port.queue = port.queue.filter((id) => ids.has(id) && !port.berth.includes(id));
    for (const ship of waiting) {
      if (port.berth.includes(ship.id) || port.queue.includes(ship.id)) continue;
      if (ship.portArrived <= 0) ship.portArrived = state.tick;
      port.queue.push(ship.id);
    }
    sortQueue(state, port);
    const open = effectiveBerths(port);
    while (port.berth.length > open) {
      const extra = port.berth.pop();
      if (extra) port.queue.push(extra);
    }
    sortQueue(state, port);
    while (port.berth.length < open && port.queue.length > 0) {
      const next = port.queue.shift();
      if (next) port.berth.push(next);
    }
    const count = Math.max(1, port.berth.length);
    const throughput = effectiveThroughput(port);
    const base = Math.floor(throughput / count);
    let extra = throughput - base * count;
    for (const id of port.berth) {
      const ship = shipOf(state, id);
      if (!ship) continue;
      ship.portAllowance = base + (extra > 0 ? 1 : 0);
      if (extra > 0) extra -= 1;
      ship.portMoved = 0;
    }
    for (let index = 0; index < port.queue.length; index += 1) {
      const ship = shipOf(state, port.queue[index]);
      if (!ship) continue;
      ship.portAllowance = 0;
      ship.portMoved = 0;
      ship.stopReason = `очередь порта «${world.name}»: место ${index + 1} из ${port.queue.length}, примерно ${index + 1} дн. Причал занят. Контрактный груз этой очереди не обходит.`;
    }
  }
}

export function capPort(ship: Ship, qty: number): { qty: number; limited: boolean } {
  const left = Math.max(0, ship.portAllowance - ship.portMoved);
  const taken = Math.min(Math.max(0, qty), left);
  ship.portMoved += taken;
  return { qty: taken, limited: taken < qty };
}

export function notePortMove(world: World, route: Route | undefined, qty: number): void {
  if (qty <= 0) return;
  world.port.handled += qty;
  if (route) route.movedWindow += qty;
}

export function releaseIdleBerths(state: SimState): void {
  for (const world of state.worlds) {
    const port = world.port;
    const keep: string[] = [];
    for (const id of port.berth) {
      const ship = shipOf(state, id);
      if (!ship) continue;
      if (ship.stopReason && berthMustYield(state, world, ship)) {
        ship.portArrived = state.tick + 1;
        port.queue.push(ship.id);
        if (!reasonKeepsItsText(ship.stopReason)) {
          ship.stopReason = `${ship.stopReason} Причал освобождён: действие сейчас невозможно, корабль встал в хвост очереди.`;
        }
        continue;
      }
      keep.push(id);
    }
    port.berth = keep;
    sortQueue(state, port);
  }
}

export function leavePort(state: SimState, ship: Ship): void {
  const world = ship.worldId ? worldOf(state, ship.worldId) : undefined;
  if (!world) return;
  world.port.berth = world.port.berth.filter((id) => id !== ship.id);
  world.port.queue = world.port.queue.filter((id) => id !== ship.id);
  ship.portArrived = 0;
  ship.portAllowance = 0;
}

export function recordPortDays(state: SimState): void {
  for (const ship of state.ships) {
    const route = ship.routeId ? state.routes.find((item) => item.id === ship.routeId) : undefined;
    if (!route) continue;
    if (ship.status === "transit") route.daysFlying += 1;
    else if (ship.worldId && worldOf(state, ship.worldId)?.port.berth.includes(ship.id)) route.daysPort += 1;
    else if (ship.worldId && worldOf(state, ship.worldId)?.port.queue.includes(ship.id)) route.daysWaiting += 1;
  }
}

export function holdForLoad(ship: Ship, route: Route, capacity: number): boolean {
  if (route.minLoad <= 0) {
    ship.loadWait = 0;
    return false;
  }
  const dry = Math.max(0, ship.cargo.grain + ship.cargo.food + ship.cargo.ore + ship.cargo.alloys + ship.cargo.parts);
  if (dry >= route.minLoad) {
    ship.loadWait = 0;
    return false;
  }
  const conflict = route.minLoad > capacity - ship.cargo.fuel;
  if (ship.loadWait < route.maxWait) {
    ship.loadWait += 1;
    ship.stopReason = conflict
      ? `минимум ${route.minLoad} ед. не влезает рядом с топливом ${ship.cargo.fuel}. Ждём ${ship.loadWait} из ${route.maxWait}, затем частичный рейс.`
      : `ждём загрузку ${dry} из ${route.minLoad}. День ${ship.loadWait} из ${route.maxWait}, затем частичный рейс.`;
    return true;
  }
  ship.stopReason = conflict
    ? `частичный рейс: минимум ${route.minLoad} не влезает рядом с топливом, ожидание ${route.maxWait} дн. истекло.`
    : `частичный рейс: загрузка ${dry} из ${route.minLoad}, ожидание ${route.maxWait} дн. истекло.`;
  ship.loadWait = 0;
  return false;
}

export function expandPort(state: SimState, houseId: string, worldId: string, kind: "berth" | "speed"): CommandResult {
  const house = houseOf(state, houseId);
  const world = worldOf(state, worldId);
  if (!house || !world) return { ok: false, reason: "нет такого мира" };
  if (world.ownerId !== house.id) return { ok: false, reason: "порт расширяет только владелец мира" };
  const port = world.port;
  if (port.project) return { ok: false, reason: "в порту уже идёт стройка" };
  if (kind === "berth" && port.berthLevel > 0) return { ok: false, reason: "второй причал уже есть" };
  if (kind === "speed" && port.speedLevel > 0) return { ok: false, reason: "обработка уже ускорена" };
  const cost = kind === "berth" ? BERTH_COST : SPEED_COST;
  const parts = kind === "berth" ? BERTH_PARTS : SPEED_PARTS;
  const days = kind === "berth" ? BERTH_DAYS : SPEED_DAYS;
  if (world.stock.parts < parts) return { ok: false, reason: `нужно ${parts} комплектующих на складе, есть ${world.stock.parts}` };
  if (house.credits - house.reserved < cost) return { ok: false, reason: `нужно ${cost} свободных кредитов` };
  destroyGoods(world.stock, state.accounts, "parts", parts);
  moveCredits(state, { kind: "house", id: house.id }, { kind: "pop", worldId: world.id }, cost);
  house.flow.construction += cost;
  port.project = { kind, remainingDays: days };
  const title = kind === "berth" ? "дополнительный причал" : "ускорение обработки";
  note(state, house.id, `«${world.name}»: начат ${title}. ${cost} кред. переданы населению, ${parts} комплектующих списаны, срок ${days} дн. Склад не растёт.`);
  return { ok: true, reason: `${title} заложен` };
}

export function portIdea(state: SimState, houseId: string): { command: { type: "expandPort"; houseId: string; worldId: string; kind: "berth" | "speed" } | { type: "assignShip"; shipId: string; routeId: null }; because: string } | null {
  const house = houseOf(state, houseId);
  if (!house) return null;
  for (const world of state.worlds) {
    if (world.ownerId !== house.id || world.port.queue.length < 2) continue;
    const port = world.port;
    if (port.berthLevel === 0 && !port.project && world.stock.parts >= BERTH_PARTS && house.credits - house.reserved >= BERTH_COST) {
      return {
        command: { type: "expandPort", houseId: house.id, worldId: world.id, kind: "berth" },
        because: `${house.name} платит за причал «${world.name}»: в очереди ${port.queue.length} корабля, свободных причалов нет.`,
      };
    }
    const extra = port.queue.map((id) => shipOf(state, id)).find((ship) => ship && ship.houseId === house.id);
    if (extra) {
      return {
        command: { type: "assignShip", shipId: extra.id, routeId: null },
        because: `${house.name} снимает ${extra.name} с «${world.name}»: очередь ${port.queue.length}, расширить порт сейчас нельзя.`,
      };
    }
  }
  return null;
}

function shipNeedsPort(state: SimState, ship: Ship, world: World): boolean {
  if (ship.status === "blocked" || ship.status === "transit" || ship.status === "building") return false;
  if (ship.mission?.type === "colonize" && ship.mission.worldId === world.id) return true;
  const route = ship.routeId ? state.routes.find((item) => item.id === ship.routeId) : undefined;
  return Boolean(route && !route.paused);
}

function sortQueue(state: SimState, port: Port): void {
  port.queue.sort((left, right) => {
    const a = shipOf(state, left);
    const b = shipOf(state, right);
    const tickA = a?.portArrived ?? 0;
    const tickB = b?.portArrived ?? 0;
    if (tickA !== tickB) return tickA - tickB;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function reasonKeepsItsText(reason: string): boolean {
  return reason.startsWith("нет топлива") || reason.startsWith("не хватает денег на транзитную") || reason.startsWith("нет доступа к следующей") || reason.startsWith("нет доступа: маршрут");
}

function berthMustYield(state: SimState, world: World, ship: Ship): boolean {
  const reason = ship.stopReason ?? "";
  if (reason.startsWith("нет топлива")) return fuelCanUseTheBerth(state, world);
  if (reason.startsWith("не хватает денег на транзитную") || reason.startsWith("нет доступа к следующей") || reason.startsWith("нет доступа: маршрут")) return true;
  return ship.portMoved === 0 && berthIsStuck(reason);
}

function fuelCanUseTheBerth(state: SimState, world: World): boolean {
  return world.port.queue.some((id) => {
    const other = shipOf(state, id);
    if (!other) return false;
    const route = other.routeId ? state.routes.find((item) => item.id === other.routeId) : undefined;
    const stop = route?.stops.find((item) => item.worldId === world.id);
    return Boolean(stop?.actions.some((action) => action.good === "fuel" && (action.mode === "unload" || action.mode === "sell" || action.mode === "load" || action.mode === "buy")));
  });
}

function berthIsStuck(reason: string): boolean {
  return reason.startsWith("нечего грузить")
    || reason.startsWith("склад заполнен")
    || reason.startsWith("у покупателя нет денег")
    || reason.startsWith("чужой склад")
    || reason.startsWith("цена ")
    || reason.startsWith("нет товара")
    || reason.startsWith("нет места")
    || reason.startsWith("не хватает денег")
    || reason.startsWith("нет доступа");
}
