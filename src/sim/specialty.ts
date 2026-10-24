import { availableCredits, createGoods, destroyGoods, houseOf, moveCredits, note, sinkCredits, worldOf } from "./mutate";
import type { CommandResult, Development, DevelopmentPath, Recipe, SimState, World } from "./types";
import type { GoodId } from "./goods";

export const PATH_LABEL: Record<DevelopmentPath, string> = {
  agrarian: "аграрный",
  industrial: "промышленный",
  transit: "транзитный",
};

const COST: Record<DevelopmentPath, [number, number]> = {
  agrarian: [1600, 2400],
  industrial: [2000, 2800],
  transit: [1400, 2000],
};
const PARTS: Record<DevelopmentPath, [number, number]> = {
  agrarian: [6, 8],
  industrial: [8, 10],
  transit: [4, 6],
};
const DAYS: Record<DevelopmentPath, [number, number]> = {
  agrarian: [5, 6],
  industrial: [6, 7],
  transit: [4, 5],
};
const TRANSIT_UPKEEP = [0, 5, 10];
const TRANSIT_THROUGHPUT = 40;

export function emptyDevelopment(): Development {
  return { path: null, level: 0, suspended: false, invested: 0, project: null, upkeepPaid: true };
}

export function levelCost(path: DevelopmentPath, level: 1 | 2): { cost: number; parts: number; days: number } {
  return { cost: COST[path][level - 1], parts: PARTS[path][level - 1], days: DAYS[path][level - 1] };
}

export function appliedDevelopment(world: World): Development | null {
  const dev = world.development;
  if (!dev?.path || dev.level <= 0 || dev.suspended) return null;
  if (dev.path === "transit" && !dev.upkeepPaid) return null;
  return dev;
}

export function transitThroughputBonus(world: World): number {
  const dev = appliedDevelopment(world);
  if (!dev || dev.path !== "transit") return 0;
  return TRANSIT_THROUGHPUT * dev.level;
}

export function transitFuelDiscount(world: World, houseId: string): number {
  const dev = appliedDevelopment(world);
  if (!dev || dev.path !== "transit" || world.ownerId !== houseId) return 0;
  return dev.level;
}

export function transitUpkeep(world: World): number {
  const dev = world.development;
  if (!dev?.path || dev.path !== "transit" || dev.level <= 0 || dev.suspended) return 0;
  return TRANSIT_UPKEEP[dev.level] ?? 0;
}

interface Batch {
  inputs: Partial<Record<GoodId, number>>;
  outputs: Partial<Record<GoodId, number>>;
  workers: number;
}

export function intendedInputs(world: World, recipe: Recipe): Partial<Record<GoodId, number>> {
  const inputs = { ...recipe.inputs };
  const dev = appliedDevelopment(world);
  if (!dev) return inputs;
  if (dev.path === "agrarian" && recipe.kind === "mill") inputs.grain = (inputs.grain ?? 0) + (dev.level === 1 ? 2 : 4);
  if (dev.path === "industrial" && recipe.kind === "smelter") inputs.ore = (inputs.ore ?? 0) + (dev.level === 1 ? 2 : 4);
  if (dev.path === "industrial" && recipe.kind === "workshop") inputs.alloys = (inputs.alloys ?? 0) + (dev.level === 1 ? 1 : 2);
  return inputs;
}

/** Фактическая партия: бонус переработки берётся только если дополнительное сырьё уже лежит на складе. */
export function plannedBatch(world: World, recipe: Recipe): Batch {
  const inputs = { ...recipe.inputs };
  const outputs = { ...recipe.outputs };
  let workers = recipe.workers;
  const dev = appliedDevelopment(world);
  if (!dev) return { inputs, outputs, workers };
  if (dev.path === "agrarian" && recipe.kind === "farm") outputs.grain = (outputs.grain ?? 0) + (dev.level === 1 ? 4 : 8);
  if (dev.path === "agrarian" && recipe.kind === "mill") {
    const extra = dev.level === 1 ? 2 : 4;
    if (world.stock.grain >= (inputs.grain ?? 0) + extra) {
      inputs.grain = (inputs.grain ?? 0) + extra;
      outputs.food = (outputs.food ?? 0) + extra;
    }
  }
  if (dev.path === "industrial" && (recipe.kind === "smelter" || recipe.kind === "workshop")) {
    workers += dev.level === 1 ? 2 : 4;
    if (recipe.kind === "smelter") {
      const extraIn = dev.level === 1 ? 2 : 4;
      const extraOut = dev.level === 1 ? 1 : 2;
      if (world.stock.ore >= (inputs.ore ?? 0) + extraIn) {
        inputs.ore = (inputs.ore ?? 0) + extraIn;
        outputs.alloys = (outputs.alloys ?? 0) + extraOut;
      }
    }
    if (recipe.kind === "workshop") {
      const extraIn = dev.level === 1 ? 1 : 2;
      if (world.stock.alloys >= (inputs.alloys ?? 0) + extraIn) {
        inputs.alloys = (inputs.alloys ?? 0) + extraIn;
        outputs.parts = (outputs.parts ?? 0) + 1;
      }
    }
  }
  return { inputs, outputs, workers };
}

