import { foodRouteNeedsFuel, planAi, refreshFoodFuel } from "./ai";
import { payContractTakes, planSale, settleContractWindows } from "./contracts";
import { dispatch, dedicatedColonyRoute, foundColony, syncColonyRoute } from "./commands";
import { RECIPES, SHIP_CLASSES } from "./config";
import { GOODS, cloneGoods, emptyGoods, sumGoods, type GoodId } from "./goods";
import {
  accessDenied,
  byId,
  cargoValue,
  cloneImported,
  destroyGoods,
  distance,
  drawSupply,
  rememberSupply,
  emptyFlow,
  takeFoodRation,
  availableCredits,
  houseOf,
  moveCredits,
  moveGoods,
  note,
  personOf,
  rememberTrade,
  routeOf,
  segmentHitsCircle,
  shiftRelation,
  sinkCredits,
  tariffBetween,
  transformGoods,
  worldOf,
} from "./mutate";
import { rollInt } from "./prng";
import type { Building, Person, Recipe, Route, Ship, SimState, World } from "./types";

export function tick(state: SimState): void {
  state.tick += 1;
  for (const world of state.worlds) world.demand = emptyGoods();
  employAndProduce(state);
  feedWorlds(state);
  sail(state);
  updatePrices(state);
  closeTreaties(state);
  driftLoyalty(state);
  inherit(state);
  if (state.aiEnabled && state.rules.aiInterval > 0 && state.tick % state.rules.aiInterval === 0) planAi(state);
  rollAccounts(state);
}

export function runTicks(state: SimState, days: number): void {
  for (let day = 0; day < days; day += 1) tick(state);
}

function employAndProduce(state: SimState): void {
  for (const world of byId(state.worlds)) {
    const laborPool = world.population;
    let laborLeft = laborPool;
    const ready = world.buildings.filter((building) => building.remainingDays <= 0 && building.enabled);
    for (const building of byId(ready)) {
      const recipe = RECIPES[building.kind];
      const needed = requiredWorkers(state, world, recipe);
      const hired = Math.min(needed, laborLeft);
      laborLeft -= hired;
      building.workers = hired;
    }
    for (const building of byId(world.buildings)) {
      if (building.remainingDays > 0) {
        building.remainingDays -= 1;
        building.stopReason = building.remainingDays > 0 ? "строится" : null;
        building.workers = 0;
        if (building.remainingDays === 0) note(state, building.ownerId, `${RECIPES[building.kind].name} на «${world.name}» достроена.`);
        continue;
      }
      if (!building.enabled) {
        building.stopReason = "остановлено владельцем";
        building.workers = 0;
        continue;
      }
      runBuilding(state, world, building);
    }
  }
}

function requiredWorkers(state: SimState, world: World, recipe: Recipe): number {
  let efficiency = 10000;
  const governor = personOf(state, world.governorId);
  if (governor?.alive && governor.traits.includes("рачительный")) efficiency += 1000;
  if (governor?.alive && governor.loyalty < 25) efficiency -= 1000;
  const head = headOf(state, world.ownerId);
  if (head?.traits.includes("распорядитель")) efficiency += 800;
  efficiency = Math.max(7000, Math.min(13000, efficiency));
  return Math.max(1, Math.ceil((recipe.workers * 10000) / efficiency));
}

