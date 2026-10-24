import { cancelContract, proposeContract, respondContract } from "./contracts";
import { expandPort } from "./port";
import { resolveSituation } from "./politics";
import { setTutorialSkipped } from "./tutorial";
import { cancelDevelopment, developWorld } from "./specialty";
import { RECIPES, SHIP_CLASSES } from "./config";
import { GOODS, emptyGoods, type GoodId } from "./goods";
import {
  buildingOf,
  destroyGoods,
  distance,
  drawSupply,
  availableCredits,
  houseOf,
  moveCredits,
  note,
  personOf,
  routeOf,
  serial,
  shipOf,
  shiftRelation,
  worldOf,
} from "./mutate";
import type { Command, CommandResult, Route, RouteStop, Ship, SimState, TreatyKind, World } from "./types";

export function dispatch(state: SimState, command: Command): CommandResult {
  switch (command.type) {
    case "build":
      return build(state, command);
    case "toggleBuilding":
      return toggleBuilding(state, command.houseId, command.buildingId, command.enabled);
    case "buildShip":
      return buildShip(state, command);
    case "createRoute":
      return createRoute(state, command.houseId, command.name, command.stops, command.shipId, false, command.autoFuel, command.returnRouteId, command.minLoad, command.maxWait);
    case "updateRoute":
      return updateRoute(state, command.routeId, command.name, command.stops, command.minLoad, command.maxWait);
    case "pauseRoute":
      return pauseRoute(state, command.routeId, command.paused);
    case "assignShip":
      return assignShip(state, command.shipId, command.routeId);
    case "setTariff":
      return setTariff(state, command.houseId, command.worldId, command.tariffBps);
    case "setEmbargo":
      return setEmbargo(state, command.houseId, command.otherId, command.embargo);
    case "proposeTreaty":
      return proposeTreaty(state, command);
    case "respondTreaty":
      return respondTreaty(state, command.houseId, command.treatyId, command.accept);
    case "proposeContract":
      return proposeContract(state, command.sellerId, command.buyerId, command.good, command.worldId, command.qtyPerWindow, command.windows, command.price, command.shortfall, command.deposit);
    case "respondContract":
      return respondContract(state, command.houseId, command.contractId, command.accept);
    case "cancelContract":
      return cancelContract(state, command.houseId, command.contractId);
    case "colonize":
      return colonize(state, command.houseId, command.shipId, command.worldId);
    case "appointGovernor":
      return appointGovernor(state, command.houseId, command.worldId, command.personId);
    case "expandPort":
      return expandPort(state, command.houseId, command.worldId, command.kind);
    case "developWorld":
      return developWorld(state, command.houseId, command.worldId, command.path);
    case "cancelDevelopment":
      return cancelDevelopment(state, command.houseId, command.worldId);
    case "resolveSituation":
      return resolveSituation(state, command.houseId, command.situationId, command.choice);
    case "skipTutorial":
      return setTutorialSkipped(state, true);
    case "resumeTutorial":
      return setTutorialSkipped(state, false);
    default:
      return fail("неизвестная команда");
  }
}

export function planBuild(state: SimState, houseId: string, worldId: string, kind: keyof typeof RECIPES): CommandResult & { lines: string[] } {
  const house = houseOf(state, houseId);
  const world = worldOf(state, worldId);
  const recipe = RECIPES[kind];
  if (!house || !world || !recipe) return { ...fail("нет такого дома, мира или проекта"), lines: [] };
  if (world.ownerId !== house.id) return { ...fail("строить можно только в своём мире"), lines: [] };
  if (world.stock.parts < recipe.parts) {
    return { ...fail(`нужно ${recipe.parts} комплектующих на складе, есть ${world.stock.parts}`), lines: [] };
  }
  if (availableCredits(house) < recipe.credits) return { ...fail(`нужно ${recipe.credits} кредитов, в казне ${availableCredits(house)}`), lines: [] };
  const lines = [
    `Списать ${recipe.parts} комплектующих со склада «${world.name}».`,
    `Передать ${recipe.credits} кредитов местному населению как плату за стройку.`,
    `Через ${recipe.days} дн. ${recipe.name} сможет выпускать продукцию, если хватит людей, сырья и места на складе.`,
  ];
  return { ok: true, reason: "", lines };
}

