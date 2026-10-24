import { describe, expect, it } from "vitest";
import { campaignBrief, createBorderContractScenario, createCrowdedHarborScenario, createIndustryDependenceScenario } from "../src/sim/campaign";
import { dispatch } from "../src/sim/commands";
import { createGame } from "../src/sim/create";
import { audit, foodCover } from "../src/sim/mutate";
import { deserialize, serialize } from "../src/sim/save";
import { runTicks, territoriesOnRoute } from "../src/sim/simulate";
import { lessonViews, nextLesson } from "../src/sim/tutorial";
import type { SimState } from "../src/sim/types";

function mustAudit(state: SimState): void {
  const report = audit(state);
  expect(report.errors, report.errors.join("\n")).toEqual([]);
}

function stamp(state: SimState): string {
  const player = state.houses.find((house) => house.player)!;
  const goods = state.worlds.map((world) => `${world.id}:${world.stock.food},${world.stock.grain},${world.stock.parts}`).join("|");
  return `${player.credits}|${goods}|${state.accounts.goodsCreated.food}|${state.accounts.goodsDestroyed.parts}`;
}

describe("обучение", () => {
  it("цель закрывается состоянием, а пропуск не двигает казну и склады", () => {
    const state = createGame({ seed: 3, scenario: "base" });
    expect(nextLesson(state)?.id).toBe("supply");
    const before = stamp(state);
    expect(dispatch(state, { type: "skipTutorial" }).ok).toBe(true);
    expect(stamp(state)).toBe(before);
    expect(state.tutorial.skipped).toBe(true);
    expect(dispatch(state, { type: "resumeTutorial" }).reason).toMatch(/снова/);
    expect(stamp(state)).toBe(before);
    runTicks(state, 1);
    expect(lessonViews(state).find((lesson) => lesson.id === "supply")?.done).toBe(true);
    expect(lessonViews(state).find((lesson) => lesson.id === "contract")?.done).toBe(false);
    const saved = deserialize(serialize(state));
    expect(saved.tutorial.skipped).toBe(false);
    expect(lessonViews(saved).find((lesson) => lesson.id === "supply")?.done).toBe(true);
    mustAudit(state);
  });

  it("версия 5 поднимается с пустым обучением, версия 7 отвергается", () => {
    const state = createBorderContractScenario();
    const raw = JSON.parse(serialize(state)) as { version: number; state: Omit<SimState, "version"> & { version: number } };
    raw.version = 5;
    raw.state.version = 5;
    delete (raw.state as { tutorial?: unknown }).tutorial;
    const loaded = deserialize(JSON.stringify(raw));
    expect(loaded.version).toBe(6);
    expect(loaded.tutorial.skipped).toBe(false);
    expect(loaded.houses.find((house) => house.player)?.credits).toBe(state.houses.find((house) => house.player)?.credits);
    expect(() => deserialize(JSON.stringify({ version: 7, state }))).toThrow(/версия/);
  });
});

