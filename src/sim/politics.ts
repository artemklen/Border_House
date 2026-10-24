import { SHIP_CLASSES } from "./config";
import { GOOD_NAME, sumGoods, type GoodId } from "./goods";
import {
  accessDenied,
  availableCredits,
  byId,
  createGoods,
  destroyGoods,
  foodCover,
  houseOf,
  moveCredits,
  note,
  pairRelation,
  rememberSupply,
  rememberTrade,
  routeOf,
  serial,
  shiftRelation,
  shipOf,
  tariffBetween,
  worldOf,
} from "./mutate";
import { SPEED_PARTS, capPort, expandPort, notePortMove } from "./port";
import type {
  CommandResult,
  GoalKind,
  House,
  Route,
  Ship,
  SimState,
  Situation,
  SituationChoice,
  SituationKind,
  TariffGrant,
  World,
} from "./types";

const DEADLINE = 8;
const COOLDOWN = 48;
const EFFECT_DAYS = 24;
const FOOD_QTY = 10;
const FOOD_PRICE = 12;
const COMPENSATION = 400;
const GRANT_BPS = 200;
const OPEN_LIMIT = 2;

export const SITUATION_LABEL: Record<SituationKind, string> = {
  foodDependence: "Зависимость столицы от еды",
  tariffDispute: "Спор из-за пошлины",
  brokenContract: "Сорванный контракт",
  congestedPort: "Перегрузка порта",
  exportShortage: "Экспорт против своего дефицита",
  successionReview: "Пересмотр условий после смены главы",
};

export const CHOICE_LABEL: Record<SituationChoice, string> = {
  yield: "Уступить",
  pay: "Оплатить",
  refuse: "Отказать",
};

export function describeGoal(state: SimState, house: House): { kind: GoalKind; title: string; reason: string } {
  const capital = worldOf(state, house.capitalId);
  const cover = capital ? foodCover(capital.population, capital.stock.food, state.rules.foodPer100) : 999;
  if (cover < 18) {
    return { kind: "food", title: "Снизить зависимость от продовольствия", reason: `В столице еды на ${cover} дн.` };
  }
  if (house.profile === "merchant" || (house.lastFlow.tariffsIn > house.lastFlow.sales && house.lastFlow.tariffsIn > 0)) {
    const reason = house.lastFlow.tariffsIn > 0 ? `Прошлый сбор пошлин ${house.lastFlow.tariffsIn} кред.` : "Профиль дома держится на перевалке.";
    return { kind: "transit", title: "Сохранить доход транзита", reason };
  }
  const reason = house.profile === "industrial" ? "Профиль дома завязан на руду и переработку." : "Еды и пошлинного дохода хватает, узкое место — сырьё для переработки.";
  return { kind: "industry", title: "Обеспечить промышленное снабжение", reason };
}

