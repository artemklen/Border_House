import { foodCover } from "./mutate";
import type { CommandResult, House, SimState, World } from "./types";

export type LessonId = "supply" | "voyage" | "cash" | "contract" | "queue" | "development" | "politics";

export interface LessonView {
  id: LessonId;
  title: string;
  check: string;
  done: boolean;
  detail: string;
  focusWorldId: string | null;
}

const ORDER: LessonId[] = ["supply", "voyage", "cash", "contract", "queue", "development", "politics"];

const COPY: Record<LessonId, { title: string; check: string }> = {
  supply: {
    title: "Изучить снабжение",
    check: "День должен пройти: у своего мира появится съеденная или произведённая еда либо зерно. Кнопка «понятно» ничего не засчитывает.",
  },
  voyage: {
    title: "Организовать первый рейс",
    check: "Свой корабль должен сдвинуться с места: пройденный путь больше нуля или статус «в пути». Назначенный, но стоящий корабль не считается.",
  },
  cash: {
    title: "Прочитать чистый денежный поток",
    check: "В кассе дома есть ненулевая строка этого или прошлого окна: налоги, продажи, закупки, пошлины, содержание или стройка.",
  },
  contract: {
    title: "Выполнить коммерческий контракт",
    check: "По контракту, где дом продавец или покупатель, принята хотя бы одна единица. Само предложение не засчитывается.",
  },
  queue: {
    title: "Распознать очередь",
    check: "В очереди своего порта или у своего корабля есть место. Пустой причал цель не закрывает.",
  },
  development: {
    title: "Выбрать развитие мира",
    check: "У своего мира заложена перестройка или уже есть уровень пути. Чужой проект не считается.",
  },
  politics: {
    title: "Принять политическое решение",
    check: "Открытая ситуация дома закрыта выбором уступить, оплатить или отказать. Просрочка без выбора не засчитывается.",
  },
};

export function setTutorialSkipped(state: SimState, skipped: boolean): CommandResult {
  state.tutorial.skipped = skipped;
  return {
    ok: true,
    reason: skipped ? "Обучение скрыто. Казна и склады не изменились." : "Обучение снова на экране. Казна и склады не изменились.",
  };
}

export function lessonViews(state: SimState): LessonView[] {
  const house = state.houses.find((item) => item.player);
  return ORDER.map((id) => {
    const status = house ? lessonStatus(state, house, id) : { done: false, detail: "Нет дома игрока.", focusWorldId: null };
    return { id, title: COPY[id].title, check: COPY[id].check, ...status };
  });
}

export function nextLesson(state: SimState): LessonView | null {
  return lessonViews(state).find((lesson) => !lesson.done) ?? null;
}

function lessonStatus(state: SimState, house: House, id: LessonId): { done: boolean; detail: string; focusWorldId: string | null } {
  const owned = state.worlds.filter((world) => world.ownerId === house.id);
  const focus = owned[0]?.id ?? house.capitalId ?? null;
  if (id === "supply") {
    const world = owned.find((item) => item.eaten > 0 || item.lastEaten > 0 || item.produced.grain > 0 || item.produced.food > 0 || item.lastProduced.grain > 0 || item.lastProduced.food > 0);
    const capital = owned.find((item) => item.id === house.capitalId) ?? owned[0];
    const cover = capital ? foodCover(capital.population, capital.stock.food, state.rules.foodPer100) : 0;
    return {
      done: Boolean(world),
      detail: capital ? `Столица «${capital.name}»: еды на ${cover} дн. Формула: запас × 100 / (население × еда на 100).` : "Нет своего мира.",
      focusWorldId: (world ?? capital)?.id ?? focus,
    };
  }
  if (id === "voyage") {
    const ship = state.ships.find((item) => item.houseId === house.id && (item.traveled > 0 || item.status === "transit"));
    return {
      done: Boolean(ship),
      detail: ship ? `${ship.name}: пройдено ${ship.traveled}, статус ${ship.status}.` : "Свои корабли ещё стоят.",
      focusWorldId: ship?.worldId ?? focus,
    };
  }
  if (id === "cash") {
    const live = flowSum(house.flow);
    const past = flowSum(house.lastFlow);
    return {
      done: live > 0 || past > 0,
      detail: `Это окно ${live} кред. по строкам кассы, прошлое ${past}. Чистое окно — сумма строк, не один остаток казны.`,
      focusWorldId: focus,
    };
  }
  if (id === "contract") {
    const contract = state.contracts.find((item) => (item.sellerId === house.id || item.buyerId === house.id) && contractMoved(item));
    return {
      done: Boolean(contract),
      detail: contract ? `Контракт ${contract.id}: принято ${contract.delivered} в текущем окне, статус ${contract.status}.` : "Поставки по контракту ещё нет.",
      focusWorldId: contract?.worldId ?? focus,
    };
  }
  if (id === "queue") {
    const world = owned.find((item) => item.port.queue.length > 0);
    const waiting = state.ships.find((ship) => ship.houseId === house.id && state.worlds.some((item) => item.port.queue.includes(ship.id)));
    const where = world ?? (waiting?.worldId ? state.worlds.find((item) => item.id === waiting.worldId) : undefined);
    return {
      done: Boolean(world || waiting),
      detail: where ? `Очередь «${where.name}»: ${where.port.queue.length}.` : "Очередей с участием дома нет.",
      focusWorldId: where?.id ?? focus,
    };
  }
  if (id === "development") {
    const world = owned.find((item) => item.development.level > 0 || item.development.project);
    return {
      done: Boolean(world),
      detail: world ? developmentDetail(world) : "Путь ещё не выбран.",
      focusWorldId: world?.id ?? focus,
    };
  }
  const situation = state.situations.find((item) => item.houseId === house.id && item.status === "resolved" && item.choice);
  return {
    done: Boolean(situation),
    detail: situation ? `Решение «${situation.choice}» по ситуации ${situation.kind}.` : "Выбора по открытой ситуации ещё нет.",
    focusWorldId: situation?.worldId ?? focus,
  };
}

function flowSum(flow: House["flow"]): number {
  return flow.wages + flow.taxes + flow.sales + flow.purchases + flow.tariffsIn + flow.tariffsOut + flow.upkeep + flow.construction + flow.penalties + flow.compensation;
}

function contractMoved(contract: SimState["contracts"][number]): boolean {
  return contract.delivered > 0 || contract.history.some((item) => item.delivered > 0);
}

function developmentDetail(world: World): string {
  const project = world.development.project ? `, стройка ${world.development.project.path} ещё ${world.development.project.remainingDays} дн.` : "";
  return `«${world.name}»: путь ${world.development.path ?? "нет"}, уровень ${world.development.level}${project}.`;
}