export function developmentBlock(state: SimState, houseId: string, worldId: string, path: DevelopmentPath): string | null {
  const house = houseOf(state, houseId);
  const world = worldOf(state, worldId);
  if (!house || !world) return "нет такого мира";
  if (world.ownerId !== house.id) return "путь выбирает только владелец мира";
  const dev = world.development;
  if (!dev) return "у мира нет учёта развития";
  if (dev.project) return "в мире уже идёт перестройка";
  if (dev.path === path && dev.level >= 2) return "этот путь уже доведён до второго уровня";
  const target: 1 | 2 = dev.path === path && dev.level === 1 ? 2 : 1;
  const ready = pathReady(state, world, path);
  if (ready) return ready;
  const price = levelCost(path, target);
  const partsHeld = colonyPartsHeld(state, world.id);
  const partsFree = world.stock.parts - partsHeld;
  if (partsFree < price.parts) {
    return partsHeld > 0
      ? `нужно ${price.parts} комплектующих сверх ${partsHeld} для колонии, свободно ${Math.max(0, partsFree)}`
      : `нужно ${price.parts} комплектующих на складе, есть ${world.stock.parts}`;
  }
  const creditsHeld = colonyCreditsHeld(state, house.id);
  if (availableCredits(house) - creditsHeld < price.cost) return `нужно ${price.cost} свободных кредитов`;
  return null;
}

export function developWorld(state: SimState, houseId: string, worldId: string, path: DevelopmentPath): CommandResult {
  const blocked = developmentBlock(state, houseId, worldId, path);
  if (blocked) return { ok: false, reason: blocked };
  const house = houseOf(state, houseId)!;
  const world = worldOf(state, worldId)!;
  const dev = world.development;
  const switching = Boolean(dev.path && dev.path !== path);
  const target: 1 | 2 = dev.path === path && dev.level === 1 ? 2 : 1;
  const price = levelCost(path, target);
  if (!destroyGoods(world.stock, state.accounts, "parts", price.parts)) return { ok: false, reason: `нужно ${price.parts} комплектующих на складе, есть ${world.stock.parts}` };
  if (!moveCredits(state, { kind: "house", id: house.id }, { kind: "pop", worldId: world.id }, price.cost)) {
    createGoods(world.stock, state.accounts, "parts", price.parts);
    return { ok: false, reason: `нужно ${price.cost} свободных кредитов` };
  }
  house.flow.construction += price.cost;
  dev.project = { path, targetLevel: target, remainingDays: price.days, spent: price.cost, kind: switching ? "switch" : "build" };
  if (switching) dev.suspended = true;
  const loss = switching ? ` Прежний путь «${PATH_LABEL[dev.path!]}» молчит, пока идёт стройка. Уже вложенные ${dev.invested} кред. не вернутся.` : "";
  note(state, house.id, `«${world.name}»: начат ${PATH_LABEL[path]} путь, уровень ${target}. ${price.cost} кред. переданы населению, ${price.parts} комплектующих списаны, срок ${price.days} дн.${loss} Бонус появится только в день завершения.`);
  return { ok: true, reason: `${PATH_LABEL[path]} путь заложен` };
}

export function cancelDevelopment(state: SimState, houseId: string, worldId: string): CommandResult {
  const house = houseOf(state, houseId);
  const world = worldOf(state, worldId);
  if (!house || !world) return { ok: false, reason: "нет такого мира" };
  if (world.ownerId !== house.id) return { ok: false, reason: "стройку отменяет только владелец" };
  const project = world.development?.project;
  if (!project) return { ok: false, reason: "стройки нет" };
  const want = Math.floor(project.spent / 2);
  const back = Math.min(want, world.popWallet);
    if (back > 0) {
    moveCredits(state, { kind: "pop", worldId: world.id }, { kind: "house", id: house.id }, back);
    house.flow.construction -= back;
  }
  const wasSwitch = project.kind === "switch";
  world.development.project = null;
  if (wasSwitch) world.development.suspended = false;
  note(state, house.id, `«${world.name}»: перестройка отменена. Населению осталась плата, дому вернулось ${back} из ${project.spent} кред. Комплектующие не возвращены, повторный бонус за отмену не выдаётся.`);
  return { ok: true, reason: "стройка отменена" };
}

