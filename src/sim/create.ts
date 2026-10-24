import { RECIPES, SHIP_CLASSES, defaultRules } from "./config";
import { GOODS, cloneGoods, emptyGoods, type GoodId } from "./goods";
import {
  createCredits,
  createGoods,
  emptyAccounts,
  emptyFlow,
  serial,
} from "./mutate";
import { emptyPort } from "./port";
import { normalizeSeed } from "./prng";
import { nextUnit } from "./prng";
import type { AiProfile, BuildingKind, GameRules, House, Person, Ship, ShipClassId, SimState, World } from "./types";

export interface NewGameOptions {
  seed: number;
  worlds?: number;
  houses?: number;
  scenario?: "base" | "generated";
}

const HOUSE_LOOKS = [
  { name: "Дом Солар", color: "#e0a84a", crest: "СЛ", profile: "player" as const },
  { name: "Дом Вега", color: "#d4533c", crest: "ВГ", profile: "merchant" as const },
  { name: "Дом Орион", color: "#6ea8fe", crest: "ОР", profile: "industrial" as const },
  { name: "Дом Лира", color: "#7dcea0", crest: "ЛР", profile: "expansionist" as const },
];

export function createGame(options: NewGameOptions): SimState {
  const scenario = options.scenario ?? "base";
  if (scenario === "base") return createBase(options.seed);
  const worlds = options.worlds ?? 16;
  const houses = options.houses ?? 4;
  if (!Number.isInteger(worlds) || worlds < 12 || worlds > 20) throw new Error("Число миров должно быть целым от 12 до 20.");
  if (!Number.isInteger(houses) || houses < 3 || houses > 4) throw new Error("Число домов должно быть целым от 3 до 4.");
  return createGenerated(options.seed, worlds, houses);
}

export function createSkeleton(seed: number, scenario: string, rules: GameRules = defaultRules()): SimState {
  return {
    version: 3,
    seed,
    scenario,
    tick: 0,
    rngState: normalizeSeed(seed),
    nextSerial: 0,
    rules,
    aiEnabled: scenario === "base" || scenario === "generated",
    houses: [],
    worlds: [],
    ships: [],
    routes: [],
    treaties: [],
    contracts: [],
    people: [],
    journal: [],
    aiLog: [],
    accounts: emptyAccounts(),
  };
}

export function endowHouse(
  state: SimState,
  spec: { name: string; color: string; crest: string; profile: AiProfile; player: boolean; credits: number },
): House {
  const house: House = {
    id: serial(state, "h"),
    name: spec.name,
    color: spec.color,
    crest: spec.crest,
    player: spec.player,
    profile: spec.profile,
    credits: 0,
    reserved: 0,
    capitalId: "",
    flow: emptyFlow(),
    lastFlow: emptyFlow(),
    flowDays: 0,
    relation: {},
    embargo: {},
    tradeWith: {},
    lastTradeWith: {},
  };
  state.houses.push(house);
  createCredits(state, { kind: "house", id: house.id }, spec.credits);
  return house;
}

export function endowWorld(
  state: SimState,
  spec: {
    id?: string;
    name: string;
    specialty: string;
    x: number;
    y: number;
    ownerId: string | null;
    population: number;
    popMoneyPerCapita: number;
    stock?: Partial<Record<GoodId, number>>;
    deposits?: Partial<Record<GoodId, number>>;
    tariffBps?: number;
    satisfaction?: number;
  },
): World {
  const stock = emptyGoods();
  for (const good of GOODS) stock[good] = spec.stock?.[good] ?? 0;
  const deposits = emptyGoods();
  for (const good of GOODS) deposits[good] = spec.deposits?.[good] ?? 0;
  const world: World = {
    id: spec.id ?? serial(state, "w"),
    name: spec.name,
    specialty: spec.specialty,
    x: spec.x,
    y: spec.y,
    ownerId: spec.ownerId,
    population: spec.population,
    popWallet: 0,
    satisfaction: spec.satisfaction ?? 62,
    stock,
    capacity: state.rules.stockCapacity,
    prices: cloneGoods(state.rules.basePrice),
    demand: emptyGoods(),
    lastDemand: emptyGoods(),
    deposits,
    tariffBps: spec.tariffBps ?? 200,
    buildings: [],
    governorId: null,
    imported: {},
    produced: emptyGoods(),
    eaten: 0,
    foodCredit: 0,
    lastImported: {},
    lastProduced: emptyGoods(),
    lastEaten: 0,
    windowDays: 0,
    port: emptyPort(),
  };
  state.worlds.push(world);
  for (const good of GOODS) createGoods(world.stock, state.accounts, good, 0);
  // createGoods adds on top of the values already written. Record endowment explicitly.
  for (const good of GOODS) {
    if (stock[good] > 0) state.accounts.goodsCreated[good] += stock[good];
  }
  createCredits(state, { kind: "pop", worldId: world.id }, spec.population * spec.popMoneyPerCapita);
  return world;
}

