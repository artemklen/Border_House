import { describe, expect, it } from "vitest";
import { createClock, planFrame } from "../src/sim/clock";
import { dispatch } from "../src/sim/commands";
import { createGame } from "../src/sim/create";
import { createExpansionScenario, createLogisticsScenario, createSuccessionScenario } from "../src/sim/diagnostics";
import { sumGoods } from "../src/sim/goods";
import { audit } from "../src/sim/mutate";
import { deserialize, SaveError, serialize, storeSave } from "../src/sim/save";
import { runTicks } from "../src/sim/simulate";
import { keptWorldId } from "../src/sim/view";

describe("замечания ревью", () => {
  it("сохранение без маршрутов или трюма не подменяет партию", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const missingRoutes = JSON.parse(serialize(state)) as { state: { routes?: unknown } };
    delete missingRoutes.state.routes;
    expect(() => deserialize(JSON.stringify(missingRoutes))).toThrow(SaveError);
    const missingCargo = JSON.parse(serialize(state)) as { state: { ships: Array<{ cargo?: unknown }> } };
    delete missingCargo.state.ships[0].cargo;
    expect(() => deserialize(JSON.stringify(missingCargo))).toThrow(SaveError);
  });

  it("кадр, перешагнувший 12-й день, помечает автосохранение и не выбрасывает секунды", () => {
    const clock = createClock();
    clock.paused = false;
    clock.speed = 3;
    const jumped = planFrame(clock, 0.125, 11, 24);
    expect(jumped.steps).toBe(2);
    expect(jumped.autosave).toBe(true);

    const replay = createClock();
    replay.paused = false;
    replay.speed = 3;
    let tick = 0;
    let saves = 0;
    for (let frame = 0; frame < 1000; frame += 1) {
      const plan = planFrame(replay, 1 / 12, tick, 24);
      if (plan.autosave) saves += 1;
      tick += plan.steps;
    }
    expect(tick).toBeGreaterThan(1300);
    expect(saves).toBeGreaterThan(50);
  });

  it("игрок не останавливает предприятие чужого дома", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const player = state.houses.find((house) => house.player)!;
    const building = state.worlds.flatMap((world) => world.buildings).find((item) => item.ownerId !== player.id)!;
    const result = dispatch(state, { type: "toggleBuilding", houseId: player.id, buildingId: building.id, enabled: false });
    expect(result.ok).toBe(false);
    expect(building.enabled).toBe(true);
  });

  it("колониальный грузовоз с полным трюмом топлива берёт набор и не уходит пустым", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const player = state.houses.find((house) => house.player)!;
    const ship = state.ships.find((item) => item.houseId === player.id && item.worldId === "w-bread" && item.classId === "freighter")!;
    expect(ship.cargo.fuel).toBe(60);
    dispatch(state, { type: "colonize", houseId: player.id, shipId: ship.id, worldId: "w-bay" });
    runTicks(state, 1);
    expect(ship.cargo.parts).toBeGreaterThanOrEqual(state.rules.colonizeParts);
    expect(ship.cargo.food).toBeGreaterThanOrEqual(state.rules.colonizeFood);
    expect(sumGoods(ship.cargo)).toBeLessThanOrEqual(70);
    expect(audit(state).ok).toBe(true);
  });

  it("приказ колонии в пути сохраняет текущий перегон и ставит маршрут после прибытия", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const player = state.houses.find((house) => house.player)!;
    const ship = state.ships.find((item) => item.houseId === player.id && item.worldId === "w-bread" && item.classId === "freighter")!;
    ship.status = "transit";
    ship.worldId = null;
    ship.fromId = "w-bread";
    ship.toId = "w-harbor";
    ship.legDistance = 10;
    ship.distanceLeft = 10;
    const result = dispatch(state, { type: "colonize", houseId: player.id, shipId: ship.id, worldId: "w-bay" });
    expect(result.ok).toBe(true);
    expect(ship.toId).toBe("w-harbor");
    expect(state.routes.some((route) => route.stops.some((stop) => stop.worldId === "w-bay"))).toBe(false);
    runTicks(state, 1);
    expect(state.routes.some((route) => route.houseId === player.id && route.stops.some((stop) => stop.worldId === "w-bay"))).toBe(true);
    expect(ship.toId === "w-bay" || ship.worldId === "w-harbor").toBe(true);
  });

  it("повтор мира в маршруте не зацикливает корабль на первой паре", () => {
    const state = createLogisticsScenario();
    const ship = state.ships[0];
    dispatch(state, {
      type: "createRoute",
      houseId: state.houses[0].id,
      name: "Петля",
      shipId: ship.id,
      stops: [
        { worldId: "l-ore", actions: [] },
        { worldId: "l-dock", actions: [] },
        { worldId: "l-ore", actions: [] },
        { worldId: "l-side", actions: [] },
      ],
    });
    const seen = new Set<string>();
    for (let day = 0; day < 40; day += 1) {
      runTicks(state, 1);
      if (ship.toId) seen.add(ship.toId);
    }
    expect(seen.has("l-side")).toBe(true);
    expect(audit(state).ok).toBe(true);
  });

  it("полный склад удерживает корабль и не сжигает топливо зря", () => {
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
    for (let day = 0; day < 20 && !(ship.worldId === "l-dock" && dock.stock.ore >= dock.capacity); day += 1) runTicks(state, 1);
    expect(ship.worldId).toBe("l-dock");
    expect(ship.cargo.ore).toBeGreaterThan(0);
    const fuel = ship.cargo.fuel;
    runTicks(state, 3);
    expect(ship.worldId).toBe("l-dock");
    expect(ship.status).not.toBe("transit");
    expect(ship.cargo.fuel).toBe(fuel);
    expect(ship.stopReason).toContain("склад");
  });

  it("пауза маршрута не грузит трюм каждый день", () => {
    const state = createLogisticsScenario();
    const ship = state.ships[0];
    dispatch(state, {
      type: "createRoute",
      houseId: state.houses[0].id,
      name: "Пауза",
      shipId: ship.id,
      stops: [
        { worldId: "l-ore", actions: [{ good: "ore", mode: "load", amount: 10, price: 0, keep: 0 }] },
        { worldId: "l-dock", actions: [] },
      ],
    });
    dispatch(state, { type: "pauseRoute", routeId: ship.routeId!, paused: true });
    runTicks(state, 3);
    expect(ship.cargo.ore).toBe(0);
    expect(ship.stopReason).toContain("пауз");
  });

  it("содержание корабля списывается и в дни перехода", () => {
    const state = createLogisticsScenario();
    const house = state.houses[0];
    const ship = state.ships[0];
    dispatch(state, {
      type: "createRoute",
      houseId: house.id,
      name: "Дальний",
      shipId: ship.id,
      stops: [
        { worldId: "l-ore", actions: [] },
        { worldId: "l-side", actions: [] },
      ],
    });
    runTicks(state, 12);
    expect(ship.traveled).toBeGreaterThan(180);
    expect(house.flow.upkeep).toBe(60);
    expect(audit(state).ok).toBe(true);
  });

  it("перевод губернатора снимает его с прежнего мира", () => {
    const state = createSuccessionScenario(9, true);
    const house = state.houses[0];
    const governor = state.people.find((person) => person.role === "governor")!;
    const home = state.worlds.find((world) => world.id === "s-world")!;
    const far = state.worlds.find((world) => world.id === "s-other")!;
    expect(home.governorId).toBe(governor.id);
    dispatch(state, { type: "appointGovernor", houseId: house.id, worldId: far.id, personId: governor.id });
    expect(far.governorId).toBe(governor.id);
    expect(home.governorId).toBeNull();
    runTicks(state, 1);
    expect(home.governorId).toBeNull();
  });

  it("повторное открытие доступа не улучшает отношения", () => {
    const state = createGame({ seed: 4, scenario: "base" });
    const player = state.houses.find((house) => house.player)!;
    const rival = state.houses.find((house) => house.name === "Дом Вега")!;
    const before = player.relation[rival.id];
    dispatch(state, { type: "setEmbargo", houseId: player.id, otherId: rival.id, embargo: false });
    expect(player.relation[rival.id]).toBe(before);
    dispatch(state, { type: "setEmbargo", houseId: player.id, otherId: rival.id, embargo: true });
    const closed = player.relation[rival.id];
    expect(closed).toBeLessThan(before);
    dispatch(state, { type: "setEmbargo", houseId: player.id, otherId: rival.id, embargo: true });
    expect(player.relation[rival.id]).toBe(closed);
  });

  it("без наследника дом берёт губернатора, даже если супруга жива", () => {
    const state = createSuccessionScenario(9, false);
    const spouse = state.people.find((person) => person.role === "spouse")!;
    const governor = state.people.find((person) => person.role === "governor")!;
    spouse.alive = true;
    runTicks(state, 4);
    expect(state.people.find((person) => person.id === governor.id)?.role).toBe("head");
    expect(state.people.find((person) => person.id === spouse.id)?.role).toBe("spouse");
  });

  it("черновик маршрута не хранит мир из другой партии", () => {
    const state = createExpansionScenario();
    expect(keptWorldId(state.worlds, "w-bread")).toBe(state.worlds[0].id);
    expect(keptWorldId(state.worlds, state.worlds[0].id)).toBe(state.worlds[0].id);
  });

  it("сценарий экспансии можно смотреть от дома игрока, а колонию основывает ИИ", () => {
    const state = createExpansionScenario();
    expect(state.houses.some((house) => house.player)).toBe(true);
    const ai = state.houses.find((house) => house.profile === "expansionist")!;
    expect(ai.player).toBe(false);
    runTicks(state, 30);
    expect(state.worlds.find((world) => world.id === "e-free")?.ownerId).toBe(ai.id);
    expect(audit(state).ok).toBe(true);
  });

  it("маленькая колония потребляет еду накопительно и платит налог без дневной нормы", () => {
    const state = createExpansionScenario();
    state.aiEnabled = false;
    const owner = state.houses.find((house) => !house.player)!;
    const world = state.worlds.find((item) => item.id === "e-free")!;
    world.ownerId = owner.id;
    world.population = 70;
    world.satisfaction = 42;
    world.popWallet = 2000;
    state.accounts.creditsCreated += 2000;
    runTicks(state, 3);
    expect(world.popWallet).toBeLessThan(2000);
    expect(world.satisfaction).toBeLessThan(42);
    expect(audit(state).ok).toBe(true);
  });

  it("сохранение без цен мира не принимается", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const broken = JSON.parse(serialize(state)) as { state: { worlds: Array<{ prices?: unknown }> } };
    delete broken.state.worlds[0].prices;
    expect(() => deserialize(JSON.stringify(broken))).toThrow(SaveError);
  });

  it("сбой записи автосохранения не бросает исключение наружу", () => {
    const storage = { setItem() { throw new Error("quota"); } };
    expect(storeSave(storage, "key", "{}")).toBe(false);
    expect(storeSave({ setItem() { return undefined; } }, "key", "{}")).toBe(true);
  });

  it("новое назначение корабля отменяет колониальный приказ", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    const ship = state.ships.find((item) => item.houseId === player.id && item.worldId === "w-bread" && item.classId === "freighter")!;
    dispatch(state, { type: "colonize", houseId: player.id, shipId: ship.id, worldId: "w-bay" });
    expect(ship.mission?.type).toBe("colonize");
    dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "Обычный",
      shipId: ship.id,
      stops: [
        { worldId: "w-bread", actions: [{ good: "food", mode: "load", amount: 8, price: 0, keep: 20 }] },
        { worldId: "w-harbor", actions: [] },
      ],
    });
    expect(ship.mission).toBeNull();
    const routeId = ship.routeId;
    runTicks(state, 1);
    expect(ship.mission).toBeNull();
    expect(ship.routeId).toBe(routeId);
    expect(state.routes.find((route) => route.id === routeId)?.stops.some((stop) => stop.worldId === "w-bay")).toBe(false);
  });

  it("покупка топлива при полном трюме не запирает корабль, если топливо уже есть", () => {
    const state = createGame({ seed: 4, scenario: "base" });
    state.aiEnabled = false;
    const vega = state.houses.find((house) => house.name === "Дом Вега")!;
    const ship = state.ships.find((item) => item.houseId === vega.id && item.classId === "freighter")!;
    ship.worldId = "w-bread";
    ship.fromId = "w-bread";
    ship.status = "docked";
    const removedFuel = ship.cargo.fuel - 45;
    ship.cargo.fuel = 45;
    if (removedFuel > 0) state.accounts.goodsDestroyed.fuel += removedFuel;
    dispatch(state, {
      type: "createRoute",
      houseId: vega.id,
      name: "Закупка",
      shipId: ship.id,
      stops: [
        {
          worldId: "w-bread",
          actions: [
            { good: "food", mode: "buy", amount: 25, price: 100, keep: 0 },
            { good: "fuel", mode: "buy", amount: 20, price: 100, keep: 0 },
          ],
        },
        { worldId: "w-vega", actions: [{ good: "food", mode: "sell", amount: 10, price: 1, keep: 0 }] },
      ],
    });
    runTicks(state, 1);
    expect(ship.status).toBe("transit");
    expect(ship.toId).toBe("w-vega");
    expect(audit(state).ok).toBe(true);
  });

  it("последнее окно поставки проверяется до истечения договора", () => {
    const state = createGame({ seed: 4, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    const vega = state.houses.find((house) => house.name === "Дом Вега")!;
    const before = player.relation[vega.id];
    dispatch(state, {
      type: "proposeTreaty",
      houseId: player.id,
      otherId: vega.id,
      kind: "exchange",
      tariffBps: 300,
      good: "food",
      qtyPerWindow: 8,
      duration: 24,
    });
    const treaty = state.treaties.find((item) => item.proposerId === player.id)!;
    dispatch(state, { type: "respondTreaty", houseId: vega.id, treatyId: treaty.id, accept: true });
    runTicks(state, 24);
    expect(treaty.status).toBe("broken");
    expect(player.relation[vega.id]).toBeLessThan(before);
  });

  it("корабль вне маршрута сначала идёт на первую остановку", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    const ship = state.ships.find((item) => item.houseId === player.id && item.worldId === "w-harbor" && item.classId === "freighter")!;
    dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "Сбор",
      shipId: ship.id,
      stops: [
        { worldId: "w-bread", actions: [{ good: "food", mode: "load", amount: 8, price: 0, keep: 20 }] },
        { worldId: "w-vega", actions: [{ good: "food", mode: "sell", amount: 8, price: 1, keep: 0 }] },
      ],
    });
    runTicks(state, 1);
    expect(ship.toId).toBe("w-bread");
  });
});
