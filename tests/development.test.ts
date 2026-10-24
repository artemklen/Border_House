import { describe, expect, it } from "vitest";
import { planAi } from "../src/sim/ai";
import { dispatch } from "../src/sim/commands";
import { SHIP_CLASSES } from "../src/sim/config";
import { createSkeleton, endowHouse, endowWorld, placeBuilding, placeShip } from "../src/sim/create";
import { createGrainScenario, createLogisticsScenario } from "../src/sim/diagnostics";
import { audit, createGoods, destroyGoods, distance, hashState } from "../src/sim/mutate";
import { effectiveThroughput } from "../src/sim/port";
import { deserialize, serialize } from "../src/sim/save";
import { transitThroughputBonus } from "../src/sim/specialty";
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
});