function build(state: SimState, command: Extract<Command, { type: "build" }>): CommandResult {
  const plan = planBuild(state, command.houseId, command.worldId, command.kind);
  if (!plan.ok) return plan;
  const world = worldOf(state, command.worldId)!;
  const recipe = RECIPES[command.kind];
  destroyGoods(world.stock, state.accounts, "parts", recipe.parts);
  moveCredits(state, { kind: "house", id: command.houseId }, { kind: "pop", worldId: world.id }, recipe.credits);
  const house = houseOf(state, command.houseId)!;
  house.flow.construction += recipe.credits;
  world.buildings.push({
    id: serial(state, "b"),
    kind: command.kind,
    worldId: world.id,
    ownerId: command.houseId,
    remainingDays: recipe.days,
    enabled: true,
    stopReason: "строится",
    workers: 0,
    lastBatch: null,
  });
  note(state, command.houseId, `Начат строительство: ${recipe.name} на «${world.name}», ${recipe.days} дн.`);
  return ok(`стройка займёт ${recipe.days} дн.`);
}

function toggleBuilding(state: SimState, houseId: string, buildingId: string, enabled: boolean): CommandResult {
  const building = buildingOf(state, buildingId);
  if (!building) return fail("предприятие не найдено");
  if (building.ownerId !== houseId) return fail("чужое предприятие");
  building.enabled = enabled;
  building.stopReason = enabled ? null : "остановлено владельцем";
  note(state, building.ownerId, `${enabled ? "Запущено" : "Остановлено"} предприятие ${RECIPES[building.kind].name}.`);
  return ok(enabled ? "предприятие включено" : "предприятие остановлено");
}

export function planShip(state: SimState, houseId: string, worldId: string, classId: Ship["classId"]): CommandResult & { lines: string[] } {
  const house = houseOf(state, houseId);
  const world = worldOf(state, worldId);
  const shipClass = SHIP_CLASSES[classId];
  if (!house || !world) return { ...fail("нет такого дома или мира"), lines: [] };
  if (world.ownerId !== house.id) return { ...fail("верфь только в своём мире"), lines: [] };
  if (world.stock.parts < shipClass.parts) return { ...fail(`нужно ${shipClass.parts} комплектующих, есть ${world.stock.parts}`), lines: [] };
  if (availableCredits(house) < shipClass.credits) return { ...fail(`нужно ${shipClass.credits} кредитов, в казне ${availableCredits(house)}`), lines: [] };
  return {
    ok: true,
    reason: "",
    lines: [
      `${shipClass.name}: трюм ${shipClass.capacity} ед., бак ${shipClass.capacity} ед. Топливо в баке и трюм не занимает. Скорость ${shipClass.speed} ед./день, топливо ${shipClass.fuelPer1000} ед. на 1000 ед. пути, содержание ${shipClass.upkeep} кред./день.`,
      `Списать ${shipClass.parts} комплектующих и передать ${shipClass.credits} кредитов населению.`,
      `Корабль будет готов через ${shipClass.days} дн. и останется в «${world.name}», пока ему не дадут маршрут.`,
    ],
  };
}

function buildShip(state: SimState, command: Extract<Command, { type: "buildShip" }>): CommandResult {
  const plan = planShip(state, command.houseId, command.worldId, command.classId);
  if (!plan.ok) return plan;
  const world = worldOf(state, command.worldId)!;
  const shipClass = SHIP_CLASSES[command.classId];
  destroyGoods(world.stock, state.accounts, "parts", shipClass.parts);
  moveCredits(state, { kind: "house", id: command.houseId }, { kind: "pop", worldId: world.id }, shipClass.credits);
  houseOf(state, command.houseId)!.flow.construction += shipClass.credits;
  state.ships.push({
    id: serial(state, "s"),
    name: `${shipClass.name} ${state.ships.length + 1}`,
    houseId: command.houseId,
    classId: command.classId,
    cargo: emptyGoods(),
    status: "building",
    worldId: world.id,
    fromId: world.id,
    toId: null,
    legDistance: 0,
    distanceLeft: 0,
    routeId: null,
    stopIndex: 0,
    stopReason: "строится",
    remainingDays: shipClass.days,
    mission: null,
    traveled: 0,
    tollWorldId: world.id,
    supplyFrom: {},
    visitKey: "",
    visitMoved: [],
    portArrived: 0,
    portMoved: 0,
    portAllowance: 0,
    loadWait: 0,
  });
  note(state, command.houseId, `Заложена ${shipClass.name} на «${world.name}».`);
  return ok(`верфь займёт ${shipClass.days} дн.`);
}

