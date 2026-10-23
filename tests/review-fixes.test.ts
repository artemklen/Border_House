import { describe, expect, it } from "vitest";
import { planAi } from "../src/sim/ai";
import { createClock, planFrame } from "../src/sim/clock";
import { dispatch } from "../src/sim/commands";
import { createGame, endowHouse, endowWorld, placeBuilding, placeShip } from "../src/sim/create";
import { createExpansionScenario, createIndustryScenario, createLogisticsScenario, createSuccessionScenario } from "../src/sim/diagnostics";
import { sumGoods } from "../src/sim/goods";
import { audit, foodCover, hashState } from "../src/sim/mutate";
import { deserialize, SaveError, serialize, storeSave } from "../src/sim/save";
import { runTicks } from "../src/sim/simulate";
import { bottlenecks, colonyShip, dependencyRows, explainShip, fleetCommandShipId, fleetPickId, foodPerDay, keptOtherHouseId, keptShipId, keptWorldId, pickMapTarget } from "../src/sim/view";

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
    expect(storeSave(() => { throw new Error("SecurityError"); }, "key", "{}")).toBe(false);
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

  it("неполные правила, касса или черты не подменяют партию", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const noPrice = JSON.parse(serialize(state)) as { state: { rules: { basePrice?: unknown } } };
    delete noPrice.state.rules.basePrice;
    expect(() => deserialize(JSON.stringify(noPrice))).toThrow(SaveError);
    const noFlow = JSON.parse(serialize(state)) as { state: { houses: Array<{ flow?: unknown }> } };
    delete noFlow.state.houses[0].flow;
    expect(() => deserialize(JSON.stringify(noFlow))).toThrow(SaveError);
    const noTraits = JSON.parse(serialize(state)) as { state: { people: Array<{ traits?: unknown }> } };
    delete noTraits.state.people[0].traits;
    expect(() => deserialize(JSON.stringify(noTraits))).toThrow(SaveError);
  });

  it("повтор стоянки не закупает ту же партию, пока выход закрыт", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    const vega = state.houses.find((house) => house.name === "Дом Вега")!;
    const ship = state.ships.find((item) => item.houseId === player.id && item.worldId === "w-harbor" && item.classId === "freighter")!;
    dispatch(state, { type: "setEmbargo", houseId: vega.id, otherId: player.id, embargo: true });
    dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "Руда наружу",
      shipId: ship.id,
      stops: [
        { worldId: "w-harbor", actions: [{ good: "ore", mode: "load", amount: 10, price: 0, keep: 0 }] },
        { worldId: "w-vega", actions: [{ good: "ore", mode: "sell", amount: 10, price: 1, keep: 0 }] },
      ],
    });
    runTicks(state, 1);
    const loaded = ship.cargo.ore;
    expect(loaded).toBeGreaterThan(0);
    runTicks(state, 3);
    expect(ship.cargo.ore).toBe(loaded);
    expect(ship.status).not.toBe("transit");
    dispatch(state, { type: "setEmbargo", houseId: vega.id, otherId: player.id, embargo: false });
    for (let day = 0; day < 6 && ship.status !== "transit"; day += 1) runTicks(state, 1);
    expect(ship.status).toBe("transit");
    expect(ship.toId).toBe("w-vega");
  });

  it("покрытие еды колонии совпадает с дробным потреблением", () => {
    expect(foodCover(70, 0, 1)).toBe(0);
    expect(foodCover(400, 240, 1)).toBe(60);
  });

  it("после основания колонии корабль не возит набор по кругу", () => {
    const state = createExpansionScenario();
    const ai = state.houses.find((house) => house.profile === "expansionist")!;
    runTicks(state, 30);
    const ship = state.ships.find((item) => item.houseId === ai.id)!;
    expect(ship.cargo.fuel === 0 && ship.cargo.parts >= 12 && ship.cargo.food >= 54).toBe(false);
    expect(audit(state).ok).toBe(true);
  });

  it("ИИ не плодит недостижимые маршруты заправки", () => {
    const state = createGame({ seed: 21, scenario: "base" });
    state.rules.aiInterval = 1;
    const vega = state.houses.find((house) => house.name === "Дом Вега")!;
    const skiff = state.ships.find((ship) => ship.houseId === vega.id && ship.classId === "skiff")!;
    skiff.worldId = "w-vega";
    skiff.fromId = "w-vega";
    skiff.status = "blocked";
    skiff.stopReason = "нет топлива на следующий перегон";
    const removed = skiff.cargo.fuel - 3;
    skiff.cargo.fuel = 3;
    if (removed > 0) state.accounts.goodsDestroyed.fuel += removed;
    runTicks(state, 15);
    const refuels = state.routes.filter((route) => route.name.startsWith("Заправка"));
    expect(refuels.length).toBeLessThanOrEqual(1);
    expect(audit(state).ok).toBe(true);
  });

  it("сценарий наследования начинается без переполненного трюма", () => {
    expect(audit(createSuccessionScenario()).ok).toBe(true);
    expect(audit(createSuccessionScenario(9, false)).ok).toBe(true);
  });

  it("неизвестный класс корабля не подменяет партию", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const broken = JSON.parse(serialize(state)) as { state: { ships: Array<{ classId?: string }> } };
    broken.state.ships[0].classId = "galleon";
    expect(() => deserialize(JSON.stringify(broken))).toThrow(SaveError);
  });

  it("правка маршрута заново исполняет действия стоянки", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    const vega = state.houses.find((house) => house.name === "Дом Вега")!;
    const ship = state.ships.find((item) => item.houseId === player.id && item.worldId === "w-harbor" && item.classId === "freighter")!;
    const harbor = state.worlds.find((world) => world.id === "w-harbor")!;
    for (const building of harbor.buildings) building.enabled = false;
    state.accounts.goodsDestroyed.fuel += ship.cargo.fuel - 40;
    ship.cargo.fuel = 40;
    dispatch(state, { type: "setEmbargo", houseId: vega.id, otherId: player.id, embargo: true });
    dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "Руда",
      shipId: ship.id,
      stops: [
        { worldId: "w-harbor", actions: [{ good: "ore", mode: "load", amount: 20, price: 0, keep: 0 }] },
        { worldId: "w-vega", actions: [{ good: "ore", mode: "sell", amount: 20, price: 1, keep: 0 }] },
      ],
    });
    runTicks(state, 1);
    const loaded = ship.cargo.ore;
    expect(loaded).toBe(20);
    dispatch(state, {
      type: "updateRoute",
      routeId: ship.routeId!,
      name: "Руда",
      stops: [
        { worldId: "w-harbor", actions: [{ good: "ore", mode: "unload", amount: 20, price: 0, keep: 0 }] },
        { worldId: "w-vega", actions: [] },
      ],
    });
    runTicks(state, 1);
    expect(ship.cargo.ore).toBe(0);
    expect(audit(state).ok).toBe(true);
  });

  it("два правила одного товара исполняются по отдельности", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    const ship = state.ships.find((item) => item.houseId === player.id && item.worldId === "w-harbor" && item.classId === "freighter")!;
    const harbor = state.worlds.find((world) => world.id === "w-harbor")!;
    for (const building of harbor.buildings) building.enabled = false;
    state.accounts.goodsDestroyed.fuel += ship.cargo.fuel - 40;
    ship.cargo.fuel = 40;
    dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "Двойная руда",
      shipId: ship.id,
      stops: [
        {
          worldId: "w-harbor",
          actions: [
            { good: "ore", mode: "load", amount: 10, price: 0, keep: 0 },
            { good: "ore", mode: "load", amount: 10, price: 0, keep: 0 },
          ],
        },
        { worldId: "w-bread", actions: [] },
      ],
    });
    runTicks(state, 1);
    expect(ship.cargo.ore).toBe(20);
  });

  it("продажа в почти полный чужой склад держит корабль", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    const ship = state.ships.find((item) => item.houseId === player.id && item.classId === "freighter")!;
    const market = state.worlds.find((world) => world.id === "w-vega")!;
    ship.worldId = "w-vega";
    ship.fromId = "w-vega";
    ship.tollWorldId = "w-vega";
    ship.cargo.ore = 10;
    state.accounts.goodsCreated.ore += 10;
    market.population = 0;
    for (const building of market.buildings) building.enabled = false;
    const added = market.capacity - sumGoods(market.stock) - 2;
    market.stock.grain += added;
    state.accounts.goodsCreated.grain += added;
    dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "Сбыт",
      shipId: ship.id,
      stops: [
        { worldId: "w-vega", actions: [{ good: "ore", mode: "sell", amount: 10, price: 1, keep: 0 }] },
        { worldId: "w-bread", actions: [{ good: "ore", mode: "unload", amount: 10, price: 0, keep: 0 }] },
      ],
    });
    runTicks(state, 2);
    expect(ship.cargo.ore).toBe(8);
    expect(ship.status).toBe("docked");
    expect(ship.worldId).toBe("w-vega");
    expect(audit(state).ok).toBe(true);
  });

  it("один простой корабль не закрывает сразу два завода", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const orion = state.houses.find((house) => house.profile === "industrial")!;
    for (const world of state.worlds) {
      if (world.ownerId === orion.id) world.stock.food = 400;
    }
    const home = state.worlds.find((world) => world.id === "w-orion")!;
    const field = state.worlds.find((world) => world.id === "w-orion-field")!;
    home.buildings[0].stopReason = "не хватает: сплавы";
    placeBuilding(state, field, orion.id, "smelter");
    field.buildings.at(-1)!.stopReason = "не хватает: руда";
    planAi(state);
    const routes = state.routes.filter((route) => route.houseId === orion.id);
    const staffed = routes.filter((route) => state.ships.some((ship) => ship.routeId === route.id));
    expect(routes.length).toBe(staffed.length);
    expect(staffed.length).toBe(1);
  });

  it("основанная колония не отправляет корабль обратно в тот же день", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    const ship = state.ships.find((item) => item.houseId === player.id && item.worldId === "w-bread" && item.classId === "freighter")!;
    dispatch(state, { type: "colonize", houseId: player.id, shipId: ship.id, worldId: "w-bay" });
    for (let day = 0; day < 40 && state.worlds.find((world) => world.id === "w-bay")?.ownerId !== player.id; day += 1) runTicks(state, 1);
    expect(state.worlds.find((world) => world.id === "w-bay")?.ownerId).toBe(player.id);
    expect(ship.worldId).toBe("w-bay");
    expect(ship.status).toBe("docked");
    expect(ship.routeId).toBeNull();
    expect(audit(state).ok).toBe(true);
  });

  it("закрытый порт всё равно берёт содержание корабля", () => {
    const state = createLogisticsScenario();
    const house = state.houses[0];
    const rival = endowHouse(state, { name: "Дом Вега", color: "#d4533c", crest: "ВГ", profile: "merchant", player: false, credits: 5000 });
    const port = endowWorld(state, {
      id: "l-vega",
      name: "Чужой порт",
      specialty: "порт",
      x: 400,
      y: 0,
      ownerId: rival.id,
      population: 10,
      popMoneyPerCapita: 1,
      stock: { ore: 1 },
    });
    const ship = state.ships[0];
    ship.worldId = port.id;
    ship.fromId = port.id;
    ship.tollWorldId = port.id;
    dispatch(state, { type: "setEmbargo", houseId: rival.id, otherId: house.id, embargo: true });
    dispatch(state, {
      type: "createRoute",
      houseId: house.id,
      name: "Домой",
      shipId: ship.id,
      stops: [
        { worldId: port.id, actions: [] },
        { worldId: "l-ore", actions: [] },
      ],
    });
    runTicks(state, 3);
    expect(house.flow.upkeep).toBe(15);
    expect(ship.status).not.toBe("transit");
    expect(audit(state).ok).toBe(true);
  });

  it("неизвестное предприятие не подменяет партию", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const broken = JSON.parse(serialize(state)) as { state: { worlds: Array<{ buildings: Array<{ kind?: string }> }> } };
    broken.state.worlds[0].buildings[0].kind = "palace";
    expect(() => deserialize(JSON.stringify(broken))).toThrow(SaveError);
  });

  it("выгрузка остатка сверх резерва не держит корабль на полном складе", () => {
    const state = createLogisticsScenario();
    const house = state.houses[0];
    const ship = state.ships[0];
    const dock = state.worlds.find((world) => world.id === "l-dock")!;
    ship.worldId = dock.id;
    ship.fromId = dock.id;
    ship.tollWorldId = dock.id;
    ship.cargo.ore = 20;
    state.accounts.goodsCreated.ore += 20;
    dispatch(state, {
      type: "createRoute",
      houseId: house.id,
      name: "Резерв",
      shipId: ship.id,
      stops: [
        { worldId: "l-dock", actions: [{ good: "ore", mode: "unload", amount: 20, price: 0, keep: 12 }] },
        { worldId: "l-ore", actions: [] },
      ],
    });
    runTicks(state, 2);
    expect(ship.cargo.ore).toBe(12);
    expect(ship.status).toBe("transit");
    expect(ship.toId).toBe("l-ore");
    expect(audit(state).ok).toBe(true);
  });

  it("переназначение в пути начинает новый маршрут с первой остановки", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    const ship = state.ships.find((item) => item.houseId === player.id && item.worldId === "w-bread" && item.classId === "freighter")!;
    dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "В гавань",
      shipId: ship.id,
      stops: [
        { worldId: "w-bread", actions: [] },
        { worldId: "w-harbor", actions: [] },
      ],
    });
    for (let day = 0; day < 6 && ship.status !== "transit"; day += 1) runTicks(state, 1);
    expect(ship.toId).toBe("w-harbor");
    expect(ship.stopIndex).toBe(1);
    const created = dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "Топливо и руда",
      stops: [
        { worldId: "w-fuel", actions: [] },
        { worldId: "w-ore", actions: [] },
      ],
    });
    expect(created.ok).toBe(true);
    const routeId = state.routes.find((route) => route.name === "Топливо и руда")!.id;
    dispatch(state, { type: "assignShip", shipId: ship.id, routeId });
    expect(ship.toId).toBe("w-harbor");
    expect(ship.stopIndex).toBe(0);
    ship.distanceLeft = 1;
    runTicks(state, 1);
    expect(ship.status).toBe("transit");
    expect(ship.toId).toBe("w-fuel");
    expect(audit(state).ok).toBe(true);
  });

  it("колония берёт выбранный корабль, а чужая партия сбрасывает выбор", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const player = state.houses.find((house) => house.player)!;
    const ships = state.ships.filter((ship) => ship.houseId === player.id && ship.status !== "building");
    expect(colonyShip(ships, player.id, ships[1].id)?.id).toBe(ships[1].id);
    expect(colonyShip(ships, player.id, "")?.id).toBe(ships[0].id);
    const other = createLogisticsScenario();
    expect(keptShipId(other.ships, other.houses[0].id, ships[0].id)).toBe("");
    expect(keptOtherHouseId(other.houses, other.houses[0].id, "h-4")).toBe("");
  });

  it("дом без отношений не подменяет партию", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const broken = JSON.parse(serialize(state)) as { state: { houses: Array<{ embargo?: unknown }> } };
    delete broken.state.houses[0].embargo;
    expect(() => deserialize(JSON.stringify(broken))).toThrow(SaveError);
  });

  it("замена маршрута в пути не пропускает первую новую остановку", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    const ship = state.ships.find((item) => item.houseId === player.id && item.worldId === "w-bread" && item.classId === "freighter")!;
    dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "К Веге",
      shipId: ship.id,
      stops: [
        { worldId: "w-bread", actions: [] },
        { worldId: "w-vega", actions: [] },
      ],
    });
    for (let day = 0; day < 8 && ship.status !== "transit"; day += 1) runTicks(state, 1);
    expect(ship.toId).toBe("w-vega");
    dispatch(state, {
      type: "updateRoute",
      routeId: ship.routeId!,
      name: "За топливом",
      stops: [
        { worldId: "w-fuel", actions: [] },
        { worldId: "w-harbor", actions: [] },
      ],
    });
    expect(ship.toId).toBe("w-vega");
    expect(ship.stopIndex).toBe(0);
    ship.distanceLeft = 1;
    runTicks(state, 1);
    expect(ship.toId).toBe("w-fuel");
  });

  it("смешанный груз выгружается по домам-источникам", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    const vega = state.houses.find((house) => house.name === "Дом Вега")!;
    const ship = state.ships.find((item) => item.houseId === player.id && item.worldId === "w-bread" && item.classId === "freighter")!;
    const bread = state.worlds.find((world) => world.id === "w-bread")!;
    for (const building of bread.buildings) building.enabled = false;
    state.accounts.goodsDestroyed.fuel += ship.cargo.fuel - 45;
    ship.cargo.fuel = 45;
    dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "Чужая еда",
      shipId: ship.id,
      stops: [
        { worldId: "w-bread", actions: [{ good: "food", mode: "load", amount: 20, price: 0, keep: 0 }] },
        { worldId: "w-vega", actions: [{ good: "food", mode: "buy", amount: 1, price: 400, keep: 0 }] },
        { worldId: "w-harbor", actions: [{ good: "food", mode: "unload", amount: 21, price: 0, keep: 0 }] },
      ],
    });
    for (let day = 0; day < 40 && (state.worlds.find((world) => world.id === "w-harbor")?.imported[player.id]?.food ?? 0) < 20; day += 1) {
      if (ship.status === "transit") ship.distanceLeft = 1;
      runTicks(state, 1);
    }
    const harbor = state.worlds.find((world) => world.id === "w-harbor")!;
    expect(harbor.imported[player.id]?.food).toBe(20);
    expect(harbor.imported[vega.id]?.food).toBe(1);
    expect(audit(state).ok).toBe(true);
  });

  it("недостроенная мельница не заказывается второй раз", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const field = state.worlds.find((world) => world.id === "w-orion-field")!;
    field.stock.food = 0;
    field.stock.grain = 40;
    const mill = field.buildings.find((building) => building.kind === "mill")!;
    mill.remainingDays = 4;
    planAi(state);
    expect(field.buildings.filter((building) => building.kind === "mill")).toHaveLength(1);
  });

  it("колония не переписывает общий торговый маршрут", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    const first = state.ships.find((item) => item.houseId === player.id && item.worldId === "w-bread")!;
    const second = state.ships.find((item) => item.houseId === player.id && item.worldId === "w-harbor")!;
    second.worldId = "w-bread";
    second.fromId = "w-bread";
    second.tollWorldId = "w-bread";
    dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "Торговля",
      shipId: first.id,
      stops: [
        { worldId: "w-bread", actions: [{ good: "grain", mode: "load", amount: 8, price: 0, keep: 0 }] },
        { worldId: "w-bay", actions: [] },
      ],
    });
    dispatch(state, { type: "assignShip", shipId: second.id, routeId: first.routeId });
    const tradeId = first.routeId;
    dispatch(state, { type: "colonize", houseId: player.id, shipId: first.id, worldId: "w-bay" });
    expect(second.routeId).toBe(tradeId);
    expect(first.routeId).not.toBe(tradeId);
    const trade = state.routes.find((route) => route.id === tradeId)!;
    expect(trade.stops[0].actions.some((action) => action.good === "food" && action.amount >= 30)).toBe(false);
  });

  it("баржа оставляет топливо на дальний колониальный перегон", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    const bread = state.worlds.find((world) => world.id === "w-bread")!;
    const barge = placeShip(state, player.id, bread, "barge", 60);
    const result = dispatch(state, { type: "colonize", houseId: player.id, shipId: barge.id, worldId: "w-pier" });
    expect(result.ok).toBe(true);
    runTicks(state, 1);
    expect(barge.status).toBe("transit");
    expect(barge.toId).toBe("w-pier");
  });

  it("шканечный бот не получает колониальный приказ", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const player = state.houses.find((house) => house.player)!;
    const skiff = state.ships.find((ship) => ship.houseId === player.id && ship.classId === "skiff")!;
    const result = dispatch(state, { type: "colonize", houseId: player.id, shipId: skiff.id, worldId: "w-bay" });
    expect(result.ok).toBe(false);
    expect(skiff.mission).toBeNull();
  });

  it("колония из 70 человек видна в узких местах без еды", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const player = state.houses.find((house) => house.player)!;
    const bay = state.worlds.find((world) => world.id === "w-bay")!;
    bay.ownerId = player.id;
    bay.population = 70;
    bay.stock.food = 0;
    expect(bottlenecks(state, player.id).some((item) => item.title.startsWith(bay.name))).toBe(true);
  });

  it("сохранение без ставки зарплаты или с пустым договором не подменяет партию", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const noWage = JSON.parse(serialize(state)) as { state: { rules: { wage?: number } } };
    delete noWage.state.rules.wage;
    expect(() => deserialize(JSON.stringify(noWage))).toThrow(SaveError);
    const nullTreaty = JSON.parse(serialize(state)) as { state: { treaties: unknown[] } };
    nullTreaty.state.treaties.push(null);
    expect(() => deserialize(JSON.stringify(nullTreaty))).toThrow(SaveError);
  });

  it("пустая продажа не держит корабль из-за цены", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    const ship = state.ships.find((item) => item.houseId === player.id && item.classId === "freighter")!;
    ship.worldId = "w-vega";
    ship.fromId = "w-vega";
    ship.tollWorldId = "w-vega";
    dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "Сначала купить",
      shipId: ship.id,
      stops: [
        { worldId: "w-vega", actions: [{ good: "ore", mode: "sell", amount: 10, price: 100, keep: 0 }] },
        { worldId: "w-harbor", actions: [{ good: "ore", mode: "load", amount: 10, price: 0, keep: 0 }] },
      ],
    });
    runTicks(state, 1);
    expect(ship.status).toBe("transit");
    expect(ship.toId).toBe("w-harbor");
  });

  it("второй корабль снимает колониальный приказ, если бухта уже занята", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    const first = state.ships.find((item) => item.houseId === player.id && item.worldId === "w-bread")!;
    const second = state.ships.find((item) => item.houseId === player.id && item.worldId === "w-harbor")!;
    second.worldId = "w-bread";
    second.fromId = "w-bread";
    second.tollWorldId = "w-bread";
    dispatch(state, { type: "colonize", houseId: player.id, shipId: first.id, worldId: "w-bay" });
    dispatch(state, { type: "colonize", houseId: player.id, shipId: second.id, worldId: "w-bay" });
    const bay = state.worlds.find((world) => world.id === "w-bay")!;
    for (let day = 0; day < 30 && (first.worldId !== "w-bay" || second.worldId !== "w-bay"); day += 1) {
      if (first.status === "transit") first.distanceLeft = 1;
      if (second.status === "transit") second.distanceLeft = 1;
      runTicks(state, 1);
    }
    expect(bay.ownerId).toBe(player.id);
    expect(second.mission).toBeNull();
    expect(second.routeId).toBeNull();
    expect(second.stopReason ?? "").not.toContain("топлив");
    expect(audit(state).ok).toBe(true);
  });

  it("клик по своему кораблю запоминает его для колонии", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const player = state.houses.find((house) => house.player)!;
    const ships = state.ships.filter((ship) => ship.houseId === player.id);
    expect(fleetPickId(ships[1], player.id)).toBe(ships[1].id);
    const rival = state.ships.find((ship) => ship.houseId !== player.id)!;
    expect(fleetPickId(rival, player.id)).toBeNull();
  });

  it("пустая строка действия или пропавший импорт не подменяют партию", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const player = state.houses.find((house) => house.player)!;
    dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "Пустой",
      stops: [
        { worldId: "w-bread", actions: [] },
        { worldId: "w-harbor", actions: [] },
      ],
    });
    const broken = JSON.parse(serialize(state)) as { state: { routes: Array<{ stops: Array<{ actions: unknown[] }> }> } };
    broken.state.routes[0].stops[0].actions = [null];
    expect(() => deserialize(JSON.stringify(broken))).toThrow(SaveError);
    const noImport = JSON.parse(serialize(state)) as { state: { worlds: Array<{ lastImported?: unknown }> } };
    noImport.state.worlds[0].lastImported = null;
    expect(() => deserialize(JSON.stringify(noImport))).toThrow(SaveError);
  });

  it("правка маршрута в пути сбрасывает уже учтённую стоянку", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    const ship = state.ships.find((item) => item.houseId === player.id && item.worldId === "w-bread")!;
    dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "К Веге",
      shipId: ship.id,
      stops: [
        { worldId: "w-bread", actions: [{ good: "fuel", mode: "load", amount: 4, price: 0, keep: 0 }] },
        { worldId: "w-vega", actions: [] },
      ],
    });
    for (let day = 0; day < 6 && ship.status !== "transit"; day += 1) runTicks(state, 1);
    ship.visitKey = "w-bread:0:" + ship.routeId;
    ship.visitMoved = [4];
    dispatch(state, {
      type: "updateRoute",
      routeId: ship.routeId!,
      name: "Обратно за топливом",
      stops: [
        { worldId: "w-bread", actions: [{ good: "fuel", mode: "load", amount: 10, price: 0, keep: 0 }] },
        { worldId: "w-harbor", actions: [] },
      ],
    });
    expect(ship.visitKey).toBe("");
    expect(ship.visitMoved).toEqual([]);
    expect(ship.toId).toBe("w-vega");
  });

  it("маршрут на строящийся корабль не остаётся в списке", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const player = state.houses.find((house) => house.player)!;
    const ship = state.ships.find((item) => item.houseId === player.id)!;
    ship.status = "building";
    const routes = state.routes.length;
    const notes = state.journal.length;
    const result = dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "Рано",
      shipId: ship.id,
      stops: [
        { worldId: "w-bread", actions: [] },
        { worldId: "w-harbor", actions: [] },
      ],
    });
    expect(result.ok).toBe(false);
    expect(state.routes).toHaveLength(routes);
    expect(state.journal).toHaveLength(notes);
  });

  it("казна без числа не подменяет партию", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const broken = JSON.parse(serialize(state)) as { state: { houses: Array<{ credits?: number }> } };
    delete broken.state.houses[0].credits;
    expect(() => deserialize(JSON.stringify(broken))).toThrow(SaveError);
  });

  it("внутренний подвоз не ставится на паузу из-за отсутствия выручки", () => {
    const state = createGame({ seed: 21, scenario: "base" });
    const lyra = state.houses.find((house) => house.profile === "expansionist")!;
    const ship = state.ships.find((item) => item.houseId === lyra.id)!;
    dispatch(state, {
      type: "createRoute",
      houseId: lyra.id,
      name: "Еда домой",
      shipId: ship.id,
      stops: [
        { worldId: "w-vega", actions: [{ good: "food", mode: "buy", amount: 20, price: 40, keep: 0 }] },
        { worldId: "w-lyra", actions: [{ good: "food", mode: "unload", amount: 20, price: 0, keep: 0 }] },
      ],
    });
    const route = state.routes.find((item) => item.id === ship.routeId)!;
    route.lastCost = 288;
    route.lastRevenue = 0;
    planAi(state);
    expect(route.paused).toBe(false);
  });

  it("подсказка корабля называет фактический следующий перегон", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const player = state.houses.find((house) => house.player)!;
    const ship = state.ships.find((item) => item.houseId === player.id && item.worldId === "w-bread")!;
    dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "Мимо",
      shipId: ship.id,
      stops: [
        { worldId: "w-harbor", actions: [] },
        { worldId: "w-lyra", actions: [] },
      ],
    });
    const text = explainShip(state, ship.id);
    expect(text).toContain("не входит в чужие пределы");
    expect(text).not.toContain("Застава");
    dispatch(state, {
      type: "updateRoute",
      routeId: ship.routeId!,
      name: "Повтор",
      stops: [
        { worldId: "w-bread", actions: [] },
        { worldId: "w-harbor", actions: [] },
        { worldId: "w-bread", actions: [] },
        { worldId: "w-vega", actions: [] },
      ],
    });
    ship.stopIndex = 2;
    expect(explainShip(state, ship.id)).toContain("Застава");
  });

  it("сохранение без миров не подменяет партию", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const broken = JSON.parse(serialize(state)) as { state: { worlds: unknown[] } };
    broken.state.worlds = [];
    expect(() => deserialize(JSON.stringify(broken))).toThrow(SaveError);
  });

  it("неудачное основание на месте не оставляет колониальный приказ", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const player = state.houses.find((house) => house.player)!;
    const ship = state.ships.find((item) => item.houseId === player.id && item.worldId === "w-bread")!;
    dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "Торговля",
      shipId: ship.id,
      stops: [
        { worldId: "w-bread", actions: [] },
        { worldId: "w-harbor", actions: [] },
      ],
    });
    const routeId = ship.routeId;
    ship.worldId = "w-beacon";
    ship.fromId = "w-beacon";
    ship.tollWorldId = "w-beacon";
    ship.cargo.food = 0;
    ship.cargo.parts = 0;
    const result = dispatch(state, { type: "colonize", houseId: player.id, shipId: ship.id, worldId: "w-beacon" });
    expect(result.ok).toBe(false);
    expect(ship.mission).toBeNull();
    expect(ship.routeId).toBe(routeId);
  });

  it("ИИ не берёт сырьё из мира под эмбарго", () => {
    const state = createGame({ seed: 21, scenario: "base" });
    const player = state.houses.find((house) => house.player)!;
    const vega = state.houses.find((house) => house.name === "Дом Вега")!;
    const mill = state.worlds.find((world) => world.id === "w-vega")!.buildings.find((building) => building.kind === "mill")!;
    mill.stopReason = "не хватает: зерно";
    dispatch(state, { type: "setEmbargo", houseId: player.id, otherId: vega.id, embargo: true });
    planAi(state);
    const routes = state.routes.filter((route) => route.houseId === vega.id);
    expect(routes.some((route) => route.stops.some((stop) => stop.worldId === "w-bread"))).toBe(false);
  });

  it("мир без координаты или партия без игрока не подменяют игру", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const noX = JSON.parse(serialize(state)) as { state: { worlds: Array<{ x?: number }> } };
    delete noX.state.worlds[0].x;
    expect(() => deserialize(JSON.stringify(noX))).toThrow(SaveError);
    const noPlayer = JSON.parse(serialize(state)) as { state: { houses: Array<{ player: boolean }> } };
    for (const house of noPlayer.state.houses) house.player = false;
    expect(() => deserialize(JSON.stringify(noPlayer))).toThrow(SaveError);
  });

  it("стоящий корабль после замены маршрута не пропускает первую остановку", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    const ship = state.ships.find((item) => item.houseId === player.id && item.worldId === "w-bread")!;
    dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "Длинный",
      shipId: ship.id,
      stops: [
        { worldId: "w-bread", actions: [] },
        { worldId: "w-harbor", actions: [] },
        { worldId: "w-ore", actions: [] },
      ],
    });
    ship.stopIndex = 2;
    dispatch(state, {
      type: "updateRoute",
      routeId: ship.routeId!,
      name: "Новый",
      stops: [
        { worldId: "w-fuel", actions: [] },
        { worldId: "w-harbor", actions: [] },
        { worldId: "w-ore", actions: [] },
      ],
    });
    runTicks(state, 1);
    expect(ship.toId).toBe("w-fuel");
  });

  it("колония в чужом порту покупает набор, а не грузит со склада", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    const ship = state.ships.find((item) => item.houseId === player.id && item.worldId === "w-bread")!;
    dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "К Веге",
      shipId: ship.id,
      stops: [
        { worldId: "w-bread", actions: [] },
        { worldId: "w-vega", actions: [] },
      ],
    });
    for (let day = 0; day < 6 && ship.status !== "transit"; day += 1) runTicks(state, 1);
    dispatch(state, { type: "colonize", houseId: player.id, shipId: ship.id, worldId: "w-bay" });
    ship.distanceLeft = 1;
    runTicks(state, 1);
    const colony = state.routes.find((route) => route.id === ship.routeId)!;
    expect(colony.stops[0].worldId).toBe("w-vega");
    expect(colony.stops[0].actions.some((action) => action.mode === "load" || action.mode === "unload")).toBe(false);
    expect(colony.stops[0].actions.some((action) => action.mode === "buy")).toBe(true);
  });

  it("кольцо из одного и того же мира не запирает корабль", () => {
    const state = createLogisticsScenario();
    const house = state.houses[0];
    const ship = state.ships[0];
    dispatch(state, {
      type: "createRoute",
      houseId: house.id,
      name: "Кольцо",
      shipId: ship.id,
      stops: [
        { worldId: "l-ore", actions: [] },
        { worldId: "l-dock", actions: [] },
        { worldId: "l-ore", actions: [] },
      ],
    });
    ship.stopIndex = 2;
    runTicks(state, 2);
    expect(ship.status).toBe("transit");
    expect(ship.toId).toBe("l-dock");
  });

  it("корабль в пути не плывёт без оплаты содержания", () => {
    const state = createLogisticsScenario();
    const house = state.houses[0];
    const ship = state.ships[0];
    const removed = house.credits - 5;
    house.credits = 5;
    state.accounts.creditsDestroyed += removed;
    for (const world of state.worlds) world.population = 0;
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
    runTicks(state, 1);
    expect(ship.status).toBe("transit");
    const left = ship.distanceLeft;
    runTicks(state, 3);
    expect(ship.distanceLeft).toBe(left);
    expect(ship.stopReason).toContain("содержание");
    expect(audit(state).ok).toBe(true);
  });

  it("клик по краю занятого мира выбирает мир, а не корабль", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const bread = state.worlds.find((world) => world.id === "w-bread")!;
    const edge = pickMapTarget(state, { x: bread.x + 10, y: bread.y }, 1);
    const core = pickMapTarget(state, { x: bread.x + 4, y: bread.y }, 1);
    expect(edge).toEqual({ kind: "world", id: "w-bread" });
    expect(core?.kind).toBe("ship");
  });

  it("отрицательный радиус или пустая запись журнала не подменяют партию", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const radius = JSON.parse(serialize(state)) as { state: { rules: { territoryRadius: number } } };
    radius.state.rules.territoryRadius = -1;
    expect(() => deserialize(JSON.stringify(radius))).toThrow(SaveError);
    const journal = JSON.parse(serialize(state)) as { state: { journal: unknown[] } };
    journal.state.journal = [null];
    expect(() => deserialize(JSON.stringify(journal))).toThrow(SaveError);
  });

  it("дробный размер сектора не создаёт миры", () => {
    expect(() => createGame({ seed: 3, scenario: "generated", worlds: 12.5, houses: 3 })).toThrow(/целым/);
    expect(() => createGame({ seed: 3, scenario: "generated", worlds: 12, houses: 3.5 })).toThrow(/целым/);
    expect(createGame({ seed: 3, scenario: "generated", worlds: 12, houses: 3 }).worlds).toHaveLength(12);
  });

  it("маршрут без имени не подменяет партию", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const player = state.houses.find((house) => house.player)!;
    dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "Имя",
      stops: [
        { worldId: "w-bread", actions: [] },
        { worldId: "w-harbor", actions: [] },
      ],
    });
    const broken = JSON.parse(serialize(state)) as { state: { routes: Array<{ name?: string }> } };
    delete broken.state.routes[0].name;
    expect(() => deserialize(JSON.stringify(broken))).toThrow(SaveError);
  });

  it("ИИ заправляется на месте, если дальняя колонка бедна", () => {
    const state = createIndustryScenario();
    const ai = state.houses.find((house) => house.profile === "industrial")!;
    const ship = state.ships.find((item) => item.houseId === ai.id)!;
    const removed = ship.cargo.fuel - 1;
    ship.cargo.fuel = 1;
    state.accounts.goodsDestroyed.fuel += removed;
    ship.stopReason = "нет топлива на следующий перегон";
    planAi(state);
    const route = state.routes.find((item) => item.name.startsWith("Заправка"));
    expect(route?.stops[0].worldId).toBe("i-mine");
    expect(route?.stops[0].actions.some((action) => action.good === "fuel" && action.mode === "load")).toBe(true);
  });

  it("заправка не выбирает порт под эмбарго", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const player = state.houses.find((house) => house.player)!;
    const vega = state.houses.find((house) => house.name === "Дом Вега")!;
    const skiff = state.ships.find((ship) => ship.houseId === vega.id && ship.classId === "skiff")!;
    skiff.worldId = "w-gate";
    skiff.fromId = "w-gate";
    skiff.status = "docked";
    skiff.stopReason = "нет топлива на следующий перегон";
    const harbor = state.worlds.find((world) => world.id === "w-harbor")!;
    const orion = state.worlds.find((world) => world.id === "w-orion")!;
    harbor.stock.fuel += 80;
    orion.stock.fuel += 80;
    state.accounts.goodsCreated.fuel += 160;
    dispatch(state, { type: "setEmbargo", houseId: player.id, otherId: vega.id, embargo: true });
    planAi(state);
    const route = state.routes.find((item) => item.houseId === vega.id && item.name.startsWith("Заправка"));
    expect(route?.stops.some((stop) => stop.worldId === "w-harbor")).toBe(false);
    expect(route?.stops.some((stop) => stop.worldId === "w-orion")).toBe(true);
  });

  it("панель мира показывает дробный расход еды колонии", () => {
    expect(foodPerDay(70, 1)).toBe(0.7);
    expect(foodPerDay(400, 1)).toBe(4);
  });

  it("неизвестный товар в маршруте не подменяет партию", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const player = state.houses.find((house) => house.player)!;
    dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "Товар",
      stops: [
        { worldId: "w-bread", actions: [{ good: "food", mode: "load", amount: 1, price: 0, keep: 0 }] },
        { worldId: "w-harbor", actions: [] },
      ],
    });
    const broken = JSON.parse(serialize(state)) as { state: { routes: Array<{ stops: Array<{ actions: Array<{ good: string }> }> }> } };
    broken.state.routes[0].stops[0].actions[0].good = "unknown";
    expect(() => deserialize(JSON.stringify(broken))).toThrow(SaveError);
  });

  it("продовольственный рейс не забивает трюм лишним топливом", () => {
    const state = createIndustryScenario();
    const forge = state.worlds.find((world) => world.id === "i-forge")!;
    const ship = state.ships.find((item) => item.classId === "freighter")!;
    state.accounts.goodsDestroyed.food += forge.stock.food;
    forge.stock.food = 0;
    state.accounts.goodsCreated.fuel += 10;
    ship.cargo.fuel = 50;
    planAi(state);
    const route = state.routes.find((item) => item.stops.some((stop) => stop.actions.some((action) => action.good === "food")));
    const fuel = route?.stops[0].actions.find((action) => action.good === "fuel");
    expect(fuel?.amount ?? 0).toBe(0);
    expect(route?.stops[0].actions.some((action) => action.good === "food")).toBe(true);
  });

  it("последний день перехода тоже требует содержание", () => {
    const state = createLogisticsScenario();
    const house = state.houses[0];
    const ship = state.ships[0];
    for (const world of state.worlds) world.population = 0;
    dispatch(state, {
      type: "createRoute",
      houseId: house.id,
      name: "Короткий",
      shipId: ship.id,
      stops: [
        { worldId: "l-ore", actions: [] },
        { worldId: "l-dock", actions: [] },
      ],
    });
    runTicks(state, 1);
    expect(ship.status).toBe("transit");
    const removed = house.credits;
    state.accounts.creditsDestroyed += removed;
    house.credits = 0;
    ship.distanceLeft = 6;
    runTicks(state, 1);
    expect(ship.status).toBe("transit");
    expect(ship.distanceLeft).toBe(6);
  });

  it("зависимость считается только по прошлому окну", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const player = state.houses.find((house) => house.player)!;
    const vega = state.houses.find((house) => house.name === "Дом Вега")!;
    for (const world of state.worlds) {
      if (world.ownerId !== player.id) continue;
      world.lastEaten = 0;
      world.eaten = 0;
      world.lastImported = {};
    }
    const harbor = state.worlds.find((world) => world.id === "w-harbor")!;
    harbor.lastEaten = 24;
    harbor.imported[vega.id] = { grain: 0, food: 10, ore: 0, alloys: 0, parts: 0, fuel: 0 };
    const line = dependencyRows(state, player).find((item) => item.startsWith("Дом Вега"));
    expect(line).toContain("0%");
    expect(line).toContain("0 ед. к 24");
  });

  it("перепродажа в той же столице не закрывает поставку", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    const vega = state.houses.find((house) => house.name === "Дом Вега")!;
    const ship = state.ships.find((item) => item.houseId === player.id && item.classId === "freighter")!;
    ship.worldId = "w-vega";
    ship.fromId = "w-vega";
    ship.tollWorldId = "w-vega";
    state.treaties.push({
      id: "t-food",
      kind: "supply",
      proposerId: player.id,
      targetId: vega.id,
      status: "active",
      startTick: 0,
      endTick: 100,
      duration: 100,
      tariffBps: 0,
      good: "food",
      qtyPerWindow: 12,
      delivered: 0,
      windowDays: 0,
      note: "еда",
    });
    dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "Туда-сюда",
      shipId: ship.id,
      stops: [
        {
          worldId: "w-vega",
          actions: [
            { good: "food", mode: "buy", amount: 12, price: 400, keep: 0 },
            { good: "food", mode: "sell", amount: 12, price: 1, keep: 0 },
          ],
        },
        { worldId: "w-bread", actions: [] },
      ],
    });
    runTicks(state, 1);
    expect(state.treaties[0].delivered).toBe(0);
    expect(audit(state).ok).toBe(true);
  });

  it("колония оставляет топливо на обратный путь", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    const ship = state.ships.find((item) => item.houseId === player.id && item.worldId === "w-bread")!;
    const bread = state.worlds.find((world) => world.id === "w-bread")!;
    for (const building of bread.buildings) building.enabled = false;
    dispatch(state, { type: "colonize", houseId: player.id, shipId: ship.id, worldId: "w-bay" });
    const colony = state.routes.find((route) => route.name.startsWith("Колония"))!;
    const fuel = colony.stops[0].actions.find((action) => action.good === "fuel");
    expect(fuel?.keep ?? ship.cargo.fuel).toBeGreaterThanOrEqual(24);
  });

  it("продажа топлива на полный чужой склад держит корабль", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    const ship = state.ships.find((item) => item.houseId === player.id && item.classId === "freighter")!;
    const market = state.worlds.find((world) => world.id === "w-vega")!;
    ship.worldId = "w-vega";
    ship.fromId = "w-vega";
    ship.tollWorldId = "w-vega";
    market.population = 0;
    for (const building of market.buildings) building.enabled = false;
    const added = market.capacity - sumGoods(market.stock);
    market.stock.grain += added;
    state.accounts.goodsCreated.grain += added;
    dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "Слить топливо",
      shipId: ship.id,
      stops: [
        { worldId: "w-vega", actions: [{ good: "fuel", mode: "sell", amount: 10, price: 1, keep: 0 }] },
        { worldId: "w-bread", actions: [] },
      ],
    });
    const fuel = ship.cargo.fuel;
    runTicks(state, 2);
    expect(ship.status).toBe("docked");
    expect(ship.cargo.fuel).toBe(fuel);
  });

  it("сохранение без счётчика или кассы не подменяет партию", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const noSerial = JSON.parse(serialize(state)) as { state: { nextSerial?: number } };
    delete noSerial.state.nextSerial;
    expect(() => deserialize(JSON.stringify(noSerial))).toThrow(SaveError);
    const noSales = JSON.parse(serialize(state)) as { state: { houses: Array<{ flow: { sales?: number } }> } };
    delete noSales.state.houses[0].flow.sales;
    expect(() => deserialize(JSON.stringify(noSales))).toThrow(SaveError);
  });

  it("унаследованные имена класса и предприятия не подменяют партию", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const kind = JSON.parse(serialize(state)) as { state: { worlds: Array<{ buildings: Array<{ kind: string }> }> } };
    kind.state.worlds[0].buildings[0].kind = "constructor";
    expect(() => deserialize(JSON.stringify(kind))).toThrow(SaveError);
    const ship = JSON.parse(serialize(state)) as { state: { ships: Array<{ classId: string }> } };
    ship.state.ships[0].classId = "constructor";
    expect(() => deserialize(JSON.stringify(ship))).toThrow(SaveError);
  });

  it("корабль вне своего маршрута без индекса стоянки не подменяет партию", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const raw = JSON.parse(serialize(state)) as {
      state: {
        ships: Array<Record<string, unknown>>;
        worlds: Array<{ id: string }>;
        routes: Array<Record<string, unknown>>;
      };
    };
    const [home, other, away] = raw.state.worlds;
    const ship = raw.state.ships[0];
    raw.state.routes.push({
      id: "r-nav",
      houseId: ship.houseId,
      name: "Проверка",
      stops: [
        { worldId: home.id, actions: [] },
        { worldId: other.id, actions: [] },
      ],
      paused: false,
      revenue: 0,
      cost: 0,
      fuelUsed: 0,
      lastRevenue: 0,
      lastCost: 0,
      lastFuelUsed: 0,
    });
    ship.routeId = "r-nav";
    ship.status = "docked";
    ship.worldId = away.id;
    ship.fromId = away.id;
    delete ship.stopIndex;
    expect(() => deserialize(JSON.stringify(raw))).toThrow(SaveError);
    ship.stopIndex = 0;
    const loaded = deserialize(JSON.stringify(raw));
    expect(() => runTicks(loaded, 1)).not.toThrow();
  });

  it("имя мира объектом не подменяет партию", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const world = JSON.parse(serialize(state)) as { state: { worlds: Array<{ name: unknown }> } };
    world.state.worlds[0].name = {};
    expect(() => deserialize(JSON.stringify(world))).toThrow(SaveError);
    const house = JSON.parse(serialize(state)) as { state: { houses: Array<{ name: unknown }> } };
    house.state.houses[0].name = {};
    expect(() => deserialize(JSON.stringify(house))).toThrow(SaveError);
    const person = JSON.parse(serialize(state)) as { state: { people: Array<{ name: unknown }> } };
    person.state.people[0].name = {};
    expect(() => deserialize(JSON.stringify(person))).toThrow(SaveError);
  });

  it("после основания колонии брошенный рейс не заменяет поставку еды", () => {
    const state = createExpansionScenario();
    const ai = state.houses.find((house) => house.profile === "expansionist")!;
    const colony = state.worlds.find((world) => world.id === "e-free")!;
    for (let day = 0; day < 12 && !colony.ownerId; day += 1) runTicks(state, 1);
    expect(colony.ownerId).toBe(ai.id);
    expect(state.routes.some((route) => route.name.startsWith("Колония ") && !state.ships.some((ship) => ship.routeId === route.id))).toBe(false);
    for (let day = 0; day < 24 && colony.stock.food === 0; day += 1) runTicks(state, 1);
    expect(colony.stock.food).toBeGreaterThan(0);
    expect(audit(state).ok).toBe(true);
  });

  it("промежуточная остановка колонии сохраняет дальнейший маршрут", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    const ship = state.ships.find((item) => item.houseId === player.id && item.worldId === "w-bread" && item.classId === "freighter")!;
    dispatch(state, { type: "colonize", houseId: player.id, shipId: ship.id, worldId: "w-pier" });
    const route = state.routes.find((item) => item.name.startsWith("Колония"))!;
    dispatch(state, {
      type: "updateRoute",
      routeId: route.id,
      name: route.name,
      stops: [
        { worldId: "w-bread", actions: route.stops[0].actions },
        { worldId: "w-beacon", actions: [] },
        { worldId: "w-north", actions: [] },
        { worldId: "w-pier", actions: [] },
      ],
    });
    ship.worldId = "w-beacon";
    ship.fromId = "w-beacon";
    ship.status = "docked";
    ship.stopIndex = 1;
    ship.tollWorldId = "w-beacon";
    runTicks(state, 1);
    const kept = state.routes.find((item) => item.id === route.id);
    expect(ship.routeId).toBe(route.id);
    expect(kept?.stops.map((stop) => stop.worldId)).toEqual(["w-bread", "w-beacon", "w-north", "w-pier"]);
    expect(kept?.stops[1].actions).toEqual([]);
  });

  it("удовлетворённость объектом не подменяет партию", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const raw = JSON.parse(serialize(state)) as { state: { worlds: Array<{ satisfaction: unknown }> } };
    raw.state.worlds[0].satisfaction = {};
    expect(() => deserialize(JSON.stringify(raw))).toThrow(SaveError);
  });

  it("чужой корабль на карте не становится целью команд флота", () => {
    const owned = { id: "s-own", houseId: "h-player", status: "docked" };
    const rival = { id: "s-rival", houseId: "h-other", status: "docked" };
    expect(fleetCommandShipId(rival, "h-player", owned.id)).toBe(owned.id);
    expect(fleetCommandShipId(owned, "h-player", "s-other-owned")).toBe(owned.id);
    expect(fleetCommandShipId(undefined, "h-player", owned.id)).toBe(owned.id);
  });

  it("оплата содержания снимает предупреждение в пути", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    for (const world of state.worlds) {
      if (world.ownerId === player.id) world.population = 0;
    }
    const ship = state.ships.find((item) => item.houseId === player.id && item.classId === "freighter")!;
    ship.status = "transit";
    ship.worldId = null;
    ship.fromId = "w-bread";
    ship.toId = "w-harbor";
    ship.legDistance = 200;
    ship.distanceLeft = 200;
    ship.stopReason = "нет денег на содержание корабля";
    player.credits = 0;
    runTicks(state, 1);
    expect(ship.distanceLeft).toBe(200);
    expect(ship.stopReason).toBe("нет денег на содержание корабля");
    player.credits = 100;
    runTicks(state, 1);
    expect(ship.distanceLeft).toBeLessThan(200);
    expect(ship.status).toBe("transit");
    expect(ship.stopReason).toBeNull();
  });

  it("сектор 21 не бросает грузовоз без топлива и не ставит рудник без руды", () => {
    const state = createGame({ seed: 21, scenario: "base" });
    runTicks(state, 42);
    const vega = state.houses.find((house) => house.name === "Дом Вега")!;
    const freighter = state.ships.find((ship) => ship.houseId === vega.id && ship.classId === "freighter")!;
    expect(freighter.cargo.fuel === 0 && freighter.stopReason?.includes("топлив")).toBe(false);
    for (const world of state.worlds) {
      if (world.deposits.ore <= 0) expect(world.buildings.some((building) => building.kind === "mine")).toBe(false);
    }
    expect(audit(state).ok).toBe(true);
  });

  it("роль и лояльность объектом не подменяют партию", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const role = JSON.parse(serialize(state)) as { state: { people: Array<{ role: unknown }> } };
    role.state.people[0].role = {};
    expect(() => deserialize(JSON.stringify(role))).toThrow(SaveError);
    const loyalty = JSON.parse(serialize(state)) as { state: { people: Array<{ loyalty: unknown }> } };
    loyalty.state.people[0].loyalty = {};
    expect(() => deserialize(JSON.stringify(loyalty))).toThrow(SaveError);
  });

  it("зерно генератора объектом не подменяет партию", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const raw = JSON.parse(serialize(state)) as { state: { seed: unknown } };
    raw.state.seed = {};
    expect(() => deserialize(JSON.stringify(raw))).toThrow(SaveError);
  });

  it("имя Еда не переписывает маршрут игрока", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    const ship = state.ships.find((item) => item.houseId === player.id && item.classId === "freighter")!;
    ship.worldId = "w-bread";
    ship.fromId = "w-bread";
    ship.status = "docked";
    ship.cargo.fuel = 50;
    dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "Еда: Хлебный Пояс",
      shipId: ship.id,
      stops: [
        {
          worldId: "w-bread",
          actions: [
            { good: "fuel", mode: "unload", amount: 50, price: 0, keep: 0 },
            { good: "food", mode: "load", amount: 40, price: 0, keep: 0 },
          ],
        },
        { worldId: "w-harbor", actions: [{ good: "food", mode: "unload", amount: 40, price: 0, keep: 0 }] },
      ],
    });
    runTicks(state, 1);
    const route = state.routes.find((item) => item.id === ship.routeId)!;
    const fuel = route.stops[0].actions.find((action) => action.good === "fuel");
    const food = route.stops[0].actions.find((action) => action.good === "food");
    expect(fuel).toMatchObject({ mode: "unload", amount: 50 });
    expect(food).toMatchObject({ mode: "load", amount: 40 });
  });

  it("еда не занимает место, пока кругу не хватает топлива", () => {
    const state = createGame({ seed: 21, scenario: "base" });
    runTicks(state, 30);
    for (const route of state.routes) {
      if (!route.autoFuel) continue;
      for (const ship of state.ships) {
        if (ship.routeId !== route.id || !ship.stopReason?.includes("топлив")) continue;
        expect(sumGoods(ship.cargo) - ship.cargo.fuel).toBe(0);
      }
    }
    expect(audit(state).ok).toBe(true);
  });

  it("отпечаток партии совпадает после записи маршрута", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    state.aiEnabled = false;
    const player = state.houses.find((house) => house.player)!;
    dispatch(state, {
      type: "createRoute",
      houseId: player.id,
      name: "Хлеб",
      stops: [
        { worldId: "w-bread", actions: [] },
        { worldId: "w-harbor", actions: [] },
      ],
    });
    expect(hashState(state)).toBe(hashState(deserialize(serialize(state))));
  });

  it("выручка маршрута объектом не подменяет партию", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    dispatch(state, {
      type: "createRoute",
      houseId: state.houses.find((house) => house.player)!.id,
      name: "Хлеб",
      stops: [
        { worldId: "w-bread", actions: [] },
        { worldId: "w-harbor", actions: [] },
      ],
    });
    const raw = JSON.parse(serialize(state)) as { state: { routes: Array<{ revenue: unknown }> } };
    raw.state.routes[0].revenue = {};
    expect(() => deserialize(JSON.stringify(raw))).toThrow(SaveError);
  });

  it("рейс за едой ищет другое топливо, если порт пуст", () => {
    const state = createGame({ seed: 21, scenario: "base" });
    runTicks(state, 45);
    const cliff = state.worlds.find((world) => world.id === "w-fuel")!;
    for (const name of ["Дом Вега", "Дом Орион"]) {
      const house = state.houses.find((item) => item.name === name)!;
      const ship = state.ships.find((item) => item.houseId === house.id && item.classId === "freighter")!;
      const stuck = ship.worldId === "w-bread" && ship.stopReason?.includes("топлив");
      expect(stuck && cliff.stock.fuel > 30).toBe(false);
    }
  });

  it("договор без пошлины не подменяет партию", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    const player = state.houses.find((house) => house.player)!;
    const other = state.houses.find((house) => !house.player)!;
    dispatch(state, {
      type: "proposeTreaty",
      houseId: player.id,
      otherId: other.id,
      kind: "transit",
      tariffBps: 300,
      good: "food",
      qtyPerWindow: 0,
      duration: 24,
    });
    const raw = JSON.parse(serialize(state)) as { state: { treaties: Array<{ tariffBps?: number }> } };
    delete raw.state.treaties[0].tariffBps;
    expect(() => deserialize(JSON.stringify(raw))).toThrow(SaveError);
  });
});
