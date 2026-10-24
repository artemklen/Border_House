import { dispatch } from "./commands";
import { createSkeleton, endowHouse, endowWorld, placeBuilding, placeFamily, placeShip } from "./create";
import { foodCover } from "./mutate";
import { advanceSituations } from "./politics";
import type { SimState } from "./types";

export interface ScenarioMeasure {
  id: string;
  title: string;
  formula: string;
  done: boolean;
  value: string;
}

export interface ScenarioBrief {
  id: string;
  title: string;
  text: string;
  measures: ScenarioMeasure[];
}

export function createBorderContractScenario(seed = 21): SimState {
  const state = createSkeleton(seed, "border-contract");
  state.aiEnabled = false;
  const player = endowHouse(state, { name: "Дом Солар", color: "#e0a84a", crest: "СЛ", profile: "player", player: true, credits: 8000 });
  const gate = endowHouse(state, { name: "Дом Вега", color: "#d4534a", crest: "ВГ", profile: "merchant", player: false, credits: 6000 });
  const buyer = endowHouse(state, { name: "Дом Лира", color: "#4aa3d4", crest: "ЛР", profile: "merchant", player: false, credits: 6000 });
  const home = endowWorld(state, { id: "b-home", name: "Усадьба", specialty: "дом", x: 0, y: 0, ownerId: player.id, population: 20, popMoneyPerCapita: 4, stock: { food: 24, grain: 30, fuel: 80, parts: 8 } });
  const field = endowWorld(state, { id: "b-field", name: "Поле", specialty: "зерно", x: 0, y: 90, ownerId: player.id, population: 30, popMoneyPerCapita: 3, stock: { grain: 60, food: 20, fuel: 20 } });
  endowWorld(state, { id: "b-gate", name: "Застава", specialty: "застава", x: 140, y: 0, ownerId: gate.id, population: 20, popMoneyPerCapita: 4, stock: { food: 30, fuel: 20 }, tariffBps: 900 });
  const market = endowWorld(state, { id: "b-market", name: "Рынок Лиры", specialty: "рынок", x: 280, y: 180, ownerId: buyer.id, population: 50, popMoneyPerCapita: 4, stock: { food: 8, grain: 10 } });
  endowWorld(state, { id: "b-beacon", name: "Обходной маяк", specialty: "маяк", x: 40, y: 180, ownerId: player.id, population: 0, popMoneyPerCapita: 0, stock: { fuel: 40 }, tariffBps: 0 });
  player.capitalId = home.id;
  gate.capitalId = "b-gate";
  buyer.capitalId = market.id;
  placeBuilding(state, field, player.id, "farm");
  placeBuilding(state, home, player.id, "mill");
  placeShip(state, player.id, home, "freighter", 70);
  placeFamily(state, player, home, 40, true);
  placeFamily(state, gate, state.worlds.find((world) => world.id === "b-gate")!, 40, true);
  placeFamily(state, buyer, market, 40, true);
  dispatch(state, {
    type: "proposeContract",
    sellerId: player.id,
    buyerId: buyer.id,
    good: "food",
    worldId: market.id,
    qtyPerWindow: 6,
    windows: 6,
    price: 12,
    shortfall: 4,
    deposit: 72,
  });
  const contract = state.contracts[0];
  if (contract) dispatch(state, { type: "respondContract", houseId: buyer.id, contractId: contract.id, accept: true });
  return state;
}