export function choicePreview(situation: Situation, choice: SituationChoice): string[] {
  const label = SITUATION_LABEL[situation.kind];
  const windowNote = `Окно выбора до тика ${situation.deadlineTick}: пауза его не тратит. Просрочка не списывает казну.`;
  const lasting = `Срок эффекта ${situation.days} дн. ${windowNote}`;
  const once = `Платёж разовый и не отменяется через ${situation.days} дн. ${windowNote}`;
  const persistent = `Этот исход не кончается через ${situation.days} дн.: эмбарго, паузу маршрута или разрыв договора снимают отдельным действием. ${windowNote}`;
  if (choice === "refuse" && situation.kind === "exportShortage") {
    return [
      `${label}: отказ не двигает товары и не переводит кредиты.`,
      "Отношения +2. Экспортный маршрут остаётся, эмбарго не вводится.",
      persistent,
    ];
  }
  if (choice === "refuse") {
    return [
      `${label}: отказ не двигает товары и не переводит кредиты.`,
      "Отношения падают. Где ситуация про доступ, дом закрывает эмбарго или разрывает действующий договор. Этот запрет сам не сгорает.",
      persistent,
    ];
  }
  if (situation.kind === "foodDependence" && choice === "yield") {
    return [
      `Договор снабжения: поставщик везёт ${situation.qty} ${GOOD_NAME[situation.good]} за окно, ${situation.days} дн., пошлина договора ${situation.tariffBps / 100}%.`,
      "Еда не появляется из события: её привезёт рейс. Пошлина столицы для поставщика становится не выше обещанной. Отношения +6. Если договор уже действует, второй не открывается и эмбарго не вводится.",
      lasting,
    ];
  }
  if (situation.kind === "foodDependence" && choice === "pay") {
    return [
      `Сразу купить ${situation.qty} ${GOOD_NAME[situation.good]} на корабль у склада контрагента за ${situation.cost} кред.`,
      "Нужны свободные кредиты, товар на складе, свой корабль у причала и открытый доступ. Дневной лимит порта должен вмещать партию. Иначе приказ не исполняется и деньги не уходят.",
      once,
    ];
  }
  if (situation.kind === "tariffDispute" && choice === "yield") {
    return [
      `Продать гостю ${situation.qty} продовольствия за ${situation.cost} кред. и держать для него пошлину ${situation.tariffBps / 100}% ещё ${situation.days} дн.`,
      "Товар списывается с нашего склада в его трюм и занимает дневной лимит причала. Отношения +8. Без места у причала, еды, его денег или при эмбарго уступка не исполняется.",
      lasting,
    ];
  }
  if (situation.kind === "tariffDispute" && choice === "pay") {
    return [
      `Компенсация ${situation.cost} кред. гостю. Пошлина мира не меняется, еда не двигается.`,
      "Отношения +3. Если в казне меньше суммы, перевод не начинается.",
      once,
    ];
  }
  if (situation.kind === "brokenContract" && choice === "yield") {
    return [
      `Продавец переводит покупателю ${situation.cost} кред. компенсации. Новый товар не создаётся.`,
      "Отношения +5. Нет суммы — решение остаётся открытым.",
      once,
    ];
  }
  if (situation.kind === "brokenContract" && choice === "pay") {
    return [
      `Покупатель платит продавцу ${situation.cost} кред. отступных. Склад не пополняется.`,
      "Отношения +3.",
      once,
    ];
  }
  if (situation.kind === "congestedPort" && choice === "yield") {
    return [
      `Для этого дома пошлина порта ${situation.tariffBps / 100}% на ${situation.days} дн. Очередь сама не исчезает.`,
      "Отношения +4.",
      lasting,
    ];
  }
  if (situation.kind === "congestedPort" && choice === "pay") {
    return [
      "Начать ускорение обработки порта: кредиты уйдут населению, комплектующие спишутся со склада.",
      "Если стройка уже идёт или ресурсов нет, решение не принимается и очередь остаётся. Готовое ускорение само не отменяется через срок решения.",
      once,
    ];
  }
  if (situation.kind === "exportShortage" && choice === "yield") {
    return [
      "Экспортный маршрут встаёт на паузу. Уже загруженный трюм не телепортируется обратно.",
      "Отношения с покупателем −3, если он известен. Пауза маршрута сама не снимается.",
      persistent,
    ];
  }
  if (situation.kind === "exportShortage" && choice === "pay") {
    return [
      `Купить ${situation.qty} ${GOOD_NAME[situation.good]} на свой корабль за ${situation.cost} кред., маршрут экспорта не трогать.`,
      "Нужен свой корабль у чужого склада с этим товаром и без эмбарго. Иначе оплата не проходит.",
      once,
    ];
  }
  if (situation.kind === "successionReview" && choice === "yield") {
    return [
      `Продлить договор на ${situation.days} дн. и опустить его пошлину до ${situation.tariffBps / 100}%, если она выше.`,
      "Отношения +4. Казна не трогается.",
      lasting,
    ];
  }
  return [
    `Компенсация ${situation.cost} кред. другой стороне. Текст договора не меняется.`,
    "Отношения +5. Нет суммы — решение остаётся открытым.",
    once,
  ];
}

export function advanceSituations(state: SimState): void {
  for (const situation of state.situations) {
    if (situation.status !== "open" || state.tick < situation.deadlineTick) continue;
    situation.status = "expired";
    situation.choice = null;
    rememberCooldown(state, situation);
    note(state, situation.houseId, `${SITUATION_LABEL[situation.kind]}: срок решения истёк. Казна и склады не изменились.`);
  }
  state.tariffGrants = state.tariffGrants.filter((grant) => grant.untilTick > state.tick);
  for (const house of byId(state.houses)) {
    openSuccession(state, house);
    openBrokenContract(state, house);
    openFoodDependence(state, house);
    openTariffDispute(state, house);
    openCongestedPort(state, house);
    openExportShortage(state, house);
  }
}

export function situationDecision(state: SimState, house: House, situation: Situation): SituationChoice {
  const preferred = preferredChoice(state, house, situation);
  if (!situationBlock(state, situation, preferred)) return preferred;
  if (preferred !== "refuse" && !situationBlock(state, situation, "refuse")) return "refuse";
  return preferred;
}