function runBuilding(state: SimState, world: World, building: Building): void {
  const recipe = RECIPES[building.kind];
  const owner = world.ownerId ? houseOf(state, world.ownerId) : undefined;
  if (!owner) {
    building.stopReason = "мир не принадлежит дому";
    return;
  }
  for (const good of GOODS) world.demand[good] += recipe.inputs[good] ?? 0;
  if (!sinkCredits(state, { kind: "house", id: owner.id }, recipe.upkeep)) {
    building.stopReason = "нет денег на содержание предприятия";
    return;
  }
  owner.flow.upkeep += recipe.upkeep;
  const needed = requiredWorkers(state, world, recipe);
  if (building.workers < needed) {
    const wageBill = building.workers * state.rules.wage;
    if (wageBill > 0 && availableCredits(owner) >= wageBill) {
      moveCredits(state, { kind: "house", id: owner.id }, { kind: "pop", worldId: world.id }, wageBill);
      owner.flow.wages += wageBill;
    }
    building.stopReason = building.workers === 0 ? "нет работников или дом не оплатил смену" : "не хватает персонала для полной партии";
    return;
  }
  const wageBill = building.workers * state.rules.wage;
  if (!moveCredits(state, { kind: "house", id: owner.id }, { kind: "pop", worldId: world.id }, wageBill)) {
    building.stopReason = "дом не оплатил работников";
    return;
  }
  owner.flow.wages += wageBill;
  for (const good of GOODS) {
    const need = recipe.inputs[good] ?? 0;
    if (world.stock[good] < need) {
      building.stopReason = `не хватает: ${goodLabel(good)}`;
      return;
    }
  }
  if (recipe.deposit) {
    const made = recipe.outputs[recipe.deposit] ?? 0;
    if (world.deposits[recipe.deposit] < made) {
      building.stopReason = "месторождение истощено";
      return;
    }
  }
  const net = sumOutputs(recipe) - sumInputs(recipe);
  if (sumGoods(world.stock) + net > world.capacity) {
    building.stopReason = "склад заполнен";
    return;
  }
  const hasInputs = GOODS.some((good) => (recipe.inputs[good] ?? 0) > 0);
  if (hasInputs) transformGoods(world.stock, state.accounts, recipe.inputs, recipe.outputs);
  else {
    for (const good of GOODS) {
      const made = recipe.outputs[good] ?? 0;
      if (made <= 0) continue;
      world.stock[good] += made;
      state.accounts.goodsCreated[good] += made;
      if (recipe.deposit === good) world.deposits[good] -= made;
    }
  }
  for (const good of GOODS) world.produced[good] += recipe.outputs[good] ?? 0;
  building.stopReason = null;
}

function feedWorlds(state: SimState): void {
  for (const world of byId(state.worlds)) {
    const ration = takeFoodRation(world.population, state.rules.foodPer100, world.foodCredit ?? 0);
    world.foodCredit = ration.credit;
    const need = ration.need;
    world.demand.food += need;
    if (!world.ownerId || world.population <= 0) continue;
    const owner = houseOf(state, world.ownerId);
    if (!owner) continue;
    const price = Math.max(1, world.prices.food);
    const affordable = Math.floor(world.popWallet / price);
    const qty = Math.min(need, world.stock.food, affordable);
    if (qty > 0) {
      moveCredits(state, { kind: "pop", worldId: world.id }, { kind: "house", id: owner.id }, qty * price);
      destroyGoods(world.stock, state.accounts, "food", qty);
      owner.flow.sales += qty * price;
      world.eaten += qty;
    }
    const governor = personOf(state, world.governorId);
    if (need > 0) {
      if (qty >= need) world.satisfaction = Math.min(100, world.satisfaction + 2);
      else world.satisfaction = Math.max(0, world.satisfaction - (governor?.traits.includes("запасник") ? 1 : 3));
    }
    let tax = Math.floor((world.population * state.rules.taxPer100) / 100);
    const head = headOf(state, world.ownerId);
    if (head?.traits.includes("казначей")) tax = Math.floor(tax * 1.1);
    tax = Math.min(tax, world.popWallet);
    if (tax > 0) {
      moveCredits(state, { kind: "pop", worldId: world.id }, { kind: "house", id: owner.id }, tax);
      owner.flow.taxes += tax;
    }
  }
}

