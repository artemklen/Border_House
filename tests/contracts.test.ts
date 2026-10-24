import { describe, expect, it } from "vitest";
import { planAi } from "../src/sim/ai";
import { dispatch } from "../src/sim/commands";
import { createSkeleton, endowHouse, endowWorld, placeShip } from "../src/sim/create";
import { audit, hashState, sinkCredits } from "../src/sim/mutate";
import { deserialize, serialize } from "../src/sim/save";
import { runTicks } from "../src/sim/simulate";
import type { SimState } from "../src/sim/types";

function mustAudit(state: SimState): void {
  const report = audit(state);
  expect(report.errors, report.errors.join("\n")).toEqual([]);
}

function bench(): { state: SimState; sellerId: string; buyerId: string; sellerWorld: string; buyerWorld: string; shipId: string } {
  const state = createSkeleton(1, "contract");
  state.aiEnabled = false;
  state.rules.window = 6;
  const seller = endowHouse(state, { name: "Продавец", color: "#e0a84a", crest: "ПР", profile: "player", player: true, credits: 5000 });
  const buyer = endowHouse(state, { name: "Покупатель", color: "#d4533c", crest: "ПК", profile: "merchant", player: false, credits: 5000 });
  const from = endowWorld(state, {
    id: "c-from", name: "Склад", specialty: "еда", x: 0, y: 0, ownerId: seller.id, population: 0, popMoneyPerCapita: 0,
    stock: { food: 80, fuel: 40 }, tariffBps: 0,
  });
  const to = endowWorld(state, {
    id: "c-to", name: "Рынок", specialty: "рынок", x: 40, y: 0, ownerId: buyer.id, population: 0, popMoneyPerCapita: 0,
    stock: { food: 0, fuel: 10 }, tariffBps: 0,
  });
  seller.capitalId = from.id;
  buyer.capitalId = to.id;
  const ship = placeShip(state, seller.id, from, "freighter", 30);
  to.prices.food = 12;
  return { state, sellerId: seller.id, buyerId: buyer.id, sellerWorld: from.id, buyerWorld: to.id, shipId: ship.id };
}

function propose(state: SimState, sellerId: string, buyerId: string, worldId: string, qty: number, price: number, windows = 2, shortfall = 0, deposit = 20) {
  return dispatch(state, {
    type: "proposeContract", sellerId, buyerId, good: "food", worldId, qtyPerWindow: qty, windows, price, shortfall, deposit,
  });
}

function sellRoute(state: SimState, sellerId: string, shipId: string, from: string, to: string, amount: number) {
  return dispatch(state, {
    type: "createRoute",
    houseId: sellerId,
    name: "Поставка",
    shipId,
    stops: [
      { worldId: from, actions: [{ good: "food", mode: "load", amount, price: 0, keep: 0 }] },
      { worldId: to, actions: [{ good: "food", mode: "sell", amount, price: 0, keep: 0 }] },
    ],
  });
}