export function resolveSituation(state: SimState, houseId: string, situationId: string, choice: SituationChoice): CommandResult {
  const situation = state.situations.find((item) => item.id === situationId);
  const house = houseOf(state, houseId);
  if (!situation || !house) return { ok: false, reason: "нет такого решения" };
  if (situation.houseId !== house.id) return { ok: false, reason: "решение принимает только этот дом" };
  if (situation.status !== "open") return { ok: false, reason: "решение уже принято" };
  const blocked = situationBlock(state, situation, choice);
  if (blocked) return { ok: false, reason: blocked };
  const applied = applyChoice(state, house, situation, choice);
  if (applied) return { ok: false, reason: applied };
  situation.status = "resolved";
  situation.choice = choice;
  rememberCooldown(state, situation);
  return { ok: true, reason: `${CHOICE_LABEL[choice]}: ${SITUATION_LABEL[situation.kind]}` };
}

function preferredChoice(state: SimState, house: House, situation: Situation): SituationChoice {
  const goal = describeGoal(state, house).kind;
  if (situation.kind === "foodDependence") return foodSuppliers(state, house).length >= 2 ? "refuse" : "yield";
  if (situation.kind === "tariffDispute") return goal === "transit" ? "refuse" : "yield";
  if (situation.kind === "brokenContract") return contractReliability(state, house.id, situation.otherId ?? "") >= 0.5 ? "yield" : "refuse";
  if (situation.kind === "congestedPort") return goal === "transit" ? "refuse" : "yield";
  if (situation.kind === "exportShortage") return goal === "food" ? "yield" : "refuse";
  return pairRelation(state, house.id, situation.otherId ?? "") >= 0 ? "yield" : "refuse";
}

function situationBlock(state: SimState, situation: Situation, choice: SituationChoice): string | null {
  if (choice === "refuse") return null;
  const house = houseOf(state, situation.houseId);
  const other = situation.otherId ? houseOf(state, situation.otherId) : undefined;
  if (!house) return "нет дома";
  if ((situation.kind === "tariffDispute" && choice === "pay") || (situation.kind === "successionReview" && choice === "pay") || (situation.kind === "brokenContract" && choice === "pay")) {
    const payer = situation.kind === "brokenContract" ? house : situation.kind === "successionReview" ? house : house;
    if (availableCredits(payer) < situation.cost) return `нужно ${situation.cost} свободных кредитов`;
  }
  if (situation.kind === "brokenContract" && choice === "yield") {
    if (!other || availableCredits(other) < situation.cost) return `у продавца нет ${situation.cost} свободных кредитов`;
  }
  if (situation.kind === "foodDependence" && choice === "yield") {
    if (!other) return "нет контрагента";
  }
  if (situation.kind === "foodDependence" && choice === "pay") {
    return cargoPurchaseBlock(state, house, other, situation);
  }
  if (situation.kind === "tariffDispute" && choice === "yield") {
    return visitorSaleBlock(state, house, other, situation);
  }
  if (situation.kind === "congestedPort" && choice === "pay") {
    const world = worldOf(state, situation.worldId);
    if (!world) return "нет порта";
    if (world.port.project || world.port.speedLevel > 0) return "ускорение порта сейчас нельзя начать";
    if (world.stock.parts < SPEED_PARTS) return `на складе порта нет ${SPEED_PARTS} комплектующих`;
  }
  if (situation.kind === "exportShortage" && choice === "yield") {
    if (!situation.routeId || !routeOf(state, situation.routeId)) return "маршрут экспорта уже снят";
  }
  if (situation.kind === "exportShortage" && choice === "pay") {
    return cargoPurchaseBlock(state, house, other, situation);
  }
  if (situation.kind === "successionReview" && choice === "yield") {
    const treaty = state.treaties.find((item) => item.id === situation.treatyId);
    if (!treaty || treaty.status !== "active") return "договор уже не действует";
  }
  return null;
}