export function createCrowdedHarborScenario(seed = 22): SimState {
  const state = createSkeleton(seed, "crowded-harbor");
  state.aiEnabled = false;
  const player = endowHouse(state, { name: "Дом Солар", color: "#e0a84a", crest: "СЛ", profile: "player", player: true, credits: 9000 });
  const alpha = endowHouse(state, { name: "Дом Норд", color: "#7d8cff", crest: "НР", profile: "merchant", player: false, credits: 4000 });
  const beta = endowHouse(state, { name: "Дом Ост", color: "#53b38a", crest: "ОС", profile: "merchant", player: false, credits: 4000 });
  const yard = endowWorld(state, { id: "h-yard", name: "Верфь", specialty: "дом", x: 0, y: 80, ownerId: player.id, population: 28, popMoneyPerCapita: 4, stock: { food: 70, parts: 4, fuel: 20 } });
  const port = endowWorld(state, {
    id: "h-port",
    name: "Гавань",
    specialty: "порт",
    x: 0,
    y: 0,
    ownerId: player.id,
    population: 12,
    popMoneyPerCapita: 4,
    stock: { food: 8, parts: 12, fuel: 10 },
    tariffBps: 200,
  });
  const homeA = endowWorld(state, { id: "h-nord", name: "Норд", specialty: "дом", x: 160, y: -40, ownerId: alpha.id, population: 24, popMoneyPerCapita: 3, stock: { food: 40, fuel: 20 } });
  const homeB = endowWorld(state, { id: "h-ost", name: "Ост", specialty: "дом", x: 160, y: 40, ownerId: beta.id, population: 24, popMoneyPerCapita: 3, stock: { food: 40, fuel: 20 } });
  player.capitalId = yard.id;
  alpha.capitalId = homeA.id;
  beta.capitalId = homeB.id;
  const first = placeShip(state, alpha.id, port, "freighter", 20);
  const second = placeShip(state, beta.id, port, "freighter", 20);
  placeShip(state, player.id, yard, "skiff", 16);
  placeFamily(state, player, yard, 40, true);
  placeFamily(state, alpha, homeA, 40, true);
  placeFamily(state, beta, homeB, 40, true);
  const proposed = dispatch(state, {
    type: "proposeContract",
    sellerId: player.id,
    buyerId: alpha.id,
    good: "ore",
    worldId: homeA.id,
    qtyPerWindow: 4,
    windows: 2,
    price: 8,
    shortfall: 2,
    deposit: 16,
  });
  const contract = proposed.ok ? state.contracts[0] : undefined;
  if (contract) dispatch(state, { type: "respondContract", houseId: alpha.id, contractId: contract.id, accept: true });
  port.port.queue = [first.id, second.id];
  advanceSituations(state);
  for (const [ship, owner, homeId, title] of [
    [first, alpha, homeA.id, "Норд ждёт груз"],
    [second, beta, homeB.id, "Ост ждёт груз"],
  ] as const) {
    dispatch(state, {
      type: "createRoute",
      houseId: owner.id,
      name: title,
      shipId: ship.id,
      minLoad: 20,
      maxWait: 30,
      stops: [
        { worldId: port.id, actions: [{ good: "food", mode: "buy", amount: 20, price: 80, keep: 0 }] },
        { worldId: homeId, actions: [{ good: "food", mode: "unload", amount: 20, price: 0, keep: 0 }] },
      ],
    });
  }
  return state;
}

export function createIndustryDependenceScenario(seed = 23): SimState {
  const state = createSkeleton(seed, "industry-dependence");
  state.aiEnabled = false;
  const player = endowHouse(state, { name: "Дом Солар", color: "#e0a84a", crest: "СЛ", profile: "industrial", player: true, credits: 10000 });
  const pantry = endowHouse(state, { name: "Дом Нива", color: "#8dba4a", crest: "НВ", profile: "merchant", player: false, credits: 5000 });
  const mine = endowWorld(state, {
    id: "i-mine",
    name: "Рудник",
    specialty: "руда",
    x: 0,
    y: 0,
    ownerId: player.id,
    population: 40,
    popMoneyPerCapita: 4,
    stock: { ore: 40, food: 10, parts: 30, fuel: 20 },
    deposits: { ore: 400 },
  });
  const barn = endowWorld(state, { id: "i-barn", name: "Нива", specialty: "еда", x: 180, y: 20, ownerId: pantry.id, population: 50, popMoneyPerCapita: 3, stock: { food: 120, grain: 80 } });
  player.capitalId = mine.id;
  pantry.capitalId = barn.id;
  placeBuilding(state, mine, player.id, "mine");
  placeBuilding(state, barn, pantry.id, "farm");
  placeShip(state, player.id, mine, "freighter", 30);
  placeFamily(state, player, mine, 40, true);
  placeFamily(state, pantry, barn, 40, true);
  return state;
}

export function campaignBrief(state: SimState): ScenarioBrief | null {
  if (state.scenario === "border-contract") return borderBrief(state);
  if (state.scenario === "crowded-harbor") return harborBrief(state);
  if (state.scenario === "industry-dependence") return industryBrief(state);
  return null;
}

function countedDeliveries(contract: { status: string; delivered: number; history: Array<{ delivered: number }> }): number {
  const history = contract.history.reduce((sum, item) => sum + item.delivered, 0);
  if (contract.status === "completed" || contract.status === "broken") return history;
  return history + contract.delivered;
}