function createRoute(state: SimState, houseId: string, name: string, stops: RouteStop[], shipId?: string, keepMission = false, autoFuel = false, returnRouteId?: string, minLoad = 0, maxWait = 0): CommandResult {
  const house = houseOf(state, houseId);
  if (!house) return fail("дом не найден");
  const checked = validateStops(state, stops);
  if (!checked.ok) return checked;
  if (shipId) {
    const ship = shipOf(state, shipId);
    if (!ship) return fail("корабль не найден");
    if (ship.status === "building") return fail("корабль ещё строится");
    if (ship.houseId !== houseId) return fail("чужой корабль");
  }
  const route: Route = {
    id: serial(state, "r"),
    houseId,
    name: name.trim() || "Маршрут",
    stops,
    paused: false,
    revenue: 0,
    cost: 0,
    fuelUsed: 0,
    lastRevenue: 0,
    lastCost: 0,
    lastFuelUsed: 0,
    minLoad: clampRouteNumber(minLoad, 0, 500),
    maxWait: clampRouteNumber(maxWait, 0, 30),
    waitDays: 0,
    movedWindow: 0,
    lastMoved: 0,
    daysFlying: 0,
    daysPort: 0,
    daysWaiting: 0,
  };
  if (autoFuel) route.autoFuel = true;
  if (returnRouteId) route.returnRouteId = returnRouteId;
  state.routes.push(route);
  note(state, houseId, `Проложен маршрут «${route.name}».`);
  if (shipId) {
    const assigned = assignShip(state, shipId, route.id, keepMission);
    if (!assigned.ok) return assigned;
  }
  return ok("маршрут создан");
}

function updateRoute(state: SimState, routeId: string, name: string, stops: RouteStop[], minLoad?: number, maxWait?: number): CommandResult {
  const route = routeOf(state, routeId);
  if (!route) return fail("маршрут не найден");
  const checked = validateStops(state, stops);
  if (!checked.ok) return checked;
  const flying = state.ships.some((ship) => ship.routeId === route.id && ship.status === "transit");
  route.stops = stops;
  route.name = name.trim() || route.name;
  if (minLoad !== undefined) route.minLoad = clampRouteNumber(minLoad, 0, 500);
  if (maxWait !== undefined) route.maxWait = clampRouteNumber(maxWait, 0, 30);
  for (const ship of state.ships) {
    if (ship.routeId !== route.id) continue;
    ship.visitKey = "";
    ship.visitMoved = [];
    ship.loadWait = 0;
    if (ship.status === "transit") ship.stopIndex = 0;
    else if (ship.worldId) {
      const index = route.stops.findIndex((stop) => stop.worldId === ship.worldId);
      ship.stopIndex = index >= 0 ? index : 0;
    }
  }
  note(
    state,
    route.houseId,
    flying
      ? `Маршрут «${route.name}» изменён. Корабли в пути закончат текущий перегон и только потом перейдут на новые остановки.`
      : `Маршрут «${route.name}» изменён.`,
  );
  return ok(flying ? "текущий перегон сохранится" : "маршрут обновлён");
}

function pauseRoute(state: SimState, routeId: string, paused: boolean): CommandResult {
  const route = routeOf(state, routeId);
  if (!route) return fail("маршрут не найден");
  route.paused = paused;
  note(state, route.houseId, paused ? `Маршрут «${route.name}» поставлен на паузу.` : `Маршрут «${route.name}» снова идёт.`);
  return ok(paused ? "пауза" : "маршрут снят с паузы");
}