export function advanceDevelopments(state: SimState): void {
  for (const world of state.worlds) {
    const dev = world.development;
    if (!dev) continue;
    if (dev.project) {
      dev.project.remainingDays -= 1;
      if (dev.project.remainingDays <= 0) finishProject(state, world);
    }
    const due = transitUpkeep(world);
    if (due <= 0 || !world.ownerId) {
      if (dev.path !== "transit" || dev.level === 0 || dev.suspended) dev.upkeepPaid = true;
      continue;
    }
    const owner = houseOf(state, world.ownerId);
    dev.upkeepPaid = Boolean(owner) && sinkCredits(state, { kind: "house", id: world.ownerId }, due);
    if (dev.upkeepPaid && owner) owner.flow.upkeep += due;
    else if (owner) note(state, owner.id, `«${world.name}»: содержание транзитного пути ${due} кред. не оплачено. Сегодня нет ни надбавки к порту, ни скидки на топливо. Уровень пути сохранён.`);
  }
}

export function developmentIdea(state: SimState, houseId: string): { command: { type: "developWorld"; houseId: string; worldId: string; path: DevelopmentPath }; because: string } | null {
  const house = houseOf(state, houseId);
  if (!house) return null;
  const owned = state.worlds.filter((world) => world.ownerId === house.id);
  const used = new Set(owned.map((world) => world.development?.path).filter((path): path is DevelopmentPath => Boolean(path)));
  let best: { world: World; path: DevelopmentPath; score: number } | null = null;
  for (const world of owned) {
    if (world.development?.project || (world.development?.level ?? 0) >= 2) continue;
    if (world.development?.path) {
      const path = world.development.path;
      const score = pathScores(state, houseId, world)[path];
      if (world.development.level === 1 && score > 0 && !developmentBlock(state, houseId, world.id, path)) {
        if (!best || score > best.score) best = { world, path, score };
      }
      continue;
    }
    const scores = pathScores(state, houseId, world);
    const ranked = (Object.entries(scores) as Array<[DevelopmentPath, number]>).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    for (const [path, score] of ranked) {
      if (score <= 0) continue;
      if (used.has(path) && ranked.some(([other, value]) => other !== path && value > 0 && !used.has(other) && !developmentBlock(state, houseId, world.id, other))) continue;
      if (developmentBlock(state, houseId, world.id, path)) continue;
      if (!best || score > best.score) best = { world, path, score };
      break;
    }
  }
  if (!best) return null;
  return {
    command: { type: "developWorld", houseId, worldId: best.world.id, path: best.path },
    because: `${house.name} выбирает ${PATH_LABEL[best.path]} путь на «${best.world.name}»: местные ресурсы и рейсы дают ему перевес, а не общий шаблон для всех миров.`,
  };
}

export function developmentText(world: World): string {
  const dev = world.development;
  if (!dev) return "Учёт развития ещё не записан.";
  const current = dev.path ? `${PATH_LABEL[dev.path]} путь, уровень ${dev.level}` : "путь не выбран";
  const live = appliedDevelopment(world);
  const fact = live
    ? `Сейчас действует ${PATH_LABEL[live.path!]} ${live.level}: ${effectLine(live.path!, live.level === 2 ? 2 : 1)}.`
    : dev.suspended
      ? "Сейчас бонуса нет: идёт смена пути, прежний эффект заморожен."
      : "Сейчас бонуса нет.";
  const project = dev.project
    ? `Стройка: ${PATH_LABEL[dev.project.path]} уровень ${dev.project.targetLevel}, осталось ${dev.project.remainingDays} дн., уплачено ${dev.project.spent} кред. Отмена вернёт половину этой платы, если деньги ещё у населения, и не вернёт комплектующие.`
    : "Стройки развития нет.";
  const upkeep = transitUpkeep(world);
  return `${current}. Вложено ${dev.invested} кред. ${fact} ${project} ${upkeep > 0 ? `Содержание транзита ${upkeep} кред./день, сегодня ${dev.upkeepPaid ? "оплачено" : "не оплачено"}.` : ""} Оценка, не текущий выпуск: аграрный уровень даёт ферме +4 или +8 зерна и мельнице +2 или +4 еды за столько же зерна. Промышленный уровень даёт плавильне +1 или +2 сплава за +2 или +4 руды и мастерской +1 комплектующую за +1 или +2 сплава, плюс 2 или 4 работника; без сырья бонус не появляется. Транзит добавляет 40 или 80 ед. к общему бюджету порта и снимает 1 или 2 ед. топлива с отхода своих кораблей. Склад не растёт. Месторождение само не пополняется.`;
}

