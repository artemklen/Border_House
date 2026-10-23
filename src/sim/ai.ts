import { dispatch } from "./commands";
import { RECIPES } from "./config";
import { GOOD_NAME, type GoodId } from "./goods";
import { byId, foodCover, foodNeed, houseOf, noteAi, worldOf } from "./mutate";
import type { BuildingKind, Command, House, RouteStop, Ship, SimState, Treaty, World } from "./types";

const INPUT_BUILDING: Record<GoodId, BuildingKind> = {
  grain: "farm",
  food: "mill",
  ore: "mine",
  alloys: "smelter",
  parts: "workshop",
  fuel: "fuelwell",
};

export function planAi(state: SimState): void {
  for (const house of byId(state.houses)) {
    if (house.player) continue;
    answerProposals(state, house);
    const plans = ideas(state, house);
    let applied = 0;
    for (const plan of plans) {
      if (applied >= 2) break;
      const result = dispatch(state, plan.command);
      noteAi(state, house.id, result.ok ? plan.because : `${house.name} не смог: ${result.reason}`);
      if (result.ok) applied += 1;
    }
  }
}

function answerProposals(state: SimState, house: House): void {
  for (const treaty of state.treaties) {
    if (treaty.status !== "proposed" || treaty.targetId !== house.id) continue;
    const decision = judgeTreaty(state, house, treaty);
    dispatch(state, { type: "respondTreaty", houseId: house.id, treatyId: treaty.id, accept: decision.accept });
    noteAi(state, house.id, decision.because);
  }
}

function judgeTreaty(state: SimState, house: House, treaty: Treaty): { accept: boolean; because: string } {
  const relation = house.relation[treaty.proposerId] ?? 0;
  const capital = worldOf(state, house.capitalId);
  const cover = capital ? foodCover(capital.population, capital.stock.food, state.rules.foodPer100) : 999;
  const alternatives = state.worlds.filter((world) => {
    if (!world.ownerId || world.ownerId === house.id || world.ownerId === treaty.proposerId) return false;
    const reserve = foodNeed(world.population, state.rules.foodPer100) * 16;
    if (world.stock.food - reserve < 40) return false;
    return houseOf(state, world.ownerId)?.embargo[house.id] !== true;
  }).length;
  if (relation < -45) return { accept: false, because: `${house.name} отказывает: отношения ${relation}, ниже порога -45.` };
  if ((treaty.kind === "exchange" || treaty.kind === "supply") && cover < 22 && alternatives === 0 && treaty.qtyPerWindow >= 8) {
    return { accept: true, because: `${house.name} принимает поставки: у столицы еды на ${cover} дн., других складов больше 60 ед. нет.` };
  }
  if (treaty.kind === "transit" && cover < 20 && treaty.tariffBps <= 500) {
    return { accept: true, because: `${house.name} снижает транзитный барьер, чтобы не остановить подвоз еды.` };
  }
  if (cover >= 22) return { accept: false, because: `${house.name} отказывает: продовольствия хватает на ${cover} дн., уступать пошлину незачем.` };
  return { accept: false, because: `${house.name} отказывает: кроме просителя есть другие источники продовольствия (${alternatives}).` };
}

