import { SHIP_CLASSES } from "./config";
import { GOOD_NAME, type GoodId } from "./goods";
import { availableCredits, distance, houseOf, note, serial, shiftRelation, worldOf } from "./mutate";
import type { CommandResult, Contract, Ship, SimState } from "./types";

export const CONTRACT_PAIR_LIMIT = 3;

const STATUSES = ["proposed", "active", "completed", "broken", "cancelled", "rejected"] as const;

export function contractPairCount(state: SimState, aId: string, bId: string): number {
  return state.contracts.filter((contract) => {
    if (contract.status !== "proposed" && contract.status !== "active") return false;
    return (contract.sellerId === aId && contract.buyerId === bId) || (contract.sellerId === bId && contract.buyerId === aId);
  }).length;
}

export interface PlannedSale {
  qty: number;
  marketUnits: number;
  contractUnits: number;
  takes: Array<{ contractId: string; units: number }>;
  blocked: "price" | "money" | "none";
}

/** Считает, сколько единиц реально оплачивается в порядке списания происхождения. Неоплаченный префикс останавливает продажу. */
export function planSale(
  state: SimState,
  ship: Ship,
  buyerId: string,
  worldId: string,
  good: GoodId,
  limit: number,
  spotPrice: number,
  floorPrice: number,
): PlannedSale {
  const empty: PlannedSale = { qty: 0, marketUnits: 0, contractUnits: 0, takes: [], blocked: "none" };
  if (limit <= 0 || spotPrice <= 0) return empty;
  const buyer = houseOf(state, buyerId);
  let marketBudget = buyer ? Math.floor(availableCredits(buyer) / spotPrice) : 0;
  const reserved = new Map<string, number>();
  const takes: Array<{ contractId: string; units: number }> = [];
  let marketUnits = 0;
  let contractUnits = 0;
  for (const origin of supplyOrder(ship, good, limit, ship.houseId)) {
    const contract = origin === buyerId ? undefined : nextContract(state, ship.houseId, buyerId, worldId, good, floorPrice, reserved);
    if (contract) {
      const row = takes.find((item) => item.contractId === contract.id);
      if (row) row.units += 1;
      else takes.push({ contractId: contract.id, units: 1 });
      reserved.set(contract.id, (reserved.get(contract.id) ?? 0) + 1);
      contractUnits += 1;
      continue;
    }
    if (spotPrice >= floorPrice && marketBudget > 0) {
      marketUnits += 1;
      marketBudget -= 1;
      continue;
    }
    break;
  }
  const qty = marketUnits + contractUnits;
  const blocked = qty > 0 ? "none" : spotPrice < floorPrice ? "price" : "money";
  return { qty, marketUnits, contractUnits, takes, blocked };
}

export function payContractTakes(state: SimState, good: GoodId, takes: Array<{ contractId: string; units: number }>): number {
  let total = 0;
  for (const take of takes) {
    const contract = state.contracts.find((item) => item.id === take.contractId);
    const buyer = contract ? houseOf(state, contract.buyerId) : undefined;
    const seller = contract ? houseOf(state, contract.sellerId) : undefined;
    if (!contract || !buyer || !seller || take.units <= 0) continue;
    const affordable = Math.floor(Math.min(contract.buyerReserve, buyer.reserved, buyer.credits) / contract.price);
    const units = Math.min(take.units, contract.qtyPerWindow - contract.delivered, affordable);
    if (units <= 0) continue;
    const money = units * contract.price;
    buyer.credits -= money;
    buyer.reserved -= money;
    buyer.flow.purchases += money;
    contract.buyerReserve -= money;
    seller.credits += money;
    seller.flow.sales += money;
    contract.delivered += units;
    contract.paidWindow += money;
    contract.trades.push({ tick: state.tick, qty: units, price: contract.price });
    if (contract.trades.length > 8) contract.trades.shift();
    note(state, buyer.id, `Контракт ${contract.id}: принято ${units} ${GOOD_NAME[good]} по ${contract.price} кред. Оплачено ${money} из резерва, не по сегодняшней рыночной цене.`);
    total += money;
  }
  return total;
}

