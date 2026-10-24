import { describe, expect, it } from "vitest";
import { campaignBrief, createBorderContractScenario, createCrowdedHarborScenario, createIndustryDependenceScenario } from "../src/sim/campaign";
import { emptyGoods } from "../src/sim/goods";
import { dispatch } from "../src/sim/commands";
import { createGame } from "../src/sim/create";
import { audit, foodCover } from "../src/sim/mutate";
import { deserialize, serialize } from "../src/sim/save";
import { runTicks, territoriesOnRoute } from "../src/sim/simulate";
import { lessonViews, nextLesson } from "../src/sim/tutorial";
import { hintLines } from "../src/sim/view";
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
    const closed = createGame({ seed: 4, scenario: "base" });
    const buyer = closed.houses.find((house) => !house.player)!;
    const seller = closed.houses.find((house) => house.player)!;
    closed.contracts.push({
      id: "k-empty",
      sellerId: seller.id,
      buyerId: buyer.id,
      good: "food",
      worldId: seller.capitalId ?? closed.worlds[0].id,
      qtyPerWindow: 4,
      windows: 2,
      price: 8,
      shortfall: 4,
      deposit: 0,
      status: "completed",
      windowIndex: 1,
      windowDays: 0,
      delivered: 0,
      paidWindow: 0,
      buyerReserve: 0,
      history: [{ window: 0, delivered: 0, paid: 0, penalty: 0 }, { window: 1, delivered: 0, paid: 0, penalty: 0 }],
      trades: [],
      note: "закрыт без поставки",
    });
    expect(lessonViews(closed).find((lesson) => lesson.id === "contract")?.done).toBe(false);
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
    expect(campaignBrief(forged)?.measures.find((item) => item.id === "path")?.done).toBe(true);
  });

  it("сосед отвечает на предложение, когда хозяйственный ИИ выключен", () => {
    const state = createIndustryDependenceScenario();
    const player = state.houses.find((house) => house.player)!;
    const buyer = state.houses.find((house) => !house.player)!;
    expect(state.aiEnabled).toBe(false);
    expect(dispatch(state, {
      type: "proposeContract",
      sellerId: player.id,
      buyerId: buyer.id,
      good: "ore",
      worldId: buyer.capitalId ?? "i-barn",
      qtyPerWindow: 4,
      windows: 2,
      price: 8,
      shortfall: 1,
      deposit: 16,
    }).ok).toBe(true);
    expect(state.contracts.at(-1)?.status).toBe("proposed");
    runTicks(state, 1);
    expect(state.contracts.at(-1)?.status).not.toBe("proposed");
  });

  it("отмена контракта не стирает уже принятое, а своя руда не считается чужой едой", () => {
    const border = createBorderContractScenario();
    const contract = border.contracts[0];
    contract.delivered = 6;
    expect(campaignBrief(border)?.measures.find((item) => item.id === "delivery")?.value).toBe("6 ед.");
    expect(dispatch(border, { type: "cancelContract", houseId: border.houses.find((house) => house.player)!.id, contractId: contract.id }).ok).toBe(true);
    expect(campaignBrief(border)?.measures.find((item) => item.id === "delivery")?.value).toBe("6 ед.");
    border.contracts.push({ ...contract, id: "k-next", status: "active", delivered: 2, history: [], paidWindow: 0, buyerReserve: 0 });
    expect(campaignBrief(border)?.measures.find((item) => item.id === "delivery")?.value).toBe("8 ед.");

    const industry = createIndustryDependenceScenario();
    const player = industry.houses.find((house) => house.player)!;
    const mine = industry.worlds.find((world) => world.id === "i-mine")!;
    const own = emptyGoods();
    own.ore = 4;
    mine.lastImported[player.id] = own;
    expect(campaignBrief(industry)?.measures.find((item) => item.id === "partner")?.done).toBe(false);
    const foreign = emptyGoods();
    foreign.food = 3;
    mine.lastImported["other-house"] = foreign;
    expect(campaignBrief(industry)?.measures.find((item) => item.id === "partner")?.done).toBe(true);
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

describe("подсказка первого рейса", () => {
  it("в базовой партии называет хлеб, Лиру и заставу, в остальных — только живые миры", () => {
    const base = hintLines(createGame({ seed: 21, scenario: "base" })).join(" ");
    expect(base).toContain("«Хлебный Пояс» уже печёт продовольствие");
    expect(base).toContain("назначьте грузовоз");
    expect(base).toContain("«Порт Лиры»");
    expect(base).toContain("«Застава Корвус»");
    expect(quotedNames(base).every((name) => name === "Флот" || worldNames(createGame({ seed: 21, scenario: "base" })).has(name))).toBe(true);

    for (const state of [
      createBorderContractScenario(),
      createCrowdedHarborScenario(),
      createIndustryDependenceScenario(),
      createGame({ seed: 9, scenario: "generated", worlds: 12, houses: 3 }),
    ]) {
      const hint = hintLines(state).join(" ");
      const known = worldNames(state);
      expect(quotedNames(hint).every((name) => name === "Флот" || known.has(name))).toBe(true);
      expect(hint).not.toContain("Хлебный Пояс");
      expect(hint).not.toContain("Порт Лиры");
      expect(hint).not.toContain("Застава Корвус");
    }
  });

  it("не называет выпечкой ферму и коротким запас, которого хватает на сотни дней", () => {
    const generated = createGame({ seed: 9, scenario: "generated", worlds: 12, houses: 3 });
    const baked = hintLines(generated).join(" ").match(/«([^»]+)» уже печёт/);
    if (baked) {
      const world = generated.worlds.find((item) => item.name === baked[1]);
      expect(world?.buildings.some((building) => building.kind === "mill" && building.remainingDays <= 0 && world.stock.grain >= 10)).toBe(true);
    }
    const industry = hintLines(createIndustryDependenceScenario()).join(" ");
    expect(industry).toContain("«Рудник» держит продовольствие");
    expect(industry).toContain("Чужой рынок — «Нива»");
    expect(industry).not.toContain("печёт");
    expect(industry).not.toContain("коротким запасом");
  });

  it("не говорит, что остановленная мельница печёт", () => {
    const state = createBorderContractScenario();
    const home = state.worlds.find((world) => world.name === "Усадьба")!;
    const mill = home.buildings.find((building) => building.kind === "mill")!;
    expect(hintLines(state).join(" ")).toContain("«Усадьба» уже печёт продовольствие");
    mill.enabled = false;
    const hint = hintLines(state).join(" ");
    expect(hint).toContain("«Усадьба» держит продовольствие");
    expect(hint).not.toContain("печёт");
  });

  it("не спорит с остановкой мельницы после тика без денег", () => {
    const state = createBorderContractScenario();
    const player = state.houses.find((house) => house.player)!;
    player.credits = 0;
    runTicks(state, 1);
    player.credits = 8000;
    const hint = hintLines(state).join(" ");
    expect(hint).not.toContain("печёт");
    expect(hint).toContain("нет денег на содержание");
  });
});

function quotedNames(text: string): string[] {
  return [...text.matchAll(/«([^»]+)»/g)].map((match) => match[1]);
}

function worldNames(state: SimState): Set<string> {
  return new Set(state.worlds.map((world) => world.name));
}

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