function assignShip(state: SimState, shipId: string, routeId: string | null, keepMission = false): CommandResult {
  const ship = shipOf(state, shipId);
  if (!ship) return fail("корабль не найден");
  if (ship.status === "building") return fail("корабль ещё строится");
  if (!routeId) {
    ship.routeId = null;
    ship.mission = null;
    note(state, ship.houseId, `${ship.name} снят с маршрута.`);
    return ok("корабль свободен");
  }
  const route = routeOf(state, routeId);
  if (!route) return fail("маршрут не найден");
  if (route.houseId !== ship.houseId) return fail("чужой маршрут");
  ship.routeId = route.id;
  ship.loadWait = 0;
  if (!keepMission) ship.mission = null;
  if (ship.status === "transit") {
    ship.stopIndex = 0;
  } else if (ship.worldId) {
    const index = route.stops.findIndex((stop) => stop.worldId === ship.worldId);
    ship.stopIndex = index >= 0 ? index : 0;
  }
  note(state, ship.houseId, `${ship.name} назначен на «${route.name}».`);
  return ok("корабль назначен");
}

function setTariff(state: SimState, houseId: string, worldId: string, tariffBps: number): CommandResult {
  const world = worldOf(state, worldId);
  if (!world || world.ownerId !== houseId) return fail("пошлину меняет только владелец мира");
  if (!Number.isInteger(tariffBps) || tariffBps < 0 || tariffBps > 2500) return fail("пошлина задаётся целым числом от 0 до 2500 базисных пунктов");
  const previous = world.tariffBps;
  world.tariffBps = tariffBps;
  note(state, houseId, `Пошлина «${world.name}»: ${previous / 100}% → ${tariffBps / 100}%.`);
  return ok("пошлина изменена");
}

function setEmbargo(state: SimState, houseId: string, otherId: string, embargo: boolean): CommandResult {
  const house = houseOf(state, houseId);
  const other = houseOf(state, otherId);
  if (!house || !other || house.id === other.id) return fail("нужны два разных дома");
  if (Boolean(house.embargo[other.id]) === embargo) return ok(embargo ? "доступ уже закрыт" : "доступ уже открыт");
  house.embargo[other.id] = embargo;
  shiftRelation(state, house.id, other.id, embargo ? -8 : 2);
  note(
    state,
    house.id,
    embargo ? `Эмбарго против ${other.name}: их кораблям закрыты наши миры.` : `Эмбарго против ${other.name} снято.`,
  );
  return ok(embargo ? "доступ закрыт" : "доступ открыт");
}

function proposeTreaty(
  state: SimState,
  command: Extract<Command, { type: "proposeTreaty" }>,
): CommandResult {
  const house = houseOf(state, command.houseId);
  const other = houseOf(state, command.otherId);
  if (!house || !other || house.id === other.id) return fail("нужны два разных дома");
  if (!Number.isInteger(command.tariffBps) || command.tariffBps < 0 || command.tariffBps > 2500) return fail("недопустимая пошлина");
  if (!Number.isInteger(command.qtyPerWindow) || command.qtyPerWindow < 0) return fail("недопустимый объём поставок");
  if (!Number.isInteger(command.duration) || command.duration < 12 || command.duration > 360) return fail("срок договора от 12 до 360 дней");
  if (command.kind !== "transit" && command.qtyPerWindow <= 0) return fail("договор снабжения требует объём больше нуля");
  const existing = state.treaties.find(
    (treaty) =>
      (treaty.status === "proposed" || treaty.status === "active") &&
      treaty.proposerId === house.id &&
      treaty.targetId === other.id,
  );
  if (existing) return fail("с этим домом уже есть открытое предложение или действующий договор");
  const noteText = treatyText(command.kind, house.name, other.name, command.tariffBps, command.good, command.qtyPerWindow, command.duration, state.rules.window);
  state.treaties.push({
    id: serial(state, "t"),
    kind: command.kind,
    proposerId: house.id,
    targetId: other.id,
    status: "proposed",
    startTick: state.tick,
    endTick: state.tick + command.duration,
    duration: command.duration,
    tariffBps: command.tariffBps,
    good: command.good,
    qtyPerWindow: command.qtyPerWindow,
    delivered: 0,
    windowDays: 0,
    note: noteText,
  });
  note(state, house.id, `Предложение ${other.name}: ${noteText}`);
  return ok("предложение отправлено");
}