function sail(state: SimState): void {
  const paidUpkeep = new Set<string>();
  for (const ship of byId(state.ships)) {
    if (ship.status === "building") {
      ship.remainingDays -= 1;
      if (ship.remainingDays <= 0) {
        ship.status = "docked";
        ship.stopReason = null;
        note(state, ship.houseId, `${ship.name} сошёл со стапеля.`);
      }
      continue;
    }
    if (ship.status === "transit") {
      const shipClass = SHIP_CLASSES[ship.classId];
      const step = Math.min(shipClass.speed, ship.distanceLeft);
      if (!payUpkeep(state, ship)) {
        ship.stopReason = "нет денег на содержание корабля";
        continue;
      }
      paidUpkeep.add(ship.id);
      if (ship.stopReason === "нет денег на содержание корабля") ship.stopReason = null;
      ship.distanceLeft -= step;
      ship.traveled += step;
      if (ship.distanceLeft <= 0) {
        ship.status = "docked";
        ship.worldId = ship.toId;
        ship.fromId = ship.toId;
        ship.tollWorldId = null;
        ship.stopReason = null;
        const route = routeOf(state, ship.routeId);
        if (route && ship.worldId) {
          const planned = route.stops[ship.stopIndex];
          if (!planned || planned.worldId !== ship.worldId) {
            const index = route.stops.findIndex((stop) => stop.worldId === ship.worldId);
            if (index >= 0) ship.stopIndex = index;
          }
        }
      } else {
        continue;
      }
    }
    if (ship.worldId) handleDock(state, ship, paidUpkeep.has(ship.id));
  }
}

function handleDock(state: SimState, ship: Ship, upkeepPaid = false): void {
  const world = worldOf(state, ship.worldId);
  if (!world) return;
  if (ship.status === "blocked") ship.status = "docked";
  if (!upkeepPaid && !payUpkeep(state, ship)) {
    block(ship, "нет денег на содержание корабля");
    return;
  }
  if (accessDenied(state, ship.houseId, world)) {
    block(ship, "нет доступа: эмбарго");
    return;
  }
  if (!clearToll(state, ship, world)) return;
  if (ship.mission?.type === "colonize" && ship.mission.worldId !== world.id) syncColonyRoute(state, ship);
  const activeRoute = routeOf(state, ship.routeId);
  if (activeRoute?.paused) {
    if (ship.mission?.type === "colonize" && ship.mission.worldId === world.id) {
      if (world.ownerId) retireColony(state, ship);
      else {
        const founded = foundColony(state, ship, world);
        if (!founded.ok) block(ship, founded.reason);
      }
    }
    ship.stopReason = "маршрут на паузе";
    return;
  }
  if (activeRoute) refreshFoodFuel(state, ship, world, activeRoute);
  const hold = activeRoute ? applyStop(state, ship, world, activeRoute) : false;
  let stuck = false;
  if (ship.mission?.type === "colonize" && ship.mission.worldId === world.id) {
    if (world.ownerId) {
      retireColony(state, ship);
      stuck = true;
    } else {
      const founded = foundColony(state, ship, world);
      if (!founded.ok) {
        block(ship, founded.reason);
        stuck = true;
      }
    }
  }
  if (hold || stuck) return;
  const routeNow = routeOf(state, ship.routeId);
  if (routeNow?.returnRouteId && routeOf(state, routeNow.returnRouteId)) {
    const fueled = routeNow.stops.some((stop) => stop.worldId === world.id && stop.actions.some((action) => action.good === "fuel" && (action.mode === "load" || action.mode === "buy")));
    if (fueled && ship.cargo.fuel >= 20) {
      const refuelId = routeNow.id;
      dispatch(state, { type: "assignShip", shipId: ship.id, routeId: routeNow.returnRouteId });
      if (state.ships.every((other) => other.routeId !== refuelId)) {
        state.routes = state.routes.filter((route) => route.id !== refuelId);
      }
      return;
    }
  }
  if (routeNow && foodRouteNeedsFuel(state, ship, routeNow)) {
    block(ship, "нет топлива на следующий перегон");
    return;
  }
  if (routeNow) depart(state, ship, routeNow);
}

function retireColony(state: SimState, ship: Ship): void {
  const route = dedicatedColonyRoute(state, ship);
  ship.mission = null;
  if (route) state.routes = state.routes.filter((item) => item.id !== route.id);
  ship.routeId = null;
  ship.stopReason = "цель колонии уже занята";
}

function payUpkeep(state: SimState, ship: Ship): boolean {
  const amount = SHIP_CLASSES[ship.classId].upkeep;
  if (!sinkCredits(state, { kind: "house", id: ship.houseId }, amount)) return false;
  houseOf(state, ship.houseId)!.flow.upkeep += amount;
  return true;
}