function borderBrief(state: SimState): ScenarioBrief {
  const player = state.houses.find((house) => house.player);
  const contract = state.contracts.find((item) => item.sellerId === player?.id);
  const delivered = contract ? countedDeliveries(contract) : 0;
  const capital = state.worlds.find((world) => world.id === player?.capitalId);
  const cover = capital && player ? foodCover(capital.population, capital.stock.food, state.rules.foodPer100) : 0;
  const toll = player ? player.flow.tariffsOut + player.lastFlow.tariffsOut : 0;
  const bypass = state.routes.some((route) => route.houseId === player?.id && route.stops.some((stop) => stop.worldId === "b-beacon") && route.stops.some((stop) => stop.worldId === "b-market"));
  return {
    id: "border-contract",
    title: "Контракт на границе",
    text: "Лира платит за еду. Короткий путь пересекает заставу Веги, пошлина 9% от цены груза. Обходной маяк принадлежит дому и лежит вне этого круга, путь длиннее. Обратный порожний рейс пошлину почти не платит. Цели необязательны, песочница после них не закрывается.",
    measures: [
      { id: "delivery", title: "Есть принятая поставка", formula: "сумма delivered по окнам контракта > 0", done: delivered > 0, value: `${delivered} ед.` },
      { id: "cover", title: "Столица сыта не меньше 12 дней", formula: "запас × 100 / (население × еда на 100) ≥ 12", done: cover >= 12, value: `${cover} дн.` },
      { id: "path", title: "Выбран путь: пошлина или обход", formula: "пошлины дома за это или прошлое окно > 0, либо маршрут через Обходной маяк на Рынок Лиры. Покупки в эту сумму не входят", done: toll > 0 || bypass, value: toll > 0 ? `пошлины в окне ${toll}` : bypass ? "обход заложен" : "маршрут не выбран" },
    ],
  };
}

function harborBrief(state: SimState): ScenarioBrief {
  const port = state.worlds.find((world) => world.id === "h-port");
  const player = state.houses.find((house) => house.player);
  const capital = state.worlds.find((world) => world.id === player?.capitalId);
  const cover = capital && player ? foodCover(capital.population, capital.stock.food, state.rules.foodPer100) : 0;
  const speed = Boolean(port && (port.port.speedLevel > 0 || port.port.project?.kind === "speed"));
  const fleet = state.ships.filter((ship) => ship.houseId === player?.id).length >= 2;
  const waiting = (port?.port.queue.length ?? 0) + (port?.port.berth.length ?? 0);
  return {
    id: "crowded-harbor",
    title: "Перегруженная гавань",
    text: "Два чужих грузовоза ждут еду, которой на причале нет: один занимает место, второй стоит в очереди. Ускорение стоит 1600 кред. и 6 комплектующих и поднимает дневной лимит, но не создаёт груз. Новый корабль очередь чужих сам не снимает.",
    measures: [
      { id: "seen", title: "Чужой корабль занимает гавань", formula: "очередь Гавани + причал ≥ 1", done: waiting >= 1, value: `очередь ${port?.port.queue.length ?? 0}, причал ${port?.port.berth.length ?? 0}` },
      { id: "choice", title: "Либо ускорение порта, либо второй свой корабль", formula: "стройка или уровень скорости, либо своих кораблей ≥ 2", done: speed || fleet, value: speed ? "скорость заложена" : fleet ? "флот расширен" : "выбор ещё не сделан" },
      { id: "food", title: "Верфь сыта не меньше 10 дней", formula: "запас × 100 / (население × еда на 100) ≥ 10", done: cover >= 10, value: `${cover} дн.` },
    ],
  };
}

function industryBrief(state: SimState): ScenarioBrief {
  const mine = state.worlds.find((world) => world.id === "i-mine");
  const player = state.houses.find((house) => house.player);
  const cover = mine && player ? foodCover(mine.population, mine.stock.food, state.rules.foodPer100) : 0;
  const path = Boolean(mine && ((mine.development.path === "industrial" && mine.development.level > 0) || mine.development.project?.path === "industrial"));
  const alloys = (mine?.produced.alloys ?? 0) + (mine?.lastProduced.alloys ?? 0) + (mine?.stock.alloys ?? 0);
  const partners = player ? Object.values(player.tradeWith).filter((value) => value > 0).length : 0;
  const foreignFood = Boolean(mine && player && [mine.imported, mine.lastImported].some((book) => Object.entries(book).some(([houseId, goods]) => houseId !== player.id && goods.food > 0)));
  return {
    id: "industry-dependence",
    title: "Промышленная зависимость",
    text: "Руда есть только на Руднике, еда в основном у Нивы. Промышленный путь усиливает плавку, но не создаёт продовольствие. Цели смотрят и на путь, и на запас еды.",
    measures: [
      { id: "path", title: "Промышленный путь заложен или даёт сплав", formula: "путь industrial с уровнем или стройкой, либо произведённые/запасные сплавы > 0", done: Boolean(path) || alloys > 0, value: path ? `уровень ${mine?.development.level ?? 0}` : `сплавы ${alloys}` },
      { id: "cover", title: "Рудник сыт не меньше 8 дней", formula: "запас × 100 / (население × еда на 100) ≥ 8", done: cover >= 8, value: `${cover} дн.` },
      { id: "partner", title: "Есть след торговли или чужая еда", formula: "tradeWith > 0 или на Рудник пришла еда от другого дома", done: partners > 0 || foreignFood, value: partners > 0 ? `партнёров ${partners}` : foreignFood ? "еда от другого дома" : "торговли ещё нет" },
    ],
  };
}