export function settleContractWindows(state: SimState): void {
  for (const contract of state.contracts) {
    if (contract.status !== "active") continue;
    contract.windowDays += 1;
    if (contract.windowDays < state.rules.window) continue;
    closeContractWindow(state, contract);
  }
}

export function proposeContract(
  state: SimState,
  sellerId: string,
  buyerId: string,
  good: GoodId,
  worldId: string,
  qtyPerWindow: number,
  windows: number,
  price: number,
  shortfall: number,
  deposit: number,
): CommandResult {
  const seller = houseOf(state, sellerId);
  const buyer = houseOf(state, buyerId);
  const world = worldOf(state, worldId);
  if (!seller || !buyer || seller.id === buyer.id) return fail("контракт заключается между двумя домами");
  if (!world || world.ownerId !== buyer.id) return fail("принимают поставку только в мире покупателя");
  if (!GOOD_NAME[good]) return fail("нет такого товара");
  if (!Number.isInteger(qtyPerWindow) || qtyPerWindow < 1 || qtyPerWindow > 500) return fail("объём окна — целое число от 1 до 500");
  if (!Number.isInteger(windows) || windows < 2 || windows > 6) return fail("срок контракта — от 2 до 6 окон");
  if (!Number.isInteger(price) || price < 1 || price > 10000) return fail("цена — целое число кредитов за единицу");
  if (!Number.isInteger(shortfall) || shortfall < 0 || shortfall > qtyPerWindow) return fail("допустимый недовоз не больше объёма окна");
  const stake = qtyPerWindow * price;
  if (!Number.isInteger(deposit) || deposit < 1 || deposit > stake) return fail("залог — от 1 кредита до стоимости одного окна");
  if (seller.embargo[buyer.id] || buyer.embargo[seller.id]) return fail("эмбарго закрывает коммерческий контракт");
  if (contractPairCount(state, seller.id, buyer.id) >= CONTRACT_PAIR_LIMIT) {
    return fail(`у пары домов уже ${CONTRACT_PAIR_LIMIT} коммерческих контракта; дипломатический договор сюда не входит`);
  }
  if (availableCredits(seller) < deposit) return fail(`для залога нужно ${deposit} свободных кредитов, доступно ${availableCredits(seller)}`);
  seller.reserved += deposit;
  const contract: Contract = {
    id: serial(state, "k"),
    sellerId: seller.id,
    buyerId: buyer.id,
    good,
    worldId: world.id,
    qtyPerWindow,
    windows,
    price,
    shortfall,
    deposit,
    buyerReserve: 0,
    delivered: 0,
    paidWindow: 0,
    windowIndex: 0,
    windowDays: 0,
    status: "proposed",
    note: `${seller.name} предлагает ${buyer.name} поставлять ${qtyPerWindow} ${GOOD_NAME[good]} в «${world.name}» по ${price} кред. за ${windows} окон. Залог ${deposit}. Допустимый недовоз ${shortfall}.`,
    history: [],
    trades: [],
  };
  state.contracts.push(contract);
  note(state, seller.id, contract.note);
  return { ok: true, reason: "предложение записано, залог зарезервирован" };
}

export function respondContract(state: SimState, houseId: string, contractId: string, accept: boolean): CommandResult {
  const contract = state.contracts.find((item) => item.id === contractId);
  const house = houseOf(state, houseId);
  if (!contract || !house) return fail("нет такого контракта");
  if (contract.status !== "proposed") return fail("это предложение уже разобрано");
  if (contract.buyerId !== house.id) return fail("принимает контракт покупатель");
  if (!accept) {
    releaseDeposit(state, contract);
    contract.status = "rejected";
    contract.note = `${house.name} отклонил контракт. Залог возвращён продавцу, деньги не создавались.`;
    note(state, house.id, contract.note);
    return { ok: true, reason: "отклонено" };
  }
  const decision = judgeContract(state, contract);
  if (!decision.accept) return fail(decision.reason);
  const buyer = houseOf(state, contract.buyerId)!;
  const need = contract.qtyPerWindow * contract.price;
  buyer.reserved += need;
  contract.buyerReserve = need;
  contract.status = "active";
  contract.windowIndex = 0;
  contract.windowDays = 0;
  contract.note = `${buyer.name} принял поставку. На ближайшее окно зарезервировано ${need} кред. Это оценка обязательства, не обещание прибыли.`;
  note(state, buyer.id, contract.note);
  return { ok: true, reason: "принято" };
}

