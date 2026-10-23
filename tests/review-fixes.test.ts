import { describe, expect, it } from "vitest";
import { createClock, planFrame } from "../src/sim/clock";
import { dispatch } from "../src/sim/commands";
import { createGame } from "../src/sim/create";
import { createExpansionScenario, createLogisticsScenario, createSuccessionScenario } from "../src/sim/diagnostics";
import { sumGoods } from "../src/sim/goods";
import { audit } from "../src/sim/mutate";
import { deserialize, SaveError, serialize } from "../src/sim/save";
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
});
