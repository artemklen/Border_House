import { SHIP_CLASSES } from "./config";
import { GOODS, cloneGoods, emptyGoods, sumGoods, type GoodId, type Goods } from "./goods";
import { canonicalJson, sha256 } from "./hash";
import type { Accounts, AuditReport, Building, House, JournalEntry, Person, Route, Ship, SimState, Treaty, World } from "./types";

export function emptyFlow() {
  return {
    wages: 0,
    taxes: 0,
    sales: 0,
    purchases: 0,
    tariffsIn: 0,
    tariffsOut: 0,
    upkeep: 0,
    construction: 0,
    penalties: 0,
    compensation: 0,
  };
}

export function emptyAccounts(): Accounts {
  return {
    creditsCreated: 0,
    creditsDestroyed: 0,
    goodsCreated: emptyGoods(),
    goodsDestroyed: emptyGoods(),
    transformedIn: emptyGoods(),
    transformedOut: emptyGoods(),
  };
}

export function byId<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function houseOf(state: SimState, id: string): House | undefined {
  return state.houses.find((house) => house.id === id);
}

export function worldOf(state: SimState, id: string | null): World | undefined {
  if (!id) return undefined;
  return state.worlds.find((world) => world.id === id);
}

export function shipOf(state: SimState, id: string): Ship | undefined {
  return state.ships.find((ship) => ship.id === id);
}

export function routeOf(state: SimState, id: string | null): Route | undefined {
  if (!id) return undefined;
  return state.routes.find((route) => route.id === id);
}

export function personOf(state: SimState, id: string | null): Person | undefined {
  if (!id) return undefined;
  return state.people.find((person) => person.id === id);
}

export function buildingOf(state: SimState, id: string): Building | undefined {
  for (const world of state.worlds) {
    const building = world.buildings.find((item) => item.id === id);
    if (building) return building;
  }
  return undefined;
}

export function serial(state: SimState, prefix: string): string {
  state.nextSerial += 1;
  return `${prefix}-${state.nextSerial}`;
}

export function note(state: SimState, houseId: string | null, text: string): void {
  pushLog(state.journal, { tick: state.tick, houseId, text }, 140);
}

export function noteAi(state: SimState, houseId: string, text: string): void {
  pushLog(state.aiLog, { tick: state.tick, houseId, text }, 80);
}

function pushLog(log: JournalEntry[], entry: JournalEntry, limit: number): void {
  log.push(entry);
  if (log.length > limit) log.shift();
}

export function creditOfHouse(state: SimState, houseId: string): number {
  return houseOf(state, houseId)?.credits ?? 0;
}

export function createCredits(state: SimState, holder: { kind: "house"; id: string } | { kind: "pop"; worldId: string }, amount: number): void {
  if (amount <= 0) return;
  if (holder.kind === "house") {
    const house = houseOf(state, holder.id);
    if (!house) return;
    house.credits += amount;
  } else {
    const world = worldOf(state, holder.worldId);
    if (!world) return;
    world.popWallet += amount;
  }
  state.accounts.creditsCreated += amount;
}

export function availableCredits(house: { credits: number; reserved?: number }): number {
  return house.credits - (house.reserved ?? 0);
}

export function moveCredits(
  state: SimState,
  from: { kind: "house"; id: string } | { kind: "pop"; worldId: string },
  to: { kind: "house"; id: string } | { kind: "pop"; worldId: string },
  amount: number,
): boolean {
  if (amount <= 0) return true;
  if (readCredits(state, from) < amount) return false;
  addCredits(state, from, -amount);
  addCredits(state, to, amount);
  return true;
}

export function sinkCredits(state: SimState, from: { kind: "house"; id: string } | { kind: "pop"; worldId: string }, amount: number): boolean {
  if (amount <= 0) return true;
  if (readCredits(state, from) < amount) return false;
  addCredits(state, from, -amount);
  state.accounts.creditsDestroyed += amount;
  return true;
}

function readCredits(state: SimState, holder: { kind: "house"; id: string } | { kind: "pop"; worldId: string }): number {
  if (holder.kind === "house") {
    const house = houseOf(state, holder.id);
    return house ? availableCredits(house) : 0;
  }
  return worldOf(state, holder.worldId)?.popWallet ?? 0;
}

function addCredits(state: SimState, holder: { kind: "house"; id: string } | { kind: "pop"; worldId: string }, amount: number): void {
  if (holder.kind === "house") {
    const house = houseOf(state, holder.id);
    if (house) house.credits += amount;
    return;
  }
  const world = worldOf(state, holder.worldId);
  if (world) world.popWallet += amount;
}