export function treatyText(kind: TreatyKind, from: string, to: string, tariffBps: number, good: GoodId, qty: number, duration: number, window = 24): string {
  const goodName = { grain: "зерна", food: "продовольствия", ore: "руды", alloys: "сплавов", parts: "комплектующих", fuel: "топлива" }[good];
  if (kind === "transit") return `${from} просит у ${to} транзит под ${tariffBps / 100}% на ${duration} дн. Товар сам по себе не перемещается.`;
  if (kind === "supply") {
    return `${from} обязуется завозить ${qty} ед. ${goodName} в столицу ${to} каждые ${window} дн. Срок договора ${duration} дн. Недопоставка разрывает его. Товар нужно реально привезти.`;
  }
  return `${from} просит пошлину ${tariffBps / 100}% и обязуется каждые ${window} дн. поставить ${qty} ед. ${goodName} в течение ${duration} дн. Скидка живёт вместе с договором; товар не появляется сам.`;
}

function respondTreaty(state: SimState, houseId: string, treatyId: string, accept: boolean): CommandResult {
  const treaty = state.treaties.find((item) => item.id === treatyId);
  if (!treaty) return fail("договор не найден");
  if (treaty.targetId !== houseId) return fail("отвечает только адресат");
  if (treaty.status !== "proposed") return fail("предложение уже закрыто");
  if (!accept) {
    treaty.status = "rejected";
    shiftRelation(state, treaty.proposerId, treaty.targetId, -2);
    note(state, houseId, `Отказ по договору: ${treaty.note}`);
    return ok("отказ");
  }
  treaty.status = "active";
  treaty.startTick = state.tick;
  treaty.endTick = state.tick + treaty.duration;
  treaty.delivered = 0;
  treaty.windowDays = 0;
  note(state, houseId, `Договор принят. ${treaty.note}`);
  return ok("договор принят");
}

function colonize(state: SimState, houseId: string, shipId: string, worldId: string): CommandResult {
  const house = houseOf(state, houseId);
  const ship = shipOf(state, shipId);
  const target = worldOf(state, worldId);
  if (!house || !ship || !target) return fail("нет корабля, дома или мира");
  if (ship.houseId !== house.id) return fail("чужой корабль");
  if (ship.status === "building") return fail("корабль ещё строится");
  if (target.ownerId) return fail("мир уже принадлежит дому");
  const kit = state.rules.colonizeFood + state.rules.colonizeParts;
  const capacity = SHIP_CLASSES[ship.classId].capacity;
  if (capacity < kit) {
    return fail(`трюм ${capacity} ед. не вмещает набор: ${state.rules.colonizeFood} продовольствия и ${state.rules.colonizeParts} комплектующих`);
  }
  if (ship.worldId === target.id && ship.status !== "transit") return foundColony(state, ship, target);
  ship.mission = { type: "colonize", worldId: target.id };
  note(
    state,
    house.id,
    `Колонизация «${target.name}»: нужны ${state.rules.colonizeFood} продовольствия, ${state.rules.colonizeParts} комплектующих и ${state.rules.colonizeCost} кредитов по прибытии. Мир не начнёт приносить доход сам.`,
  );
  if (ship.status === "transit") return ok("текущий перегон сохранится, колониальный маршрут начнётся по прибытии");
  const prepared = syncColonyRoute(state, ship);
  if (!prepared.ok) return prepared;
  return ok("корабль везёт колониальный набор");
}