function clearToll(state: SimState, ship: Ship, world: World): boolean {
  if (!world.ownerId || world.ownerId === ship.houseId) {
    ship.tollWorldId = world.id;
    return true;
  }
  if (ship.tollWorldId === world.id) return true;
  const bps = tariffBetween(state, ship.houseId, world.ownerId, world.tariffBps);
  const fee = Math.floor((cargoValue(ship.cargo, world.prices) * bps) / 10000);
  if (fee <= 0) {
    ship.tollWorldId = world.id;
    return true;
  }
  const payer = houseOf(state, ship.houseId);
  const owner = houseOf(state, world.ownerId);
  if (!payer || !owner || availableCredits(payer) < fee) {
    block(ship, "не хватает денег на пошлину");
    return false;
  }
  moveCredits(state, { kind: "house", id: payer.id }, { kind: "house", id: owner.id }, fee);
  payer.flow.tariffsOut += fee;
  owner.flow.tariffsIn += fee;
  const route = routeOf(state, ship.routeId);
  if (route) route.cost += fee;
  ship.tollWorldId = world.id;
  note(state, payer.id, `${ship.name} уплатил ${fee} кред. пошлины «${world.name}» дому ${owner.name}.`);
  return true;
}

function applyStop(state: SimState, ship: Ship, world: World, route: Route): boolean {
  const planned = route.stops[ship.stopIndex];
  const stop = planned && planned.worldId === world.id ? planned : route.stops.find((item) => item.worldId === world.id);
  let hold = false;
  if (!stop) {
    if (!route.stops.some((item) => item.worldId === world.id)) {
      ship.stopReason = "маршрут изменён, корабль завершил текущий перегон";
    }
    return false;
  }
  ensureVisit(ship);
  for (let index = 0; index < stop.actions.length; index += 1) {
    const action = stop.actions[index];
    const moved = ship.visitMoved[index] ?? 0;
    const wanted = action.amount - moved;
    if (wanted <= 0) continue;
    const roomCargo = SHIP_CLASSES[ship.classId].capacity - sumGoods(ship.cargo);
    const roomStock = world.capacity - sumGoods(world.stock);
    if (action.mode === "load") {
      if (world.ownerId !== ship.houseId) {
        ship.stopReason = "чужой склад: нужна покупка";
        continue;
      }
      const qty = Math.min(wanted, Math.max(0, world.stock[action.good] - action.keep), roomCargo);
      if (qty <= 0) ship.stopReason = `нечего грузить: ${goodLabel(action.good)}`;
      else {
        moveGoods(world.stock, ship.cargo, action.good, qty);
        ship.visitMoved[index] = moved + qty;
        rememberSupply(ship, action.good, ship.houseId, qty);
      }
      continue;
    }
    if (action.mode === "unload") {
      if (world.ownerId !== ship.houseId) {
        ship.stopReason = "чужой склад: нужна продажа";
        continue;
      }
      const eligible = Math.max(0, ship.cargo[action.good] - action.keep);
      const qty = Math.min(wanted, eligible, roomStock);
      if (qty < Math.min(wanted, eligible) && roomStock <= qty) {
        ship.stopReason = "склад заполнен";
        hold = true;
      }
      if (qty > 0) {
        moveGoods(ship.cargo, world.stock, action.good, qty);
        ship.visitMoved[index] = moved + qty;
        for (const slice of drawSupply(ship, action.good, qty)) {
          if (!world.imported[slice.houseId]) world.imported[slice.houseId] = emptyGoods();
          world.imported[slice.houseId][action.good] += slice.qty;
          countDelivery(state, slice.houseId, world, action.good, slice.qty);
        }
      } else if (ship.cargo[action.good] > action.keep) {
        ship.stopReason = "склад заполнен";
        hold = true;
      }
      continue;
    }
    if (!world.ownerId || world.ownerId === ship.houseId) {
      ship.stopReason = "это ваш или ничей мир: здесь нет встречной сделки";
      continue;
    }
    const price = world.prices[action.good];
    const sellerHouse = action.mode === "sell" ? ship.houseId : world.ownerId;
    const buyerHouse = action.mode === "sell" ? world.ownerId : ship.houseId;
    if (action.mode === "sell" && ship.cargo[action.good] - action.keep <= 0) continue;
    if (action.mode === "buy" && price > action.price) {
      ship.stopReason = `цена ${goodLabel(action.good)} ${price} выше предела ${action.price}`;
      if (roomCargo > 0) hold = true;
      continue;
    }
    const sellerPile = action.mode === "sell" ? ship.cargo : world.stock;
    const buyerPile = action.mode === "sell" ? world.stock : ship.cargo;
    const sellerKeep = action.mode === "sell" ? action.keep : action.keep;
    const available = Math.max(0, sellerPile[action.good] - sellerKeep);
    const room = action.mode === "sell" ? roomStock : roomCargo;
    const buyer = houseOf(state, buyerHouse);
    const seller = houseOf(state, sellerHouse);
    if (!buyer || !seller || price <= 0) continue;
    const sale = action.mode === "sell" && world.ownerId
      ? planSale(state, ship, world.ownerId, world.id, action.good, Math.min(wanted, available, room), price, action.price)
      : null;
    const affordable = Math.floor(availableCredits(buyer) / price);
    const qty = sale ? sale.qty : Math.min(wanted, available, room, affordable);
    if (qty <= 0) {
      if (available <= 0) ship.stopReason = `нет товара с учётом резерва: ${goodLabel(action.good)}`;
      else if (sale?.blocked === "price") {
        ship.stopReason = `цена ${goodLabel(action.good)} ${price} ниже предела ${action.price}`;
        hold = true;
      } else if (affordable <= 0 || sale?.blocked === "money") {
        ship.stopReason = "у покупателя нет денег";
        if (!(action.mode === "buy" && room <= 0)) hold = true;
      } else if (action.mode === "buy") {
        ship.stopReason = action.good === "fuel" && ship.cargo.fuel > 0
          ? "в трюме нет места для дополнительного топлива"
          : "нет места под груз или на складе";
      } else {
        ship.stopReason = "нет места под груз или на складе";
        hold = true;
      }
      continue;
    }
    const marketUnits = sale ? sale.marketUnits : qty;
    const marketMoney = marketUnits * price;
    if (marketMoney > 0 && !moveCredits(state, { kind: "house", id: buyer.id }, { kind: "house", id: seller.id }, marketMoney)) {
      ship.stopReason = "у покупателя нет денег";
      hold = true;
      continue;
    }
    const contractMoney = sale ? payContractTakes(state, action.good, sale.takes) : 0;
    if (marketMoney > 0) {
      buyer.flow.purchases += marketMoney;
      seller.flow.sales += marketMoney;
    }
    moveGoods(sellerPile, buyerPile, action.good, qty);
    ship.visitMoved[index] = moved + qty;
    if (action.mode === "buy") rememberSupply(ship, action.good, world.ownerId ?? ship.houseId, qty);
    let deliveredQty = qty;
    if (action.mode === "sell") {
      const slices = drawSupply(ship, action.good, qty);
      const local = slices.filter((slice) => slice.houseId === world.ownerId).reduce((sum, slice) => sum + slice.qty, 0);
      deliveredQty = qty - local;
    }
    const paid = marketMoney + contractMoney;
    rememberTrade(buyer, seller, paid);
    if (action.mode === "sell") route.revenue += paid;
    else route.cost += paid;
    if (deliveredQty > 0) {
      if (!world.imported[sellerHouse]) world.imported[sellerHouse] = emptyGoods();
      world.imported[sellerHouse][action.good] += deliveredQty;
      countDelivery(state, sellerHouse, world, action.good, deliveredQty);
    }
    if (sale && sale.blocked === "price" && qty < wanted) {
      ship.stopReason = `цена ${goodLabel(action.good)} ${price} ниже предела ${action.price}`;
      hold = true;
    } else if (sale && sale.blocked === "money" && qty < wanted) {
      ship.stopReason = "у покупателя нет денег";
      hold = true;
    } else if (!sale && qty < wanted && affordable <= qty && !(action.mode === "buy" && room <= qty)) {
      ship.stopReason = "у покупателя нет денег";
      hold = true;
    } else if (action.mode === "sell" && qty < wanted && room <= qty) {
      ship.stopReason = "склад заполнен";
      hold = true;
    }
  }
  return hold;
}