function applyChoice(state: SimState, house: House, situation: Situation, choice: SituationChoice): string | null {
  const other = situation.otherId ? houseOf(state, situation.otherId) : undefined;
  if (choice === "refuse") {
    if (situation.kind === "successionReview") {
      const treaty = state.treaties.find((item) => item.id === situation.treatyId);
      if (treaty && treaty.status === "active") treaty.status = "broken";
      if (other) shiftRelation(state, house.id, other.id, -10);
      note(state, house.id, `${SITUATION_LABEL[situation.kind]}: отказ. Договор разорван, отношения −10. Казна не списана.`);
      return null;
    }
    if (other && situation.kind !== "exportShortage") house.embargo[other.id] = true;
    if (other) shiftRelation(state, house.id, other.id, situation.kind === "exportShortage" ? 2 : -12);
    note(state, house.id, `${SITUATION_LABEL[situation.kind]}: отказ. ${other && situation.kind !== "exportShortage" ? `Эмбарго против ${other.name}, ` : ""}отношения ${situation.kind === "exportShortage" ? "+2" : "−12"}. Товары и кредиты на месте.`);
    return null;
  }
  if (situation.kind === "foodDependence" && choice === "yield" && other) {
    if (activeTreaty(state, house.id, other.id)) {
      note(state, house.id, `${SITUATION_LABEL[situation.kind]}: уступка. Договор с ${other.name} уже действует, второй не открыт. Эмбарго не введено, казна и склады на месте.`);
      return null;
    }
    state.treaties.push({
      id: serial(state, "t"),
      kind: "supply",
      proposerId: other.id,
      targetId: house.id,
      status: "active",
      startTick: state.tick,
      endTick: state.tick + situation.days,
      duration: situation.days,
      tariffBps: situation.tariffBps,
      good: situation.good,
      qtyPerWindow: situation.qty,
      delivered: 0,
      windowDays: 0,
      note: "Поставка по решению о зависимости. Еда приходит только рейсом.",
    });
    const capital = worldOf(state, house.capitalId);
    if (capital) putGrant(state, capital.id, house.id, other.id, situation.tariffBps, situation.days);
    shiftRelation(state, house.id, other.id, 6);
    note(state, house.id, `${SITUATION_LABEL[situation.kind]}: уступка. Договор на ${situation.qty} ${GOOD_NAME[situation.good]} и ${situation.days} дн. Пошлина столицы для поставщика не выше ${situation.tariffBps / 100}% на этот срок. Отношения +6. Еда из события не создана.`);
    return null;
  }
  if (situation.kind === "foodDependence" && choice === "pay") {
    const failure = moveCargoPurchase(state, house, other, situation);
    if (failure) return failure;
    if (other) shiftRelation(state, house.id, other.id, 4);
    note(state, house.id, `${SITUATION_LABEL[situation.kind]}: оплата. ${situation.qty} ${GOOD_NAME[situation.good]} легли в трюм за ${situation.cost} кред. Отношения +4.`);
    return null;
  }
  if (situation.kind === "tariffDispute" && choice === "yield" && other && situation.worldId) {
    const failure = sellToVisitor(state, house, other, situation);
    if (failure) return failure;
    putGrant(state, situation.worldId, house.id, other.id, situation.tariffBps, situation.days);
    shiftRelation(state, house.id, other.id, 8);
    note(state, house.id, `${SITUATION_LABEL[situation.kind]}: уступка. Продано ${situation.qty} продовольствия за ${situation.cost} кред., пошлина для гостя ${situation.tariffBps / 100}% на ${situation.days} дн. Отношения +8.`);
    return null;
  }
  if (situation.kind === "tariffDispute" && choice === "pay" && other) {
    if (!pay(state, house, other, situation.cost)) return `нужно ${situation.cost} свободных кредитов`;
    shiftRelation(state, house.id, other.id, 3);
    note(state, house.id, `${SITUATION_LABEL[situation.kind]}: компенсация ${situation.cost} кред. Пошлина не снижена, еда не двигалась. Отношения +3.`);
    return null;
  }
  if (situation.kind === "brokenContract" && choice === "yield" && other) {
    if (!pay(state, other, house, situation.cost)) return `у продавца нет ${situation.cost} свободных кредитов`;
    shiftRelation(state, house.id, other.id, 5);
    note(state, house.id, `${SITUATION_LABEL[situation.kind]}: уступка. Продавец перевёл ${situation.cost} кред. Отношения +5. Товар не создан.`);
    return null;
  }
  if (situation.kind === "brokenContract" && choice === "pay" && other) {
    if (!pay(state, house, other, situation.cost)) return `нужно ${situation.cost} свободных кредитов`;
    shiftRelation(state, house.id, other.id, 3);
    note(state, house.id, `${SITUATION_LABEL[situation.kind]}: отступные ${situation.cost} кред. продавцу. Отношения +3.`);
    return null;
  }
  if (situation.kind === "congestedPort" && choice === "yield" && other && situation.worldId) {
    putGrant(state, situation.worldId, house.id, other.id, situation.tariffBps, situation.days);
    shiftRelation(state, house.id, other.id, 4);
    note(state, house.id, `${SITUATION_LABEL[situation.kind]}: уступка. Пошлина для ${other.name} ${situation.tariffBps / 100}% на ${situation.days} дн. Отношения +4.`);
    return null;
  }
  if (situation.kind === "congestedPort" && choice === "pay" && situation.worldId) {
    const started = expandPort(state, house.id, situation.worldId, "speed");
    if (!started.ok) return started.reason;
    note(state, house.id, `${SITUATION_LABEL[situation.kind]}: оплачено ускорение порта. ${started.reason}`);
    return null;
  }
  if (situation.kind === "exportShortage" && choice === "yield") {
    const route = routeOf(state, situation.routeId);
    if (!route) return "маршрут экспорта уже снят";
    route.paused = true;
    if (other) shiftRelation(state, house.id, other.id, -3);
    note(state, house.id, `${SITUATION_LABEL[situation.kind]}: маршрут «${route.name}» на паузе. Отношения −3. Груз из трюма не возвращён.`);
    return null;
  }
  if (situation.kind === "exportShortage" && choice === "pay") {
    const failure = moveCargoPurchase(state, house, other, situation);
    if (failure) return failure;
    if (other) shiftRelation(state, house.id, other.id, 2);
    note(state, house.id, `${SITUATION_LABEL[situation.kind]}: закуплено ${situation.qty} ${GOOD_NAME[situation.good]} за ${situation.cost} кред. Экспорт не остановлен.`);
    return null;
  }
  if (situation.kind === "successionReview" && choice === "yield") {
    const treaty = state.treaties.find((item) => item.id === situation.treatyId);
    if (!treaty || treaty.status !== "active") return "договор уже не действует";
    const previousEnd = treaty.endTick;
    treaty.endTick += situation.days;
    treaty.duration = Math.min(360, treaty.duration + situation.days);
    treaty.tariffBps = Math.min(treaty.tariffBps, situation.tariffBps);
    if (treaty.kind === "supply") {
      for (const grant of state.tariffGrants) {
        if (grant.ownerId !== treaty.targetId || grant.beneficiaryId !== treaty.proposerId) continue;
        if (grant.untilTick <= state.tick || grant.untilTick > previousEnd) continue;
        grant.untilTick = treaty.endTick;
        grant.bps = Math.min(grant.bps, treaty.tariffBps);
      }
    }
    if (other) shiftRelation(state, house.id, other.id, 4);
    note(state, house.id, `${SITUATION_LABEL[situation.kind]}: договор продлён на ${situation.days} дн., пошлина не выше ${situation.tariffBps / 100}%. Отношения +4.`);
    return null;
  }
  if (situation.kind === "successionReview" && choice === "pay" && other) {
    if (!pay(state, house, other, situation.cost)) return `нужно ${situation.cost} свободных кредитов`;
    shiftRelation(state, house.id, other.id, 5);
    note(state, house.id, `${SITUATION_LABEL[situation.kind]}: компенсация ${situation.cost} кред. Текст договора прежний. Отношения +5.`);
    return null;
  }
  return "этот вариант сейчас нельзя исполнить";
}

