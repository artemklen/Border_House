import { describe, expect, it } from "vitest";
import { dispatch } from "../src/sim/commands";
import { createGame, createSkeleton, endowHouse, endowWorld, placeBuilding, placeShip } from "../src/sim/create";
import { createGoods } from "../src/sim/mutate";
import { holdForLoad } from "../src/sim/port";
import { tick } from "../src/sim/simulate";
import type { Flow } from "../src/sim/types";
import { hintLines, treasuryOutlook, treasuryWarning } from "../src/sim/view";

const FLOW_KEYS: Array<keyof Flow> = ["wages", "taxes", "sales", "purchases", "tariffsIn", "tariffsOut", "upkeep", "construction", "penalties", "compensation"];
const INCOME = new Set<keyof Flow>(["taxes", "sales", "tariffsIn", "compensation"]);

function signed(flow: Flow): number {
  return FLOW_KEYS.reduce((sum, key) => sum + flow[key] * (INCOME.has(key) ? 1 : -1), 0);
}

function dayFlow(before: Flow, afterFlow: Flow, afterLast: Flow, reset: boolean): Flow {
  const flow = {} as Flow;
  for (const key of FLOW_KEYS) flow[key] = reset ? afterLast[key] - before[key] : afterFlow[key] - before[key];
  return flow;
}