function ensureVisit(ship: Ship): void {
  const key = `${ship.worldId ?? ""}:${ship.stopIndex}:${ship.routeId ?? ""}`;
  if (ship.visitKey !== key || !Array.isArray(ship.visitMoved)) {
    ship.visitKey = key;
    ship.visitMoved = [];
  }
}

function countDelivery(state: SimState, sellerId: string, world: World, good: GoodId, qty: number): void {
  if (!world.ownerId) return;
  const capital = houseOf(state, world.ownerId)?.capitalId === world.id;
  if (!capital) return;
  for (const treaty of state.treaties) {
    if (treaty.status !== "active" || treaty.good !== good) continue;
    if (treaty.proposerId === sellerId && treaty.targetId === world.ownerId && (treaty.kind === "supply" || treaty.kind === "exchange")) {
      treaty.delivered += qty;
    }
  }
}

function depart(state: SimState, ship: Ship, route: Route): void {
  if (route.stops.length < 2) {
    ship.stopReason = "в маршруте меньше двух остановок";
    return;
  }
  if (ship.mission?.type === "colonize" && ship.worldId !== ship.mission.worldId) {
    if (ship.cargo.parts < state.rules.colonizeParts || ship.cargo.food < state.rules.colonizeFood) {
      ship.stopReason = "колониальный набор ещё не в трюме";
      return;
    }
  }
  const nextIndex = nextStopIndex(ship, route);
  const next = route.stops[nextIndex];
  const origin = worldOf(state, ship.worldId);
  const dest = worldOf(state, next.worldId);
  if (!origin || !dest) return;
  if (dest.id === origin.id) {
    ship.stopIndex = nextIndex;
    ship.stopReason = null;
    return;
  }
  if (accessDenied(state, ship.houseId, dest)) {
    block(ship, "нет доступа к следующей остановке");
    return;
  }
  const dist = distance(origin, dest);
  const shipClass = SHIP_CLASSES[ship.classId];
  const fuel = Math.max(1, Math.ceil((dist * shipClass.fuelPer1000) / 1000));
  const crossings = territoriesOnRoute(state, origin.id, dest.id, ship.houseId);
  if (crossings.some((world) => accessDenied(state, ship.houseId, world))) {
    block(ship, "нет доступа: маршрут пересекает эмбарго");
    return;
  }
  const fees = crossings.map((world) => ({
    world,
    fee: Math.floor((cargoValue(ship.cargo, origin.prices) * tariffBetween(state, ship.houseId, world.ownerId!, world.tariffBps)) / 10000),
  }));
  const totalFee = fees.reduce((sum, item) => sum + item.fee, 0);
  if (ship.cargo.fuel < fuel) {
    block(ship, "нет топлива на следующий перегон");
    return;
  }
  const payer = houseOf(state, ship.houseId);
  if (!payer || availableCredits(payer) < totalFee) {
    block(ship, "не хватает денег на транзитную пошлину");
    return;
  }
  destroyGoods(ship.cargo, state.accounts, "fuel", fuel);
  drawSupply(ship, "fuel", fuel);
  route.fuelUsed += fuel;
  for (const fee of fees) {
    if (fee.fee <= 0 || !fee.world.ownerId) continue;
    moveCredits(state, { kind: "house", id: payer.id }, { kind: "house", id: fee.world.ownerId }, fee.fee);
    payer.flow.tariffsOut += fee.fee;
    houseOf(state, fee.world.ownerId)!.flow.tariffsIn += fee.fee;
    route.cost += fee.fee;
  }
  ship.status = "transit";
  ship.fromId = origin.id;
  ship.toId = dest.id;
  ship.legDistance = dist;
  ship.distanceLeft = dist;
  ship.worldId = null;
  ship.stopIndex = nextIndex;
  ship.stopReason = null;
}

