import { describe, expect, it } from "vitest";
import { planAi } from "../src/sim/ai";
import { createClock, planFrame } from "../src/sim/clock";
import { dispatch } from "../src/sim/commands";
import { createGame, endowHouse, endowWorld, placeBuilding } from "../src/sim/create";
import { createExpansionScenario, createLogisticsScenario, createSuccessionScenario } from "../src/sim/diagnostics";
import { sumGoods } from "../src/sim/goods";
import { audit, foodCover } from "../src/sim/mutate";
import { deserialize, SaveError, serialize, storeSave } from "../src/sim/save";
import { runTicks } from "../src/sim/simulate";
import { colonyShip, keptOtherHouseId, keptShipId, keptWorldId } from "../src/sim/view";

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
});