export function cancelContract(state: SimState, houseId: string, contractId: string): CommandResult {
  const contract = state.contracts.find((item) => item.id === contractId);
  const house = houseOf(state, houseId);
  if (!contract || !house) return fail("нет такого контракта");
  if (house.id !== contract.sellerId && house.id !== contract.buyerId) return fail("отменяет сторона контракта");
  if (contract.status === "proposed") {
    releaseDeposit(state, contract);
    contract.status = "cancelled";
    contract.note = "Предложение снято до принятия. Залог возвращён, потерь нет.";
    note(state, house.id, contract.note);
    return { ok: true, reason: "снято" };
  }
  if (contract.status !== "active") return fail("этот контракт уже закрыт");
  const sellerCancels = house.id === contract.sellerId;
  const loss = sellerCancels ? Math.floor(contract.deposit / 2) : Math.floor(contract.buyerReserve / 2);
  if (sellerCancels) payDeposit(state, contract, loss);
  else payReserve(state, contract, loss);
  const returnedDeposit = contract.deposit;
  const returnedReserve = contract.buyerReserve;
  releaseDeposit(state, contract);
  releaseBuyer(state, contract);
  contract.status = "cancelled";
  contract.note = sellerCancels
    ? `${house.name} отменил контракт со своей стороны. Покупатель получил ${loss} кред. из залога, продавцу возвращено ${returnedDeposit}. Резерв покупателя освобождён.`
    : `${house.name} отменил контракт со своей стороны. Продавец получил ${loss} кред. из резерва покупателя, покупателю возвращено ${returnedReserve}. Залог продавца возвращён целиком.`;
  note(state, house.id, contract.note);
  shiftRelation(state, contract.sellerId, contract.buyerId, -6);
  return { ok: true, reason: contract.note };
}

export function judgeContract(state: SimState, contract: Contract): { accept: boolean; reason: string } {
  const buyer = houseOf(state, contract.buyerId);
  const seller = houseOf(state, contract.sellerId);
  const world = worldOf(state, contract.worldId);
  if (!buyer || !seller || !world || world.ownerId !== buyer.id) return { accept: false, reason: "мир назначения больше не принадлежит покупателю" };
  const need = contract.qtyPerWindow * contract.price;
  if (availableCredits(buyer) < need) return { accept: false, reason: `нет свободных денег на резерв окна: нужно ${need}, доступно ${availableCredits(buyer)}` };
  if (contract.deposit < 1 || seller.reserved < contract.deposit) return { accept: false, reason: "залог продавца не удержан" };
  const market = world.prices[contract.good];
  if (contract.price > market) return { accept: false, reason: `цена ${contract.price} выше рыночной ${market}: сделка убыточна` };
  const ship = state.ships.some((item) => item.houseId === seller.id && item.status !== "building");
  if (!ship) return { accept: false, reason: "у продавца нет готового корабля, поставка невыполнима" };
  if (world.stock[contract.good] >= contract.qtyPerWindow * 2) {
    return { accept: false, reason: `на складе уже ${world.stock[contract.good]} ${GOOD_NAME[contract.good]}, контракт не нужен` };
  }
  return { accept: true, reason: `цена ${contract.price} не выше рынка ${market}, резерв ${need} кред. свободен, у продавца есть корабль` };
}

export interface ContractEstimate {
  revenue: number;
  voyageDays: number;
  trips: number;
  capacity: number;
  fuelCost: number;
  collateral: number;
  assumptions: string[];
}

