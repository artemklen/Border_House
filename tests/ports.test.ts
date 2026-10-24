import { describe, expect, it } from "vitest";
import { dispatch } from "../src/sim/commands";
import { createLogisticsScenario } from "../src/sim/diagnostics";
import { createGame, placeShip } from "../src/sim/create";
import { createGoods, createCredits, destroyGoods, audit, hashState } from "../src/sim/mutate";
import { deserialize, serialize } from "../src/sim/save";
import { runTicks } from "../src/sim/simulate";
import type { SimState } from "../src/sim/types";

function drainFuel(state: SimState, shipId: string): void {
  const ship = state.ships.find((item) => item.id === shipId);
  if (!ship) return;
  destroyGoods(ship.cargo, state.accounts, "fuel", ship.cargo.fuel);
}

describe("порт", () => {
  it("два корабля не обрабатывают больше лимита, а второй стоит в очереди", () => {
    const state = createLogisticsScenario();
    const house = state.houses[0];
    const ore = state.worlds.find((world) => world.id === "l-ore")!;
    createGoods(ore.stock, state.accounts, "ore", 200);
    const first = state.ships[0];
    const second = placeShip(state, house.id, ore, "freighter", 0);
    drainFuel(state, first.id);
    for (const ship of [first, second]) {
      ship.status = "docked";
      ship.worldId = ore.id;
    }
    dispatch(state, {
      type: "createRoute",
      houseId: house.id,
      name: "Руда",
      shipId: first.id,
      stops: [
        { worldId: "l-ore", actions: [{ good: "ore", mode: "load", amount: 70, price: 0, keep: 0 }] },
        { worldId: "l-side", actions: [{ good: "ore", mode: "unload", amount: 70, price: 0, keep: 0 }] },
      ],
    });
    dispatch(state, { type: "assignShip", shipId: second.id, routeId: first.routeId });
    runTicks(state, 1);
    const moved = first.cargo.ore + second.cargo.ore;
    expect(moved).toBe(70);
    expect([first.cargo.ore, second.cargo.ore].filter((qty) => qty === 0)).toHaveLength(1);
    expect(ore.port.queue).toHaveLength(1);
    expect(audit(state).errors).toEqual([]);
  });

  it("достройка причала не увеличивает склад", () => {
    const state = createLogisticsScenario();
    const house = state.houses[0];
    const world = state.worlds.find((item) => item.id === "l-ore")!;
    const capacity = world.capacity;
    createGoods(world.stock, state.accounts, "parts", 20);
    const berth = dispatch(state, { type: "expandPort", houseId: house.id, worldId: world.id, kind: "berth" });
    expect(berth.ok).toBe(true);
    runTicks(state, 5);
    expect(world.port.berthLevel).toBe(1);
    expect(world.capacity).toBe(capacity);
    const speed = dispatch(state, { type: "expandPort", houseId: house.id, worldId: world.id, kind: "speed" });
    expect(speed.ok).toBe(true);
    runTicks(state, 4);
    expect(world.port.speedLevel).toBe(1);
    expect(world.capacity).toBe(capacity);
    expect(audit(state).errors).toEqual([]);
  });

  it("перевалка идёт через склад узла", () => {
    const state = createLogisticsScenario();
    const house = state.houses[0];
    const ore = state.worlds.find((world) => world.id === "l-ore")!;
    const dock = state.worlds.find((world) => world.id === "l-dock")!;
    const side = state.worlds.find((world) => world.id === "l-side")!;
    dock.capacity = 4000;
    createGoods(ore.stock, state.accounts, "food", 80);
    const shipA = state.ships[0];
    const shipB = placeShip(state, house.id, dock, "freighter", 40);
    shipA.worldId = ore.id;
    shipA.status = "docked";
    dispatch(state, {
      type: "createRoute",
      houseId: house.id,
      name: "К доку",
      shipId: shipA.id,
      stops: [
        { worldId: ore.id, actions: [{ good: "food", mode: "load", amount: 20, price: 0, keep: 0 }] },
        { worldId: dock.id, actions: [{ good: "food", mode: "unload", amount: 20, price: 0, keep: 0 }] },
      ],
    });
    dispatch(state, {
      type: "createRoute",
      houseId: house.id,
      name: "Дальше",
      shipId: shipB.id,
      minLoad: 10,
      maxWait: 6,
      stops: [
        { worldId: dock.id, actions: [{ good: "food", mode: "load", amount: 20, price: 0, keep: 0 }] },
        { worldId: side.id, actions: [{ good: "food", mode: "unload", amount: 20, price: 0, keep: 0 }] },
      ],
    });
    runTicks(state, 30);
    expect(side.stock.food).toBeGreaterThan(0);
    expect(audit(state).errors).toEqual([]);
  });

  it("сохранение посреди обработки совпадает с непрерывным прогоном", () => {
    const build = (): SimState => {
      const state = createLogisticsScenario();
      const house = state.houses[0];
      const ship = state.ships[0];
      drainFuel(state, ship.id);
      dispatch(state, {
        type: "createRoute",
        houseId: house.id,
        name: "Руда",
        shipId: ship.id,
        stops: [
          { worldId: "l-ore", actions: [{ good: "ore", mode: "load", amount: 200, price: 0, keep: 0 }] },
          { worldId: "l-dock", actions: [{ good: "ore", mode: "unload", amount: 200, price: 0, keep: 0 }] },
        ],
      });
      return state;
    };
    const left = build();
    const right = build();
    runTicks(left, 2);
    const restored = deserialize(serialize(left));
    runTicks(restored, 3);
    runTicks(right, 5);
    expect(hashState(restored)).toBe(hashState(right));
  });

  it("запись версии 2 получает порт, а версия 4 отвергается", () => {
    const state = createLogisticsScenario();
    const raw = JSON.parse(serialize(state)) as { version: number; state: SimState };
    raw.version = 2;
    raw.state.version = 2 as unknown as 3;
    for (const world of raw.state.worlds) delete (world as { port?: unknown }).port;
    const loaded = deserialize(JSON.stringify(raw));
    expect(loaded.version).toBe(3);
    expect(loaded.worlds.every((world) => world.port.berthLevel === 0 && world.port.queue.length === 0)).toBe(true);
    expect(() => deserialize(JSON.stringify({ version: 4, state }))).toThrow(/версия/);
  });

  it("баржа забирает остаток на следующий день и не проводит уже взятое ещё раз", () => {
    const state = createLogisticsScenario();
    const house = state.houses[0];
    const ore = state.worlds.find((world) => world.id === "l-ore")!;
    createGoods(ore.stock, state.accounts, "ore", 200);
    const before = ore.stock.ore;
    const barge = placeShip(state, house.id, ore, "barge", 0);
    state.ships[0].routeId = null;
    dispatch(state, {
      type: "createRoute",
      houseId: house.id,
      name: "Полная баржа",
      shipId: barge.id,
      stops: [
        { worldId: "l-ore", actions: [{ good: "ore", mode: "load", amount: 140, price: 0, keep: 0 }] },
        { worldId: "l-side", actions: [{ good: "ore", mode: "unload", amount: 140, price: 0, keep: 0 }] },
      ],
    });
    runTicks(state, 1);
    expect(barge.cargo.ore).toBe(80);
    expect(ore.stock.ore).toBe(before - 80);
    runTicks(state, 1);
    expect(barge.cargo.ore).toBe(140);
    expect(ore.stock.ore).toBe(before - 140);
    expect(audit(state).errors).toEqual([]);
  });

  it("полный склад отпускает причал и не уничтожает груз", () => {
    const state = createLogisticsScenario();
    const house = state.houses[0];
    const dock = state.worlds.find((world) => world.id === "l-dock")!;
    const ship = state.ships[0];
    createGoods(dock.stock, state.accounts, "ore", dock.capacity - Object.values(dock.stock).reduce((sum, value) => sum + value, 0));
    createGoods(ship.cargo, state.accounts, "ore", 10);
    ship.worldId = dock.id;
    ship.status = "docked";
    dispatch(state, {
      type: "createRoute",
      houseId: house.id,
      name: "В полный док",
      shipId: ship.id,
      stops: [
        { worldId: "l-dock", actions: [{ good: "ore", mode: "unload", amount: 10, price: 0, keep: 0 }] },
        { worldId: "l-ore", actions: [] },
      ],
    });
    runTicks(state, 1);
    expect(ship.cargo.ore).toBe(10);
    expect(ship.stopReason ?? "").toContain("Причал освобождён");
    expect(dock.port.berth).not.toContain(ship.id);
  });

  it("ожидание минимума заканчивается частичным рейсом", () => {
    const state = createLogisticsScenario();
    const house = state.houses[0];
    const ore = state.worlds.find((world) => world.id === "l-ore")!;
    destroyGoods(ore.stock, state.accounts, "ore", ore.stock.ore - 5);
    const ship = state.ships[0];
    dispatch(state, {
      type: "createRoute",
      houseId: house.id,
      name: "Неполный",
      shipId: ship.id,
      minLoad: 20,
      maxWait: 1,
      stops: [
        { worldId: "l-ore", actions: [{ good: "ore", mode: "load", amount: 5, price: 0, keep: 0 }] },
        { worldId: "l-side", actions: [{ good: "ore", mode: "unload", amount: 5, price: 0, keep: 0 }] },
      ],
    });
    runTicks(state, 1);
    expect(ship.status).toBe("docked");
    expect(ship.cargo.ore).toBe(5);
    runTicks(state, 1);
    expect(ship.status).toBe("transit");
    expect(ship.cargo.ore).toBe(5);
    expect(ship.stopReason ?? "").toContain("частичный рейс");
  });

  it("ИИ платит за причал, когда у своего порта в очереди два корабля", () => {
    const state = createGame({ seed: 9, scenario: "base" });
    const house = state.houses.find((item) => !item.player)!;
    const world = state.worlds.find((item) => item.ownerId === house.id)!;
    const other = state.worlds.find((item) => item.id !== world.id)!;
    for (const ship of state.ships) {
      ship.routeId = null;
      if (ship.houseId !== house.id) {
        ship.status = "building";
        ship.remainingDays = 40;
      }
    }
    createGoods(world.stock, state.accounts, "parts", 20);
    createCredits(state, { kind: "house", id: house.id }, 5000);
    const ships = [0, 1, 2].map(() => placeShip(state, house.id, world, "skiff", 4));
    for (const ship of ships) {
      dispatch(state, {
        type: "createRoute",
        houseId: house.id,
        name: `Ждать ${ship.id}`,
        shipId: ship.id,
        minLoad: 20,
        maxWait: 30,
        stops: [
          { worldId: world.id, actions: [{ good: "alloys", mode: "load", amount: 20, price: 0, keep: 0 }] },
          { worldId: other.id, actions: [] },
        ],
      });
    }
    runTicks(state, 5);
    expect(world.port.project?.kind).toBe("berth");
    expect(house.flow.construction).toBeGreaterThanOrEqual(2400);
    expect(audit(state).errors).toEqual([]);
  });
});