export function createGoods(pile: Goods, accounts: Accounts, good: GoodId, amount: number): void {
  if (amount <= 0) return;
  pile[good] += amount;
  accounts.goodsCreated[good] += amount;
}

export function destroyGoods(pile: Goods, accounts: Accounts, good: GoodId, amount: number): boolean {
  if (amount <= 0) return true;
  if (pile[good] < amount) return false;
  pile[good] -= amount;
  accounts.goodsDestroyed[good] += amount;
  return true;
}

export function transformGoods(pile: Goods, accounts: Accounts, inputs: Partial<Record<GoodId, number>>, outputs: Partial<Record<GoodId, number>>): boolean {
  for (const good of GOODS) {
    const need = inputs[good] ?? 0;
    if (pile[good] < need) return false;
  }
  for (const good of GOODS) {
    const need = inputs[good] ?? 0;
    if (need > 0) {
      pile[good] -= need;
      accounts.transformedIn[good] += need;
    }
  }
  for (const good of GOODS) {
    const made = outputs[good] ?? 0;
    if (made > 0) {
      pile[good] += made;
      accounts.transformedOut[good] += made;
    }
  }
  return true;
}

export function rememberSupply(ship: Ship, good: GoodId, houseId: string, qty: number): void {
  if (qty <= 0 || !houseId) return;
  const book = ship.supplyFrom[good] ?? {};
  book[houseId] = (book[houseId] ?? 0) + qty;
  ship.supplyFrom[good] = book;
}

export function drawSupply(ship: Ship, good: GoodId, qty: number): Array<{ houseId: string; qty: number }> {
  const book = ship.supplyFrom[good] ?? {};
  const slices: Array<{ houseId: string; qty: number }> = [];
  let left = qty;
  for (const houseId of Object.keys(book).sort()) {
    if (left <= 0) break;
    const have = book[houseId] ?? 0;
    const take = Math.min(have, left);
    if (take <= 0) continue;
    book[houseId] = have - take;
    if (book[houseId] <= 0) delete book[houseId];
    slices.push({ houseId, qty: take });
    left -= take;
  }
  ship.supplyFrom[good] = book;
  return slices;
}

export function moveGoods(from: Goods, to: Goods, good: GoodId, amount: number): boolean {
  if (amount <= 0) return true;
  if (from[good] < amount) return false;
  from[good] -= amount;
  to[good] += amount;
  return true;
}

export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(1, Math.round(Math.hypot(a.x - b.x, a.y - b.y)));
}

export function segmentHitsCircle(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  radius: number,
): boolean {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const ab2 = abx * abx + aby * aby;
  const t = ab2 === 0 ? 0 : Math.max(0, Math.min(1, ((c.x - a.x) * abx + (c.y - a.y) * aby) / ab2));
  const dx = a.x + abx * t - c.x;
  const dy = a.y + aby * t - c.y;
  return dx * dx + dy * dy <= radius * radius;
}

export function cargoValue(cargo: Goods, prices: Goods): number {
  let total = 0;
  for (const good of GOODS) total += cargo[good] * prices[good];
  return total;
}

export function foodNeed(population: number, foodPer100: number): number {
  return Math.floor((population * foodPer100) / 100);
}

/** Дневная пайка с переносом остатка: 70 жителей при норме 1 на 100 едят не каждый день, но не остаются вечно сытыми на бумаге. */
export function takeFoodRation(population: number, foodPer100: number, credit: number): { need: number; credit: number } {
  const pending = population * foodPer100 + Math.max(0, credit);
  if (pending <= 0) return { need: 0, credit: 0 };
  return { need: Math.floor(pending / 100), credit: pending % 100 };
}

