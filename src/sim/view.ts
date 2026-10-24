import { RECIPES, SHIP_CLASSES } from "./config";
import { GOODS, GOOD_NAME, type GoodId } from "./goods";
import { availableCredits, foodCover, foodNeed, houseOf, personOf, routeOf, worldOf } from "./mutate";
import { nextStopIndex, territoriesOnRoute } from "./simulate";
import { plannedBatch } from "./specialty";
import type { House, Ship, SimState, World } from "./types";

export function foodPerDay(population: number, foodPer100: number): number {
  return (population * foodPer100) / 100;
}

export function formatDay(state: SimState): string {
  const year = Math.floor(state.tick / state.rules.ticksPerYear) + 1;
  const day = (state.tick % state.rules.ticksPerYear) + 1;
  return `год ${year}, день ${day}`;
}

export function pickMapTarget(state: SimState, point: { x: number; y: number }, zoom: number): { kind: "ship" | "world"; id: string } | null {
  const shipRadius = 9 / zoom;
  const transitRadius = 16 / zoom;
  const worldRadius = 12 / zoom;
  let bestShip: { id: string; distance: number } | null = null;
  for (const ship of state.ships) {
    if (ship.status === "building") continue;
    const position = shipPoint(state, ship);
    const distance = Math.hypot(position.x - point.x, position.y - point.y);
    const limit = ship.status === "transit" ? transitRadius : shipRadius;
    if (distance < limit && (!bestShip || distance < bestShip.distance)) bestShip = { id: ship.id, distance };
  }
  if (bestShip) return { kind: "ship", id: bestShip.id };
  let bestWorld: { id: string; distance: number } | null = null;
  for (const world of state.worlds) {
    const distance = Math.hypot(world.x - point.x, world.y - point.y);
    if (distance < worldRadius && (!bestWorld || distance < bestWorld.distance)) bestWorld = { id: world.id, distance };
  }
  return bestWorld ? { kind: "world", id: bestWorld.id } : null;
}

export function shipPoint(state: SimState, ship: Ship): { x: number; y: number } {
  if (ship.status === "transit" && ship.fromId && ship.toId && ship.legDistance > 0) {
    const from = worldOf(state, ship.fromId);
    const to = worldOf(state, ship.toId);
    if (from && to) {
      const progress = 1 - ship.distanceLeft / ship.legDistance;
      return { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress };
    }
  }
  const world = worldOf(state, ship.worldId ?? ship.fromId);
  return { x: world?.x ?? 0, y: world?.y ?? 0 };
}

export function explainPrice(state: SimState, worldId: string, good: GoodId): string {
  const world = worldOf(state, worldId);
  if (!world) return "Мир не найден.";
  const base = state.rules.basePrice[good];
  const demand = world.lastDemand[good];
  const stock = world.stock[good];
  return `Цена ${world.prices[good]} кред./ед. База ${base}. На складе ${stock} ед., спрос прошлого дня ${demand} ед. Сырая цена — это база, умноженная на отношение спроса к запасу и зажатая в 40–250%. Затем она сглаживается: новая = округление((прошлая × 2 + сырая) / 3). Случайных скачков нет.`;
}

export function explainBuilding(state: SimState, buildingId: string): string {
  for (const world of state.worlds) {
    const building = world.buildings.find((item) => item.id === buildingId);
    if (!building) continue;
    const recipe = RECIPES[building.kind];
    if (building.remainingDays > 0) return `${recipe.name} строится ещё ${building.remainingDays} дн. Пока стройка идёт, выпуска нет.`;
    const batch = building.stopReason == null && building.lastBatch ? building.lastBatch : plannedBatch(world, recipe);
    const inputs = GOODS.filter((good) => batch.inputs[good]).map((good) => `${batch.inputs[good]} ${GOOD_NAME[good]}`).join(", ") || "без сырья";
    const outputs = GOODS.filter((good) => batch.outputs[good]).map((good) => `${batch.outputs[good]} ${GOOD_NAME[good]}`).join(", ");
    const reason = building.stopReason ? `Сейчас стоит: ${building.stopReason}.` : "Полная партия идёт.";
    return `${recipe.name}: ${inputs} → ${outputs} за день. Нужно работников: ${batch.workers}, на месте ${building.workers}. Содержание ${recipe.upkeep} кред./день уходит в сток «содержание», зарплата ${state.rules.wage} кред. за человека переходит населению. ${reason}`;
  }
  return "Предприятие не найдено.";
}