function openSuccession(state: SimState, house: House): void {
  if (house.successionTick !== state.tick) return;
  const treaty = state.treaties.find((item) => item.status === "active" && (item.proposerId === house.id || item.targetId === house.id));
  if (!treaty) return;
  const otherId = treaty.proposerId === house.id ? treaty.targetId : treaty.proposerId;
  pushSituation(state, house, {
    kind: "successionReview",
    otherId,
    worldId: null,
    routeId: null,
    contractId: null,
    treatyId: treaty.id,
    shipId: null,
    cause: `Глава сменился. Договор с ${houseOf(state, otherId)?.name ?? "соседом"} ещё действует, его условия можно пересмотреть.`,
    cost: COMPENSATION,
    days: EFFECT_DAYS,
    tariffBps: GRANT_BPS,
    qty: 0,
    good: treaty.good,
  });
}

function openBrokenContract(state: SimState, house: House): void {
  const contract = state.contracts.find((item) => item.status === "broken" && item.buyerId === house.id && sellerOwesCompensation(item) && !state.situations.some((situation) => situation.contractId === item.id));
  if (!contract) return;
  pushSituation(state, house, {
    kind: "brokenContract",
    otherId: contract.sellerId,
    worldId: contract.worldId,
    routeId: null,
    contractId: contract.id,
    treatyId: null,
    shipId: null,
    cause: `Контракт на ${GOOD_NAME[contract.good]} сорван: доставлено ${contract.delivered} из обещанного. Компенсация — перевод кредитов, не новый товар.`,
    cost: COMPENSATION,
    days: EFFECT_DAYS,
    tariffBps: 0,
    qty: 0,
    good: contract.good,
  });
}