export function placeBuilding(state: SimState, world: World, ownerId: string, kind: BuildingKind): void {
  world.buildings.push({
    id: serial(state, "b"),
    kind,
    worldId: world.id,
    ownerId,
    remainingDays: 0,
    enabled: true,
    stopReason: null,
    workers: RECIPES[kind].workers,
  });
}

export function placeShip(state: SimState, houseId: string, world: World, classId: ShipClassId, fuel: number): Ship {
  const ship: Ship = {
    id: serial(state, "s"),
    name: `${SHIP_CLASSES[classId].name} ${state.ships.length + 1}`,
    houseId,
    classId,
    cargo: emptyGoods(),
    status: "docked",
    worldId: world.id,
    fromId: world.id,
    toId: null,
    legDistance: 0,
    distanceLeft: 0,
    routeId: null,
    stopIndex: 0,
    stopReason: null,
    tollWorldId: world.id,
    remainingDays: 0,
    mission: null,
    traveled: 0,
    supplyFrom: {},
    visitKey: "",
    visitMoved: [],
    portArrived: 0,
    portMoved: 0,
    portAllowance: 0,
  };
  state.ships.push(ship);
  if (fuel > 0) createGoods(ship.cargo, state.accounts, "fuel", fuel);
  return ship;
}

export function placeFamily(state: SimState, house: House, capital: World, headYears: number, withHeir: boolean): void {
  const year = state.rules.ticksPerYear;
  const head = addPerson(state, house.id, "Глава Астерий", "head", headYears * year, ["распорядитель"], null, null);
  const spouse = addPerson(state, house.id, "Супруга Нима", "spouse", Math.max(18, headYears - 4) * year, ["казначей"], null, head.id);
  head.spouseId = spouse.id;
  if (withHeir) addPerson(state, house.id, "Наследник Ивар", "heir", 24 * year, ["дипломат"], head.id, null);
  const governor = addPerson(state, house.id, "Губернатор Сера", "governor", 44 * year, ["рачительный"], null, null);
  governor.worldId = capital.id;
  governor.loyalty = 72;
  capital.governorId = governor.id;
}

function addPerson(
  state: SimState,
  houseId: string,
  name: string,
  role: Person["role"],
  ageDays: number,
  traits: string[],
  parentId: string | null,
  spouseId: string | null,
): Person {
  const person: Person = {
    id: serial(state, "p"),
    houseId,
    name,
    role,
    ageDays,
    alive: true,
    traits,
    loyalty: role === "governor" ? 70 : 50,
    parentId,
    spouseId,
    worldId: null,
  };
  state.people.push(person);
  return person;
}

function linkRelations(state: SimState, warmth: Record<string, number>): void {
  for (const house of state.houses) {
    for (const other of state.houses) {
      if (house.id === other.id) continue;
      const key = [house.id, other.id].sort().join(":");
      house.relation[other.id] = warmth[key] ?? 15;
    }
  }
}