describe("сценарии кампании", () => {
  it("короткий путь платит заставе, обход тратит больше топлива", () => {
    const paid = scoreBorder(true);
    const around = scoreBorder(false);
    expect(paid.delivered).toBeGreaterThan(0);
    expect(around.delivered).toBeGreaterThan(0);
    const paidTollEach = paid.toll / paid.delivered;
    const aroundTollEach = around.toll / around.delivered;
    const paidFuelEach = paid.fuel / paid.delivered;
    const aroundFuelEach = around.fuel / around.delivered;
    expect(paidTollEach, `toll ${paid.toll}/${around.toll} fuel ${paid.fuel}/${around.fuel} delivered ${paid.delivered}/${around.delivered}`).toBeGreaterThan(aroundTollEach);
    expect(aroundFuelEach).toBeGreaterThan(paidFuelEach);
    expect(paid.delivered === around.delivered && paid.credits === around.credits).toBe(false);
    mustAudit(paid.state);
    mustAudit(around.state);
  });

  it("ускорение гавани и ожидание расходятся по очереди и казне", () => {
    const built = createCrowdedHarborScenario();
    const waited = createCrowdedHarborScenario();
    expect(built.contracts.some((contract) => contract.status === "active")).toBe(true);
    expect(built.situations.some((item) => item.status === "open")).toBe(true);
    expect(built.worlds.find((world) => world.id === "h-port")!.port.queue.length).toBeGreaterThan(0);
    const player = built.houses.find((house) => house.player)!;
    expect(dispatch(built, { type: "expandPort", houseId: player.id, worldId: "h-port", kind: "speed" }).ok).toBe(true);
    runTicks(built, 20);
    runTicks(waited, 20);
    const builtPort = built.worlds.find((world) => world.id === "h-port")!;
    const waitedPort = waited.worlds.find((world) => world.id === "h-port")!;
    expect(builtPort.port.project?.kind === "speed" || builtPort.port.speedLevel > 0).toBe(true);
    expect(waitedPort.port.speedLevel).toBe(0);
    expect(built.houses.find((house) => house.player)!.credits).toBeLessThan(waited.houses.find((house) => house.player)!.credits);
    expect(campaignBrief(built)?.measures.find((item) => item.id === "choice")?.done).toBe(true);
    expect(campaignBrief(waited)?.measures.find((item) => item.id === "choice")?.done).toBe(false);
    expect(campaignBrief(waited)?.measures.find((item) => item.id === "seen")?.done).toBe(true);
    mustAudit(built);
    mustAudit(waited);
  });

  it("промышленный путь и закупка еды выигрывают разные показатели", () => {
    const forged = createIndustryDependenceScenario();
    const fed = createIndustryDependenceScenario();
    const player = forged.houses.find((house) => house.player)!;
    const ship = forged.ships[0];
    expect(dispatch(forged, { type: "developWorld", houseId: player.id, worldId: "i-mine", path: "industrial" }).ok).toBe(true);
    expect(dispatch(fed, {
      type: "createRoute",
      houseId: player.id,
      name: "Еда с Нивы",
      shipId: fed.ships[0].id,
      autoFuel: true,
      stops: [
        { worldId: "i-mine", actions: [{ good: "food", mode: "unload", amount: 8, price: 0, keep: 0 }] },
        { worldId: "i-barn", actions: [{ good: "food", mode: "buy", amount: 8, price: 40, keep: 0 }] },
      ],
    }).ok).toBe(true);
    runTicks(forged, 30);
    runTicks(fed, 40);
    const forgeMine = forged.worlds.find((world) => world.id === "i-mine")!;
    const fedMine = fed.worlds.find((world) => world.id === "i-mine")!;
    expect(forgeMine.development.project?.path === "industrial" || forgeMine.development.level > 0).toBe(true);
    expect(fedMine.development.path).toBe(null);
    const forgeCover = foodCover(forgeMine.population, forgeMine.stock.food, forged.rules.foodPer100);
    const fedCover = foodCover(fedMine.population, fedMine.stock.food, fed.rules.foodPer100);
    expect(fedCover).toBeGreaterThan(forgeCover);
    expect(ship.traveled >= 0).toBe(true);
    mustAudit(forged);
    mustAudit(fed);
  });

  it("каждый новый сценарий держит инварианты 3600 дней", () => {
    for (const state of [createBorderContractScenario(), createCrowdedHarborScenario(), createIndustryDependenceScenario()]) {
      runTicks(state, 3600);
      mustAudit(state);
      expect(state.houses.every((house) => house.credits >= 0)).toBe(true);
      expect(state.worlds.every((world) => world.port.queue.length >= 0)).toBe(true);
      const again = deserialize(serialize(state));
      expect(again.tick).toBe(3600);
      expect(again.scenario).toBe(state.scenario);
    }
  });
});

function scoreBorder(throughGate: boolean): { state: SimState; delivered: number; toll: number; fuel: number; credits: number; cover: number } {
  const state = createBorderContractScenario();
  const player = state.houses.find((house) => house.player)!;
  const ship = state.ships.find((item) => item.houseId === player.id)!;
  const stops = throughGate
    ? [
        { worldId: "b-home", actions: [{ good: "food" as const, mode: "load" as const, amount: 6, price: 0, keep: 0 }] },
        { worldId: "b-market", actions: [{ good: "food" as const, mode: "sell" as const, amount: 6, price: 0, keep: 0 }] },
      ]
    : [
        { worldId: "b-home", actions: [{ good: "food" as const, mode: "load" as const, amount: 6, price: 0, keep: 0 }] },
        { worldId: "b-beacon", actions: [{ good: "fuel" as const, mode: "load" as const, amount: 1, price: 0, keep: 0 }] },
        { worldId: "b-market", actions: [{ good: "food" as const, mode: "sell" as const, amount: 6, price: 0, keep: 0 }] },
      ];
  const direct = territoriesOnRoute(state, "b-home", "b-market", player.id).map((world) => world.id);
  const bypass = [
    ...territoriesOnRoute(state, "b-home", "b-beacon", player.id),
    ...territoriesOnRoute(state, "b-beacon", "b-market", player.id),
  ].map((world) => world.id);
  expect(state.contracts[0]?.status).toBe("active");
  expect(direct).toContain("b-gate");
  expect(bypass).not.toContain("b-gate");
  expect(dispatch(state, { type: "createRoute", houseId: player.id, name: throughGate ? "Через заставу" : "Обход", shipId: ship.id, autoFuel: true, stops }).ok).toBe(true);
  let toll = 0;
  let fuel = 0;
  let seenCost = 0;
  let seenFuel = 0;
  for (let day = 0; day < 100; day += 1) {
    runTicks(state, 1);
    const route = state.routes[0];
    if (route.cost < seenCost) toll += seenCost;
    if (route.fuelUsed < seenFuel) fuel += seenFuel;
    seenCost = route.cost;
    seenFuel = route.fuelUsed;
  }
  toll += seenCost;
  fuel += seenFuel;
  const contract = state.contracts[0];
  const capital = state.worlds.find((world) => world.id === player.capitalId)!;
  return {
    state,
    delivered: contract.delivered + contract.history.reduce((sum, item) => sum + item.delivered, 0),
    toll,
    fuel,
    credits: player.credits,
    cover: foodCover(capital.population, capital.stock.food, state.rules.foodPer100),
  };
}