function openFoodDependence(state: SimState, house: House): void {
  const capital = worldOf(state, house.capitalId);
  if (!capital) return;
  const cover = foodCover(capital.population, capital.stock.food, state.rules.foodPer100);
  if (cover >= 8) return;
  const suppliers = foodSuppliers(state, house);
  const other = suppliers[0];
  if (!other) return;
  const pantry = pantryOf(state, other.id);
  const ship = pantry ? dockedShip(state, house.id, pantry.id) : undefined;
  pushSituation(state, house, {
    kind: "foodDependence",
    otherId: other.id,
    worldId: pantry?.id ?? null,
    routeId: null,
    contractId: null,
    treatyId: null,
    shipId: ship?.id ?? null,
    cause: `Столица «${capital.name}» сыта на ${cover} дн. Продовольствие есть у ${other.name}, но само оно не придёт.`,
    cost: FOOD_QTY * FOOD_PRICE,
    days: EFFECT_DAYS,
    tariffBps: GRANT_BPS,
    qty: FOOD_QTY,
    good: "food",
  });
}

function openTariffDispute(state: SimState, house: House): void {
  for (const world of state.worlds) {
    if (world.ownerId !== house.id) continue;
    const ship = foreignShipAt(state, world, house.id);
    if (!ship) continue;
    const other = houseOf(state, ship.houseId);
    const capital = worldOf(state, other?.capitalId ?? null);
    if (!other || !capital) continue;
    const cover = foodCover(capital.population, capital.stock.food, state.rules.foodPer100);
    if (cover >= 12) continue;
    const charged = tariffBetween(state, other.id, house.id, world.tariffBps, world.id);
    if (charged < 800) continue;
    pushSituation(state, house, {
      kind: "tariffDispute",
      otherId: other.id,
      worldId: world.id,
      routeId: null,
      contractId: null,
      treatyId: null,
      shipId: ship.id,
      cause: `«${world.name}» берёт с ${other.name} ${charged / 100}%. Столица ${other.name} сыта на ${cover} дн., их корабль стоит у нашего причала.`,
      cost: FOOD_QTY * FOOD_PRICE,
      days: EFFECT_DAYS,
      tariffBps: GRANT_BPS,
      qty: FOOD_QTY,
      good: "food",
    });
    return;
  }
}

function openCongestedPort(state: SimState, house: House): void {
  for (const world of state.worlds) {
    if (world.ownerId !== house.id || world.port.queue.length < 2) continue;
    const ship = foreignShipAt(state, world, house.id);
    if (!ship) continue;
    pushSituation(state, house, {
      kind: "congestedPort",
      otherId: ship.houseId,
      worldId: world.id,
      routeId: null,
      contractId: null,
      treatyId: null,
      shipId: ship.id,
      cause: `В очереди «${world.name}» ${world.port.queue.length} корабля. Общая гавань не разгружается от одной подписи.`,
      cost: 0,
      days: EFFECT_DAYS,
      tariffBps: GRANT_BPS,
      qty: 0,
      good: "food",
    });
    return;
  }
}

function openExportShortage(state: SimState, house: House): void {
  const capital = worldOf(state, house.capitalId);
  if (!capital || foodCover(capital.population, capital.stock.food, state.rules.foodPer100) >= 10) return;
  const route = exportRoute(state, house);
  if (!route) return;
  const abroad = foreignExport(state, house, route);
  if (!abroad) return;
  const { world, good } = abroad;
  pushSituation(state, house, {
    kind: "exportShortage",
    otherId: world.ownerId && world.ownerId !== house.id ? world.ownerId : null,
    worldId: world.id,
    routeId: route.id,
    contractId: null,
    treatyId: null,
    shipId: null,
    cause: `Маршрут «${route.name}» вывозит ${GOOD_NAME[good]}, а столица сыта на ${foodCover(capital.population, capital.stock.food, state.rules.foodPer100)} дн.`,
    cost: FOOD_QTY * FOOD_PRICE,
    days: EFFECT_DAYS,
    tariffBps: 0,
    qty: FOOD_QTY,
    good,
  });
}

function pushSituation(state: SimState, house: House, draft: Omit<Situation, "id" | "status" | "houseId" | "openedTick" | "deadlineTick" | "choice">): void {
  if (!canOpen(state, house.id, draft.kind, draft.otherId)) return;
  const situation: Situation = {
    ...draft,
    id: serial(state, "q"),
    status: "open",
    houseId: house.id,
    openedTick: state.tick,
    deadlineTick: state.tick + DEADLINE,
    choice: null,
  };
  state.situations.push(situation);
  note(state, house.id, `${SITUATION_LABEL[situation.kind]}. ${situation.cause} Выбор до тика ${situation.deadlineTick}.`);
}

function canOpen(state: SimState, houseId: string, kind: SituationKind, otherId: string | null): boolean {
  const open = state.situations.filter((item) => item.houseId === houseId && item.status === "open");
  if (open.length >= OPEN_LIMIT) return false;
  if (open.some((item) => item.kind === kind)) return false;
  const other = otherId ?? "";
  const cool = state.cooldowns.find((item) => item.kind === kind && item.houseId === houseId && item.otherId === other);
  return !cool || cool.untilTick <= state.tick;
}