function createBase(seed: number): SimState {
  const state = createSkeleton(seed, "base");
  const solar = endowHouse(state, { ...HOUSE_LOOKS[0], player: true, profile: "player", credits: 18000 });
  const vega = endowHouse(state, { ...HOUSE_LOOKS[1], player: false, profile: "merchant", credits: 18000 });
  const orion = endowHouse(state, { ...HOUSE_LOOKS[2], player: false, profile: "industrial", credits: 18000 });
  const lyra = endowHouse(state, { ...HOUSE_LOOKS[3], player: false, profile: "expansionist", credits: 18000 });

  const harbor = endowWorld(state, {
    id: "w-harbor",
    name: "Солнечная Гавань",
    specialty: "сплавы и комплектующие",
    x: 240,
    y: 480,
    ownerId: solar.id,
    population: 640,
    popMoneyPerCapita: 4,
    stock: { food: 90, alloys: 40, parts: 36, ore: 20 },
    tariffBps: 150,
  });
  const bread = endowWorld(state, {
    id: "w-bread",
    name: "Хлебный Пояс",
    specialty: "зерно и продовольствие",
    x: 200,
    y: 260,
    ownerId: solar.id,
    population: 400,
    popMoneyPerCapita: 4,
    stock: { grain: 180, food: 240, parts: 24, fuel: 40 },
    tariffBps: 150,
  });
  const ore = endowWorld(state, {
    id: "w-ore",
    name: "Рудный Кряж",
    specialty: "руда",
    x: 70,
    y: 560,
    ownerId: solar.id,
    population: 240,
    popMoneyPerCapita: 4,
    stock: { ore: 50, food: 40, parts: 8, fuel: 20 },
    deposits: { ore: 500000 },
    tariffBps: 150,
  });
  const fuel = endowWorld(state, {
    id: "w-fuel",
    name: "Топливный Утёс",
    specialty: "топливо",
    x: 70,
    y: 320,
    ownerId: solar.id,
    population: 160,
    popMoneyPerCapita: 4,
    stock: { fuel: 220, food: 30, parts: 8 },
    deposits: { fuel: 500000 },
    tariffBps: 150,
  });
  const vegaPrime = endowWorld(state, {
    id: "w-vega",
    name: "Вега-Прайм",
    specialty: "столица без своих полей",
    x: 700,
    y: 320,
    ownerId: vega.id,
    population: 860,
    popMoneyPerCapita: 4,
    stock: { food: 70, alloys: 16, parts: 20, ore: 10 },
    tariffBps: 400,
    satisfaction: 55,
  });
  const gate = endowWorld(state, {
    id: "w-gate",
    name: "Застава Корвус",
    specialty: "транзитная застава",
    x: 520,
    y: 390,
    ownerId: vega.id,
    population: 120,
    popMoneyPerCapita: 4,
    stock: { food: 24, fuel: 30 },
    tariffBps: 900,
  });
  endowWorld(state, {
    id: "w-vega-mine",
    name: "Шахты Веги",
    specialty: "руда",
    x: 860,
    y: 200,
    ownerId: vega.id,
    population: 220,
    popMoneyPerCapita: 4,
    stock: { ore: 40, food: 28, parts: 6 },
    deposits: { ore: 500000 },
    tariffBps: 250,
  });
  const oriHome = endowWorld(state, {
    id: "w-orion",
    name: "Орион",
    specialty: "мастерские",
    x: 1080,
    y: 220,
    ownerId: orion.id,
    population: 460,
    popMoneyPerCapita: 4,
    stock: { food: 40, alloys: 18, parts: 16, ore: 12 },
    tariffBps: 200,
  });
  const oriField = endowWorld(state, {
    id: "w-orion-field",
    name: "Поля Ориона",
    specialty: "скромные поля",
    x: 1140,
    y: 70,
    ownerId: orion.id,
    population: 340,
    popMoneyPerCapita: 4,
    stock: { grain: 36, food: 48, parts: 6 },
    tariffBps: 200,
  });
  const lyraPort = endowWorld(state, {
    id: "w-lyra",
    name: "Порт Лиры",
    specialty: "богатый рынок",
    x: 1000,
    y: 540,
    ownerId: lyra.id,
    population: 520,
    popMoneyPerCapita: 5,
    stock: { food: 18, parts: 6, alloys: 8 },
    tariffBps: 250,
  });
  endowWorld(state, {
    id: "w-lyra-ore",
    name: "Копи Лиры",
    specialty: "руда",
    x: 820,
    y: 700,
    ownerId: lyra.id,
    population: 180,
    popMoneyPerCapita: 4,
    stock: { ore: 30, food: 20, parts: 4 },
    deposits: { ore: 400000 },
    tariffBps: 200,
  });
  endowWorld(state, {
    id: "w-bay",
    name: "Тихая Бухта",
    specialty: "свободный мир",
    x: 360,
    y: 660,
    ownerId: null,
    population: 0,
    popMoneyPerCapita: 0,
    tariffBps: 0,
    satisfaction: 40,
  });
  endowWorld(state, {
    id: "w-atoll",
    name: "Серый Атолл",
    specialty: "свободный мир",
    x: 560,
    y: 700,
    ownerId: null,
    population: 0,
    popMoneyPerCapita: 0,
    tariffBps: 0,
    satisfaction: 40,
  });
  endowWorld(state, {
    id: "w-pier",
    name: "Дальний Причал",
    specialty: "свободный мир",
    x: 760,
    y: 560,
    ownerId: null,
    population: 0,
    popMoneyPerCapita: 0,
    tariffBps: 0,
    satisfaction: 40,
  });
  endowWorld(state, {
    id: "w-beacon",
    name: "Обходной Маяк",
    specialty: "свободный фарватер",
    x: 180,
    y: 40,
    ownerId: null,
    population: 0,
    popMoneyPerCapita: 0,
    tariffBps: 0,
    satisfaction: 40,
  });
  endowWorld(state, {
    id: "w-north",
    name: "Северный Предел",
    specialty: "свободный фарватер",
    x: 560,
    y: 40,
    ownerId: null,
    population: 0,
    popMoneyPerCapita: 0,
    tariffBps: 0,
    satisfaction: 40,
  });

  solar.capitalId = harbor.id;
  vega.capitalId = vegaPrime.id;
  orion.capitalId = oriHome.id;
  lyra.capitalId = lyraPort.id;

  placeBuilding(state, bread, solar.id, "farm");
  placeBuilding(state, bread, solar.id, "farm");
  placeBuilding(state, bread, solar.id, "mill");
  placeBuilding(state, harbor, solar.id, "smelter");
  placeBuilding(state, harbor, solar.id, "workshop");
  placeBuilding(state, ore, solar.id, "mine");
  placeBuilding(state, fuel, solar.id, "fuelwell");
  placeBuilding(state, vegaPrime, vega.id, "workshop");
  placeBuilding(state, vegaPrime, vega.id, "mill");
  placeBuilding(state, state.worlds.find((world) => world.id === "w-vega-mine")!, vega.id, "mine");
  placeBuilding(state, oriHome, orion.id, "workshop");
  placeBuilding(state, oriField, orion.id, "farm");
  placeBuilding(state, oriField, orion.id, "mill");
  placeBuilding(state, lyraPort, lyra.id, "workshop");
  placeBuilding(state, state.worlds.find((world) => world.id === "w-lyra-ore")!, lyra.id, "mine");

  placeShip(state, solar.id, bread, "freighter", 60);
  placeShip(state, solar.id, harbor, "freighter", 60);
  placeShip(state, solar.id, fuel, "skiff", 20);
  placeShip(state, vega.id, vegaPrime, "freighter", 60);
  placeShip(state, vega.id, gate, "skiff", 20);
  placeShip(state, orion.id, oriHome, "freighter", 50);
  placeShip(state, lyra.id, lyraPort, "freighter", 50);

  placeFamily(state, solar, harbor, 56, true);
  placeFamily(state, vega, vegaPrime, 58, true);
  placeFamily(state, orion, oriHome, 51, true);
  placeFamily(state, lyra, lyraPort, 49, true);
  const pair = (a: string, b: string) => [a, b].sort().join(":");
  linkRelations(state, { [pair(solar.id, vega.id)]: 8 });
  state.journal.push({
    tick: 0,
    houseId: solar.id,
    text: "Дом Солар принимает сектор. Хлебный Пояс кормит гавань, а короткий путь к Порту Лиры пересекает Заставу Корвус.",
  });
  return state;
}