export function explainShip(state: SimState, shipId: string): string {
  const ship = state.ships.find((item) => item.id === shipId);
  if (!ship) return "Корабль не найден.";
  const shipClass = SHIP_CLASSES[ship.classId];
  const route = routeOf(state, ship.routeId);
  const where = ship.status === "transit" ? `в пути к ${worldOf(state, ship.toId)?.name ?? "цели"}, осталось ${ship.distanceLeft} ед.` : `у мира ${worldOf(state, ship.worldId)?.name ?? "—"}`;
  let nextCost = "";
  if (ship.worldId && route && !route.paused) {
    const next = route.stops[nextStopIndex(ship, route)];
    const from = worldOf(state, ship.worldId);
    const to = worldOf(state, next?.worldId ?? null);
    if (from && to && from.id !== to.id) {
      const crossed = territoriesOnRoute(state, from.id, to.id, ship.houseId).map((world) => world.name);
      nextCost = crossed.length ? ` Следующий перегон пересекает: ${crossed.join(", ")}.` : " Следующий перегон не входит в чужие пределы.";
    }
  }
  const reason = ship.stopReason ? ` Причина остановки: ${ship.stopReason}.` : "";
  return `${ship.name}, ${shipClass.name}. Трюм ${shipClass.capacity} ед., скорость ${shipClass.speed} ед./день, содержание ${shipClass.upkeep} кред./день. Сейчас ${where}.${reason}${nextCost} Топливо списывается в начале перегона, груз остаётся на корабле, если рейс не начался.`;
}

export interface Bottleneck {
  title: string;
  detail: string;
}

export function bottlenecks(state: SimState, houseId: string): Bottleneck[] {
  const items: Bottleneck[] = [];
  for (const world of state.worlds) {
    if (world.ownerId !== houseId) continue;
    const cover = foodCover(world.population, world.stock.food, state.rules.foodPer100);
    const perDay = (world.population * state.rules.foodPer100) / 100;
    if (world.population > 0 && perDay > 0 && cover < 10) {
      items.push({ title: `${world.name}: еда на ${cover} дн.`, detail: `Население ${world.population} съедает ${perDay} ед./день. На складе ${world.stock.food}. Удовлетворённость ${world.satisfaction}.` });
    }
    for (const building of world.buildings) {
      if (building.stopReason) items.push({ title: `${RECIPES[building.kind].name} на «${world.name}»`, detail: building.stopReason });
    }
  }
  for (const ship of state.ships) {
    if (ship.houseId !== houseId || !ship.stopReason) continue;
    items.push({ title: ship.name, detail: ship.stopReason });
  }
  for (const route of state.routes) {
    if (route.houseId !== houseId) continue;
    if (route.lastCost > route.lastRevenue && route.lastCost + route.lastRevenue > 0) {
      items.push({
        title: `Маршрут «${route.name}» убыточен`,
        detail: `За прошлое окно ${state.rules.window} дн. выручка ${route.lastRevenue} кред., расход ${route.lastCost} кред., топливо ${route.lastFuelUsed} ед. В расход входят закупки и пошлины, топливо списывается отдельно со склада корабля.`,
      });
    }
  }
  return items;
}

export function dependencyRows(state: SimState, house: House): string[] {
  const lines: string[] = [];
  let eaten = 0;
  for (const world of state.worlds) {
    if (world.ownerId === house.id) eaten += world.lastEaten;
  }
  for (const other of state.houses) {
    if (other.id === house.id) continue;
    let imported = 0;
    for (const world of state.worlds) {
      if (world.ownerId !== house.id) continue;
      imported += world.lastImported[other.id]?.food ?? 0;
    }
    const share = eaten > 0 ? Math.round((imported / eaten) * 100) : 0;
    const tariff = state.worlds.filter((world) => world.ownerId === other.id).reduce((sum, world) => sum + world.tariffBps, 0);
    lines.push(
      `${other.name}: отношения ${house.relation[other.id] ?? 0}. Доля их продовольствия в последнем учёте ${share}% (${imported} ед. к ${eaten} съеденным). Их средняя пошлина по мирам задаётся отдельно, сумма ставок ${tariff / 100} п.п. Оборот с ними за окно ${house.lastTradeWith[other.id] ?? 0} кред. Эмбарго с нашей стороны: ${house.embargo[other.id] ? "да" : "нет"}.`,
    );
  }
  const capital = worldOf(state, house.capitalId);
  if (capital) {
    const others = state.worlds.filter((world) => {
      if (world.id === capital.id) return false;
      const reserve = foodNeed(world.population, state.rules.foodPer100) * 16;
      return world.stock.food - reserve >= 40;
    });
    lines.push(
      others.length
        ? `Альтернативные склады с запасом продовольствия сверх 16 дней своего потребления: ${others.map((world) => world.name).join(", ")}.`
        : "Других складов с большим свободным запасом продовольствия сейчас нет.",
    );
  }
  return lines;
}

export function hintLines(state: SimState): string[] {
  const player = state.houses.find((house) => house.player);
  if (!player) return [];
  const tips: string[] = [];
  const routes = state.routes.filter((route) => route.houseId === player.id);
  if (routes.length === 0) tips.push(firstVoyageHint(state, player));
  const idle = state.ships.find((ship) => ship.houseId === player.id && ship.status === "docked" && !ship.routeId);
  if (idle && routes.length > 0) tips.push(`${idle.name} стоит без маршрута. Назначение в «Флоте» не телепортирует груз: корабль поедет от текущего мира.`);
  const stuck = bottlenecks(state, player.id)[0];
  if (stuck) tips.push(hintSentence(stuck.title, stuck.detail));
  return tips.slice(0, 3);
}