function ideas(state: SimState, house: House): Array<{ command: Command; because: string }> {
  const plans: Array<{ command: Command; because: string }> = [];
  const owned = byId(state.worlds).filter((world) => world.ownerId === house.id);
  const hungry = owned
    .filter((world) => foodCover(world.population, world.stock.food, state.rules.foodPer100) < 18)
    .sort((a, b) => a.stock.food / Math.max(1, a.population) - b.stock.food / Math.max(1, b.population));
  for (const world of hungry) {
    const cover = foodCover(world.population, world.stock.food, state.rules.foodPer100);
    if (!world.buildings.some((building) => building.kind === "mill" && building.remainingDays === 0) && world.stock.grain >= 20) {
      const command: Command = { type: "build", houseId: house.id, worldId: world.id, kind: "mill" };
      plans.push({ command, because: `${house.name} строит мельницу на «${world.name}»: еды на ${cover} дн., зерно уже есть.` });
      break;
    }
    if (!world.buildings.some((building) => building.kind === "farm")) {
      plans.push({
        command: { type: "build", houseId: house.id, worldId: world.id, kind: "farm" },
        because: `${house.name} закладывает ферму на «${world.name}»: своего зерна нет, запас еды на ${cover} дн.`,
      });
    }
    const source = foodSource(state, house, world);
    if (source && !linked(state, house.id, source.id, world.id, "food")) {
      const ship = idleShip(state, house.id);
      if (ship) {
        plans.push({
          command: {
            type: "createRoute",
            houseId: house.id,
            name: `Еда: ${source.name}`,
            shipId: ship.id,
            stops: foodStops(house, source, world),
          },
          because: `${house.name} везёт продовольствие «${source.name}» → «${world.name}»: запаса на ${cover} дн.`,
        });
        break;
      }
    }
    break;
  }

  for (const world of owned) {
    for (const building of world.buildings) {
      const missing = missingGood(building.stopReason);
      if (!missing) continue;
      const upstream = INPUT_BUILDING[missing];
      const source = stockSource(state, house, world, missing);
      const ship = idleShip(state, house.id);
      if (source && ship && !linked(state, house.id, source.id, world.id, missing)) {
        plans.push({
          command: {
            type: "createRoute",
            houseId: house.id,
            name: `${GOOD_NAME[missing]} → ${world.name}`,
            shipId: ship.id,
            stops: haulStops(house, source, world, missing),
          },
          because: `${house.name} везёт ${GOOD_NAME[missing]} с «${source.name}», чтобы запустить производство на «${world.name}».`,
        });
      } else if (!world.buildings.some((item) => item.kind === upstream)) {
        plans.push({
          command: { type: "build", houseId: house.id, worldId: world.id, kind: upstream },
          because: `${house.name} строит ${RECIPES[upstream].name} на «${world.name}»: производство встало без «${GOOD_NAME[missing]}», подвозить нечего.`,
        });
      }
    }
  }

  const dry = byId(state.ships).find((ship) => ship.houseId === house.id && ship.stopReason?.includes("топлив") && ship.worldId);
  if (dry?.worldId) {
    const pump = byId(state.worlds).find((world) => world.stock.fuel > 30 && (world.ownerId === house.id || world.ownerId));
    if (pump && pump.id !== dry.worldId) {
      plans.push({
        command: {
          type: "createRoute",
          houseId: house.id,
          name: `Заправка ${dry.name}`,
          shipId: dry.id,
          stops: [
            { worldId: dry.worldId, actions: [] },
            {
              worldId: pump.id,
              actions: [pump.ownerId === house.id
                ? { good: "fuel", mode: "load", amount: 40, price: 0, keep: 20 }
                : { good: "fuel", mode: "buy", amount: 30, price: 40, keep: 10 }],
            },
          ],
        },
        because: `${house.name} снимает ${dry.name} с рейса: нет топлива, ближайший запас на «${pump.name}».`,
      });
    }
  }

  for (const route of state.routes) {
    if (route.houseId !== house.id || route.paused) continue;
    if (route.lastCost > route.lastRevenue + 40 && route.lastRevenue + route.lastCost > 0) {
      plans.push({
        command: { type: "pauseRoute", routeId: route.id, paused: true },
        because: `${house.name} ставит «${route.name}» на паузу: за окно расход ${route.lastCost} кред. больше выручки ${route.lastRevenue}.`,
      });
    }
  }

  if (house.profile === "expansionist" || house.credits > 24000) {
    const home = owned.find((world) => world.stock.food >= state.rules.colonizeFood + 15 && world.stock.parts >= state.rules.colonizeParts && world.stock.fuel >= 20);
    const ship = home ? state.ships.find((item) => item.houseId === house.id && item.worldId === home.id && item.status === "docked" && !item.mission) : undefined;
    const free = byId(state.worlds).find((world) => world.ownerId === null);
    if (home && ship && free && house.credits >= state.rules.colonizeCost + 1500) {
      plans.push({
        command: { type: "colonize", houseId: house.id, shipId: ship.id, worldId: free.id },
        because: `${house.name} снаряжает колонию на «${free.name}»: есть продовольствие, комплектующие и ${house.credits} кред.`,
      });
    }
  }

  const capital = worldOf(state, house.capitalId);
  const cover = capital ? foodCover(capital.population, capital.stock.food, state.rules.foodPer100) : 999;
  const gate = owned.find((world) => world.tariffBps >= 700) ?? owned[0];
  if (gate && cover < 14 && gate.tariffBps > 350) {
    plans.push({
      command: { type: "setTariff", houseId: house.id, worldId: gate.id, tariffBps: 300 },
      because: `${house.name} снижает пошлину «${gate.name}» до 3%: еды в столице на ${cover} дн., сбор важнее не спугнуть поставщика.`,
    });
  } else if (gate && cover > 40 && gate.tariffBps < 900 && house.lastFlow.tariffsIn > 100) {
    plans.push({
      command: { type: "setTariff", houseId: house.id, worldId: gate.id, tariffBps: 1000 },
      because: `${house.name} поднимает пошлину «${gate.name}»: еды на ${cover} дн., прошлый транзит принёс ${house.lastFlow.tariffsIn} кред.`,
    });
  }

  if (cover < 12) {
    for (const [otherId, closed] of Object.entries(house.embargo)) {
      if (!closed) continue;
      const supplier = worldOf(state, houseOf(state, otherId)?.capitalId ?? null);
      if (supplier && supplier.stock.food > 40) {
        plans.push({
          command: { type: "setEmbargo", houseId: house.id, otherId, embargo: false },
          because: `${house.name} снимает эмбарго: без чужого продовольствия столица не протянет.`,
        });
        break;
      }
    }
  }
  return plans;
}