export function nextStopIndex(ship: Ship, route: Route): number {
  if (route.stops.length === 0) return 0;
  const planned = route.stops[ship.stopIndex];
  const here = planned && planned.worldId === ship.worldId
    ? ship.stopIndex
    : route.stops.findIndex((stop) => stop.worldId === ship.worldId);
  return here >= 0 ? (here + 1) % route.stops.length : Math.min(Math.max(ship.stopIndex, 0), route.stops.length - 1);
}

export function territoriesOnRoute(state: SimState, fromId: string, toId: string, travelerId: string): World[] {
  const from = worldOf(state, fromId);
  const to = worldOf(state, toId);
  if (!from || !to) return [];
  return byId(state.worlds).filter((world) => {
    if (!world.ownerId || world.ownerId === travelerId) return false;
    if (world.id === from.id || world.id === to.id) return false;
    return segmentHitsCircle(from, to, world, state.rules.territoryRadius);
  });
}

function updatePrices(state: SimState): void {
  for (const world of state.worlds) {
    for (const good of GOODS) {
      const base = state.rules.basePrice[good];
      const demand = world.demand[good];
      const stock = world.stock[good];
      const raw = demand <= 0
        ? Math.max(1, Math.round((base * 40) / 100))
        : Math.max(1, Math.round((base * Math.max(40, Math.min(250, Math.round((demand * 100) / Math.max(stock, 1))))) / 100));
      world.prices[good] = Math.max(1, Math.round((world.prices[good] * 2 + raw) / 3));
    }
    world.lastDemand = cloneGoods(world.demand);
  }
}