/** Подгоняет маршрут колонии под текущий трюм: лишнее сгружается, недостающее добирается. Топливо лежит в баке и место набора не занимает. */
export function syncColonyRoute(state: SimState, ship: Ship): CommandResult {
  if (ship.mission?.type !== "colonize" || !ship.worldId || ship.worldId === ship.mission.worldId) return ok();
  const target = worldOf(state, ship.mission.worldId);
  const house = houseOf(state, ship.houseId);
  if (!target || !house) return fail("нет цели колонии");
  const route = routeOf(state, ship.routeId);
  const solo = Boolean(route && state.ships.every((other) => other.id === ship.id || other.routeId !== route.id));
  const marked = Boolean(route && (route.colony === true || route.name.startsWith(`Колония ${target.name}`)));
  const dedicated = Boolean(
    route
    && solo
    && marked
    && route.stops.some((stop) => stop.worldId === ship.worldId)
    && route.stops.some((stop) => stop.worldId === target.id),
  );
  if (!dedicated) {
    const created = createRoute(
      state,
      house.id,
      `Колония ${target.name}`,
      [
        { worldId: ship.worldId, actions: colonyLoadActions(state, ship) },
        { worldId: target.id, actions: [] },
      ],
      ship.id,
      true,
    );
    if (!created.ok) return created;
  }
  const current = routeOf(state, ship.routeId);
  if (current && state.ships.every((other) => other.id === ship.id || other.routeId !== current.id)) current.colony = true;
  const origin = current?.stops[0];
  if (origin && current && origin.worldId === ship.worldId && state.ships.every((other) => other.id === ship.id || other.routeId !== current.id)) {
    origin.actions = colonyLoadActions(state, ship);
    ship.visitKey = "";
  }
  return ok();
}

function colonyFuelTarget(state: SimState, ship: Ship): number {
  const rules = state.rules;
  const room = SHIP_CLASSES[ship.classId].capacity - rules.colonizeParts - rules.colonizeFood;
  if (room <= 0) return 0;
  const here = worldOf(state, ship.worldId);
  const target = ship.mission?.type === "colonize" ? worldOf(state, ship.mission.worldId) : undefined;
  if (!here || !target || here.id === target.id) return Math.min(room, 24);
  const outbound = fuelAlongRoute(state, ship, here.id, target.id);
  return Math.min(outbound * 2, room);
}

function fuelAlongRoute(state: SimState, ship: Ship, fromId: string, targetId: string): number {
  const stops = routeOf(state, ship.routeId)?.stops ?? [];
  const start = stops.findIndex((stop) => stop.worldId === fromId);
  const end = stops.findIndex((stop) => stop.worldId === targetId);
  const direct = () => {
    const from = worldOf(state, fromId);
    const target = worldOf(state, targetId);
    if (!from || !target) return 1;
    return legFuel(ship, from, target);
  };
  if (start < 0 || end <= start) return direct();
  let fuel = 0;
  for (let index = start; index < end; index += 1) {
    const from = worldOf(state, stops[index].worldId);
    const to = worldOf(state, stops[index + 1].worldId);
    if (!from || !to || from.id === to.id) continue;
    fuel += legFuel(ship, from, to);
  }
  return Math.max(1, fuel);
}

function legFuel(ship: Ship, from: World, to: World): number {
  return Math.max(1, Math.ceil((distance(from, to) * SHIP_CLASSES[ship.classId].fuelPer1000) / 1000));
}

function colonyLoadActions(state: SimState, ship: Ship): RouteStop["actions"] {
  const rules = state.rules;
  const fuelTarget = colonyFuelTarget(state, ship);
  const keep: Partial<Record<GoodId, number>> = {
    parts: rules.colonizeParts,
    food: rules.colonizeFood,
    fuel: fuelTarget,
  };
  const here = worldOf(state, ship.worldId);
  const own = !here?.ownerId || here.ownerId === ship.houseId;
  const takeMode = own ? "load" : "buy";
  const dropMode = own ? "unload" : "sell";
  const actions: RouteStop["actions"] = [];
  for (const good of GOODS) {
    const needed = keep[good] ?? 0;
    const have = ship.cargo[good];
    if (have > needed) actions.push({ good, mode: dropMode, amount: have - needed, price: own ? 0 : 1, keep: needed });
  }
  for (const good of ["parts", "food", "fuel"] as const) {
    const needed = keep[good] ?? 0;
    if (ship.cargo[good] < needed) actions.push({ good, mode: takeMode, amount: needed - ship.cargo[good], price: own ? 0 : 80, keep: 0 });
  }
  return actions;
}

export function dedicatedColonyRoute(state: SimState, ship: Ship): Route | undefined {
  const route = routeOf(state, ship.routeId);
  if (!route) return undefined;
  if (!state.ships.every((other) => other.id === ship.id || other.routeId !== route.id)) return undefined;
  if (route.colony === true || route.name.startsWith("Колония ")) return route;
  return undefined;
}

