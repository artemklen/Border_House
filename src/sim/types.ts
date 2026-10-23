import type { GoodId, Goods } from "./goods";

export type BuildingKind = "farm" | "mill" | "mine" | "smelter" | "workshop" | "fuelwell";
export type ShipClassId = "skiff" | "freighter" | "barge";
export type AiProfile = "player" | "merchant" | "industrial" | "expansionist";
export type TreatyKind = "transit" | "supply" | "exchange";
export type ShipStatus = "docked" | "transit" | "blocked" | "building";
export type PersonRole = "head" | "heir" | "spouse" | "kin" | "governor";

export interface GameRules {
  ticksPerYear: number;
  foodPer100: number;
  wage: number;
  taxPer100: number;
  territoryRadius: number;
  colonizeFood: number;
  colonizeParts: number;
  colonizeCost: number;
  colonizePop: number;
  aiInterval: number;
  window: number;
  stockCapacity: number;
  deathStartAge: number;
  deathCertainAge: number;
  basePrice: Record<GoodId, number>;
}

export interface Recipe {
  kind: BuildingKind;
  name: string;
  workers: number;
  credits: number;
  parts: number;
  days: number;
  upkeep: number;
  inputs: Partial<Record<GoodId, number>>;
  outputs: Partial<Record<GoodId, number>>;
  renewable: boolean;
  deposit: GoodId | null;
}

export interface ShipClass {
  id: ShipClassId;
  name: string;
  capacity: number;
  speed: number;
  fuelPer1000: number;
  upkeep: number;
  credits: number;
  parts: number;
  days: number;
}

export interface Flow {
  wages: number;
  taxes: number;
  sales: number;
  purchases: number;
  tariffsIn: number;
  tariffsOut: number;
  upkeep: number;
  construction: number;
}

export interface House {
  id: string;
  name: string;
  color: string;
  crest: string;
  player: boolean;
  profile: AiProfile;
  credits: number;
  capitalId: string;
  flow: Flow;
  lastFlow: Flow;
  flowDays: number;
  relation: Record<string, number>;
  embargo: Record<string, boolean>;
  tradeWith: Record<string, number>;
  lastTradeWith: Record<string, number>;
}

export interface Building {
  id: string;
  kind: BuildingKind;
  worldId: string;
  ownerId: string;
  remainingDays: number;
  enabled: boolean;
  stopReason: string | null;
  workers: number;
}

export interface World {
  id: string;
  name: string;
  specialty: string;
  x: number;
  y: number;
  ownerId: string | null;
  population: number;
  popWallet: number;
  satisfaction: number;
  stock: Goods;
  capacity: number;
  prices: Goods;
  demand: Goods;
  lastDemand: Goods;
  deposits: Goods;
  tariffBps: number;
  buildings: Building[];
  governorId: string | null;
  imported: Record<string, Goods>;
  produced: Goods;
  eaten: number;
  /** Остаток спроса на еду, меньший одной единицы. Копится, чтобы малое население всё же ело. */
  foodCredit: number;
  lastImported: Record<string, Goods>;
  lastProduced: Goods;
  lastEaten: number;
  windowDays: number;
}

export interface StopAction {
  good: GoodId;
  mode: "load" | "unload" | "buy" | "sell";
  amount: number;
  price: number;
  keep: number;
}

export interface RouteStop {
  worldId: string;
  actions: StopAction[];
}

export interface Route {
  id: string;
  houseId: string;
  name: string;
  stops: RouteStop[];
  paused: boolean;
  revenue: number;
  cost: number;
  fuelUsed: number;
  lastRevenue: number;
  lastCost: number;
  lastFuelUsed: number;
  /** Маршрут ИИ сам добирает топливо на круг и не отдаёт это место под еду. */
  autoFuel?: boolean;
  pausedFood?: RouteStop["actions"];
  /** После заправки вернуть корабль на этот маршрут. */
  returnRouteId?: string;
}

