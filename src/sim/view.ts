import { RECIPES, SHIP_CLASSES } from "./config";
import { GOODS, GOOD_NAME, type GoodId } from "./goods";
import { foodCover, foodNeed, houseOf, personOf, routeOf, worldOf } from "./mutate";
import { territoriesOnRoute } from "./simulate";
import type { House, Ship, SimState, World } from "./types";

export function formatDay(state: SimState): string {
  const year = Math.floor(state.tick / state.rules.ticksPerYear) + 1;
  const day = (state.tick % state.rules.ticksPerYear) + 1;
  return `год ${year}, день ${day}`;
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
    const inputs = GOODS.filter((good) => recipe.inputs[good]).map((good) => `${recipe.inputs[good]} ${GOOD_NAME[good]}`).join(", ") || "без сырья";
    const outputs = GOODS.filter((good) => recipe.outputs[good]).map((good) => `${recipe.outputs[good]} ${GOOD_NAME[good]}`).join(", ");
    const reason = building.stopReason ? `Сейчас стоит: ${building.stopReason}.` : "Полная партия идёт.";
    return `${recipe.name}: ${inputs} → ${outputs} за день. Нужно работников: ${recipe.workers}, на месте ${building.workers}. Содержание ${recipe.upkeep} кред./день уходит в сток «содержание», зарплата ${state.rules.wage} кред. за человека переходит населению. ${reason}`;
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
    const index = route.stops.findIndex((stop) => stop.worldId === ship.worldId);
    const next = route.stops[(Math.max(index, 0) + 1) % route.stops.length];
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
    const need = foodNeed(world.population, state.rules.foodPer100);
    if (need > 0 && cover < 10) {
      items.push({ title: `${world.name}: еда на ${cover} дн.`, detail: `Население ${world.population} съедает ${need} ед./день. На складе ${world.stock.food}. Удовлетворённость ${world.satisfaction}.` });
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
    if (world.ownerId === house.id) eaten += world.lastEaten || world.eaten;
  }
  for (const other of state.houses) {
    if (other.id === house.id) continue;
    let imported = 0;
    for (const world of state.worlds) {
      if (world.ownerId !== house.id) continue;
      imported += world.lastImported[other.id]?.food ?? world.imported[other.id]?.food ?? 0;
    }
    const share = eaten > 0 ? Math.round((imported / eaten) * 100) : 0;
    const tariff = state.worlds.filter((world) => world.ownerId === other.id).reduce((sum, world) => sum + world.tariffBps, 0);
    lines.push(
      `${other.name}: отношения ${house.relation[other.id] ?? 0}. Доля их продовольствия в последнем учёте ${share}% (${imported} ед. к ${eaten} съеденным). Их средняя пошлина по мирам задаётся отдельно, сумма ставок ${tariff / 100} п.п. Оборот с ними за окно ${house.lastTradeWith[other.id] ?? house.tradeWith[other.id] ?? 0} кред. Эмбарго с нашей стороны: ${house.embargo[other.id] ? "да" : "нет"}.`,
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
  if (routes.length === 0) {
    tips.push("Хлебный Пояс уже печёт продовольствие. Откройте «Флот», соберите маршрут из двух миров и назначьте грузовоз. Короткий путь к Порту Лиры пересекает Заставу Корвус.");
  }
  const idle = state.ships.find((ship) => ship.houseId === player.id && ship.status === "docked" && !ship.routeId);
  if (idle && routes.length > 0) tips.push(`${idle.name} стоит без маршрута. Назначение в «Флоте» не телепортирует груз: корабль поедет от текущего мира.`);
  const stuck = bottlenecks(state, player.id)[0];
  if (stuck) tips.push(`Узкое место: ${stuck.title}. ${stuck.detail}`);
  return tips.slice(0, 3);
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