describe("коммерческие контракты", () => {
  it("фиксированная цена не следует за рынком и отличается от свободной продажи", () => {
    const agreed = bench();
    const spot = bench();
    expect(propose(agreed.state, agreed.sellerId, agreed.buyerId, agreed.buyerWorld, 4, 8).ok).toBe(true);
    expect(dispatch(agreed.state, { type: "respondContract", houseId: agreed.buyerId, contractId: agreed.state.contracts[0].id, accept: true }).ok).toBe(true);
    sellRoute(agreed.state, agreed.sellerId, agreed.shipId, agreed.sellerWorld, agreed.buyerWorld, 4);
    sellRoute(spot.state, spot.sellerId, spot.shipId, spot.sellerWorld, spot.buyerWorld, 4);
    for (let day = 0; day < 12 && agreed.state.contracts[0].delivered === 0; day += 1) {
      agreed.state.worlds[1].prices.food = 30;
      spot.state.worlds[1].prices.food = 30;
      runTicks(agreed.state, 1);
      runTicks(spot.state, 1);
    }
    expect(agreed.state.contracts[0].trades[0].price).toBe(8);
    expect(agreed.state.contracts[0].paidWindow).toBe(32);
    expect(spot.state.routes[0].revenue).not.toBe(agreed.state.routes[0].revenue);
    mustAudit(agreed.state);
    mustAudit(spot.state);
  });

  it("частичная поставка платит только за принятое, полная закрывает окно без штрафа", () => {
    const partial = bench();
    propose(partial.state, partial.sellerId, partial.buyerId, partial.buyerWorld, 4, 8, 2, 0, 20);
    dispatch(partial.state, { type: "respondContract", houseId: partial.buyerId, contractId: partial.state.contracts[0].id, accept: true });
    sellRoute(partial.state, partial.sellerId, partial.shipId, partial.sellerWorld, partial.buyerWorld, 2);
    for (let day = 0; day < 12 && partial.state.contracts[0].delivered < 2; day += 1) runTicks(partial.state, 1);
    expect(partial.state.contracts[0].delivered).toBe(2);
    expect(partial.state.contracts[0].paidWindow).toBe(16);
    expect(partial.state.houses[1].credits).toBe(5000 - 16);
    mustAudit(partial.state);

    const full = bench();
    propose(full.state, full.sellerId, full.buyerId, full.buyerWorld, 4, 8, 2, 0, 20);
    dispatch(full.state, { type: "respondContract", houseId: full.buyerId, contractId: full.state.contracts[0].id, accept: true });
    sellRoute(full.state, full.sellerId, full.shipId, full.sellerWorld, full.buyerWorld, 4);
    for (let day = 0; day < 20 && full.state.contracts[0].status === "active"; day += 1) runTicks(full.state, 1);
    expect(full.state.contracts[0].history.some((item) => item.delivered === 4 && item.penalty === 0)).toBe(true);
    mustAudit(full.state);
  });

  it("недовоз берёт штраф из залога и не уводит казну в минус", () => {
    const { state, sellerId, buyerId, buyerWorld } = bench();
    propose(state, sellerId, buyerId, buyerWorld, 4, 8, 2, 0, 10);
    dispatch(state, { type: "respondContract", houseId: buyerId, contractId: state.contracts[0].id, accept: true });
    runTicks(state, state.rules.window);
    expect(state.contracts[0].status).toBe("broken");
    expect(state.contracts[0].history[0].penalty).toBe(10);
    expect(state.houses[0].credits).toBeLessThan(5000);
    expect(state.houses[1].credits).toBeGreaterThan(5000);
    expect(state.houses[0].reserved).toBe(0);
    expect(state.houses.every((house) => house.credits >= 0)).toBe(true);
    mustAudit(state);
  });

  it("не хватает свободных денег, и один резерв нельзя занять дважды", () => {
    const poor = bench();
    sinkCredits(poor.state, { kind: "house", id: poor.buyerId }, 4980);
    expect(propose(poor.state, poor.sellerId, poor.buyerId, poor.buyerWorld, 4, 8, 2, 0, 10).ok).toBe(true);
    const refused = dispatch(poor.state, { type: "respondContract", houseId: poor.buyerId, contractId: poor.state.contracts[0].id, accept: true });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain("нет свободных денег");
    expect(poor.state.contracts[0].status).toBe("proposed");
    mustAudit(poor.state);

    const { state, sellerId, buyerId, buyerWorld } = bench();
    sinkCredits(state, { kind: "house", id: buyerId }, 4960);
    expect(propose(state, sellerId, buyerId, buyerWorld, 4, 8, 2, 0, 10).ok).toBe(true);
    expect(dispatch(state, { type: "respondContract", houseId: buyerId, contractId: state.contracts[0].id, accept: true }).ok).toBe(true);
    expect(propose(state, sellerId, buyerId, buyerWorld, 4, 8, 2, 0, 10).ok).toBe(true);
    expect(dispatch(state, { type: "respondContract", houseId: buyerId, contractId: state.contracts[1].id, accept: true }).ok).toBe(false);
    expect(state.houses[1].reserved).toBe(32);
    expect(state.houses[0].reserved).toBe(20);
    mustAudit(state);
  });

  it("отмена называет потерю и возвращает остаток, завершение освобождает залог", () => {
    const cancelled = bench();
    propose(cancelled.state, cancelled.sellerId, cancelled.buyerId, cancelled.buyerWorld, 4, 8, 2, 0, 20);
    dispatch(cancelled.state, { type: "respondContract", houseId: cancelled.buyerId, contractId: cancelled.state.contracts[0].id, accept: true });
    const result = dispatch(cancelled.state, { type: "cancelContract", houseId: cancelled.sellerId, contractId: cancelled.state.contracts[0].id });
    expect(result.ok).toBe(true);
    expect(result.reason).toContain("10");
    expect(cancelled.state.houses[1].credits).toBe(5000 + 10);
    expect(cancelled.state.houses[0].reserved).toBe(0);
    expect(cancelled.state.houses[1].reserved).toBe(0);
    mustAudit(cancelled.state);

    const done = bench();
    propose(done.state, done.sellerId, done.buyerId, done.buyerWorld, 4, 8, 2, 4, 20);
    dispatch(done.state, { type: "respondContract", houseId: done.buyerId, contractId: done.state.contracts[0].id, accept: true });
    runTicks(done.state, done.state.rules.window * 2);
    expect(done.state.contracts[0].status).toBe("completed");
    expect(done.state.houses[0].reserved).toBe(0);
    expect(done.state.houses[1].reserved).toBe(0);
    mustAudit(done.state);
  });

  it("перепродажа местного груза и транзит не считаются приёмкой", () => {
    const { state, sellerId, buyerId, buyerWorld, shipId } = bench();
    propose(state, sellerId, buyerId, buyerWorld, 4, 8, 2, 0, 20);
    dispatch(state, { type: "respondContract", houseId: buyerId, contractId: state.contracts[0].id, accept: true });
    const ship = state.ships[0];
    ship.cargo.food = 4;
    ship.supplyFrom.food = { [buyerId]: 4 };
    state.accounts.goodsCreated.food += 4;
    dispatch(state, {
      type: "createRoute",
      houseId: sellerId,
      name: "Перепродажа",
      shipId,
      stops: [
        { worldId: buyerWorld, actions: [{ good: "food", mode: "sell", amount: 4, price: 0, keep: 0 }] },
      ],
    });
    ship.worldId = buyerWorld;
    runTicks(state, 1);
    expect(state.contracts[0].delivered).toBe(0);

    const flying = bench();
    propose(flying.state, flying.sellerId, flying.buyerId, flying.buyerWorld, 4, 8, 2, 0, 20);
    dispatch(flying.state, { type: "respondContract", houseId: flying.buyerId, contractId: flying.state.contracts[0].id, accept: true });
    sellRoute(flying.state, flying.sellerId, flying.shipId, flying.sellerWorld, flying.buyerWorld, 4);
    for (let day = 0; day < 8 && flying.state.ships[0].status !== "transit"; day += 1) runTicks(flying.state, 1);
    expect(flying.state.ships[0].status).toBe("transit");
    expect(flying.state.contracts[0].delivered).toBe(0);
    const raw = serialize(flying.state);
    const loaded = deserialize(raw);
    expect(hashState(loaded)).toBe(hashState(flying.state));
    expect(loaded.contracts[0].buyerReserve).toBe(flying.state.contracts[0].buyerReserve);
    runTicks(flying.state, 2);
    runTicks(loaded, 2);
    expect(hashState(loaded)).toBe(hashState(flying.state));
    mustAudit(loaded);
  });

  it("сохранение версии 1 поднимается без потери партии", () => {
    const { state } = bench();
    const parsed = JSON.parse(serialize(state)) as { version: number; state: SimState };
    parsed.version = 1;
    delete (parsed.state.houses[0] as { reserved?: number }).reserved;
    delete (parsed.state as { contracts?: unknown }).contracts;
    const loaded = deserialize(JSON.stringify(parsed));
    expect(loaded.version).toBe(2);
    expect(loaded.contracts).toEqual([]);
    expect(loaded.houses[0].reserved).toBe(0);
    mustAudit(loaded);
  });

  it("ИИ принимает исполнимую цену не выше рынка и отклоняет убыточную и невыполнимую", () => {
    const good = bench();
    good.state.aiEnabled = true;
    propose(good.state, good.sellerId, good.buyerId, good.buyerWorld, 4, 8, 2, 0, 20);
    planAi(good.state);
    expect(good.state.contracts[0].status).toBe("active");
    expect(good.state.aiLog.some((entry) => entry.text.includes("принимает контракт"))).toBe(true);

    const dear = bench();
    propose(dear.state, dear.sellerId, dear.buyerId, dear.buyerWorld, 4, 40, 2, 0, 20);
    planAi(dear.state);
    expect(dear.state.contracts[0].status).toBe("rejected");
    expect(dear.state.aiLog.some((entry) => entry.text.includes("выше рыночной"))).toBe(true);
    expect(dear.state.houses[0].reserved).toBe(0);

    const stuck = bench();
    propose(stuck.state, stuck.sellerId, stuck.buyerId, stuck.buyerWorld, 4, 8, 2, 0, 20);
    stuck.state.ships = [];
    planAi(stuck.state);
    expect(stuck.state.contracts[0].status).toBe("rejected");
    expect(stuck.state.aiLog.some((entry) => entry.text.includes("нет готового корабля"))).toBe(true);
  });

  it("три сценария: спокойный рынок, дефицит и срыв перевозки не дают гарантированной прибыли", () => {
    const calm = bench();
    propose(calm.state, calm.sellerId, calm.buyerId, calm.buyerWorld, 4, 12, 2, 0, 20);
    dispatch(calm.state, { type: "respondContract", houseId: calm.buyerId, contractId: calm.state.contracts[0].id, accept: true });
    sellRoute(calm.state, calm.sellerId, calm.shipId, calm.sellerWorld, calm.buyerWorld, 4);
    for (let day = 0; day < 12 && calm.state.contracts[0].delivered === 0; day += 1) {
      calm.state.worlds[1].prices.food = 12;
      runTicks(calm.state, 1);
    }
    expect(calm.state.contracts[0].paidWindow).toBe(48);

    const shortage = bench();
    propose(shortage.state, shortage.sellerId, shortage.buyerId, shortage.buyerWorld, 4, 8, 2, 0, 20);
    dispatch(shortage.state, { type: "respondContract", houseId: shortage.buyerId, contractId: shortage.state.contracts[0].id, accept: true });
    sellRoute(shortage.state, shortage.sellerId, shortage.shipId, shortage.sellerWorld, shortage.buyerWorld, 4);
    for (let day = 0; day < 12 && shortage.state.contracts[0].delivered === 0; day += 1) {
      shortage.state.worlds[1].prices.food = 30;
      runTicks(shortage.state, 1);
    }
    expect(shortage.state.contracts[0].trades[0].price).toBe(8);
    expect(shortage.state.houses[1].credits).toBeGreaterThan(5000 - 4 * 30);

    const risk = bench();
    propose(risk.state, risk.sellerId, risk.buyerId, risk.buyerWorld, 4, 8, 2, 0, 20);
    dispatch(risk.state, { type: "respondContract", houseId: risk.buyerId, contractId: risk.state.contracts[0].id, accept: true });
    sellRoute(risk.state, risk.sellerId, risk.shipId, risk.sellerWorld, risk.buyerWorld, 4);
    dispatch(risk.state, { type: "setEmbargo", houseId: risk.buyerId, otherId: risk.sellerId, embargo: true });
    runTicks(risk.state, risk.state.rules.window);
    expect(risk.state.contracts[0].status).toBe("broken");
    expect(risk.state.houses[0].credits).toBeLessThan(5000);
    mustAudit(calm.state);
    mustAudit(shortage.state);
    mustAudit(risk.state);
  });

  it("четвёртый контракт пары отклоняется, дипломатический договор не занимает это место", () => {
    const { state, sellerId, buyerId, buyerWorld } = bench();
    for (let index = 0; index < 3; index += 1) {
      expect(propose(state, sellerId, buyerId, buyerWorld, 1, 8, 2, 0, 8).ok).toBe(true);
    }
    expect(propose(state, sellerId, buyerId, buyerWorld, 1, 8, 2, 0, 8).ok).toBe(false);
    const treaty = dispatch(state, {
      type: "proposeTreaty", houseId: sellerId, otherId: buyerId, kind: "supply", tariffBps: 0, good: "food", qtyPerWindow: 4, duration: 48,
    });
    expect(treaty.ok).toBe(true);
    expect(state.treaties.filter((item) => item.status === "proposed")).toHaveLength(1);
    expect(state.contracts.filter((item) => item.status === "proposed")).toHaveLength(3);
  });
});