function createGenerated(seed: number, worldCount: number, houseCount: number): SimState {
  const state = createSkeleton(seed, "generated");
  let rng = normalizeSeed(seed);
  const roll = (max: number) => {
    const next = nextUnit(rng);
    rng = next.state;
    return Math.floor(next.value * max);
  };
  state.rngState = normalizeSeed(seed ^ 0x9e3779b9);
  const houses: House[] = [];
  for (let index = 0; index < houseCount; index += 1) {
    const look = HOUSE_LOOKS[index];
    houses.push(
      endowHouse(state, {
        name: look.name,
        color: look.color,
        crest: look.crest,
        profile: index === 0 ? "player" : look.profile,
        player: index === 0,
        credits: 16000,
      }),
    );
  }
  const specs: Array<{ specialty: string; kind: BuildingKind | null; deposit?: GoodId; stock: Partial<Record<GoodId, number>> }> = [
    { specialty: "поля", kind: "farm", stock: { grain: 80, food: 70, parts: 10 } },
    { specialty: "мельницы", kind: "mill", stock: { grain: 40, food: 50, parts: 8 } },
    { specialty: "рудник", kind: "mine", deposit: "ore", stock: { ore: 30, food: 24, parts: 8 } },
    { specialty: "топливо", kind: "fuelwell", deposit: "fuel", stock: { fuel: 80, food: 20, parts: 6 } },
    { specialty: "мастерские", kind: "workshop", stock: { alloys: 16, parts: 14, food: 24 } },
  ];
  for (let index = 0; index < worldCount; index += 1) {
    const angle = (Math.PI * 2 * index) / worldCount;
    const ring = 180 + (index % 3) * 70;
    const jitter = roll(80) - 40;
    const x = Math.round(640 + Math.cos(angle) * (ring + jitter));
    const y = Math.round(420 + Math.sin(angle) * (ring * 0.72));
    const free = index >= houseCount && index % 5 === 0;
    const owner = free ? null : houses[index % houseCount];
    const spec = specs[index % specs.length];
    const population = free ? 0 : 180 + (index % 4) * 80;
    const world = endowWorld(state, {
      name: generatedName(roll),
      specialty: free ? "свободный мир" : spec.specialty,
      x,
      y,
      ownerId: owner?.id ?? null,
      population,
      popMoneyPerCapita: free ? 0 : 4,
      stock: free ? {} : spec.stock,
      deposits: spec.deposit ? { [spec.deposit]: 400000 } : {},
      tariffBps: free ? 0 : 180,
    });
    if (owner && spec.kind) placeBuilding(state, world, owner.id, spec.kind);
    if (index < houseCount && owner) owner.capitalId = world.id;
  }
  for (const house of houses) {
    const capital = state.worlds.find((world) => world.id === house.capitalId);
    if (!capital) continue;
    if (!capital.buildings.some((building) => building.kind === "farm" || building.kind === "mill")) {
      placeBuilding(state, capital, house.id, "farm");
      placeBuilding(state, capital, house.id, "mill");
      capital.stock.grain += 40;
      capital.stock.food += 40;
      state.accounts.goodsCreated.grain += 40;
      state.accounts.goodsCreated.food += 40;
    }
    placeShip(state, house.id, capital, "freighter", 50);
    placeFamily(state, house, capital, 50 + (houses.indexOf(house) % 5), true);
  }
  linkRelations(state, {});
  return state;
}

const LEFT = ["Ар", "Вел", "Кор", "Нор", "Сол", "Тар", "Эн", "Мир", "Кас", "Ор", "Юн", "Лис"];
const RIGHT = ["вес", "дор", "кан", "мир", "тан", "поль", "рек", "шон", "валь", "гет", "бор", "нис"];

function generatedName(roll: (max: number) => number): string {
  return `${LEFT[roll(LEFT.length)]}${RIGHT[roll(RIGHT.length)]}`;
}
