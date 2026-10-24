import { describe, expect, it } from "vitest";
import { foodReturnFuel, planAi, refreshFoodFuel } from "../src/sim/ai";
import { dispatch } from "../src/sim/commands";
import { SHIP_CLASSES } from "../src/sim/config";
import { createSkeleton, endowHouse, endowWorld, placeBuilding, placeShip } from "../src/sim/create";
import { createExpansionScenario, createGrainScenario, createLogisticsScenario } from "../src/sim/diagnostics";
import { audit, createGoods, destroyGoods, distance, hashState } from "../src/sim/mutate";
import { explainBuilding } from "../src/sim/view";
import { effectiveThroughput } from "../src/sim/port";
import { deserialize, serialize } from "../src/sim/save";
import { developmentIdea, transitThroughputBonus } from "../src/sim/specialty";
import { runTicks } from "../src/sim/simulate";

describe("развитие миров", () => {
  it("бонус аграрного пути появляется только после стройки и отличается от промышленного", () => {
    const agrarian = createGrainScenario();
    const field = agrarian.worlds.find((world) => world.id === "g-field")!;
    const before = field.stock.grain;
    createGoods(field.stock, agrarian.accounts, "parts", 20);
    const started = dispatch(agrarian, { type: "developWorld", houseId: agrarian.houses[0].id, worldId: field.id, path: "agrarian" });
    expect(started.ok).toBe(true);
    runTicks(agrarian, 1);
    expect(field.development.level).toBe(0);
    expect(field.stock.grain - before).toBeLessThanOrEqual(14);
    runTicks(agrarian, 4);
    expect(field.development.path).toBe("agrarian");
    expect(field.development.level).toBe(1);
    const grainAtBonus = field.stock.grain;
    runTicks(agrarian, 1);
    expect(field.stock.grain - grainAtBonus).toBe(18);

    const industrial = createLogisticsScenario();
    const ore = industrial.worlds.find((world) => world.id === "l-ore")!;
    ore.deposits.ore = 80;
    placeBuilding(industrial, ore, industrial.houses[0].id, "smelter");
    createGoods(ore.stock, industrial.accounts, "parts", 20);
    createGoods(ore.stock, industrial.accounts, "ore", 40);
    dispatch(industrial, { type: "developWorld", houseId: industrial.houses[0].id, worldId: ore.id, path: "industrial" });
    runTicks(industrial, 6);
    expect(ore.development.level).toBe(1);
    const alloys = ore.stock.alloys;
    const oreLeft = ore.stock.ore;
    runTicks(industrial, 1);
    expect(ore.stock.alloys - alloys).toBe(6);
    expect(oreLeft - ore.stock.ore).toBe(8);
    expect(ore.stock.grain).toBe(0);
    expect(field.development.path).not.toBe(ore.development.path);
  });

  it("без дополнительного сырья промышленный бонус не создаёт сплавы, а пустое месторождение не пополняется", () => {
    const state = createLogisticsScenario();
    const house = state.houses[0];
    const ore = state.worlds.find((world) => world.id === "l-ore")!;
    ore.deposits.ore = 0;
    placeBuilding(state, ore, house.id, "smelter");
    ore.development = { path: "industrial", level: 1, suspended: false, invested: 2000, project: null, upkeepPaid: true };
    ore.stock.ore = 6;
    state.accounts.goodsCreated.ore += 6;
    runTicks(state, 1);
    expect(ore.stock.alloys).toBe(5);
    expect(ore.stock.ore).toBe(0);
    expect(ore.deposits.ore).toBe(0);
    const bare = createLogisticsScenario();
    const blocked = dispatch(bare, { type: "developWorld", houseId: bare.houses[0].id, worldId: "l-side", path: "industrial" });
    expect(blocked.ok).toBe(false);
  });

  it("чужой дом, нехватка платы, отмена и смена пути не возвращают вложения целиком", () => {
    const state = createGrainScenario();
    const house = state.houses[0];
    const field = state.worlds.find((world) => world.id === "g-field")!;
    createGoods(field.stock, state.accounts, "parts", 30);
    const stranger = endowHouse(state, { name: "Чужой", color: "#999", crest: "Ч", profile: "merchant", player: false, credits: 9000 });
    expect(dispatch(state, { type: "developWorld", houseId: stranger.id, worldId: field.id, path: "agrarian" }).ok).toBe(false);
    const poor = createGrainScenario();
    poor.houses[0].credits = 10;
    expect(dispatch(poor, { type: "developWorld", houseId: poor.houses[0].id, worldId: "g-field", path: "agrarian" }).ok).toBe(false);
    dispatch(state, { type: "developWorld", houseId: house.id, worldId: field.id, path: "agrarian" });
    const spent = field.development.project?.spent ?? 0;
    const partsAfter = field.stock.parts;
    const wallet = field.popWallet;
    dispatch(state, { type: "cancelDevelopment", houseId: house.id, worldId: field.id });
    expect(field.development.project).toBeNull();
    expect(field.development.level).toBe(0);
    expect(field.stock.parts).toBe(partsAfter);
    expect(house.credits).toBeGreaterThan(0);
    expect(field.popWallet).toBe(wallet - Math.floor(spent / 2));
    dispatch(state, { type: "developWorld", houseId: house.id, worldId: field.id, path: "agrarian" });
    runTicks(state, 5);
    expect(field.development.level).toBe(1);
    const invested = field.development.invested;
    dispatch(state, {
      type: "createRoute",
      houseId: house.id,
      name: "Через поле",
      stops: [
        { worldId: field.id, actions: [] },
        { worldId: "g-mill", actions: [] },
      ],
    });
    const switched = dispatch(state, { type: "developWorld", houseId: house.id, worldId: field.id, path: "transit" });
    expect(switched.ok).toBe(true);
    expect(field.development.suspended).toBe(true);
    expect(field.development.invested).toBe(invested);
    runTicks(state, 1);
    const frozen = field.stock.grain;
    runTicks(state, 1);
    expect(field.stock.grain - frozen).toBe(14);
  });

  it("транзит поднимает бюджет порта и снижает топливо только после оплаты", () => {
    const state = createLogisticsScenario();
    const house = state.houses[0];
    const ore = state.worlds.find((world) => world.id === "l-ore")!;
    const dock = state.worlds.find((world) => world.id === "l-dock")!;
    createGoods(ore.stock, state.accounts, "parts", 20);
    dispatch(state, {
      type: "createRoute",
      houseId: house.id,
      name: "Узел",
      stops: [
        { worldId: ore.id, actions: [] },
        { worldId: dock.id, actions: [] },
      ],
    });
    expect(dispatch(state, { type: "developWorld", houseId: house.id, worldId: "l-side", path: "transit" }).ok).toBe(false);
    dispatch(state, { type: "developWorld", houseId: house.id, worldId: ore.id, path: "transit" });
    runTicks(state, 4);
    expect(transitThroughputBonus(ore)).toBe(40);
    expect(effectiveThroughput(ore.port) + transitThroughputBonus(ore)).toBe(120);
    expect(ore.capacity).toBe(state.rules.stockCapacity);
    const ship = state.ships[0];
    ship.worldId = ore.id;
    ship.status = "docked";
    const fuelBefore = ship.cargo.fuel;
    dispatch(state, {
      type: "createRoute",
      houseId: house.id,
      name: "Отход",
      shipId: ship.id,
      stops: [
        { worldId: ore.id, actions: [] },
        { worldId: dock.id, actions: [] },
      ],
    });
    runTicks(state, 1);
    const spentFuel = fuelBefore - ship.cargo.fuel;
    house.credits = 0;
    runTicks(state, 1);
    expect(ore.development.level).toBe(1);
    expect(ore.development.upkeepPaid).toBe(false);
    expect(transitThroughputBonus(ore)).toBe(0);
    expect(spentFuel).toBeGreaterThan(0);
  });

  it("сохранение посреди стройки совпадает с непрерывным прогоном", () => {
    const left = createGrainScenario();
    const right = createGrainScenario();
    for (const state of [left, right]) createGoods(state.worlds[0].stock, state.accounts, "parts", 20);
    dispatch(left, { type: "developWorld", houseId: left.houses[0].id, worldId: "g-field", path: "agrarian" });
    dispatch(right, { type: "developWorld", houseId: right.houses[0].id, worldId: "g-field", path: "agrarian" });
    runTicks(left, 2);
    const restored = deserialize(serialize(left));
    runTicks(restored, 4);
    runTicks(right, 6);
    expect(hashState(restored)).toBe(hashState(right));
    expect(audit(restored).ok).toBe(true);
    const raw = JSON.parse(serialize(left)) as { version: number; state: { version: number; worlds: Array<{ development?: unknown }> } };
    raw.version = 3;
    raw.state.version = 3;
    for (const world of raw.state.worlds) delete world.development;
    const migrated = deserialize(JSON.stringify(raw));
    expect(migrated.version).toBe(4);
    expect(migrated.worlds.every((world) => world.development.level === 0)).toBe(true);
    expect(() => deserialize(JSON.stringify({ version: 5, state: left }))).toThrow(/версия/);
  });

  it("ИИ на ферме и на руде выбирает разные пути и платит своими ресурсами", () => {
    const state = createSkeleton(5, "paths");
    const player = endowHouse(state, { name: "Игрок", color: "#eee", crest: "ИГ", profile: "player", player: true, credits: 1000 });
    endowWorld(state, { id: "p-home", name: "Дом", specialty: "дом", x: 0, y: 400, ownerId: player.id, population: 20, popMoneyPerCapita: 2, stock: { food: 40 } });
    const ai = endowHouse(state, { name: "Мастер", color: "#48a", crest: "МС", profile: "industrial", player: false, credits: 20000 });
    const field = endowWorld(state, {
      id: "a-field",
      name: "Пашня",
      specialty: "поля",
      x: 0,
      y: 0,
      ownerId: ai.id,
      population: 80,
      popMoneyPerCapita: 4,
      stock: { grain: 40, food: 40, parts: 20, fuel: 40 },
    });
    const mine = endowWorld(state, {
      id: "a-mine",
      name: "Жила",
      specialty: "руда",
      x: 200,
      y: 0,
      ownerId: ai.id,
      population: 80,
      popMoneyPerCapita: 4,
      stock: { ore: 40, parts: 20, fuel: 40, food: 40 },
      deposits: { ore: 100 },
    });
    ai.capitalId = field.id;
    placeBuilding(state, field, ai.id, "farm");
    placeBuilding(state, mine, ai.id, "smelter");
    placeShip(state, ai.id, field, "freighter", 20);
    state.aiEnabled = true;
    state.rules.aiInterval = 1;
    const credits = ai.credits;
    const parts = field.stock.parts + mine.stock.parts;
    runTicks(state, 8);
    const paths = [field.development.path, mine.development.path];
    expect(paths.filter(Boolean).length).toBe(2);
    expect(new Set(paths).size).toBe(2);
    expect(ai.credits).toBeLessThan(credits);
    expect(field.stock.parts + mine.stock.parts).toBeLessThan(parts);
    expect(audit(state).ok).toBe(true);
    planAi(state);
  });

  it("ИИ достраивает уже выбранный путь и не меняет его на соседний", () => {
    const state = createSkeleton(6, "one-path");
    const player = endowHouse(state, { name: "Игрок", color: "#eee", crest: "ИГ", profile: "player", player: true, credits: 1000 });
    endowWorld(state, { id: "p-home", name: "Дом", specialty: "дом", x: 0, y: 400, ownerId: player.id, population: 20, popMoneyPerCapita: 2, stock: { food: 40 } });
    const ai = endowHouse(state, { name: "Мастер", color: "#48a", crest: "МС", profile: "industrial", player: false, credits: 30000 });
    const world = endowWorld(state, {
      id: "a-both",
      name: "Комбинат",
      specialty: "руда и поля",
      x: 0,
      y: 0,
      ownerId: ai.id,
      population: 90,
      popMoneyPerCapita: 4,
      stock: { grain: 40, food: 80, ore: 40, parts: 40, fuel: 40 },
      deposits: { ore: 100 },
    });
    ai.capitalId = world.id;
    placeBuilding(state, world, ai.id, "farm");
    placeBuilding(state, world, ai.id, "smelter");
    state.aiEnabled = true;
    state.rules.aiInterval = 1;
    runTicks(state, 40);
    expect(world.development.path).toBe("industrial");
    expect(world.development.level).toBe(2);
    expect(state.journal.some((entry) => entry.text.includes("аграрный путь"))).toBe(false);
  });

  it("скидка транзита входит в проверку топлива продовольственного рейса", () => {
    const state = createLogisticsScenario();
    const house = state.houses[0];
    const ore = state.worlds.find((world) => world.id === "l-ore")!;
    const side = state.worlds.find((world) => world.id === "l-side")!;
    ore.development = { path: "transit", level: 1, suspended: false, invested: 1400, project: null, upkeepPaid: true };
    createGoods(ore.stock, state.accounts, "food", 40);
    const ship = state.ships[0];
    const leg = Math.max(1, Math.ceil((distance(ore, side) * SHIP_CLASSES.freighter.fuelPer1000) / 1000));
    const voyage = Math.max(1, leg - 1) + leg;
    destroyGoods(ship.cargo, state.accounts, "fuel", ship.cargo.fuel - voyage);
    dispatch(state, {
      type: "createRoute",
      houseId: house.id,
      name: "Еда через узел",
      shipId: ship.id,
      autoFuel: true,
      stops: [
        { worldId: ore.id, actions: [{ good: "food", mode: "load", amount: 10, price: 0, keep: 0 }] },
        { worldId: side.id, actions: [{ good: "food", mode: "unload", amount: 10, price: 0, keep: 0 }] },
      ],
    });
    runTicks(state, 1);
    expect(ship.stopReason ?? "").not.toContain("нет топлива");
    expect(ship.status).toBe("transit");
  });

  it("возврат за отменённую стройку виден в новом окне кассы", () => {
    const state = createGrainScenario();
    const house = state.houses[0];
    const field = state.worlds.find((world) => world.id === "g-field")!;
    createGoods(field.stock, state.accounts, "parts", 10);
    house.flowDays = state.rules.window - 1;
    dispatch(state, { type: "developWorld", houseId: house.id, worldId: field.id, path: "agrarian" });
    expect(house.flow.construction).toBe(1600);
    runTicks(state, 1);
    expect(house.lastFlow.construction).toBe(1600);
    expect(house.flow.construction).toBe(0);
    dispatch(state, { type: "cancelDevelopment", houseId: house.id, worldId: field.id });
    expect(house.flow.construction).toBe(-800);
  });

  it("ИИ берёт уже занятый путь, если запасной сейчас недоступен", () => {
    const state = createSkeleton(7, "merchant-path");
    const player = endowHouse(state, { name: "Игрок", color: "#eee", crest: "ИГ", profile: "player", player: true, credits: 1000 });
    endowWorld(state, { id: "p-home", name: "Дом", specialty: "дом", x: 0, y: 400, ownerId: player.id, population: 20, popMoneyPerCapita: 2, stock: { food: 40 } });
    const ai = endowHouse(state, { name: "Купцы", color: "#48a", crest: "КП", profile: "merchant", player: false, credits: 20000 });
    const taken = endowWorld(state, {
      id: "m-old",
      name: "Старое поле",
      specialty: "поле",
      x: 0,
      y: 0,
      ownerId: ai.id,
      population: 40,
      popMoneyPerCapita: 4,
      stock: { grain: 40, food: 40, parts: 20 },
    });
    const fresh = endowWorld(state, {
      id: "m-new",
      name: "Новое поле",
      specialty: "поле",
      x: 200,
      y: 0,
      ownerId: ai.id,
      population: 40,
      popMoneyPerCapita: 4,
      stock: { grain: 40, food: 40, parts: 20 },
    });
    ai.capitalId = taken.id;
    placeBuilding(state, taken, ai.id, "farm");
    placeBuilding(state, fresh, ai.id, "farm");
    taken.development = { path: "agrarian", level: 2, suspended: false, invested: 4000, project: null, upkeepPaid: true };
    const idea = developmentIdea(state, ai.id);
    expect(idea?.command.worldId).toBe(fresh.id);
    expect(idea?.command.path).toBe("agrarian");
  });

  it("пояснение плавильни показывает штат и выпуск с бонусом пути", () => {
    const state = createLogisticsScenario();
    const house = state.houses[0];
    const ore = state.worlds.find((world) => world.id === "l-ore")!;
    ore.development = { path: "industrial", level: 1, suspended: false, invested: 2000, project: null, upkeepPaid: true };
    placeBuilding(state, ore, house.id, "smelter");
    const building = ore.buildings.find((item) => item.kind === "smelter")!;
    building.workers = 14;
    building.stopReason = "не хватает работников";
    const text = explainBuilding(state, building.id);
    expect(text).toContain("8 руда → 6 сплавы");
    expect(text).toContain("Нужно работников: 16, на месте 14");
  });

  it("пояснение после выпуска показывает уже прошедшую партию, а не пересчёт по пустому складу", () => {
    const state = createLogisticsScenario();
    const house = state.houses[0];
    const ore = state.worlds.find((world) => world.id === "l-ore")!;
    ore.development = { path: "industrial", level: 1, suspended: false, invested: 2000, project: null, upkeepPaid: true };
    destroyGoods(ore.stock, state.accounts, "ore", ore.stock.ore - 8);
    placeBuilding(state, ore, house.id, "smelter");
    runTicks(state, 1);
    const building = ore.buildings.find((item) => item.kind === "smelter")!;
    expect(ore.stock.ore).toBe(0);
    expect(ore.stock.alloys).toBe(6);
    const text = explainBuilding(state, building.id);
    expect(text).toContain("8 руда → 6 сплавы");
    expect(text).toContain(`Нужно работников: ${building.workers}, на месте ${building.workers}`);
    expect(text).toContain("Полная партия идёт");
  });

  it("сохранение без явного пути или с уровнем не по пути отвергается", () => {
    const state = createGrainScenario();
    const broken = (edit: (development: Record<string, unknown>) => void) => {
      const raw = JSON.parse(serialize(state)) as { state: { worlds: Array<{ development: Record<string, unknown> }> } };
      edit(raw.state.worlds[0].development);
      expect(() => deserialize(JSON.stringify(raw))).toThrow(/развитие мира повреждено/);
    };
    broken((development) => {
      delete development.path;
    });
    broken((development) => {
      development.path = "";
    });
    broken((development) => {
      development.path = null;
      development.level = 1;
    });
    broken((development) => {
      development.path = "agrarian";
      development.level = 0;
    });
    const intact = deserialize(serialize(state));
    expect(intact.worlds[0].development.path).toBe(null);
    expect(intact.worlds[0].development.level).toBe(0);
  });

  it("развитие не забирает комплектующие уже назначенной колонии", () => {
    const state = createExpansionScenario();
    const home = state.worlds.find((world) => world.id === "e-home")!;
    const ai = state.houses.find((house) => house.profile === "expansionist")!;
    destroyGoods(home.stock, state.accounts, "parts", home.stock.parts - state.rules.colonizeParts);
    planAi(state);
    expect(state.ships.some((ship) => ship.mission?.type === "colonize")).toBe(true);
    expect(home.stock.parts).toBe(state.rules.colonizeParts);
    expect(home.development.project).toBeNull();
    runTicks(state, 40);
    expect(state.worlds.find((world) => world.id === "e-free")?.ownerId).toBe(ai.id);
    expect(audit(state).ok).toBe(true);
  });

  it("чужой корабль у причала не держит комплектующие хозяина", () => {
    const state = createGrainScenario();
    const house = state.houses[0];
    const field = state.worlds.find((world) => world.id === "g-field")!;
    const other = endowHouse(state, { name: "Чужой", color: "#333", crest: "ЧЖ", profile: "expansionist", player: false, credits: 8000 });
    const ship = placeShip(state, other.id, field, "freighter", 10);
    ship.mission = { type: "colonize", worldId: "nowhere" };
    const started = dispatch(state, { type: "developWorld", houseId: house.id, worldId: field.id, path: "agrarian" });
    expect(started.ok).toBe(true);
    expect(field.stock.parts).toBe(4);
  });

  it("запас обратного продовольственного рейса не опирается на сегодняшнюю скидку порта назначения", () => {
    const state = createSkeleton(8, "return-fuel");
    const house = endowHouse(state, { name: "Игрок", color: "#eee", crest: "ИГ", profile: "player", player: true, credits: 8000 });
    const origin = endowWorld(state, { id: "f-from", name: "Поле", specialty: "поле", x: 0, y: 0, ownerId: house.id, population: 20, popMoneyPerCapita: 2, stock: { food: 40, fuel: 40 } });
    const dest = endowWorld(state, { id: "f-to", name: "Узел", specialty: "порт", x: 50, y: 0, ownerId: house.id, population: 20, popMoneyPerCapita: 2, stock: { food: 10 } });
    house.capitalId = origin.id;
    dest.development = { path: "transit", level: 1, suspended: false, invested: 1400, project: null, upkeepPaid: true };
    const ship = placeShip(state, house.id, origin, "freighter", 0);
    dispatch(state, {
      type: "createRoute",
      houseId: house.id,
      name: "Еда к узлу",
      shipId: ship.id,
      autoFuel: true,
      stops: [
        { worldId: origin.id, actions: [{ good: "food", mode: "load", amount: 10, price: 0, keep: 0 }] },
        { worldId: dest.id, actions: [{ good: "food", mode: "unload", amount: 10, price: 0, keep: 0 }] },
      ],
    });
    const route = state.routes[0];
    expect(foodReturnFuel(state, ship, route, origin)).toBe(4);
    refreshFoodFuel(state, ship, origin, route);
    expect(route.stops[0].actions.find((action) => action.good === "fuel")?.amount).toBe(4);
  });

  it("запас до продовольственного порта не считает скидку будущего выхода", () => {
    const state = createSkeleton(10, "future-pickup");
    const house = endowHouse(state, { name: "Игрок", color: "#eee", crest: "ИГ", profile: "player", player: true, credits: 8000 });
    const away = endowWorld(state, { id: "f-away", name: "Даль", specialty: "склад", x: 0, y: 500, ownerId: house.id, population: 20, popMoneyPerCapita: 2, stock: { fuel: 80 } });
    const origin = endowWorld(state, { id: "f-from", name: "Узел", specialty: "порт", x: 0, y: 0, ownerId: house.id, population: 20, popMoneyPerCapita: 2, stock: { food: 40 } });
    const dest = endowWorld(state, { id: "f-to", name: "Поле", specialty: "поле", x: 500, y: 0, ownerId: house.id, population: 20, popMoneyPerCapita: 2, stock: { food: 10 } });
    house.capitalId = origin.id;
    origin.development = { path: "transit", level: 2, suspended: false, invested: 3400, project: null, upkeepPaid: true };
    const ship = placeShip(state, house.id, away, "freighter", 40);
    dispatch(state, {
      type: "createRoute",
      houseId: house.id,
      name: "Еда с узла",
      shipId: ship.id,
      autoFuel: true,
      stops: [
        { worldId: origin.id, actions: [{ good: "food", mode: "load", amount: 10, price: 0, keep: 0 }] },
        { worldId: dest.id, actions: [{ good: "food", mode: "unload", amount: 10, price: 0, keep: 0 }] },
      ],
    });
    expect(foodReturnFuel(state, ship, state.routes[0], away)).toBe(42);
    expect(foodReturnFuel(state, ship, state.routes[0], origin)).toBe(26);
  });

  it("ИИ не закладывает один путь на двух мирах, пока первая стройка идёт", () => {
    const state = createSkeleton(9, "pending-path");
    const player = endowHouse(state, { name: "Игрок", color: "#eee", crest: "ИГ", profile: "player", player: true, credits: 1000 });
    endowWorld(state, { id: "p-home", name: "Дом", specialty: "дом", x: 0, y: 400, ownerId: player.id, population: 20, popMoneyPerCapita: 2, stock: { food: 40 } });
    const ai = endowHouse(state, { name: "Мастер", color: "#48a", crest: "МС", profile: "industrial", player: false, credits: 30000 });
    const first = endowWorld(state, {
      id: "p-a",
      name: "Первый",
      specialty: "руда и поля",
      x: 0,
      y: 0,
      ownerId: ai.id,
      population: 80,
      popMoneyPerCapita: 4,
      stock: { grain: 40, food: 40, ore: 40, parts: 20, fuel: 20 },
      deposits: { ore: 80 },
    });
    const second = endowWorld(state, {
      id: "p-b",
      name: "Второй",
      specialty: "руда и поля",
      x: 200,
      y: 0,
      ownerId: ai.id,
      population: 80,
      popMoneyPerCapita: 4,
      stock: { grain: 40, food: 40, ore: 40, parts: 20, fuel: 20 },
      deposits: { ore: 80 },
    });
    ai.capitalId = first.id;
    for (const world of [first, second]) {
      placeBuilding(state, world, ai.id, "farm");
      placeBuilding(state, world, ai.id, "smelter");
    }
    const idea = developmentIdea(state, ai.id);
    expect(idea?.command.path).toBe("industrial");
    expect(dispatch(state, idea!.command).ok).toBe(true);
    const next = developmentIdea(state, ai.id);
    expect(next?.command.worldId).toBe(second.id);
    expect(next?.command.path).toBe("agrarian");
  });
});
