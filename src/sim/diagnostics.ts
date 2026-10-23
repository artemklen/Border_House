import { createSkeleton, endowHouse, endowWorld, placeBuilding, placeFamily, placeShip } from "./create";
import type { SimState } from "./types";

/** Отдельные партии для проверок. Обычное меню их не подставляет. */

export function createGrainScenario(seed = 7): SimState {
  const state = createSkeleton(seed, "grain");
  state.aiEnabled = false;
  const house = endowHouse(state, { name: "Дом Солар", color: "#e0a84a", crest: "СЛ", profile: "player", player: true, credits: 12000 });
  const field = endowWorld(state, {
    id: "g-field",
    name: "Поле",
    specialty: "зерно",
    x: 0,
    y: 0,
    ownerId: house.id,
    population: 80,
    popMoneyPerCapita: 6,
    stock: { grain: 40, food: 40, fuel: 80, parts: 10 },
  });
  const mill = endowWorld(state, {
    id: "g-mill",
    name: "Мельница",
    specialty: "продовольствие",
    x: 160,
    y: 0,
    ownerId: house.id,
    population: 400,
    popMoneyPerCapita: 6,
    stock: { grain: 12, food: 16, fuel: 20 },
  });
  house.capitalId = mill.id;
  placeBuilding(state, field, house.id, "farm");
  placeBuilding(state, mill, house.id, "mill");
  placeShip(state, house.id, field, "freighter", 50);
  placeFamily(state, house, mill, 40, true);
  return state;
}

export function createLogisticsScenario(seed = 11): SimState {
  const state = createSkeleton(seed, "logistics");
  state.aiEnabled = false;
  const house = endowHouse(state, { name: "Дом Солар", color: "#e0a84a", crest: "СЛ", profile: "player", player: true, credits: 9000 });
  const ore = endowWorld(state, {
    id: "l-ore",
    name: "Копь",
    specialty: "руда",
    x: 0,
    y: 0,
    ownerId: house.id,
    population: 40,
    popMoneyPerCapita: 4,
    stock: { ore: 80, fuel: 40 },
  });
  const dock = endowWorld(state, {
    id: "l-dock",
    name: "Док",
    specialty: "склад",
    x: 180,
    y: 0,
    ownerId: house.id,
    population: 40,
    popMoneyPerCapita: 4,
    stock: { ore: 22 },
  });
  dock.capacity = 30;
  const side = endowWorld(state, {
    id: "l-side",
    name: "Тупик",
    specialty: "обход",
    x: 180,
    y: 200,
    ownerId: house.id,
    population: 20,
    popMoneyPerCapita: 4,
    stock: { fuel: 10 },
  });
  house.capitalId = dock.id;
  placeShip(state, house.id, ore, "freighter", 40);
  placeFamily(state, house, dock, 40, true);
  void side;
  return state;
}

export function createIndustryScenario(seed = 3): SimState {
  const state = createSkeleton(seed, "industry");
  state.aiEnabled = true;
  state.rules.aiInterval = 2;
  const player = endowHouse(state, { name: "Дом Солар", color: "#e0a84a", crest: "СЛ", profile: "player", player: true, credits: 8000 });
  const ai = endowHouse(state, { name: "Дом Орион", color: "#6ea8fe", crest: "ОР", profile: "industrial", player: false, credits: 9000 });
  const mine = endowWorld(state, {
    id: "i-mine",
    name: "Копи",
    specialty: "руда",
    x: 0,
    y: 0,
    ownerId: ai.id,
    population: 80,
    popMoneyPerCapita: 8,
    stock: { ore: 60, food: 80, fuel: 40, parts: 10 },
    deposits: { ore: 200000 },
  });
  const forge = endowWorld(state, {
    id: "i-forge",
    name: "Горн",
    specialty: "сплавы",
    x: 140,
    y: 0,
    ownerId: ai.id,
    population: 80,
    popMoneyPerCapita: 8,
    stock: { ore: 0, food: 80, fuel: 20, alloys: 0, parts: 8 },
  });
  player.capitalId = mine.id;
  ai.capitalId = forge.id;
  placeBuilding(state, mine, ai.id, "mine");
  placeBuilding(state, forge, ai.id, "smelter");
  placeShip(state, ai.id, mine, "freighter", 40);
  placeFamily(state, player, mine, 40, true);
  placeFamily(state, ai, forge, 40, true);
  ai.relation[player.id] = 10;
  player.relation[ai.id] = 10;
  return state;
}

export function createExpansionScenario(seed = 5): SimState {
  const state = createSkeleton(seed, "expansion");
  state.aiEnabled = true;
  state.rules.aiInterval = 1;
  const ai = endowHouse(state, { name: "Дом Лира", color: "#7dcea0", crest: "ЛР", profile: "expansionist", player: false, credits: 12000 });
  const home = endowWorld(state, {
    id: "e-home",
    name: "Верфь",
    specialty: "база",
    x: 0,
    y: 0,
    ownerId: ai.id,
    population: 100,
    popMoneyPerCapita: 5,
    stock: { food: 90, parts: 30, fuel: 80, grain: 20 },
  });
  endowWorld(state, {
    id: "e-free",
    name: "Пустой Берег",
    specialty: "свободный мир",
    x: 120,
    y: 0,
    ownerId: null,
    population: 0,
    popMoneyPerCapita: 0,
    tariffBps: 0,
  });
  ai.capitalId = home.id;
  placeBuilding(state, home, ai.id, "farm");
  placeShip(state, ai.id, home, "freighter", 10);
  placeFamily(state, ai, home, 40, true);
  const watcher = endowHouse(state, { name: "Дом Солар", color: "#e0a84a", crest: "СЛ", profile: "player", player: true, credits: 4000 });
  const post = endowWorld(state, {
    id: "e-watch",
    name: "Наблюдательный Пост",
    specialty: "наблюдение",
    x: 0,
    y: 500,
    ownerId: watcher.id,
    population: 0,
    popMoneyPerCapita: 0,
    tariffBps: 0,
  });
  watcher.capitalId = post.id;
  placeFamily(state, watcher, post, 40, true);
  return state;
}

export function createSuccessionScenario(seed = 9, withHeir = true): SimState {
  const state = createSkeleton(seed, withHeir ? "succession" : "succession-fallback");
  state.aiEnabled = false;
  state.rules.ticksPerYear = 4;
  state.rules.deathCertainAge = 90;
  state.rules.deathStartAge = 90;
  const house = endowHouse(state, { name: "Дом Солар", color: "#e0a84a", crest: "СЛ", profile: "player", player: true, credits: 6000 });
  const world = endowWorld(state, {
    id: "s-world",
    name: "Столица",
    specialty: "дом",
    x: 0,
    y: 0,
    ownerId: house.id,
    population: 100,
    popMoneyPerCapita: 4,
    stock: { food: 80, fuel: 40 },
  });
  const other = endowWorld(state, {
    id: "s-other",
    name: "Дальний",
    specialty: "рейс",
    x: 200,
    y: 0,
    ownerId: house.id,
    population: 40,
    popMoneyPerCapita: 4,
    stock: { food: 20 },
  });
  house.capitalId = world.id;
  placeShip(state, house.id, world, "skiff", 20);
  placeFamily(state, house, world, 89, withHeir);
  if (!withHeir) {
    for (const person of state.people) {
      if (person.role === "heir") person.alive = false;
    }
  }
  const head = state.people.find((person) => person.role === "head");
  if (head) head.ageDays = 89 * state.rules.ticksPerYear;
  void other;
  return state;
}