function effectLine(path: DevelopmentPath, level: 1 | 2): string {
  if (path === "agrarian") return level === 1 ? "ферма +4 зерна, мельница +2 еды за +2 зерна" : "ферма +8 зерна, мельница +4 еды за +4 зерна";
  if (path === "industrial") return level === 1 ? "плавильня +1 сплав за +2 руды, мастерская +1 комплектующую за +1 сплав, +2 работника" : "плавильня +2 сплава за +4 руды, мастерская +1 комплектующую за +2 сплава, +4 работника";
  return level === 1 ? "+40 ед. пропускной способности порта и −1 топлива на отход" : "+80 ед. пропускной способности и −2 топлива на отход";
}

function finishProject(state: SimState, world: World): void {
  const dev = world.development;
  const project = dev.project;
  if (!project || !world.ownerId) return;
  const ready = pathReady(state, world, project.path);
  if (ready) {
    dev.project = null;
    if (project.kind === "switch") dev.suspended = false;
    note(state, world.ownerId, `«${world.name}»: ${PATH_LABEL[project.path]} путь не завершён. ${ready} Уплаченные деньги и комплектующие не возвращены.`);
    return;
  }
  if (project.kind === "switch") dev.invested = project.spent;
  else dev.invested += project.spent;
  dev.path = project.path;
  dev.level = project.targetLevel;
  dev.suspended = false;
  dev.project = null;
  note(state, world.ownerId, `«${world.name}»: ${PATH_LABEL[project.path]} путь достиг уровня ${project.targetLevel}. Бонус включён. Складская ёмкость ${world.capacity} не изменилась.`);
}

function pathReady(state: SimState, world: World, path: DevelopmentPath): string | null {
  const built = (kind: string) => world.buildings.some((building) => building.kind === kind && building.remainingDays <= 0);
  if (path === "agrarian" && !built("farm") && !built("mill")) return "аграрному пути нужна готовая ферма или мельница";
  if (path === "industrial" && world.deposits.ore <= 0 && !built("smelter") && !built("workshop")) return "промышленному пути нужна руда в месторождении или готовая плавильня либо мастерская";
  if (path === "transit" && !state.routes.some((route) => route.houseId === world.ownerId && !route.paused && route.stops.some((stop) => stop.worldId === world.id))) {
    return "транзитному пути нужен действующий маршрут дома через этот мир";
  }
  return null;
}

function colonyPartsHeld(state: SimState, worldId: string): number {
  let held = 0;
  for (const ship of state.ships) {
    if (ship.mission?.type !== "colonize" || ship.worldId !== worldId) continue;
    held += Math.max(0, state.rules.colonizeParts - ship.cargo.parts);
  }
  return held;
}

function colonyCreditsHeld(state: SimState, houseId: string): number {
  let held = 0;
  for (const ship of state.ships) {
    if (ship.houseId !== houseId || ship.mission?.type !== "colonize") continue;
    held += state.rules.colonizeCost;
  }
  return held;
}

function pathScores(state: SimState, houseId: string, world: World): Record<DevelopmentPath, number> {
  const built = (kind: string) => world.buildings.some((building) => building.kind === kind && building.remainingDays <= 0);
  const routes = state.routes.filter((route) => route.houseId === houseId && !route.paused && route.stops.some((stop) => stop.worldId === world.id)).length;
  const house = houseOf(state, houseId);
  return {
    agrarian: (built("farm") ? 3 : 0) + (built("mill") ? 3 : 0) + (world.stock.grain > 20 ? 1 : 0),
    industrial: (world.deposits.ore > 0 ? 3 : 0) + (built("smelter") || built("workshop") ? 3 : 0) + (house?.profile === "industrial" ? 1 : 0),
    transit: routes + world.port.queue.length + (house?.profile === "merchant" ? 2 : 0),
  };
}
