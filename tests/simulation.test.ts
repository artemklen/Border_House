import { describe, expect, it } from "vitest";
import { createClock, takeTicks } from "../src/sim/clock";
import { dispatch } from "../src/sim/commands";
import { createGame } from "../src/sim/create";
import {
  createExpansionScenario,
  createGrainScenario,
  createIndustryScenario,
  createLogisticsScenario,
  createSuccessionScenario,
} from "../src/sim/diagnostics";
import { sha256 } from "../src/sim/hash";
import { audit, hashState } from "../src/sim/mutate";
import { deserialize, serialize } from "../src/sim/save";
import { runTicks, territoriesOnRoute } from "../src/sim/simulate";
import type { SimState } from "../src/sim/types";

function mustAudit(state: SimState): void {
  const report = audit(state);
  expect(report.errors, report.errors.join("\n")).toEqual([]);
}

describe("контрольный отпечаток", () => {
  it("sha256('abc') совпадает с эталоном FIPS", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("один seed и те же команды дают один hash, а скорость кадров не входит в состояние", () => {
    const left = createGame({ seed: 42, scenario: "base" });
    const right = createGame({ seed: 42, scenario: "base" });
    const script = () => {
      dispatch(left, {
        type: "createRoute",
        houseId: left.houses[0].id,
        name: "Хлеб",
        shipId: left.ships[0].id,
        stops: [
          { worldId: "w-bread", actions: [{ good: "food", mode: "load", amount: 20, price: 0, keep: 30 }] },
          { worldId: "w-harbor", actions: [{ good: "food", mode: "unload", amount: 20, price: 0, keep: 0 }] },
        ],
      });
      dispatch(right, {
        type: "createRoute",
        houseId: right.houses[0].id,
        name: "Хлеб",
        shipId: right.ships[0].id,
        stops: [
          { worldId: "w-bread", actions: [{ good: "food", mode: "load", amount: 20, price: 0, keep: 30 }] },
          { worldId: "w-harbor", actions: [{ good: "food", mode: "unload", amount: 20, price: 0, keep: 0 }] },
        ],
      });
    };
    script();
    runTicks(left, 30);
    runTicks(right, 30);
    expect(hashState(left)).toBe(hashState(right));
    expect(left.tick).toBe(30);
    const clock = createClock();
    clock.paused = false;
    expect(takeTicks(clock, 0.5, 10) + takeTicks(clock, 0.5, 10)).toBe(2);
    const burst = createClock();
    burst.paused = false;
    expect(takeTicks(burst, 1, 10)).toBe(2);
    burst.speed = 3;
    expect(takeTicks(burst, 1, 30)).toBe(16);
    burst.paused = true;
    expect(takeTicks(burst, 5, 30)).toBe(0);
  });
});

describe("баланс и новая партия", () => {
  it("базовый сектор 16/4 и произвольный диапазон", () => {
    const base = createGame({ seed: 1, scenario: "base" });
    expect(base.worlds).toHaveLength(16);
    expect(base.houses).toHaveLength(4);
    expect(base.houses.filter((house) => house.player)).toHaveLength(1);
    mustAudit(base);
    const custom = createGame({ seed: 2, scenario: "generated", worlds: 12, houses: 3 });
    expect(custom.worlds).toHaveLength(12);
    expect(custom.houses).toHaveLength(3);
    mustAudit(custom);
    expect(() => createGame({ seed: 1, scenario: "generated", worlds: 11, houses: 3 })).toThrow();
  });

  it("рецепт мельницы сохраняет соотношение, а покупка без денег не проходит", () => {
    const state = createGrainScenario();
    const beforeGrain = state.accounts.transformedIn.grain;
    const beforeFood = state.accounts.transformedOut.food;
    runTicks(state, 1);
    expect(state.accounts.transformedIn.grain - beforeGrain).toBe(10);
    expect(state.accounts.transformedOut.food - beforeFood).toBe(10);
    mustAudit(state);
    const buyer = state.houses[0];
    const sellerCredits = buyer.credits;
    buyer.credits = 0;
    const broke = dispatch(state, { type: "build", houseId: buyer.id, worldId: "g-field", kind: "farm" });
    expect(broke.ok).toBe(false);
    expect(buyer.credits).toBe(0);
    expect(sellerCredits).toBeGreaterThan(0);
  });
});

describe("логистика", () => {
  it("груз не продаётся до прибытия, полный склад оставляет остаток, смена маршрута не бросает текущий перегон", () => {
    const state = createLogisticsScenario();
    const ship = state.ships[0];
    const dock = state.worlds.find((world) => world.id === "l-dock")!;
    dispatch(state, {
      type: "createRoute",
      houseId: state.houses[0].id,
      name: "Руда",
      shipId: ship.id,
      stops: [
        { worldId: "l-ore", actions: [{ good: "ore", mode: "load", amount: 20, price: 0, keep: 0 }] },
        { worldId: "l-dock", actions: [{ good: "ore", mode: "unload", amount: 20, price: 0, keep: 0 }] },
      ],
    });
    const cargoBeforeDeparture = ship.cargo.ore;
    runTicks(state, 1);
    expect(ship.status === "transit" || ship.cargo.ore > cargoBeforeDeparture).toBe(true);
    runTicks(state, 1);
    if (ship.status === "transit") {
      const destination = ship.toId;
      dispatch(state, {
        type: "updateRoute",
        routeId: ship.routeId!,
        name: "Обход",
        stops: [
          { worldId: "l-ore", actions: [{ good: "ore", mode: "load", amount: 5, price: 0, keep: 0 }] },
          { worldId: "l-side", actions: [{ good: "ore", mode: "unload", amount: 5, price: 0, keep: 0 }] },
        ],
      });
      expect(ship.toId).toBe(destination);
      expect(ship.status).toBe("transit");
    }
    for (let day = 0; day < 12 && ship.traveled === 0; day += 1) runTicks(state, 1);
    expect(ship.traveled).toBeGreaterThan(0);
    for (let day = 0; day < 15 && dock.stock.ore <= 28; day += 1) runTicks(state, 1);
    expect(dock.stock.ore).toBeLessThanOrEqual(dock.capacity);
    expect(ship.cargo.ore).toBeGreaterThan(0);
    expect(sumOre(state)).toBe(audit(state).goods.ore);
    mustAudit(state);
  });

  it("короткий путь к Лире платит Веге, обход через маяк — нет", () => {
    const state = createGame({ seed: 1, scenario: "base" });
    const player = state.houses.find((house) => house.player)!;
    const direct = territoriesOnRoute(state, "w-bread", "w-lyra", player.id).map((world) => world.id);
    expect(direct).toContain("w-gate");
    const legA = territoriesOnRoute(state, "w-bread", "w-beacon", player.id).map((world) => world.id);
    const legB = territoriesOnRoute(state, "w-beacon", "w-north", player.id).map((world) => world.id);
    const legC = territoriesOnRoute(state, "w-north", "w-lyra", player.id).map((world) => world.id);
    expect([...legA, ...legB, ...legC]).not.toContain("w-gate");
  });
});

describe("дефицит зерна", () => {
  it("остановка подвоза останавливает мельницу, возобновление её поднимает", () => {
    const state = createGrainScenario();
    const ship = state.ships[0];
    const mill = state.worlds.find((world) => world.id === "g-mill")!;
    dispatch(state, {
      type: "createRoute",
      houseId: state.houses[0].id,
      name: "Зерно",
      shipId: ship.id,
      stops: [
        { worldId: "g-field", actions: [{ good: "grain", mode: "load", amount: 30, price: 0, keep: 0 }] },
        { worldId: "g-mill", actions: [{ good: "grain", mode: "unload", amount: 30, price: 0, keep: 0 }] },
      ],
    });
    let produced = false;
    for (let day = 0; day < 20; day += 1) {
      runTicks(state, 1);
      mustAudit(state);
      if (state.accounts.transformedOut.food > 0) produced = true;
    }
    expect(produced).toBe(true);
    dispatch(state, { type: "pauseRoute", routeId: ship.routeId!, paused: true });
    let stalled = false;
    for (let day = 0; day < 30; day += 1) {
      runTicks(state, 1);
      mustAudit(state);
      const reason = mill.buildings.find((building) => building.kind === "mill")?.stopReason ?? "";
      if (reason.includes("зерно") && mill.stock.food < 30) stalled = true;
    }
    expect(stalled).toBe(true);
    const foodAtStall = state.accounts.transformedOut.food;
    dispatch(state, { type: "pauseRoute", routeId: ship.routeId!, paused: false });
    let recovered = false;
    for (let day = 0; day < 40; day += 1) {
      runTicks(state, 1);
      mustAudit(state);
      const reason = mill.buildings.find((building) => building.kind === "mill")?.stopReason;
      if (state.accounts.transformedOut.food > foodAtStall && !reason?.includes("зерно")) recovered = true;
    }
    expect(recovered).toBe(true);
  });
});

describe("дома-соперники", () => {
  it("ИИ на свои деньги подвозит руду и получает сплавы", () => {
    const state = createIndustryScenario();
    const ai = state.houses.find((house) => !house.player)!;
    const started = ai.credits;
    runTicks(state, 40);
    mustAudit(state);
    const forge = state.worlds.find((world) => world.id === "i-forge")!;
    expect(forge.stock.alloys).toBeGreaterThan(0);
    expect(ai.credits).not.toBe(started);
    expect(state.aiLog.some((entry) => entry.houseId === ai.id)).toBe(true);
    expect(state.ships.some((ship) => ship.houseId === ai.id && ship.traveled > 0)).toBe(true);
  });

  it("ИИ сам основывает колонию и платит за неё", () => {
    const state = createExpansionScenario();
    const ai = state.houses[0];
    const credits = ai.credits;
    const parts = state.worlds[0].stock.parts + state.ships[0].cargo.parts;
    runTicks(state, 30);
    mustAudit(state);
    const colony = state.worlds.find((world) => world.id === "e-free")!;
    expect(colony.ownerId).toBe(ai.id);
    expect(colony.buildings).toHaveLength(0);
    expect(colony.population).toBe(state.rules.colonizePop);
    expect(colony.satisfaction).toBeLessThan(70);
    expect(ai.credits).toBeLessThan(credits);
    const partsNow = state.worlds.reduce((sum, world) => sum + world.stock.parts, 0) + state.ships.reduce((sum, ship) => sum + ship.cargo.parts, 0);
    expect(partsNow).toBeLessThan(parts);
  });
});

describe("зависимость и два разных хода", () => {
  it("голодная Вега принимает обмен, сытая отказывает; эмбарго и продолжение торговли расходятся", () => {
    const hungry = createGame({ seed: 4, scenario: "base" });
    const player = hungry.houses.find((house) => house.player)!;
    const vega = hungry.houses.find((house) => house.name === "Дом Вега")!;
    dispatch(hungry, {
      type: "proposeTreaty",
      houseId: player.id,
      otherId: vega.id,
      kind: "exchange",
      tariffBps: 300,
      good: "food",
      qtyPerWindow: 12,
      duration: 48,
    });
    runTicks(hungry, 5);
    const accepted = hungry.treaties.find((treaty) => treaty.proposerId === player.id);
    expect(accepted?.status).toBe("active");

    const fed = createGame({ seed: 4, scenario: "base" });
    const fedPlayer = fed.houses.find((house) => house.player)!;
    const fedVega = fed.houses.find((house) => house.name === "Дом Вега")!;
    const capital = fed.worlds.find((world) => world.id === "w-vega")!;
    capital.stock.food = 900;
    fed.accounts.goodsCreated.food += 830;
    dispatch(fed, {
      type: "proposeTreaty",
      houseId: fedPlayer.id,
      otherId: fedVega.id,
      kind: "exchange",
      tariffBps: 300,
      good: "food",
      qtyPerWindow: 12,
      duration: 48,
    });
    runTicks(fed, 5);
    expect(fed.treaties.find((treaty) => treaty.proposerId === fedPlayer.id)?.status).toBe("rejected");

    const trade = createGame({ seed: 4, scenario: "base" });
    trade.aiEnabled = false;
    const trader = trade.houses.find((house) => house.player)!;
    const rival = trade.houses.find((house) => house.name === "Дом Вега")!;
    const vegaWorld = trade.worlds.find((world) => world.id === "w-vega")!;
    trade.accounts.goodsDestroyed.food += vegaWorld.stock.food - 12;
    vegaWorld.stock.food = 12;
    vegaWorld.population = 100;
    const ship = trade.ships.find((item) => item.houseId === trader.id && item.worldId === "w-bread")!;
    dispatch(trade, {
      type: "createRoute",
      houseId: trader.id,
      name: "Кормушка",
      shipId: ship.id,
      stops: [
        {
          worldId: "w-bread",
          actions: [
            { good: "food", mode: "load", amount: 16, price: 0, keep: 30 },
            { good: "fuel", mode: "load", amount: 20, price: 0, keep: 8 },
          ],
        },
        { worldId: "w-vega", actions: [{ good: "food", mode: "sell", amount: 16, price: 1, keep: 0 }] },
      ],
    });
    let opened = false;
    for (let day = 0; day < 40 && !opened; day += 1) {
      runTicks(trade, 1);
      const delivered = trade.worlds.find((world) => world.id === "w-vega")!.imported[trader.id]?.food ?? 0;
      if (delivered > 0) opened = true;
    }
    expect(opened).toBe(true);
    const flowing = serialize(trade);
    const cut = deserialize(flowing);
    const kept = deserialize(flowing);
    const cutPlayer = cut.houses.find((house) => house.player)!;
    const cutRival = cut.houses.find((house) => house.name === "Дом Вега")!;
    dispatch(cut, { type: "pauseRoute", routeId: cut.routes[0].id, paused: true });
    dispatch(cut, { type: "setEmbargo", houseId: cutPlayer.id, otherId: cutRival.id, embargo: true });
    runTicks(cut, 30);
    runTicks(kept, 30);
    const cutSales = cut.houses.find((house) => house.player)!.flow.sales + cut.houses.find((house) => house.player)!.lastFlow.sales;
    const keptSales = kept.houses.find((house) => house.player)!.flow.sales + kept.houses.find((house) => house.player)!.lastFlow.sales;
    const cutFood = cut.worlds.find((world) => world.id === "w-vega")!.stock.food;
    const keptFood = kept.worlds.find((world) => world.id === "w-vega")!.stock.food;
    const cutRelation = cut.houses.find((house) => house.player)!.relation[cut.houses.find((house) => house.name === "Дом Вега")!.id];
    const keptRelation = kept.houses.find((house) => house.player)!.relation[rival.id];
    expect(keptSales).toBeGreaterThan(cutSales);
    expect(keptFood).toBeGreaterThan(cutFood);
    expect(cutRelation).toBeLessThan(keptRelation);
    mustAudit(cut);
    mustAudit(kept);
  });
});

describe("наследование и сохранения", () => {
  it("наследник принимает дом, а без наследника главой становится губернатор", () => {
    const state = createSuccessionScenario(9, true);
    const house = state.houses[0];
    const heir = state.people.find((person) => person.role === "heir")!;
    const ship = state.ships[0];
    dispatch(state, {
      type: "createRoute",
      houseId: house.id,
      name: "Рейс",
      shipId: ship.id,
      stops: [
        { worldId: "s-world", actions: [{ good: "food", mode: "load", amount: 4, price: 0, keep: 10 }] },
        { worldId: "s-other", actions: [{ good: "food", mode: "unload", amount: 4, price: 0, keep: 0 }] },
      ],
    });
    dispatch(state, {
      type: "proposeTreaty",
      houseId: house.id,
      otherId: house.id,
      kind: "supply",
      tariffBps: 0,
      good: "food",
      qtyPerWindow: 1,
      duration: 40,
    });
    const worlds = state.worlds.map((world) => world.ownerId);
    runTicks(state, 4);
    expect(state.people.find((person) => person.id === heir.id)?.role).toBe("head");
    expect(state.worlds.map((world) => world.ownerId)).toEqual(worlds);
    expect(state.ships[0].houseId).toBe(house.id);
    expect(house.credits).toBeGreaterThan(0);
    mustAudit(state);

    const fallback = createSuccessionScenario(9, false);
    const governor = fallback.people.find((person) => person.role === "governor")!;
    runTicks(fallback, 4);
    expect(fallback.people.find((person) => person.id === governor.id)?.role).toBe("head");
    expect(fallback.journal.some((entry) => entry.text.includes("наследник"))).toBe(true);
    expect(fallback.worlds.every((world) => world.ownerId === fallback.houses[0].id || world.ownerId)).toBe(true);
  });

  it("сохранение и загрузка совпадают с непрерывным прогоном", () => {
    const continuous = createGame({ seed: 15, scenario: "base" });
    const paused = createGame({ seed: 15, scenario: "base" });
    runTicks(continuous, 18);
    runTicks(paused, 7);
    const raw = serialize(paused);
    const loaded = deserialize(raw);
    expect(() => deserialize("{")).toThrow(/повреждён/);
    expect(() => deserialize(JSON.stringify({ version: 7, state: paused }))).toThrow(/версия/);
    runTicks(loaded, 11);
    runTicks(continuous, 0);
    expect(hashState(loaded)).toBe(hashState(continuous));
    expect(loaded.rngState).toBe(continuous.rngState);
  });
});

describe("долгий прогон", () => {
  it("3600 дней базовой партии держат инварианты", () => {
    const state = createGame({ seed: 21, scenario: "base" });
    runTicks(state, 3600);
    mustAudit(state);
    expect(state.tick).toBe(3600);
    expect(state.houses.every((house) => house.credits >= 0)).toBe(true);
  });
});

function sumOre(state: SimState): number {
  return state.worlds.reduce((sum, world) => sum + world.stock.ore, 0) + state.ships.reduce((sum, ship) => sum + ship.cargo.ore, 0);
}