export function foundColony(state: SimState, ship: Ship, world: World): CommandResult {
  const house = houseOf(state, ship.houseId);
  if (!house) return fail("дом корабля не найден");
  if (world.ownerId) {
    ship.mission = null;
    return fail("мир уже занят");
  }
  const rules = state.rules;
  if (ship.cargo.food < rules.colonizeFood) return fail("для колонии не хватает продовольствия на борту");
  if (ship.cargo.parts < rules.colonizeParts) return fail("для колонии не хватает комплектующих на борту");
  if (availableCredits(house) < rules.colonizeCost) return fail("для колонии не хватает денег");
  destroyGoods(ship.cargo, state.accounts, "food", rules.colonizeFood);
  destroyGoods(ship.cargo, state.accounts, "parts", rules.colonizeParts);
  drawSupply(ship, "food", rules.colonizeFood);
  drawSupply(ship, "parts", rules.colonizeParts);
  moveCredits(state, { kind: "house", id: house.id }, { kind: "pop", worldId: world.id }, rules.colonizeCost);
  house.flow.construction += rules.colonizeCost;
  world.ownerId = house.id;
  world.population = rules.colonizePop;
  world.satisfaction = 42;
  world.tariffBps = 150;
  world.specialty = "молодая колония";
  world.governorId = null;
  const route = dedicatedColonyRoute(state, ship);
  if (route) state.routes = state.routes.filter((item) => item.id !== route.id);
  ship.mission = null;
  ship.routeId = null;
  ship.tollWorldId = world.id;
  note(state, house.id, `Основана колония «${world.name}». Население ${rules.colonizePop}, предприятий нет, удовлетворённость низкая: мир ещё нужно снабжать.`);
  return ok("колония основана");
}

function appointGovernor(state: SimState, houseId: string, worldId: string, personId: string): CommandResult {
  const world = worldOf(state, worldId);
  const person = personOf(state, personId);
  if (!world || world.ownerId !== houseId || !person) return fail("некого назначать");
  if (person.houseId !== houseId || !person.alive) return fail("человек не из этого дома");
  if (person.role === "head") return fail("глава не становится губернатором");
  if (world.governorId) {
    const previous = personOf(state, world.governorId);
    if (previous && previous.id !== person.id) {
      previous.role = previous.role === "governor" ? "kin" : previous.role;
      previous.worldId = null;
    }
  }
  if (person.worldId && person.worldId !== world.id) {
    const previousWorld = worldOf(state, person.worldId);
    if (previousWorld && previousWorld.governorId === person.id) previousWorld.governorId = null;
  }
  person.role = "governor";
  person.worldId = world.id;
  world.governorId = person.id;
  note(state, houseId, `${person.name} назначен губернатором «${world.name}». Черты: ${person.traits.join(", ") || "нет"}.`);
  return ok("губернатор назначен");
}

function validateStops(state: SimState, stops: RouteStop[]): CommandResult {
  if (stops.length < 2) return fail("в маршруте нужны хотя бы две остановки");
  for (const stop of stops) {
    if (!worldOf(state, stop.worldId)) return fail("в маршруте неизвестный мир");
    for (const action of stop.actions) {
      if (!GOODS.includes(action.good)) return fail("неизвестный товар");
      if (!["load", "unload", "buy", "sell"].includes(action.mode)) return fail("неизвестное правило погрузки");
      if (!Number.isInteger(action.amount) || action.amount <= 0) return fail("количество должно быть целым и больше нуля");
      if (!Number.isInteger(action.price) || action.price < 0) return fail("предел цены должен быть целым и неотрицательным");
      if (!Number.isInteger(action.keep) || action.keep < 0) return fail("резерв должен быть целым и неотрицательным");
    }
  }
  return ok();
}

function clampRouteNumber(value: number | undefined, min: number, max: number): number {
  if (!Number.isInteger(value)) return min;
  return Math.max(min, Math.min(max, value as number));
}

function ok(reason = ""): CommandResult {
  return { ok: true, reason };
}

function fail(reason: string): CommandResult {
  return { ok: false, reason };
}