function rememberCooldown(state: SimState, situation: Situation): void {
  const otherId = situation.otherId ?? "";
  const untilTick = state.tick + COOLDOWN;
  const prior = state.cooldowns.find((item) => item.kind === situation.kind && item.houseId === situation.houseId && item.otherId === otherId);
  if (prior) prior.untilTick = untilTick;
  else state.cooldowns.push({ kind: situation.kind, houseId: situation.houseId, otherId, untilTick });
}

function putGrant(state: SimState, worldId: string, ownerId: string, beneficiaryId: string, bps: number, days: number): void {
  const prior = state.tariffGrants.find((item) => item.worldId === worldId && item.ownerId === ownerId && item.beneficiaryId === beneficiaryId);
  if (prior) {
    prior.bps = bps;
    prior.untilTick = state.tick + days;
    return;
  }
  const grant: TariffGrant = { id: serial(state, "g"), worldId, ownerId, beneficiaryId, bps, untilTick: state.tick + days };
  state.tariffGrants.push(grant);
}

function pay(state: SimState, from: House, to: House, amount: number): boolean {
  if (!moveCredits(state, { kind: "house", id: from.id }, { kind: "house", id: to.id }, amount)) return false;
  from.flow.purchases += amount;
  to.flow.compensation += amount;
  return true;
}

function recordSale(state: SimState, buyer: House, seller: House, amount: number): boolean {
  if (!moveCredits(state, { kind: "house", id: buyer.id }, { kind: "house", id: seller.id }, amount)) return false;
  buyer.flow.purchases += amount;
  seller.flow.sales += amount;
  rememberTrade(buyer, seller, amount);
  return true;
}

function sellerOwesCompensation(contract: { note: string }): boolean {
  return !contract.note.includes("свободных кредитов");
}

function portCargoBlock(world: World, ship: Ship, qty: number): string | null {
  if (!world.port.berth.includes(ship.id)) return "корабль не стоит у причала";
  if (ship.portAllowance - ship.portMoved < qty) return "лимит порта на сегодня исчерпан";
  return null;
}

function liveShip(state: SimState, ownerId: string, situation: Situation): Ship | undefined {
  const worldId = situation.worldId;
  if (!worldId) return undefined;
  const fits = (ship: Ship) =>
    ship.houseId === ownerId &&
    ship.worldId === worldId &&
    ship.status !== "transit" &&
    ship.status !== "building" &&
    SHIP_CLASSES[ship.classId].capacity - sumGoods(ship.cargo) >= situation.qty;
  const pinned = situation.shipId ? shipOf(state, situation.shipId) : undefined;
  if (pinned && fits(pinned)) return pinned;
  return state.ships.find(fits);
}

function cargoPurchaseBlock(state: SimState, buyer: House, seller: House | undefined, situation: Situation): string | null {
  if (!seller) return "нет продавца";
  const world = worldOf(state, situation.worldId);
  const ship = liveShip(state, buyer.id, situation);
  if (!world || world.ownerId !== seller.id) return "склад продавца недоступен";
  if (accessDenied(state, buyer.id, world)) return "эмбарго закрывает склад";
  if (!ship) return "свой корабль уже не стоит у склада";
  const portBlock = portCargoBlock(world, ship, situation.qty);
  if (portBlock) return portBlock;
  if (world.stock[situation.good] < situation.qty) return `на складе меньше ${situation.qty} ${GOOD_NAME[situation.good]}`;
  if (SHIP_CLASSES[ship.classId].capacity - sumGoods(ship.cargo) < situation.qty) return "в трюме нет места";
  if (availableCredits(buyer) < situation.cost) return `нужно ${situation.cost} свободных кредитов`;
  return null;
}

function moveCargoPurchase(state: SimState, buyer: House, seller: House | undefined, situation: Situation): string | null {
  const blocked = cargoPurchaseBlock(state, buyer, seller, situation);
  if (blocked || !seller) return blocked ?? "нет продавца";
  const world = worldOf(state, situation.worldId)!;
  const ship = liveShip(state, buyer.id, situation)!;
  if (!recordSale(state, buyer, seller, situation.cost)) return `нужно ${situation.cost} свободных кредитов`;
  capPort(ship, situation.qty);
  notePortMove(world, routeOf(state, ship.routeId), situation.qty);
  destroyGoods(world.stock, state.accounts, situation.good, situation.qty);
  createGoods(ship.cargo, state.accounts, situation.good, situation.qty);
  rememberSupply(ship, situation.good, seller.id, situation.qty);
  return null;
}