function closeTreaties(state: SimState): void {
  settleContractWindows(state);
  for (const treaty of state.treaties) {
    const tracked = treaty.status === "active" && (treaty.kind === "supply" || treaty.kind === "exchange");
    if (tracked) {
      treaty.windowDays += 1;
      const ending = state.tick >= treaty.endTick;
      if (treaty.windowDays >= state.rules.window || ending) {
        if (treaty.delivered < treaty.qtyPerWindow) {
          treaty.status = "broken";
          shiftRelation(state, treaty.proposerId, treaty.targetId, -12);
          note(state, treaty.targetId, `Договор сорван: поставлено ${treaty.delivered} из ${treaty.qtyPerWindow}. Отношения хуже, товар из воздуха не появился.`);
        } else {
          shiftRelation(state, treaty.proposerId, treaty.targetId, 3);
          note(state, treaty.targetId, `Поставка выполнена: ${treaty.delivered} ед. за окно.`);
          treaty.delivered = 0;
          treaty.windowDays = 0;
        }
      }
    }
    if (treaty.status === "active" && state.tick >= treaty.endTick) {
      treaty.status = "expired";
      note(state, treaty.targetId, "Срок договора истёк.");
    }
  }
  for (const world of state.worlds) {
    world.windowDays += 1;
    if (world.windowDays < state.rules.window) continue;
    world.lastImported = cloneImported(world.imported);
    world.lastProduced = cloneGoods(world.produced);
    world.lastEaten = world.eaten;
    world.imported = {};
    world.produced = emptyGoods();
    world.eaten = 0;
    world.windowDays = 0;
  }
}

function driftLoyalty(state: SimState): void {
  for (const world of state.worlds) {
    const governor = personOf(state, world.governorId);
    if (!governor?.alive) continue;
    if (governor.loyalty < world.satisfaction) governor.loyalty += 1;
    else if (governor.loyalty > world.satisfaction) governor.loyalty -= 1;
  }
}

function inherit(state: SimState): void {
  for (const person of byId(state.people)) {
    if (!person.alive) continue;
    person.ageDays += 1;
    if (person.ageDays % state.rules.ticksPerYear !== 0) continue;
    if (person.role !== "head") continue;
    const years = Math.floor(person.ageDays / state.rules.ticksPerYear);
    let dies = years >= state.rules.deathCertainAge;
    if (!dies && years >= state.rules.deathStartAge) {
      const chance = (years - state.rules.deathStartAge) * 4;
      const rolled = rollInt(state.rngState, 100);
      state.rngState = rolled.state;
      dies = rolled.value < chance;
    }
    if (dies) passHouse(state, person);
  }
}

