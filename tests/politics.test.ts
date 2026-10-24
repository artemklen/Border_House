import { describe, expect, it } from "vitest";
import { dispatch } from "../src/sim/commands";
import { createSkeleton, endowHouse, endowWorld, placeFamily, placeShip } from "../src/sim/create";
import { createCrisisScenario } from "../src/sim/diagnostics";
import { audit, hashState } from "../src/sim/mutate";
import { advanceSituations, situationDecision } from "../src/sim/politics";
import { deserialize, serialize } from "../src/sim/save";
import { runTicks } from "../src/sim/simulate";
import type { SimState, Treaty } from "../src/sim/types";

describe("политические решения", () => {
  it("зависимость от еды открывается только при пустой столице и чужом складе", () => {
    const hungry = foodCase(0);
    advanceSituations(hungry);
    expect(hungry.situations.map((item) => item.kind)).toEqual(["foodDependence"]);
    const fed = foodCase(80);
    advanceSituations(fed);
    expect(fed.situations).toHaveLength(0);
  });

  it("спор о пошлине требует дорогой порт и голодного гостя, а отказ и уступка расходятся", () => {
    const yielded = createCrisisScenario();
    const refused = deserialize(serialize(yielded));
    const port = yielded.worlds.find((world) => world.id === "c-port")!;
    const ship = yielded.ships[0];
    const player = yielded.houses[0];
    const rival = yielded.houses[1];
    const foodBefore = port.stock.food;
    const creditsBefore = player.credits;
    const relationBefore = player.relation[rival.id] ?? 0;
    const yes = dispatch(yielded, { type: "resolveSituation", houseId: player.id, situationId: yielded.situations[0].id, choice: "yield" });
    expect(yes.ok).toBe(true);
    expect(port.stock.food).toBe(foodBefore - 10);
    expect(ship.cargo.food).toBe(10);
    expect(player.credits).toBe(creditsBefore + 120);
    expect(player.flow.sales).toBe(120);
    expect(player.flow.compensation).toBe(0);
    expect(rival.flow.purchases).toBe(120);
    expect(player.tradeWith[rival.id]).toBe(120);
    expect(player.relation[rival.id]).toBe(relationBefore + 8);
    expect(yielded.tariffGrants).toHaveLength(1);
    expect(audit(yielded).ok).toBe(true);

    const refusedPort = refused.worlds.find((world) => world.id === "c-port")!;
    const refusedPlayer = refused.houses[0];
    const refusedRival = refused.houses[1];
    const no = dispatch(refused, { type: "resolveSituation", houseId: refusedPlayer.id, situationId: refused.situations[0].id, choice: "refuse" });
    expect(no.ok).toBe(true);
    expect(refusedPort.stock.food).toBe(foodBefore);
    expect(refusedPlayer.credits).toBe(creditsBefore);
    expect(refusedPlayer.relation[refusedRival.id]).toBe(relationBefore - 12);
    expect(refusedPlayer.embargo[refusedRival.id]).toBe(true);
    expect(refused.tariffGrants).toHaveLength(0);
    expect(audit(refused).ok).toBe(true);

    const quiet = createCrisisScenario();
    const gate = quiet.worlds.find((world) => world.id === "c-port")!;
    gate.tariffBps = 100;
    quiet.situations = [];
    quiet.journal = [];
    advanceSituations(quiet);
    expect(quiet.situations.some((item) => item.kind === "tariffDispute")).toBe(false);
  });

  it("сорванный контракт открывается один раз и не создаёт товар", () => {
    const { state, buyer, seller } = brokenCase();
    advanceSituations(state);
    expect(state.situations.map((item) => item.kind)).toEqual(["brokenContract"]);
    const sellerCredits = seller.credits;
    const buyerCredits = buyer.credits;
    const food = state.worlds.reduce((sum, world) => sum + world.stock.food, 0);
    dispatch(state, { type: "resolveSituation", houseId: buyer.id, situationId: state.situations[0].id, choice: "yield" });
    expect(seller.credits).toBe(sellerCredits - 400);
    expect(buyer.credits).toBe(buyerCredits + 400);
    expect(state.worlds.reduce((sum, world) => sum + world.stock.food, 0)).toBe(food);
    advanceSituations(state);
    expect(state.situations.filter((item) => item.kind === "brokenContract")).toHaveLength(1);
    expect(audit(state).ok).toBe(true);
    const intact = brokenCase().state;
    intact.contracts[0].status = "active";
    advanceSituations(intact);
    expect(intact.situations).toHaveLength(0);
  });

  it("перегрузка порта и экспорт открываются только на своих условиях", () => {
    const crowded = createSkeleton(4, "crowd");
    crowded.aiEnabled = false;
    const player = endowHouse(crowded, { name: "Игрок", color: "#eee", crest: "ИГ", profile: "player", player: true, credits: 8000 });
    const port = endowWorld(crowded, { id: "q-port", name: "Гавань", specialty: "порт", x: 0, y: 0, ownerId: player.id, population: 10, popMoneyPerCapita: 2, stock: { food: 40 }, tariffBps: 100 });
    const other = endowHouse(crowded, { name: "Гость", color: "#333", crest: "ГС", profile: "merchant", player: false, credits: 2000 });
    endowWorld(crowded, { id: "q-home", name: "Дом гостя", specialty: "дом", x: 100, y: 0, ownerId: other.id, population: 10, popMoneyPerCapita: 2, stock: { food: 40 } });
    player.capitalId = port.id;
    other.capitalId = "q-home";
    const foreign = placeShip(crowded, other.id, port, "skiff", 5);
    const local = placeShip(crowded, player.id, port, "skiff", 5);
    port.port.queue = [foreign.id, local.id];
    advanceSituations(crowded);
    expect(crowded.situations.map((item) => item.kind)).toEqual(["congestedPort"]);
    port.port.queue = [];
    crowded.situations = [];
    advanceSituations(crowded);
    expect(crowded.situations).toHaveLength(0);

    const exporting = createSkeleton(5, "export");
    exporting.aiEnabled = false;
    const seller = endowHouse(exporting, { name: "Игрок", color: "#eee", crest: "ИГ", profile: "player", player: true, credits: 4000 });
    const capital = endowWorld(exporting, { id: "e-home", name: "Столица", specialty: "дом", x: 0, y: 0, ownerId: seller.id, population: 80, popMoneyPerCapita: 2, stock: { food: 0 } });
    const buyerHome = endowWorld(exporting, { id: "e-out", name: "Чужой", specialty: "рынок", x: 100, y: 0, ownerId: null, population: 0, popMoneyPerCapita: 0 });
    seller.capitalId = capital.id;
    dispatch(exporting, {
      type: "createRoute",
      houseId: seller.id,
      name: "Вывоз еды",
      stops: [
        { worldId: capital.id, actions: [{ good: "food", mode: "load", amount: 10, price: 0, keep: 0 }] },
        { worldId: buyerHome.id, actions: [{ good: "food", mode: "unload", amount: 10, price: 0, keep: 0 }] },
      ],
    });
    advanceSituations(exporting);
    expect(exporting.situations.map((item) => item.kind)).toEqual(["exportShortage"]);
    dispatch(exporting, { type: "resolveSituation", houseId: seller.id, situationId: exporting.situations[0].id, choice: "yield" });
    expect(exporting.routes[0].paused).toBe(true);
    capital.stock.food = 80;
    exporting.situations = [];
    exporting.routes[0].paused = false;
    advanceSituations(exporting);
    expect(exporting.situations).toHaveLength(0);
  });

  it("смена главы открывает пересмотр только если договор уже есть", () => {
    const withTreaty = successionCase(true);
    runTicks(withTreaty, 1);
    expect(withTreaty.situations.some((item) => item.kind === "successionReview")).toBe(true);
    expect(withTreaty.journal.some((entry) => entry.text.includes("умер"))).toBe(true);
    const bare = successionCase(false);
    runTicks(bare, 1);
    expect(bare.situations.some((item) => item.kind === "successionReview")).toBe(false);
    expect(bare.journal.some((entry) => entry.text.includes("умер"))).toBe(true);
  });

  it("срок, повтор, нехватка денег и сохранение не списывают казну дважды", () => {
    const state = createCrisisScenario();
    for (const route of state.routes) route.paused = true;
    const player = state.houses[0];
    const situation = state.situations[0];
    expect(situation.deadlineTick).toBe(8);
    const shipFood = state.ships[0].cargo.food;
    runTicks(state, 7);
    expect(state.situations[0].status).toBe("open");
    runTicks(state, 1);
    expect(state.situations[0].status).toBe("expired");
    expect(state.ships[0].cargo.food).toBe(shipFood);
    expect(state.tariffGrants).toHaveLength(0);
    expect(player.credits).toBeLessThan(6000 + 120);
    expect(state.journal.some((entry) => entry.text.includes("срок решения истёк"))).toBe(true);

    const repeat = createCrisisScenario();
    const actor = repeat.houses[0];
    const rival = repeat.houses[1];
    const relation = actor.relation[rival.id] ?? 0;
    const first = dispatch(repeat, { type: "resolveSituation", houseId: actor.id, situationId: repeat.situations[0].id, choice: "refuse" });
    const second = dispatch(repeat, { type: "resolveSituation", houseId: actor.id, situationId: repeat.situations[0].id, choice: "refuse" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(actor.relation[rival.id]).toBe(relation - 12);

    const poor = createCrisisScenario();
    poor.houses[1].credits = 0;
    const food = poor.worlds.find((world) => world.id === "c-port")!.stock.food;
    const failed = dispatch(poor, { type: "resolveSituation", houseId: poor.houses[0].id, situationId: poor.situations[0].id, choice: "yield" });
    expect(failed.ok).toBe(false);
    expect(poor.situations[0].status).toBe("open");
    expect(poor.houses[1].credits).toBe(0);
    expect(poor.worlds.find((world) => world.id === "c-port")!.stock.food).toBe(food);

    const saved = createCrisisScenario();
    const loaded = deserialize(serialize(saved));
    expect(loaded.situations[0].status).toBe("open");
    expect(hashState(loaded)).toBe(hashState(saved));
    const legacy = JSON.parse(serialize(saved)) as { version: number; state: { version: number; situations?: unknown; tariffGrants?: unknown; cooldowns?: unknown } };
    legacy.version = 4;
    legacy.state.version = 4;
    delete legacy.state.situations;
    delete legacy.state.tariffGrants;
    delete legacy.state.cooldowns;
    const migrated = deserialize(JSON.stringify(legacy));
    expect(migrated.version).toBe(5);
    expect(migrated.situations).toEqual([]);
    expect(() => deserialize(JSON.stringify({ version: 6, state: saved }))).toThrow(/версия/);
  });

  it("один и тот же seed повторяет события, а кулдаун не даёт крутить эмбарго", () => {
    const left = createCrisisScenario();
    const right = createCrisisScenario();
    runTicks(left, 12);
    runTicks(right, 12);
    expect(hashState(left)).toBe(hashState(right));
    expect(left.journal.map((entry) => entry.text)).toEqual(right.journal.map((entry) => entry.text));

    const state = createCrisisScenario();
    for (const route of state.routes) route.paused = true;
    const player = state.houses[0];
    const rival = state.houses[1];
    dispatch(state, { type: "resolveSituation", houseId: player.id, situationId: state.situations[0].id, choice: "refuse" });
    player.embargo[rival.id] = false;
    runTicks(state, 5);
    expect(state.situations.filter((item) => item.kind === "tariffDispute" && item.status === "open")).toHaveLength(0);
    expect(player.embargo[rival.id]).toBe(false);
  });

  it("одновременно открыты не больше двух ситуаций игрока", () => {
    const { state, buyer } = brokenCase();
    const capital = state.worlds.find((world) => world.ownerId === buyer.id)!;
    capital.stock.food = 0;
    capital.population = 80;
    capital.tariffBps = 900;
    const seller = state.houses.find((house) => house.id !== buyer.id)!;
    const ship = placeShip(state, seller.id, capital, "freighter", 10);
    const hungry = endowWorld(state, { id: "v-cap", name: "Голод", specialty: "город", x: 80, y: 0, ownerId: seller.id, population: 200, popMoneyPerCapita: 2, stock: { food: 2 } });
    seller.capitalId = hungry.id;
    capital.port.berth = [ship.id];
    ship.worldId = capital.id;
    advanceSituations(state);
    expect(state.situations.filter((item) => item.status === "open")).toHaveLength(2);
  });

  it("ИИ уступает единственному поставщику и отказывает, если есть альтернатива", () => {
    const only = aiFoodCase(false);
    runTicks(only, 1);
    const accepted = only.situations.find((item) => item.kind === "foodDependence");
    expect(accepted?.choice).toBe("yield");
    const supply = only.treaties.find((treaty) => treaty.kind === "supply");
    const supplier = only.houses.find((house) => house.name === "Игрок")!;
    const hungry = only.houses.find((house) => house.name === "Голодный")!;
    expect(supply?.status).toBe("active");
    expect(supply?.proposerId).toBe(supplier.id);
    expect(supply?.targetId).toBe(hungry.id);
    expect(only.aiLog.some((entry) => entry.text.includes("Зависимость"))).toBe(true);

    const choice = aiFoodCase(true);
    runTicks(choice, 1);
    const declined = choice.situations.find((item) => item.kind === "foodDependence");
    expect(declined?.choice).toBe("refuse");
    const ai = choice.houses.find((house) => house.name === "Голодный")!;
    expect(choice.treaties.some((treaty) => treaty.kind === "supply")).toBe(false);
    expect(ai.embargo[declined?.otherId ?? ""]).toBe(true);
  });

  it("уже принятая поставка не превращается в эмбарго, а надёжность считает закрытые окна", () => {
    const covered = aiFoodCase(false);
    const player = covered.houses.find((house) => house.player)!;
    const ai = covered.houses.find((house) => house.name === "Голодный")!;
    dispatch(covered, {
      type: "proposeTreaty",
      houseId: player.id,
      otherId: ai.id,
      kind: "supply",
      good: "food",
      tariffBps: 200,
      qtyPerWindow: 10,
      duration: 24,
    });
    runTicks(covered, 1);
    expect(covered.treaties.filter((treaty) => treaty.kind === "supply")).toHaveLength(1);
    expect(covered.treaties[0].status).toBe("active");
    expect(ai.embargo[player.id]).not.toBe(true);
    expect(covered.situations.find((item) => item.kind === "foodDependence")?.choice).toBe("yield");

    const reliable = brokenCase();
    const contract = reliable.state.contracts[0];
    contract.windows = 4;
    contract.qtyPerWindow = 10;
    contract.delivered = 0;
    contract.history = [
      { window: 0, delivered: 10, paid: 0, penalty: 0 },
      { window: 1, delivered: 10, paid: 0, penalty: 0 },
      { window: 2, delivered: 10, paid: 0, penalty: 0 },
      { window: 3, delivered: 0, paid: 0, penalty: 0 },
    ];
    advanceSituations(reliable.state);
    expect(situationDecision(reliable.state, reliable.buyer, reliable.state.situations[0])).toBe("yield");

    const thin = brokenCase();
    thin.state.contracts[0].windows = 4;
    thin.state.contracts[0].qtyPerWindow = 10;
    thin.state.contracts[0].status = "active";
    thin.state.contracts[0].delivered = 10;
    advanceSituations(thin.state);
    const opened = reliable.state.situations[0];
    expect(situationDecision(thin.state, thin.buyer, { ...opened, houseId: thin.buyer.id, otherId: thin.seller.id })).toBe("refuse");
  });

  it("оплата экспорта берёт корабль, который подошёл уже после открытия ситуации", () => {
    const state = createSkeleton(5, "export-pay");
    state.aiEnabled = false;
    const buyer = endowHouse(state, { name: "Игрок", color: "#eee", crest: "ИГ", profile: "player", player: true, credits: 4000 });
    const capital = endowWorld(state, { id: "e-home", name: "Столица", specialty: "дом", x: 0, y: 0, ownerId: buyer.id, population: 80, popMoneyPerCapita: 2, stock: { food: 0 } });
    const seller = endowHouse(state, { name: "Склад", color: "#333", crest: "СК", profile: "merchant", player: false, credits: 1000 });
    const warehouse = endowWorld(state, { id: "e-out", name: "Чужой", specialty: "рынок", x: 100, y: 0, ownerId: seller.id, population: 10, popMoneyPerCapita: 2, stock: { food: 40 } });
    buyer.capitalId = capital.id;
    seller.capitalId = warehouse.id;
    dispatch(state, {
      type: "createRoute",
      houseId: buyer.id,
      name: "Вывоз еды",
      stops: [
        { worldId: capital.id, actions: [{ good: "food", mode: "load", amount: 10, price: 0, keep: 0 }] },
        { worldId: warehouse.id, actions: [{ good: "food", mode: "unload", amount: 10, price: 0, keep: 0 }] },
      ],
    });
    advanceSituations(state);
    expect(state.situations[0].shipId).toBeNull();
    const ship = placeShip(state, buyer.id, warehouse, "freighter", 0);
    const paid = dispatch(state, { type: "resolveSituation", houseId: buyer.id, situationId: state.situations[0].id, choice: "pay" });
    expect(paid.ok).toBe(true);
    expect(ship.cargo.food).toBe(10);
    expect(warehouse.stock.food).toBe(30);
    expect(seller.flow.sales).toBe(120);
    expect(seller.flow.compensation).toBe(0);
    expect(buyer.tradeWith[seller.id]).toBe(120);
    expect(audit(state).ok).toBe(true);
  });
});

function foodCase(capitalFood: number): SimState {
  const state = createSkeleton(2, "food-politics");
  state.aiEnabled = false;
  const player = endowHouse(state, { name: "Игрок", color: "#eee", crest: "ИГ", profile: "player", player: true, credits: 2000 });
  const capital = endowWorld(state, { id: "f-cap", name: "Столица", specialty: "дом", x: 0, y: 0, ownerId: player.id, population: 80, popMoneyPerCapita: 2, stock: { food: capitalFood } });
  const other = endowHouse(state, { name: "Амбар", color: "#333", crest: "АМ", profile: "merchant", player: false, credits: 2000 });
  endowWorld(state, { id: "f-barn", name: "Амбар", specialty: "еда", x: 100, y: 0, ownerId: other.id, population: 20, popMoneyPerCapita: 2, stock: { food: 80 } });
  player.capitalId = capital.id;
  other.capitalId = "f-barn";
  return state;
}

function brokenCase(): { state: SimState; buyer: SimState["houses"][number]; seller: SimState["houses"][number] } {
  const state = createSkeleton(3, "broken-politics");
  state.aiEnabled = false;
  const seller = endowHouse(state, { name: "Продавец", color: "#333", crest: "ПР", profile: "merchant", player: false, credits: 5000 });
  const buyer = endowHouse(state, { name: "Игрок", color: "#eee", crest: "ИГ", profile: "player", player: true, credits: 5000 });
  const world = endowWorld(state, { id: "b-home", name: "Склад", specialty: "дом", x: 0, y: 0, ownerId: buyer.id, population: 20, popMoneyPerCapita: 2, stock: { food: 40 } });
  endowWorld(state, { id: "b-sell", name: "Лавка", specialty: "лавка", x: 40, y: 0, ownerId: seller.id, population: 10, popMoneyPerCapita: 2, stock: { food: 40 } });
  buyer.capitalId = world.id;
  seller.capitalId = "b-sell";
  dispatch(state, {
    type: "proposeContract",
    sellerId: seller.id,
    buyerId: buyer.id,
    good: "food",
    worldId: world.id,
    qtyPerWindow: 8,
    windows: 2,
    price: 10,
    shortfall: 0,
    deposit: 20,
  });
  dispatch(state, { type: "respondContract", houseId: buyer.id, contractId: state.contracts[0].id, accept: true });
  state.contracts[0].status = "broken";
  state.contracts[0].delivered = 0;
  return { state, buyer, seller };
}

function successionCase(withTreaty: boolean): SimState {
  const state = createSkeleton(6, "succession-politics");
  state.aiEnabled = false;
  const player = endowHouse(state, { name: "Игрок", color: "#eee", crest: "ИГ", profile: "player", player: true, credits: 4000 });
  const capital = endowWorld(state, { id: "s-cap", name: "Столица", specialty: "дом", x: 0, y: 0, ownerId: player.id, population: 30, popMoneyPerCapita: 2, stock: { food: 40 } });
  const other = endowHouse(state, { name: "Сосед", color: "#333", crest: "СО", profile: "merchant", player: false, credits: 2000 });
  endowWorld(state, { id: "s-other", name: "Соседний", specialty: "дом", x: 80, y: 0, ownerId: other.id, population: 20, popMoneyPerCapita: 2, stock: { food: 40 } });
  player.capitalId = capital.id;
  other.capitalId = "s-other";
  placeFamily(state, player, capital, 89, true);
  const head = state.people.find((person) => person.role === "head")!;
  head.ageDays = state.rules.deathCertainAge * state.rules.ticksPerYear - 1;
  if (withTreaty) {
    const treaty: Treaty = {
      id: "t-old",
      kind: "transit",
      proposerId: player.id,
      targetId: other.id,
      status: "active",
      startTick: 0,
      endTick: 48,
      duration: 48,
      tariffBps: 500,
      good: "food",
      qtyPerWindow: 0,
      delivered: 0,
      windowDays: 0,
      note: "старый транзит",
    };
    state.treaties.push(treaty);
  }
  return state;
}

function aiFoodCase(alternative: boolean): SimState {
  const state = createSkeleton(alternative ? 8 : 7, "ai-food");
  state.aiEnabled = true;
  state.rules.aiInterval = 1;
  const player = endowHouse(state, { name: "Игрок", color: "#eee", crest: "ИГ", profile: "player", player: true, credits: 4000 });
  const home = endowWorld(state, { id: "p-home", name: "Дом", specialty: "дом", x: 0, y: 200, ownerId: player.id, population: 20, popMoneyPerCapita: 2, stock: { food: 80 } });
  const ai = endowHouse(state, { name: "Голодный", color: "#48a", crest: "ГЛ", profile: "industrial", player: false, credits: 3000 });
  const capital = endowWorld(state, { id: "a-cap", name: "Пустая", specialty: "город", x: 0, y: 0, ownerId: ai.id, population: 100, popMoneyPerCapita: 2, stock: { food: 0 } });
  player.capitalId = home.id;
  ai.capitalId = capital.id;
  if (alternative) {
    const third = endowHouse(state, { name: "Запас", color: "#6a6", crest: "ЗП", profile: "merchant", player: false, credits: 2000 });
    endowWorld(state, { id: "z-barn", name: "Второй амбар", specialty: "еда", x: 120, y: 0, ownerId: third.id, population: 10, popMoneyPerCapita: 2, stock: { food: 90 } });
    third.capitalId = "z-barn";
  }
  return state;
}