function visitorSaleBlock(state: SimState, seller: House, buyer: House | undefined, situation: Situation): string | null {
  if (!buyer) return "нет гостя";
  const world = worldOf(state, situation.worldId);
  const ship = buyer ? liveShip(state, buyer.id, situation) : undefined;
  if (!world || world.ownerId !== seller.id) return "нет нашего порта";
  if (accessDenied(state, buyer.id, world)) return "эмбарго закрывает порт";
  if (!ship || ship.houseId !== buyer.id || ship.worldId !== world.id || ship.status === "transit" || ship.status === "building") return "корабль гостя уже ушёл";
  const portBlock = portCargoBlock(world, ship, situation.qty);
  if (portBlock) return portBlock;
  if (world.stock.food < situation.qty) return `на складе меньше ${situation.qty} продовольствия`;
  if (SHIP_CLASSES[ship.classId].capacity - sumGoods(ship.cargo) < situation.qty) return "в трюме гостя нет места";
  if (availableCredits(buyer) < situation.cost) return "у гостя нет денег на продовольствие";
  return null;
}

function sellToVisitor(state: SimState, seller: House, buyer: House, situation: Situation): string | null {
  const blocked = visitorSaleBlock(state, seller, buyer, situation);
  if (blocked) return blocked;
  const world = worldOf(state, situation.worldId)!;
  const ship = liveShip(state, buyer.id, situation)!;
  if (!recordSale(state, buyer, seller, situation.cost)) return "у гостя нет денег на продовольствие";
  capPort(ship, situation.qty);
  notePortMove(world, routeOf(state, ship.routeId), situation.qty);
  destroyGoods(world.stock, state.accounts, "food", situation.qty);
  createGoods(ship.cargo, state.accounts, "food", situation.qty);
  rememberSupply(ship, "food", seller.id, situation.qty);
  return null;
}

function foodSuppliers(state: SimState, house: House): House[] {
  return state.houses.filter((other) => {
    if (other.id === house.id || house.embargo[other.id] || other.embargo[house.id]) return false;
    return Boolean(pantryOf(state, other.id));
  });
}

function pantryOf(state: SimState, houseId: string): World | undefined {
  return state.worlds
    .filter((world) => world.ownerId === houseId && world.stock.food >= 40)
    .sort((a, b) => b.stock.food - a.stock.food || (a.id < b.id ? -1 : 1))[0];
}

function dockedShip(state: SimState, houseId: string, worldId: string): Ship | undefined {
  return state.ships.find((ship) => ship.houseId === houseId && ship.worldId === worldId && ship.status === "docked");
}

function foreignShipAt(state: SimState, world: World, ownerId: string): Ship | undefined {
  const ids = [...world.port.berth, ...world.port.queue];
  for (const id of ids) {
    const ship = shipOf(state, id);
    if (ship && ship.houseId !== ownerId) return ship;
  }
  return undefined;
}

function foreignExport(state: SimState, house: House, route: Route): { world: World; good: GoodId } | undefined {
  for (const stop of route.stops) {
    const world = worldOf(state, stop.worldId);
    if (!world || world.ownerId === house.id) continue;
    const action = stop.actions.find((item) => (item.mode === "sell" || item.mode === "unload") && (item.good === "food" || item.good === "grain" || item.good === "ore"));
    if (action) return { world, good: action.good };
  }
  return undefined;
}

function exportRoute(state: SimState, house: House): Route | undefined {
  return state.routes.find((route) => {
    if (route.houseId !== house.id || route.paused) return false;
    return route.stops.some((stop) => {
      const world = worldOf(state, stop.worldId);
      if (!world || world.ownerId === house.id) return false;
      return stop.actions.some((action) => (action.mode === "sell" || action.mode === "unload") && (action.good === "food" || action.good === "grain" || action.good === "ore"));
    });
  });
}

function activeTreaty(state: SimState, aId: string, bId: string): boolean {
  return state.treaties.some(
    (treaty) =>
      (treaty.status === "active" || treaty.status === "proposed") &&
      ((treaty.proposerId === aId && treaty.targetId === bId) || (treaty.proposerId === bId && treaty.targetId === aId)),
  );
}

function contractReliability(state: SimState, aId: string, bId: string): number {
  const rows = state.contracts.filter((contract) => (contract.sellerId === aId && contract.buyerId === bId) || (contract.sellerId === bId && contract.buyerId === aId));
  let promised = 0;
  let got = 0;
  for (const contract of rows) {
    promised += contract.qtyPerWindow * contract.windows;
    const closed = contract.history.reduce((sum, item) => sum + item.delivered, 0);
    got += closed + (contract.status === "active" ? contract.delivered : 0);
  }
  if (promised <= 0) return 1;
  return got / promised;
}
