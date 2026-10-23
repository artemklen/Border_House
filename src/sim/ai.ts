import { dispatch } from "./commands";
import { RECIPES, SHIP_CLASSES } from "./config";
import { GOOD_NAME, sumGoods, type GoodId } from "./goods";
import { byId, distance, foodCover, foodNeed, houseOf, noteAi, worldOf } from "./mutate";
import type { BuildingKind, Command, House, Route, RouteStop, Ship, SimState, Treaty, World } from "./types";

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
  const reserved = new Set<string>();
  const owned = byId(state.worlds).filter((world) => world.ownerId === house.id);
  const hungry = owned
    .filter((world) => foodCover(world.population, world.stock.food, state.rules.foodPer100) < 18)
    .sort((a, b) => a.stock.food / Math.max(1, a.population) - b.stock.food / Math.max(1, b.population));
  for (const world of hungry) {
    const cover = foodCover(world.population, world.stock.food, state.rules.foodPer100);
    if (!world.buildings.some((building) => building.kind === "mill") && world.stock.grain >= 20) {
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
      const ship = idleShip(state, house.id, reserved);
      if (ship) {
        reserved.add(ship.id);
        plans.push({
          command: {
            type: "createRoute",
            houseId: house.id,
            name: `Еда: ${source.name}`,
            shipId: ship.id,
            stops: foodStops(house, ship, source, world),
            autoFuel: true,
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
      const ship = idleShip(state, house.id, reserved);
      if (source && ship && !linked(state, house.id, source.id, world.id, missing)) {
        reserved.add(ship.id);
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
      } else if (!world.buildings.some((item) => item.kind === upstream) && canExtract(world, upstream)) {
        plans.push({
          command: { type: "build", houseId: house.id, worldId: world.id, kind: upstream },
          because: `${house.name} строит ${RECIPES[upstream].name} на «${world.name}»: производство встало без «${GOOD_NAME[missing]}», подвозить нечего.`,
        });
      }
    }
  }

  const dry = byId(state.ships).find((ship) => {
    if (ship.houseId !== house.id || !ship.stopReason?.includes("топлив") || !ship.worldId || ship.status === "transit") return false;
    const route = state.routes.find((item) => item.id === ship.routeId && item.autoFuel);
    if (!route) return true;
    const here = worldOf(state, ship.worldId);
    if (!here) return true;
    const owner = here.ownerId ? houseOf(state, here.ownerId) : undefined;
    const open = !here.ownerId || here.ownerId === house.id || owner?.embargo[house.id] !== true;
    return !(open && here.stock.fuel > 0);
  });
  const refuelName = dry ? `Заправка ${dry.name}` : "";
  const alreadyRefueling = dry ? state.routes.some((route) => route.houseId === house.id && route.name === refuelName) : false;
  if (dry?.worldId && !alreadyRefueling && !reserved.has(dry.id)) {
    const here = worldOf(state, dry.worldId);
    const reachable = here ? reachableFuelWorld(state, dry, here) : undefined;
    const reserve = 8;
    const room = here ? SHIP_CLASSES[dry.classId].capacity - sumGoods(dry.cargo) : 0;
    const portOwner = here?.ownerId ? houseOf(state, here.ownerId) : undefined;
    const localOpen = Boolean(portOwner) && (here?.ownerId === house.id || portOwner?.embargo[house.id] !== true);
    const gained = here && localOpen ? Math.max(0, Math.min(24, here.stock.fuel - reserve, room)) : 0;
    const elsewhere = here
      ? byId(state.worlds).find((world) => world.id !== here.id && (world.ownerId === house.id || (world.ownerId !== null && houseOf(state, world.ownerId)?.embargo[house.id] !== true)))
      : undefined;
    const destination = reachable ?? (gained > 0 ? elsewhere : undefined);
    if (here && destination) {
      reserved.add(dry.id);
      const takeHere = gained > 0;
      plans.push({
        command: {
          type: "createRoute",
          houseId: house.id,
          name: refuelName,
          shipId: dry.id,
          returnRouteId: state.routes.find((route) => route.id === dry.routeId && route.autoFuel)?.id,
          stops: [
            {
              worldId: here.id,
              actions: takeHere
                ? [here.ownerId === house.id
                  ? { good: "fuel", mode: "load", amount: gained, price: 0, keep: reserve }
                  : { good: "fuel", mode: "buy", amount: gained, price: 40, keep: reserve }]
                : [],
            },
            {
              worldId: destination.id,
              actions: reachable
                ? [reachable.ownerId === house.id
                  ? { good: "fuel", mode: "load", amount: 40, price: 0, keep: 20 }
                  : { good: "fuel", mode: "buy", amount: 30, price: 40, keep: 10 }]
                : [],
            },
          ],
        },
        because: reachable
          ? `${house.name} снимает ${dry.name} с рейса: нет топлива, ближайший достижимый запас на «${reachable.name}».`
          : `${house.name} заправляет ${dry.name} на «${here.name}»: местного топлива хватает, чтобы сняться с мели.`,
      });
    }
  }

  for (const route of state.routes) {
    if (route.houseId !== house.id || route.paused) continue;
    if (feedsOwnWorld(state, route)) continue;
    if (route.lastCost > route.lastRevenue + 40 && route.lastRevenue + route.lastCost > 0) {
      plans.push({
        command: { type: "pauseRoute", routeId: route.id, paused: true },
        because: `${house.name} ставит «${route.name}» на паузу: за окно расход ${route.lastCost} кред. больше выручки ${route.lastRevenue}.`,
      });
    }
  }

  if (house.profile === "expansionist" || house.credits > 24000) {
    const home = owned.find((world) => world.stock.food >= state.rules.colonizeFood + 15 && world.stock.parts >= state.rules.colonizeParts && world.stock.fuel >= 20);
    const ship = home ? state.ships.find((item) => item.houseId === house.id && item.worldId === home.id && item.status === "docked" && !item.mission && !reserved.has(item.id)) : undefined;
    const free = byId(state.worlds).find((world) => world.ownerId === null);
    if (home && ship && free && house.credits >= state.rules.colonizeCost + 1500) {
      reserved.add(ship.id);
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

function feedsOwnWorld(state: SimState, route: { houseId: string; stops: RouteStop[] }): boolean {
  const sells = route.stops.some((stop) => stop.actions.some((action) => action.mode === "sell"));
  if (sells) return false;
  return route.stops.some((stop) => {
    const world = worldOf(state, stop.worldId);
    return world?.ownerId === route.houseId && stop.actions.some((action) => action.mode === "unload");
  });
}

function canExtract(world: World, kind: BuildingKind): boolean {
  const deposit = RECIPES[kind].deposit;
  return deposit === null || world.deposits[deposit] > 0;
}

function foodStops(house: House, ship: Ship, source: World, dest: World): RouteStop[] {
  const foodAmount = source.ownerId === house.id ? 40 : 36;
  const outbound = source.ownerId === house.id
    ? { good: "food" as const, mode: "load" as const, amount: foodAmount, price: 0, keep: 40 }
    : { good: "food" as const, mode: "buy" as const, amount: foodAmount, price: 48, keep: 20 };
  const inbound = dest.ownerId === house.id
    ? { good: "food" as const, mode: "unload" as const, amount: 40, price: 0, keep: 0 }
    : { good: "food" as const, mode: "sell" as const, amount: 36, price: 1, keep: 0 };
  const voyage = fuelForLeg(ship, source, dest) + fuelForLeg(ship, dest, source);
  const free = SHIP_CLASSES[ship.classId].capacity - sumGoods(ship.cargo);
  const amount = Math.max(0, Math.min(voyage - ship.cargo.fuel, free));
  const actions: RouteStop["actions"] = [];
  if (amount > 0) {
    actions.push({ good: "fuel", mode: source.ownerId === house.id ? "load" : "buy", amount, price: 30, keep: 0 });
  }
  actions.push(outbound);
  return [
    { worldId: source.id, actions },
    { worldId: dest.id, actions: [inbound] },
  ];
}

/** На следующем заходе добирает топливо на круг. Пока его не хватает, еда не занимает трюм. */
export function refreshFoodFuel(state: SimState, ship: Ship, world: World, route: Route): void {
  if (!route.autoFuel) return;
  const here = route.stops.find((stop) => stop.worldId === world.id);
  const there = route.stops.find((stop) => stop.worldId !== world.id);
  if (!here || !there || !isFuelPickup(here, route)) return;
  const dest = worldOf(state, there.worldId);
  if (!dest) return;
  const voyage = fuelForLeg(ship, world, dest) + fuelForLeg(ship, dest, world);
  const deficit = Math.max(0, voyage - ship.cargo.fuel);
  if (deficit > 0) {
    const food = here.actions.filter(isFoodTake);
    if (food.length > 0) {
      route.pausedFood = food;
      here.actions = here.actions.filter((action) => !food.includes(action));
      ship.visitKey = "";
    }
    const fuel = here.actions.find((action) => action.good === "fuel" && (action.mode === "load" || action.mode === "buy"));
    if (!fuel) {
      here.actions.unshift({
        good: "fuel",
        mode: world.ownerId === ship.houseId ? "load" : "buy",
        amount: deficit,
        price: 30,
        keep: 0,
      });
      ship.visitKey = "";
      return;
    }
    if (fuel.amount !== deficit || fuel.keep !== 0) {
      fuel.amount = deficit;
      fuel.keep = 0;
      ship.visitKey = "";
    }
    return;
  }
  const fuel = here.actions.find((action) => action.good === "fuel" && (action.mode === "load" || action.mode === "buy"));
  if (fuel) {
    here.actions = here.actions.filter((action) => action !== fuel);
    ship.visitKey = "";
  }
  if (route.pausedFood?.length && !here.actions.some(isFoodTake)) {
    here.actions.push(...route.pausedFood);
    delete route.pausedFood;
    ship.visitKey = "";
  }
}

export function foodRouteNeedsFuel(state: SimState, ship: Ship, route: Route): boolean {
  if (!route.autoFuel || !ship.worldId) return false;
  const here = route.stops.find((stop) => stop.worldId === ship.worldId);
  const there = route.stops.find((stop) => stop.worldId !== ship.worldId);
  if (!here || !there || !isFuelPickup(here, route)) return false;
  if (route.pausedFood?.length) return true;
  const origin = worldOf(state, ship.worldId);
  const dest = worldOf(state, there.worldId);
  if (!origin || !dest) return false;
  const voyage = fuelForLeg(ship, origin, dest) + fuelForLeg(ship, dest, origin);
  return ship.cargo.fuel < voyage;
}

function isFoodTake(action: RouteStop["actions"][number]): boolean {
  return action.good === "food" && (action.mode === "load" || action.mode === "buy");
}

function isFuelPickup(stop: RouteStop, route: Route): boolean {
  const dropsFood = stop.actions.some((action) => action.good === "food" && (action.mode === "unload" || action.mode === "sell"));
  return stop.actions.some(isFoodTake) || (Boolean(route.pausedFood?.length) && !dropsFood);
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

function fuelForLeg(ship: Ship, from: World, to: World): number {
  const shipClass = SHIP_CLASSES[ship.classId];
  return Math.max(1, Math.ceil((distance(from, to) * shipClass.fuelPer1000) / 1000));
}

function reachableFuelWorld(state: SimState, ship: Ship, here: World): World | undefined {
  const reserve = 8;
  const room = SHIP_CLASSES[ship.classId].capacity - sumGoods(ship.cargo);
  const gained = here.ownerId && here.stock.fuel > reserve ? Math.max(0, Math.min(24, here.stock.fuel - reserve, room)) : 0;
  const aboard = ship.cargo.fuel + gained;
  return byId(state.worlds)
    .filter((world) => {
      if (world.id === here.id || world.stock.fuel <= 30 || fuelForLeg(ship, here, world) > aboard) return false;
      return !world.ownerId || world.ownerId === ship.houseId || houseOf(state, world.ownerId)?.embargo[ship.houseId] !== true;
    })
    .sort((a, b) => distance(here, a) - distance(here, b))[0];
}

function stockSource(state: SimState, house: House, dest: World, good: GoodId): World | undefined {
  return byId(state.worlds).find((world) => {
    if (world.id === dest.id || world.stock[good] <= 16 || !world.ownerId) return false;
    return world.ownerId === house.id || houseOf(state, world.ownerId)?.embargo[house.id] !== true;
  });
}

function linked(state: SimState, houseId: string, a: string, b: string, good: GoodId): boolean {
  return state.routes.some((route) => {
    if (route.houseId !== houseId || route.paused) return false;
    if (!state.ships.some((ship) => ship.routeId === route.id)) return false;
    const delivers = route.stops.some((stop) => stop.worldId === b && stop.actions.some((action) => action.good === good && (action.mode === "unload" || action.mode === "sell")));
    return delivers && route.stops.some((stop) => stop.worldId === a);
  });
}

function idleShip(state: SimState, houseId: string, reserved: ReadonlySet<string>): Ship | undefined {
  return byId(state.ships).find((ship) => ship.houseId === houseId && ship.status === "docked" && !ship.routeId && !ship.mission && !reserved.has(ship.id));
}

function missingGood(reason: string | null): GoodId | null {
  if (!reason?.startsWith("не хватает:")) return null;
  const label = reason.slice("не хватает:".length).trim();
  const found = (Object.entries(GOOD_NAME) as Array<[GoodId, string]>).find(([, name]) => name === label);
  return found?.[0] ?? null;
}