export interface Ship {
  id: string;
  name: string;
  houseId: string;
  classId: ShipClassId;
  cargo: Goods;
  status: ShipStatus;
  worldId: string | null;
  fromId: string | null;
  toId: string | null;
  legDistance: number;
  distanceLeft: number;
  routeId: string | null;
  stopIndex: number;
  stopReason: string | null;
  /** Мир, за текущий заход в который пошлина уже уплачена или не требуется. */
  tollWorldId: string | null;
  remainingDays: number;
  mission: { type: "colonize"; worldId: string } | null;
  traveled: number;
  /** Сколько единиц каждого товара пришло от каждого дома. Выгрузка делит учёт по этим долям. */
  supplyFrom: Partial<Record<GoodId, Record<string, number>>>;
  /** Ключ текущего захода в порт. Сбрасывается при смене мира или маршрута. */
  visitKey: string;
  /** Сколько уже проведено по каждому действию этой стоянки. Повтор тика не исполняет то же правило снова. */
  visitMoved: number[];
}

export interface Treaty {
  id: string;
  kind: TreatyKind;
  proposerId: string;
  targetId: string;
  status: "proposed" | "active" | "broken" | "rejected" | "expired";
  startTick: number;
  endTick: number;
  duration: number;
  tariffBps: number;
  good: GoodId;
  qtyPerWindow: number;
  delivered: number;
  windowDays: number;
  note: string;
}

export interface Person {
  id: string;
  houseId: string;
  name: string;
  role: PersonRole;
  ageDays: number;
  alive: boolean;
  traits: string[];
  loyalty: number;
  parentId: string | null;
  spouseId: string | null;
  worldId: string | null;
}

export interface JournalEntry {
  tick: number;
  houseId: string | null;
  text: string;
}

export interface Accounts {
  creditsCreated: number;
  creditsDestroyed: number;
  goodsCreated: Goods;
  goodsDestroyed: Goods;
  transformedIn: Goods;
  transformedOut: Goods;
}

export interface SimState {
  version: 1;
  seed: number;
  scenario: string;
  tick: number;
  rngState: number;
  nextSerial: number;
  rules: GameRules;
  aiEnabled: boolean;
  houses: House[];
  worlds: World[];
  ships: Ship[];
  routes: Route[];
  treaties: Treaty[];
  people: Person[];
  journal: JournalEntry[];
  aiLog: JournalEntry[];
  accounts: Accounts;
}

export type Command =
  | { type: "build"; houseId: string; worldId: string; kind: BuildingKind }
  | { type: "toggleBuilding"; houseId: string; buildingId: string; enabled: boolean }
  | { type: "buildShip"; houseId: string; worldId: string; classId: ShipClassId }
  | { type: "createRoute"; houseId: string; name: string; stops: RouteStop[]; shipId?: string; autoFuel?: boolean; returnRouteId?: string }
  | { type: "updateRoute"; routeId: string; name: string; stops: RouteStop[] }
  | { type: "pauseRoute"; routeId: string; paused: boolean }
  | { type: "assignShip"; shipId: string; routeId: string | null }
  | { type: "setTariff"; houseId: string; worldId: string; tariffBps: number }
  | { type: "setEmbargo"; houseId: string; otherId: string; embargo: boolean }
  | {
      type: "proposeTreaty";
      houseId: string;
      otherId: string;
      kind: TreatyKind;
      tariffBps: number;
      good: GoodId;
      qtyPerWindow: number;
      duration: number;
    }
  | { type: "respondTreaty"; houseId: string; treatyId: string; accept: boolean }
  | { type: "colonize"; houseId: string; shipId: string; worldId: string }
  | { type: "appointGovernor"; houseId: string; worldId: string; personId: string };

export interface CommandResult {
  ok: boolean;
  reason: string;
}

export interface AuditReport {
  ok: boolean;
  errors: string[];
  credits: number;
  goods: Goods;
}