export function hintSentence(title: string, detail: string): string {
  const trimmed = title.trim();
  const seam = /[.!?…]$/.test(trimmed) ? " " : ". ";
  return `Узкое место: ${trimmed}${seam}${detail}`;
}

function firstVoyageHint(state: SimState, player: House): string {
  const owned = state.worlds.filter((world) => world.ownerId === player.id);
  const pantry = [...owned].sort((left, right) => right.stock.food - left.stock.food || left.name.localeCompare(right.name, "ru"))[0];
  const markets = state.worlds
    .filter((world) => world.ownerId && world.ownerId !== player.id)
    .sort((left, right) => foodCover(left.population, left.stock.food, state.rules.foodPer100) - foodCover(right.population, right.stock.food, state.rules.foodPer100) || right.population - left.population || left.name.localeCompare(right.name, "ru"));
  const market = markets.find((world) => world.id !== pantry?.id);
  const shipWord = state.ships.some((ship) => ship.houseId === player.id && ship.classId === "freighter") ? "грузовоз" : "корабль";
  if (!pantry) return `Откройте «Флот», соберите маршрут из двух миров и назначьте ${shipWord}.`;
  const stockLine = bakesFood(state, pantry)
    ? `«${pantry.name}» уже печёт продовольствие.`
    : pantry.stock.food > 0
      ? `«${pantry.name}» держит продовольствие.`
      : `У «${pantry.name}» мало продовольствия на складе.`;
  let line = `${stockLine} Откройте «Флот», соберите маршрут из двух миров и назначьте ${shipWord}.`;
  if (!market) return line;
  const gates = territoriesOnRoute(state, pantry.id, market.id, player.id);
  if (gates.length > 0) line += ` Короткий путь к «${market.name}» пересекает ${gates.map((world) => `«${world.name}»`).join(" и ")}.`;
  else if (foodCover(market.population, market.stock.food, state.rules.foodPer100) < 16) line += ` Чужой рынок с коротким запасом — «${market.name}».`;
  else line += ` Чужой рынок — «${market.name}».`;
  return line;
}

function bakesFood(state: SimState, world: World): boolean {
  const owner = world.ownerId ? houseOf(state, world.ownerId) : undefined;
  return world.buildings.some((building) => {
    if (building.remainingDays > 0 || !building.enabled || building.stopReason || building.workers <= 0) return false;
    const recipe = RECIPES[building.kind];
    if ((recipe.outputs.food ?? 0) <= 0) return false;
    const shift = recipe.upkeep + building.workers * state.rules.wage;
    if (!owner || availableCredits(owner) < shift) return false;
    return GOODS.every((good) => world.stock[good] >= (recipe.inputs[good] ?? 0));
  });
}

export function fleetPickId(ship: { id: string; houseId: string; status: string }, playerId: string): string | null {
  if (ship.houseId !== playerId || ship.status === "building") return null;
  return ship.id;
}

/** Команды флота остаются на корабле игрока, даже если на карте выбран чужой борт. */
export function fleetCommandShipId(selected: { id: string; houseId: string; status: string } | undefined, playerId: string, current: string): string {
  if (selected && selected.houseId === playerId && selected.status !== "building") return selected.id;
  return current;
}

export function colonyShip(ships: Ship[], houseId: string, preferredId: string): Ship | undefined {
  const preferred = ships.find((ship) => ship.id === preferredId && ship.houseId === houseId && ship.status !== "building");
  return preferred ?? ships.find((ship) => ship.houseId === houseId && ship.status !== "building");
}

export function keptShipId(ships: Array<{ id: string; houseId: string }>, houseId: string, current: string): string {
  return ships.some((ship) => ship.id === current && ship.houseId === houseId) ? current : "";
}

export function keptOtherHouseId(houses: Array<{ id: string }>, playerId: string, current: string): string {
  return houses.some((house) => house.id === current && house.id !== playerId) ? current : "";
}

export function keptWorldId(worlds: Array<{ id: string }>, current: string): string {
  if (worlds.some((world) => world.id === current)) return current;
  return worlds[0]?.id ?? "";
}

export function worldOwnerName(state: SimState, world: World): string {
  return houseOf(state, world.ownerId ?? "")?.name ?? "ничей";
}

export function governorBlurb(state: SimState, world: World): string {
  const governor = personOf(state, world.governorId);
  if (!governor) return "Губернатора нет. Мир работает без местной черты.";
  const effect = governor.traits.includes("рачительный")
    ? "Черта «рачительный» снижает потребность в работниках примерно на десятую часть, рецепт партии не меняется."
    : governor.traits.includes("запасник")
      ? "Черта «запасник» замедляет падение удовлетворённости при нехватке еды."
      : "Особых хозяйственных черт нет.";
  const loyalty = governor.loyalty < 25 ? " Лояльность ниже 25, поэтому работников нужно больше." : "";
  return `${governor.name}, лояльность ${governor.loyalty}. Лояльность каждый день сдвигается на шаг к удовлетворённости мира (${world.satisfaction}). ${effect}${loyalty}`;
}