export function contractEstimate(
  state: SimState,
  sellerId: string,
  buyerId: string,
  good: GoodId,
  worldId: string,
  qtyPerWindow: number,
  windows: number,
  price: number,
  deposit: number,
): ContractEstimate {
  const seller = houseOf(state, sellerId);
  const world = worldOf(state, worldId);
  const origin = seller ? worldOf(state, seller.capitalId) : undefined;
  const ship = state.ships.find((item) => item.houseId === sellerId && item.status !== "building");
  const shipClass = SHIP_CLASSES[ship?.classId ?? "freighter"];
  const voyage = origin && world ? Math.max(1, Math.ceil(distance(origin, world) / shipClass.speed)) : 0;
  const capacity = shipClass.capacity;
  const trips = qtyPerWindow > 0 ? Math.ceil(qtyPerWindow / Math.max(1, capacity)) : 0;
  const fuelUnits = origin && world ? Math.max(1, Math.ceil((distance(origin, world) * shipClass.fuelPer1000) / 1000)) : 0;
  const fuelPrice = world?.prices.fuel ?? state.rules.basePrice.fuel;
  const revenue = qtyPerWindow * price * windows;
  const buyer = houseOf(state, buyerId);
  return {
    revenue,
    voyageDays: voyage,
    trips,
    capacity,
    fuelCost: fuelUnits * trips * windows * fuelPrice,
    collateral: deposit,
    assumptions: [
      "Это оценка, не гарантия прибыли.",
      `Выручка за «${GOOD_NAME[good]}» считается как объём × цена × окна: ${qtyPerWindow} × ${price} × ${windows}.`,
      origin && world ? `Путь взят от столицы продавца до «${world.name}», скорость ${shipClass.name}.` : "Столица или мир назначения неизвестны, срок пути не посчитан.",
      `Рейсов на окно ${trips} при вместимости ${capacity}. Топливо оценено по текущей цене ${fuelPrice} и не включает пошлины.`,
      `Покупатель резервирует ${qtyPerWindow * price} кред. на ближайшее окно. Сейчас свободно ${buyer ? availableCredits(buyer) : 0}.`,
      "Оплата идёт только за принятый чужой груз. Недовоз сверх допуска берётся из залога.",
    ],
  };
}

export function contractRisks(state: SimState, contract: Contract): string[] {
  const risks: string[] = [];
  const sellerRoutes = state.routes.some((route) => route.houseId === contract.sellerId && !route.paused && route.stops.some((stop) => stop.worldId === contract.worldId && stop.actions.some((action) => action.mode === "sell" && action.good === contract.good)));
  if (contract.status === "active" && !sellerRoutes) risks.push("нет действующего маршрута продажи этого товара в мир контракта");
  const left = contract.qtyPerWindow - contract.delivered;
  if (contract.status === "active" && contract.buyerReserve < left * contract.price) risks.push("резерв окна не покрывает оставшийся объём");
  if (contract.status === "active" && contract.windowDays > state.rules.window * 0.75 && contract.delivered + contract.shortfall < contract.qtyPerWindow) {
    risks.push("окно почти закрыто, а объём с допуском ещё не набран");
  }
  if ((contract.status === "proposed" || contract.status === "active") && contract.deposit < contract.price) {
    risks.push("залог меньше цены одной единицы: следующий недовоз закроет контракт");
  }
  if (risks.length === 0 && contract.status === "active") risks.push("явной причины срыва по текущим данным нет");
  return risks;
}