function passHouse(state: SimState, head: Person): void {
  head.alive = false;
  head.role = "kin";
  const living = state.people.filter((person) => person.alive && person.houseId === head.houseId);
  const heir = living.filter((person) => person.role === "heir").sort((a, b) => b.ageDays - a.ageDays)[0];
  const kin = living.filter((person) => person.role === "kin" || person.role === "spouse").sort((a, b) => b.ageDays - a.ageDays)[0];
  const governor = living
    .filter((person) => person.role === "governor")
    .sort((a, b) => b.loyalty - a.loyalty || (a.id < b.id ? -1 : 1))[0];
  let next = heir ?? governor ?? kin;
  let how = heir ? "наследник" : governor ? "губернатор с наибольшей лояльностью: прямого наследника нет" : kin ? "старшая родня" : "";
  if (!next) {
    const rolled = rollInt(state.rngState, 1);
    state.rngState = rolled.state;
    next = {
      id: `p-${state.nextSerial + 1}`,
      houseId: head.houseId,
      name: "Регент Лиор",
      role: "head",
      ageDays: 40 * state.rules.ticksPerYear,
      alive: true,
      traits: ["регент"],
      loyalty: 55,
      parentId: null,
      spouseId: null,
      worldId: null,
    };
    state.nextSerial += 1;
    state.people.push(next);
    how = "резервный регент: живых родственников и губернаторов не осталось";
  } else {
    if (next.role === "governor" && next.worldId) {
      const world = worldOf(state, next.worldId);
      if (world) world.governorId = null;
      next.worldId = null;
    }
    next.role = "head";
  }
  for (const child of living) {
    if (child.parentId === next.id && child.alive && child.role !== "head") child.role = "heir";
  }
  for (const other of state.houses) {
    if (other.id === head.houseId) continue;
    const rolled = rollInt(state.rngState, 17);
    state.rngState = rolled.state;
    shiftRelation(state, head.houseId, other.id, rolled.value - 8);
  }
  const house = houseOf(state, head.houseId);
  note(state, head.houseId, `${head.name} умер. Новый глава ${house?.name ?? "дома"}: ${next.name} (${how}). Казна, миры, корабли, маршруты и договоры остаются у дома.`);
}

function rollAccounts(state: SimState): void {
  for (const house of state.houses) {
    house.flowDays += 1;
    if (house.flowDays < state.rules.window) continue;
    house.lastFlow = { ...house.flow };
    house.flow = emptyFlow();
    house.lastTradeWith = { ...house.tradeWith };
    house.tradeWith = {};
    house.flowDays = 0;
  }
  for (const route of state.routes) {
    const house = houseOf(state, route.houseId);
    if (!house || house.flowDays !== 0) continue;
    route.lastRevenue = route.revenue;
    route.lastCost = route.cost;
    route.lastFuelUsed = route.fuelUsed;
    route.revenue = 0;
    route.cost = 0;
    route.fuelUsed = 0;
  }
}

function block(ship: Ship, reason: string): void {
  ship.status = "blocked";
  ship.stopReason = reason;
}

function headOf(state: SimState, houseId: string | null): Person | undefined {
  if (!houseId) return undefined;
  return state.people.find((person) => person.alive && person.houseId === houseId && person.role === "head");
}

function goodLabel(good: GoodId): string {
  return { grain: "зерно", food: "продовольствие", ore: "руда", alloys: "сплавы", parts: "комплектующие", fuel: "топливо" }[good];
}

function sumOutputs(recipe: Recipe): number {
  return GOODS.reduce((sum, good) => sum + (recipe.outputs[good] ?? 0), 0);
}

function sumInputs(recipe: Recipe): number {
  return GOODS.reduce((sum, good) => sum + (recipe.inputs[good] ?? 0), 0);
}