export function foodCover(population: number, food: number, foodPer100: number): number {
  const perDay = population * foodPer100;
  if (population <= 0 || perDay <= 0) return 999;
  if (food <= 0) return 0;
  return Math.floor((food * 100) / perDay);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function shiftRelation(state: SimState, aId: string, bId: string, delta: number): void {
  const a = houseOf(state, aId);
  const b = houseOf(state, bId);
  if (!a || !b || aId === bId) return;
  a.relation[bId] = clamp((a.relation[bId] ?? 0) + delta, -100, 100);
  b.relation[aId] = clamp((b.relation[aId] ?? 0) + delta, -100, 100);
}

export function pairRelation(state: SimState, aId: string, bId: string): number {
  return houseOf(state, aId)?.relation[bId] ?? 0;
}

export function audit(state: SimState): AuditReport {
  const errors: string[] = [];
  let credits = 0;
  for (const house of state.houses) {
    if (house.credits < 0) errors.push(`отрицательная казна ${house.id}`);
    if (!Number.isInteger(house.credits)) errors.push(`дробные деньги ${house.id}`);
    if (!Number.isInteger(house.reserved) || house.reserved < 0 || house.reserved > house.credits) {
      errors.push(`резерв казны ${house.id} вышел за деньги дома`);
    }
    credits += house.credits;
  }
  const goods = emptyGoods();
  for (const world of state.worlds) {
    if (world.popWallet < 0) errors.push(`отрицательный кошелёк населения ${world.id}`);
    if (!Number.isInteger(world.popWallet)) errors.push(`дробные деньги населения ${world.id}`);
    credits += world.popWallet;
    if (world.population < 0) errors.push(`отрицательное население ${world.id}`);
    const stored = sumGoods(world.stock);
    if (stored > world.capacity) errors.push(`склад переполнен ${world.id}: ${stored}/${world.capacity}`);
    for (const good of GOODS) {
      if (world.stock[good] < 0) errors.push(`отрицательный запас ${good} на ${world.id}`);
      if (!Number.isInteger(world.stock[good])) errors.push(`дробный товар ${good} на ${world.id}`);
      goods[good] += world.stock[good];
    }
  }
  for (const ship of state.ships) {
    const shipClassCap = shipCapacity(state, ship);
    const loaded = sumGoods(ship.cargo);
    if (loaded > shipClassCap) errors.push(`трюм переполнен ${ship.id}: ${loaded}/${shipClassCap}`);
    for (const good of GOODS) {
      if (ship.cargo[good] < 0) errors.push(`отрицательный груз ${good} на ${ship.id}`);
      goods[good] += ship.cargo[good];
    }
  }
  const expectedCredits = state.accounts.creditsCreated - state.accounts.creditsDestroyed;
  if (credits !== expectedCredits) {
    errors.push(`деньги: есть ${credits}, ожидалось ${expectedCredits}`);
  }
  for (const good of GOODS) {
    const expected =
      state.accounts.goodsCreated[good] +
      state.accounts.transformedOut[good] -
      state.accounts.goodsDestroyed[good] -
      state.accounts.transformedIn[good];
    if (goods[good] !== expected) errors.push(`${good}: есть ${goods[good]}, ожидалось ${expected}`);
  }
  return { ok: errors.length === 0, errors, credits, goods };
}

function shipCapacity(_state: SimState, ship: Ship): number {
  return SHIP_CLASSES[ship.classId].capacity;
}

export function hashState(state: SimState): string {
  return sha256(canonicalJson(state));
}

export function cloneImported(source: Record<string, Goods>): Record<string, Goods> {
  const copy: Record<string, Goods> = {};
  for (const [id, goods] of Object.entries(source)) copy[id] = cloneGoods(goods);
  return copy;
}

export function rememberTrade(buyer: House, seller: House, amount: number): void {
  buyer.tradeWith[seller.id] = (buyer.tradeWith[seller.id] ?? 0) + amount;
  seller.tradeWith[buyer.id] = (seller.tradeWith[buyer.id] ?? 0) + amount;
}

export function activeTreaty(state: SimState, aId: string, bId: string, kinds: Treaty["kind"][]): Treaty | undefined {
  return state.treaties.find(
    (treaty) =>
      treaty.status === "active" &&
      kinds.includes(treaty.kind) &&
      ((treaty.proposerId === aId && treaty.targetId === bId) || (treaty.proposerId === bId && treaty.targetId === aId)),
  );
}

export function tariffBetween(state: SimState, travelerId: string, ownerId: string, worldTariff: number, worldId?: string): number {
  const deal = state.treaties.find(
    (treaty) =>
      treaty.status === "active" &&
      (treaty.kind === "transit" || treaty.kind === "exchange") &&
      treaty.proposerId === travelerId &&
      treaty.targetId === ownerId,
  );
  const base = deal ? deal.tariffBps : worldTariff;
  const grants = worldId
    ? state.tariffGrants.filter(
        (item) => item.worldId === worldId && item.ownerId === ownerId && item.beneficiaryId === travelerId && item.untilTick > state.tick,
      )
    : [];
  return grants.reduce((rate, grant) => Math.min(rate, grant.bps), base);
}

export function accessDenied(state: SimState, travelerId: string, world: World): boolean {
  if (!world.ownerId || world.ownerId === travelerId) return false;
  return houseOf(state, world.ownerId)?.embargo[travelerId] === true;
}