export function isContractStatus(value: unknown): value is Contract["status"] {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

function supplyOrder(ship: Ship, good: GoodId, limit: number, sellerId: string): string[] {
  const book = ship.supplyFrom?.[good] ?? {};
  const keys = Object.keys(book).sort();
  const origins: string[] = [];
  let left = limit;
  if (keys.length === 0) {
    for (let index = 0; index < limit; index += 1) origins.push(sellerId);
    return origins;
  }
  for (const houseId of keys) {
    let have = book[houseId] ?? 0;
    while (have > 0 && left > 0) {
      origins.push(houseId);
      have -= 1;
      left -= 1;
    }
  }
  while (left > 0) {
    origins.push(sellerId);
    left -= 1;
  }
  return origins;
}

function nextContract(
  state: SimState,
  sellerId: string,
  buyerId: string,
  worldId: string,
  good: GoodId,
  floorPrice: number,
  reserved: Map<string, number>,
): Contract | undefined {
  return state.contracts.find((contract) => {
    if (contract.status !== "active" || contract.sellerId !== sellerId || contract.buyerId !== buyerId || contract.worldId !== worldId || contract.good !== good) return false;
    if (contract.price < floorPrice) return false;
    const taken = reserved.get(contract.id) ?? 0;
    const left = contract.qtyPerWindow - contract.delivered - taken;
    const funded = Math.floor((contract.buyerReserve - taken * contract.price) / contract.price);
    return left > 0 && funded > 0;
  });
}

function closeContractWindow(state: SimState, contract: Contract): void {
  const missed = Math.max(0, contract.qtyPerWindow - contract.delivered - contract.shortfall);
  const penalty = Math.min(contract.deposit, missed * contract.price);
  payDeposit(state, contract, penalty);
  contract.history.push({ window: contract.windowIndex, delivered: contract.delivered, paid: contract.paidWindow, penalty });
  if (contract.history.length > 8) contract.history.shift();
  if (missed > 0) shiftRelation(state, contract.sellerId, contract.buyerId, -8);
  else shiftRelation(state, contract.sellerId, contract.buyerId, 3);
  const unfinished = missed > 0 && contract.deposit === 0;
  const last = contract.windowIndex + 1 >= contract.windows;
  if (unfinished || last) {
    const status = unfinished ? "broken" : "completed";
    releaseDeposit(state, contract);
    releaseBuyer(state, contract);
    contract.status = status;
    contract.note = unfinished
      ? `Окно ${contract.windowIndex + 1}: принято ${contract.history.at(-1)?.delivered ?? 0}, штраф ${penalty}. Залог исчерпан, контракт сорван. Казна не ушла в долг.`
      : `Контракт завершён. Последнее окно: принято ${contract.delivered}, штраф ${penalty}. Остаток залога и резерва возвращён.`;
    note(state, contract.buyerId, contract.note);
    return;
  }
  contract.windowIndex += 1;
  contract.windowDays = 0;
  contract.delivered = 0;
  contract.paidWindow = 0;
  const need = contract.qtyPerWindow * contract.price;
  const topUp = Math.max(0, need - contract.buyerReserve);
  const buyer = houseOf(state, contract.buyerId);
  if (!buyer || availableCredits(buyer) < topUp) {
    releaseDeposit(state, contract);
    releaseBuyer(state, contract);
    contract.status = "broken";
    contract.note = `Следующее окно требует ещё ${topUp} свободных кредитов. Их нет, резерв и залог возвращены, долг не открыт.`;
    note(state, contract.buyerId, contract.note);
    return;
  }
  buyer.reserved += topUp;
  contract.buyerReserve += topUp;
  contract.note = `Окно ${contract.windowIndex}: штраф прошлого окна ${penalty}. На новое окно зарезервировано ${contract.buyerReserve} кред.`;
  note(state, contract.buyerId, contract.note);
}

function payDeposit(state: SimState, contract: Contract, amount: number): void {
  const seller = houseOf(state, contract.sellerId);
  const buyer = houseOf(state, contract.buyerId);
  const money = Math.min(amount, contract.deposit, seller?.reserved ?? 0, seller?.credits ?? 0);
  if (!seller || !buyer || money <= 0) return;
  seller.credits -= money;
  seller.reserved -= money;
  seller.flow.penalties += money;
  contract.deposit -= money;
  buyer.credits += money;
  buyer.flow.compensation += money;
}

function payReserve(state: SimState, contract: Contract, amount: number): void {
  const seller = houseOf(state, contract.sellerId);
  const buyer = houseOf(state, contract.buyerId);
  const money = Math.min(amount, contract.buyerReserve, buyer?.reserved ?? 0, buyer?.credits ?? 0);
  if (!seller || !buyer || money <= 0) return;
  buyer.credits -= money;
  buyer.reserved -= money;
  buyer.flow.penalties += money;
  contract.buyerReserve -= money;
  seller.credits += money;
  seller.flow.compensation += money;
}

function releaseDeposit(state: SimState, contract: Contract): void {
  const seller = houseOf(state, contract.sellerId);
  if (seller) seller.reserved = Math.max(0, seller.reserved - contract.deposit);
  contract.deposit = 0;
}

function releaseBuyer(state: SimState, contract: Contract): void {
  const buyer = houseOf(state, contract.buyerId);
  if (buyer) buyer.reserved = Math.max(0, buyer.reserved - contract.buyerReserve);
  contract.buyerReserve = 0;
}

function fail(reason: string): CommandResult {
  return { ok: false, reason };
}