describe("казна базовой партии", () => {
  it("каждый день 0–50 объясняется потоком, отказ смены наступает на 51-м", () => {
    const state = createGame({ seed: 21, scenario: "base" });
    const player = state.houses.find((house) => house.player)!;
    expect(player.credits).toBe(18000);
    expect(treasuryOutlook(state, player.id)).toEqual({ wages: 465, upkeep: 45, free: 18000, runway: 35 });
    const warning = treasuryWarning(state, player.id)!;
    expect(warning).toContain("зарплаты 465");
    expect(warning).toContain("примерно на 35 дн");
    expect(warning).toContain("«Касса»");
    expect(warning).toContain("не гарантия");
    const ticker = hintLines(state)[0];
    expect(ticker).toContain("зарплаты 465");
    expect(ticker).toContain("примерно на 35 дн");
    expect(ticker).toContain("«Касса»");
    expect(ticker.length).toBeLessThan(warning.length);
    const marks: Record<number, number> = {};
    let fail: number | null = null;
    for (let day = 1; day <= 60; day += 1) {
      const beforeCredits = player.credits;
      const beforeFlow = { ...player.flow };
      const beforeDays = player.flowDays;
      tick(state);
      const reset = player.flowDays === 0 && beforeDays !== 0;
      const flow = dayFlow(beforeFlow, player.flow, player.lastFlow, reset);
      expect(player.credits - beforeCredits).toBe(signed(flow));
      if ([12, 24, 36, 48, 50].includes(day)) marks[day] = player.credits;
      const stopped = state.worlds.some((world) => world.ownerId === player.id && world.buildings.some((building) => building.stopReason === "дом не оплатил работников" || building.stopReason === "нет денег на содержание предприятия"));
      if (stopped && fail === null) fail = day;
    }
    expect(marks).toEqual({ 12: 14104, 24: 10255, 36: 5826, 48: 1408, 50: 606 });
    expect(fail).toBe(52);
    const again = createGame({ seed: 21, scenario: "base" });
    const other = again.houses.find((house) => house.player)!;
    for (let day = 0; day < 50; day += 1) tick(again);
    expect(other.credits).toBe(606);
  });

  it("рейс в Порт Лиры приносит выручку до отказа смены", () => {
    const state = createGame({ seed: 21, scenario: "base" });
    const player = state.houses.find((house) => house.player)!;
    const ship = state.ships.find((item) => item.houseId === player.id && item.worldId === "w-bread")!;
    expect(dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "Хлеб в Лиру",
      shipId: ship.id,
      autoFuel: true,
      stops: [
        { worldId: "w-bread", actions: [{ good: "food", mode: "load", amount: 40, price: 0, keep: 0 }] },
        { worldId: "w-lyra", actions: [{ good: "food", mode: "sell", amount: 40, price: 0, keep: 0 }] },
      ],
    }).ok).toBe(true);
    let sold = 0;
    let carried = 0;
    let fuelWithFood = 0;
    for (let day = 1; day <= 50; day += 1) {
      tick(state);
      if (ship.cargo.food > carried) {
        carried = ship.cargo.food;
        fuelWithFood = ship.cargo.fuel;
      }
      const route = state.routes.find((item) => item.houseId === player.id)!;
      if (sold === 0 && route.revenue > 0) sold = day;
    }
    expect(carried).toBe(40);
    expect(fuelWithFood).toBeGreaterThanOrEqual(24);
    expect(sold).toBeGreaterThan(0);
    expect(sold).toBeLessThan(51);
  });

  it("бак и трюм заполняются отдельно", () => {
    const state = createGame({ seed: 21, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    const ship = state.ships.find((item) => item.houseId === player.id && item.worldId === "w-bread")!;
    ship.cargo.fuel = 70;
    expect(dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "Ещё топливо",
      shipId: ship.id,
      autoFuel: false,
      stops: [
        { worldId: "w-bread", actions: [{ good: "fuel", mode: "load", amount: 5, price: 0, keep: 0 }] },
        { worldId: "w-harbor", actions: [] },
      ],
    }).ok).toBe(true);
    tick(state);
    expect(ship.cargo.fuel).toBe(70);
    expect(ship.stopReason).toContain("в баке нет места для топлива");

    const held = createGame({ seed: 21, scenario: "base" });
    held.aiEnabled = false;
    const owner = held.houses.find((house) => house.player)!;
    const full = held.ships.find((item) => item.houseId === owner.id && item.worldId === "w-bread")!;
    full.cargo.food = 70;
    full.cargo.fuel = 20;
    expect(dispatch(held, {
      type: "createRoute",
      houseId: owner.id,
      name: "Ещё еда",
      shipId: full.id,
      autoFuel: false,
      stops: [
        { worldId: "w-bread", actions: [{ good: "food", mode: "load", amount: 5, price: 0, keep: 0 }] },
        { worldId: "w-harbor", actions: [] },
      ],
    }).ok).toBe(true);
    tick(held);
    expect(full.cargo.food).toBe(70);
    expect(full.cargo.fuel).toBe(20);
    expect(full.stopReason).toContain("нет места под груз");
  });

  it("не выдумывает смену без работников и считает содержание порта и транзита", () => {
    const state = createSkeleton(21, "fixture");
    const house = endowHouse(state, { name: "Дом Солар", color: "#e0a84a", crest: "СЛ", profile: "player", player: true, credits: 200 });
    const world = endowWorld(state, { name: "Поле", specialty: "хлеб", x: 0, y: 0, ownerId: house.id, population: 16, popMoneyPerCapita: 0 });
    house.capitalId = world.id;
    placeBuilding(state, world, house.id, "farm");
    placeBuilding(state, world, house.id, "farm");
    tick(state);
    expect(world.buildings.map((building) => building.workers)).toEqual([16, 0]);
    expect(treasuryOutlook(state, house.id)).toEqual({ wages: 80, upkeep: 6, free: house.credits, runway: Math.floor(house.credits / 86) });

    for (const building of world.buildings) building.enabled = false;
    world.port.berthLevel = 1;
    world.port.speedLevel = 1;
    world.development = { path: "transit", level: 2, suspended: false, invested: 0, project: null, upkeepPaid: true };
    const outlook = treasuryOutlook(state, house.id);
    expect(outlook).toEqual({ wages: 0, upkeep: 17, free: house.credits, runway: Math.floor(house.credits / 17) });
    expect(treasuryWarning(state, house.id)).toContain("содержание 17");
  });

  it("включённые на паузе предприятия оцениваются сменой следующего дня", () => {
    const state = createGame({ seed: 21, scenario: "base" });
    const player = state.houses.find((house) => house.player)!;
    tick(state);
    const buildings = state.worlds.flatMap((world) => world.buildings).filter((building) => building.ownerId === player.id && building.remainingDays <= 0);
    for (const building of buildings) expect(dispatch(state, { type: "toggleBuilding", houseId: player.id, buildingId: building.id, enabled: false }).ok).toBe(true);
    tick(state);
    for (const building of buildings) expect(dispatch(state, { type: "toggleBuilding", houseId: player.id, buildingId: building.id, enabled: true }).ok).toBe(true);
    expect(buildings.every((building) => building.workers === 0)).toBe(true);
    const outlook = treasuryOutlook(state, player.id);
    expect(outlook?.wages).toBe(465);
    expect(outlook && outlook.runway <= 60).toBe(true);
    const beforeFlow = { ...player.flow };
    const beforeDays = player.flowDays;
    tick(state);
    const reset = player.flowDays === 0 && beforeDays !== 0;
    const flow = dayFlow(beforeFlow, player.flow, player.lastFlow, reset);
    expect(flow.wages).toBe(outlook?.wages);
  });

  it("полный бак освобождает причал, а колония не сливает топливо на обратный путь", () => {
    const state = createGame({ seed: 21, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    const bread = state.worlds.find((world) => world.id === "w-bread")!;
    const stuck = state.ships.find((item) => item.houseId === player.id && item.worldId === "w-bread")!;
    const waiter = state.ships.find((item) => item.houseId === player.id && item.id !== stuck.id && item.classId === "freighter")!;
    stuck.cargo.fuel = 70;
    waiter.worldId = bread.id;
    waiter.status = "docked";
    waiter.portArrived = 2;
    stuck.portArrived = 1;
    expect(dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "Лишнее топливо",
      shipId: stuck.id,
      autoFuel: false,
      stops: [
        { worldId: "w-bread", actions: [{ good: "fuel", mode: "load", amount: 5, price: 0, keep: 0 }] },
        { worldId: "w-harbor", actions: [] },
      ],
    }).ok).toBe(true);
    expect(dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "Ждёт причал",
      shipId: waiter.id,
      autoFuel: false,
      stops: [
        { worldId: "w-bread", actions: [{ good: "food", mode: "load", amount: 1, price: 0, keep: 0 }] },
        { worldId: "w-harbor", actions: [] },
      ],
    }).ok).toBe(true);
    bread.port.berth = [stuck.id];
    bread.port.queue = [waiter.id];
    tick(state);
    expect(stuck.stopReason ?? "").toContain("Причал освобождён");
    expect(bread.port.berth).not.toContain(stuck.id);

    const colony = createSkeleton(1, "fixture");
    const house = endowHouse(colony, { name: "Дом Солар", color: "#e0a84a", crest: "СЛ", profile: "player", player: true, credits: 20000 });
    const home = endowWorld(colony, { name: "Дом", specialty: "дом", x: 0, y: 0, ownerId: house.id, population: 10, popMoneyPerCapita: 0, stock: { food: 40, parts: 20, fuel: 40 } });
    endowWorld(colony, { name: "Пустошь", specialty: "пусто", x: 607, y: 0, ownerId: null, population: 0, popMoneyPerCapita: 0 });
    const ship = placeShip(colony, house.id, home, "freighter", 34);
    createGoods(ship.cargo, colony.accounts, "food", 30);
    createGoods(ship.cargo, colony.accounts, "parts", 12);
    expect(dispatch(colony, { type: "colonize", houseId: house.id, shipId: ship.id, worldId: colony.worlds[1].id }).ok).toBe(true);
    const fuelAction = colony.routes[0].stops[0].actions.find((action) => action.good === "fuel");
    expect(fuelAction).toBeUndefined();

    const partial = placeShip(colony, house.id, home, "freighter", 0);
    partial.cargo.food = 40;
    partial.loadWait = 0;
    expect(holdForLoad(partial, { minLoad: 50, maxWait: 3, stops: [], id: "r", houseId: house.id, name: "", paused: false, autoFuel: false, revenue: 0, cost: 0, fuelUsed: 0, movedWindow: 0, daysFlying: 0, daysPort: 0, daysWaiting: 0, lastRevenue: 0, lastCost: 0, lastFuelUsed: 0, lastMoved: 0 } as never, 70)).toBe("waiting");
    expect(partial.stopReason).toContain("ждём загрузку");
    expect(partial.stopReason).not.toContain("не влезает");
  });
});