function foodStops(house: House, source: World, dest: World): RouteStop[] {
  const outbound = source.ownerId === house.id
    ? { good: "food" as const, mode: "load" as const, amount: 40, price: 0, keep: 40 }
    : { good: "food" as const, mode: "buy" as const, amount: 36, price: 48, keep: 20 };
  const inbound = dest.ownerId === house.id
    ? { good: "food" as const, mode: "unload" as const, amount: 40, price: 0, keep: 0 }
    : { good: "food" as const, mode: "sell" as const, amount: 36, price: 1, keep: 0 };
  return [
    { worldId: source.id, actions: [outbound, { good: "fuel", mode: source.ownerId === house.id ? "load" : "buy", amount: 20, price: 30, keep: 10 }] },
    { worldId: dest.id, actions: [inbound] },
  ];
}

function haulStops(house: House, source: World, dest: World, good: GoodId): RouteStop[] {
  const take = source.ownerId === house.id
    ? { good, mode: "load" as const, amount: 30, price: 0, keep: 8 }
    : { good, mode: "buy" as const, amount: 24, price: 80, keep: 6 };
  const drop = dest.ownerId === house.id
    ? { good, mode: "unload" as const, amount: 30, price: 0, keep: 0 }
    : { good, mode: "sell" as const, amount: 24, price: 1, keep: 0 };
  return [
    { worldId: source.id, actions: [take] },
    { worldId: dest.id, actions: [drop] },
  ];
}

function foodSource(state: SimState, house: House, dest: World): World | undefined {
  return byId(state.worlds)
    .filter((world) => world.id !== dest.id && world.stock.food > 50)
    .filter((world) => !world.ownerId || world.ownerId === house.id || houseOf(state, world.ownerId)?.embargo[house.id] !== true)
    .sort((a, b) => a.prices.food - b.prices.food || a.x - b.x)[0];
}

function stockSource(state: SimState, house: House, dest: World, good: GoodId): World | undefined {
  return byId(state.worlds).find((world) => world.id !== dest.id && world.stock[good] > 16 && (world.ownerId === house.id || world.ownerId));
}

function linked(state: SimState, houseId: string, a: string, b: string, good: GoodId): boolean {
  return state.routes.some((route) => {
    if (route.houseId !== houseId || route.paused) return false;
    const worlds = route.stops.map((stop) => stop.worldId);
    const mentions = route.stops.some((stop) => stop.actions.some((action) => action.good === good));
    return mentions && worlds.includes(a) && worlds.includes(b);
  });
}

function idleShip(state: SimState, houseId: string): Ship | undefined {
  return byId(state.ships).find((ship) => ship.houseId === houseId && ship.status === "docked" && !ship.routeId && !ship.mission);
}

function missingGood(reason: string | null): GoodId | null {
  if (!reason?.startsWith("не хватает:")) return null;
  const label = reason.slice("не хватает:".length).trim();
  const found = (Object.entries(GOOD_NAME) as Array<[GoodId, string]>).find(([, name]) => name === label);
  return found?.[0] ?? null;
}
