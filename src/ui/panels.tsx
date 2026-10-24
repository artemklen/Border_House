import { useEffect, useMemo, useRef, useState } from "react";
import { campaignBrief, createBorderContractScenario, createCrowdedHarborScenario, createIndustryDependenceScenario } from "../sim/campaign";
import { contractEstimate, contractRisks } from "../sim/contracts";
import { RECIPES, SHIP_CLASSES } from "../sim/config";
import { createGame } from "../sim/create";
import { GOODS, GOOD_NAME, holdLoad, type GoodId } from "../sim/goods";
import { contractStatusLabel, officeLine, personRoleLabel, shipStatusLabel, treatyStatusLabel } from "../sim/labels";
import { foodCover, houseOf, worldOf } from "../sim/mutate";
import { BERTH_COST, BERTH_PARTS, BERTH_UPKEEP, SPEED_COST, SPEED_PARTS, SPEED_UPKEEP, effectiveBerths, effectiveThroughput, portEstimate } from "../sim/port";
import { CHOICE_LABEL, SITUATION_LABEL, choicePreview, describeGoal } from "../sim/politics";
import { PATH_LABEL, developmentText, transitThroughputBonus } from "../sim/specialty";
import { lessonViews } from "../sim/tutorial";
import type { Command, DevelopmentPath, RouteStop, SimState, SituationChoice, StopAction } from "../sim/types";
import {
  bottlenecks,
  dependencyRows,
  explainBuilding,
  explainPrice,
  explainShip,
  foodPerDay,
  governorBlurb,
  treasuryOutlook,
  treasuryWarning,
  worldOwnerName,
} from "../sim/view";
import { Badge, Button, Card, Field, Hint, KpiTile, Meter, Tab } from "./components";
import { drawMap, frameCamera } from "./drawMap";
import { FLOW_LABELS, flowSign, groupInt, netFlow, signedInt } from "./format";
import { Icon, Seal } from "./icons";
import { previewVoyage } from "./voyage";

const MODE_LABEL = { load: "погрузка", unload: "выгрузка", buy: "покупка", sell: "продажа" } as const;

export function MenuScreen(props: {
  seed: number;
  worldCount: number;
  houseCount: number;
  onSeed: (value: number) => void;
  onWorlds: (value: number) => void;
  onHouses: (value: number) => void;
  onBase: () => void;
  onScenario: (kind: "border-contract" | "crowded-harbor" | "industry-dependence") => void;
  onCustom: () => void;
  onLoad: () => void;
  onImport: (raw: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const backdrop = useMemo(() => createGame({ seed: 21, scenario: "base" }), []);
  const briefs = useMemo(() => ({
    border: campaignBrief(createBorderContractScenario()),
    harbor: campaignBrief(createCrowdedHarborScenario()),
    industry: campaignBrief(createIndustryDependenceScenario()),
  }), []);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const paint = () => {
      if (canvas.clientWidth < 2) return;
      const camera = frameCamera(backdrop.worlds, canvas.clientWidth, canvas.clientHeight);
      drawMap(canvas, backdrop, camera, backdrop.houses.find((house) => house.player)?.capitalId ?? null, {
        paused: true,
        playerId: backdrop.houses.find((house) => house.player)?.id,
      });
    };
    paint();
    const frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [backdrop]);
  return (
    <main className="menu-screen">
      <canvas ref={canvasRef} className="menu-map" aria-hidden="true" />
      <div className="menu-card">
        <img src="/icons/game-crest.svg" width={56} height={56} alt="" />
        <div>
          <h1>Дома Пограничья</h1>
          <p className="lede">Торговый дом в пограничном секторе. Зерно становится едой только на мельнице, руда — сплавами, а груз доезжает сам. Короткий путь к богатому рынку лежит через чужую заставу.</p>
        </div>
        <section className="hero">
          <p className="caps">Рекомендуем для первой партии</p>
          <h2>Базовый сектор · 16 миров, 4 дома</h2>
          <p>Обучение в 7 шагов: снабжение, первый рейс, денежный поток, контракт, очередь, развитие мира, решение. Партия начнётся на паузе.</p>
          <div className="row">
            <Button variant="primary" onClick={props.onBase}>Новая партия</Button>
            <Button onClick={props.onLoad}>Продолжить</Button>
          </div>
        </section>
        <div className="scenario-grid">
          <ScenarioCard
            title="Контракт на границе"
            blurb="Лира платит за еду. Короткий путь пересекает заставу Веги, пошлина 9% от цены груза."
            goals={["принятая поставка", "столица сыта ≥ 12 дней", "выбран путь: пошлина или обход"]}
            hint={briefs.border?.text ?? ""}
            onPlay={() => props.onScenario("border-contract")}
          />
          <ScenarioCard
            title="Перегруженная гавань"
            blurb="Два чужих грузовоза ждут еду, которой на причале нет."
            goals={["чужой корабль занимает гавань", "ускорение порта или второй корабль", "верфь сыта ≥ 10 дней"]}
            hint={briefs.harbor?.text ?? ""}
            onPlay={() => props.onScenario("crowded-harbor")}
          />
          <ScenarioCard
            title="Промышленная зависимость"
            blurb="Руда есть только на Руднике, еда в основном у Нивы."
            goals={["промышленный путь или сплав", "рудник сыт ≥ 8 дней", "след торговли или чужая еда"]}
            hint={briefs.industry?.text ?? ""}
            onPlay={() => props.onScenario("industry-dependence")}
          />
        </div>
        <details className="card">
          <summary>Свой сектор</summary>
          <div className="stack">
            <Field label="Зерно seed"><input type="number" value={props.seed} onChange={(event) => props.onSeed(Number(event.target.value))} /></Field>
            <Field label="Миры 12–20"><input type="number" min={12} max={20} value={props.worldCount} onChange={(event) => props.onWorlds(Number(event.target.value))} /></Field>
            <Field label="Дома 3–4"><input type="number" min={3} max={4} value={props.houseCount} onChange={(event) => props.onHouses(Number(event.target.value))} /></Field>
            <div className="row">
              <Button onClick={props.onCustom}>Собрать сектор</Button>
              <label className="btn btn-secondary">
                Импорт файла
                <input aria-label="Импорт сохранения" hidden type="file" accept="application/json,.json" onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) file.text().then(props.onImport);
                }} />
              </label>
            </div>
          </div>
        </details>
      </div>
    </main>
  );
}

function ScenarioCard(props: { title: string; blurb: string; goals: string[]; hint: string; onPlay: () => void }) {
  return (
    <article className="scenario">
      <header className="card-head">
        <h2>{props.title}</h2>
        {props.hint ? <Hint text={props.hint} label={`Условия: ${props.title}`} /> : null}
      </header>
      <p>{props.blurb}</p>
      <ul className="goal-list">{props.goals.map((goal) => <li key={goal}>{goal}</li>)}</ul>
      <Button onClick={props.onPlay}>Открыть сценарий</Button>
    </article>
  );
}

export function LearnStrip(props: { sim: SimState; onSkip: () => void; onResume: () => void; onFocus: (worldId: string) => void }) {
  const brief = campaignBrief(props.sim);
  const lessons = lessonViews(props.sim);
  const current = lessons.find((lesson) => !lesson.done) ?? null;
  const done = lessons.filter((lesson) => lesson.done).length;
  if (props.sim.tutorial.skipped) {
    return (
      <div className="learn">
        <div className="row">
          <strong>Обучение скрыто</strong>
          <Button variant="ghost" onClick={props.onResume}>Вернуться к обучению</Button>
        </div>
      </div>
    );
  }
  const title = current?.title ?? "все шаги закрыты";
  return (
    <details className="learn">
      <summary>Обучение {done}/7 · {title}</summary>
      {current ? (
        <div className="stack">
          <p>{current.detail}</p>
          <p>{current.check}</p>
          {current.focusWorldId ? <Button variant="ghost" onClick={() => props.onFocus(current.focusWorldId!)}>Показать мир</Button> : null}
          <Button variant="ghost" onClick={props.onSkip}>Пропустить обучение</Button>
        </div>
      ) : <p>Все учебные цели закрыты состоянием партии. Наград нет.</p>}
      {brief ? <Hint text={`${brief.text} ${brief.measures.map((measure) => `${measure.title}: ${measure.value}. ${measure.formula}`).join(" ")}`} label="Цель сценария" /> : null}
    </details>
  );
}

export function WorldPanel(props: {
  sim: SimState;
  worldId: string;
  onSelect: (id: string) => void;
  onExpand: (kind: "berth" | "speed") => void;
  onDevelop: (path: DevelopmentPath) => void;
  onCancelDevelopment: () => void;
  onColonize: () => void;
}) {
  const world = worldOf(props.sim, props.worldId) ?? props.sim.worlds[0];
  const player = props.sim.houses.find((house) => house.player);
  const owned = world.ownerId === player?.id;
  const need = foodPerDay(world.population, props.sim.rules.foodPer100);
  const cover = foodCover(world.population, world.stock.food, props.sim.rules.foodPer100);
  const stored = Object.values(world.stock).reduce((sum, value) => sum + value, 0);
  const portText = `${portEstimate(world.port)} За окно обработано ${world.port.handled} ед. Транзитный путь добавляет ${transitThroughputBonus(world)} ед. и не открывает второй причал. Содержание причала ${BERTH_UPKEEP}, скорости ${SPEED_UPKEEP}. ${world.port.project ? `Стройка: ${world.port.project.kind === "berth" ? "причал" : "скорость"}, осталось ${world.port.project.remainingDays} дн.` : "Стройки нет."} ${world.port.upkeepPaid ? "Содержание оплачено." : "Содержание не оплачено: сегодня только базовый причал."}`;
  return (
    <div className="stack">
      <Field label="Мир">
        <select value={world.id} onChange={(event) => props.onSelect(event.target.value)}>
          {props.sim.worlds.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </Field>
      <header className="card-head">
        <h2>{world.name}</h2>
        <span className="muted">{worldOwnerName(props.sim, world)}</span>
      </header>
      <div className="tiles">
        <div className="tile"><span>Население</span><strong className="num">{groupInt(world.population)}</strong></div>
        <div className="tile"><span>Еда</span><strong className="num">{cover >= 999 ? "—" : `${cover} дн.`}</strong><span>{need} ед./день</span></div>
        <div className="tile"><span>Склад</span><strong className="num">{groupInt(stored)} / {groupInt(world.capacity)}</strong></div>
        <div className="tile"><span>Порт</span><strong className="num">{effectiveBerths(world.port)} прич.</strong><span>до {effectiveThroughput(world.port)} ед./день <Hint text={portText} label="Порт" /></span></div>
        <div className="tile"><span>Пошлина</span><strong className="num">{world.tariffBps / 100}%</strong></div>
        <div className="tile"><span>Удовлетворённость</span><strong className="num">{world.satisfaction}</strong><Hint text={governorBlurb(props.sim, world)} label="Губернатор" /></div>
      </div>
      <p className="muted">У причала: {world.port.berth.map((id) => props.sim.ships.find((ship) => ship.id === id)?.name ?? id).join(", ") || "пусто"}. Очередь: {world.port.queue.map((id, index) => `${index + 1}. ${props.sim.ships.find((ship) => ship.id === id)?.name ?? id}`).join("; ") || "нет"}.</p>
      <Hint text={developmentText(world)} label="Развитие мира" />
      {owned ? (
        <div className="row">
          {(["agrarian", "industrial", "transit"] as const).map((path) => (
            <Button key={path} onClick={() => props.onDevelop(path)}>{PATH_LABEL[path]} путь</Button>
          ))}
          {world.development?.project ? <Button onClick={props.onCancelDevelopment}>Отменить перестройку</Button> : null}
          <Button onClick={() => props.onExpand("berth")}>Причал, {BERTH_COST} кред. и {BERTH_PARTS} компл.</Button>
          <Button onClick={() => props.onExpand("speed")}>Скорость, {SPEED_COST} кред. и {SPEED_PARTS} компл.</Button>
        </div>
      ) : null}
      {!world.ownerId ? <Button variant="primary" onClick={props.onColonize}>Готовить колонию</Button> : null}
      <table>
        <tbody>
          {GOODS.map((good) => (
            <tr key={good}>
              <th>{GOOD_NAME[good]}</th>
              <td className="num">{world.stock[good]} ед.</td>
              <td className="num">{world.prices[good]} кред.</td>
              <td><Hint text={explainPrice(props.sim, world.id, good)} label={`Почему цена: ${GOOD_NAME[good]}`} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BuildPanel(props: {
  sim: SimState;
  houseId: string;
  worldId: string;
  onPreview: (kind: keyof typeof RECIPES) => void;
  onShip: (classId: keyof typeof SHIP_CLASSES) => void;
  onToggle: (buildingId: string, enabled: boolean) => void;
}) {
  const world = worldOf(props.sim, props.worldId);
  const owned = world?.ownerId === props.houseId;
  return (
    <div className="stack">
      <p>{owned ? "Стройка только в своём мире." : "Чужой мир: предприятия можно смотреть."}</p>
      {owned ? (
        <>
          <div className="row">
            {(Object.keys(RECIPES) as Array<keyof typeof RECIPES>).map((kind) => (
              <Button key={kind} onClick={() => props.onPreview(kind)}>{RECIPES[kind].name}, {RECIPES[kind].parts} компл.</Button>
            ))}
          </div>
          <div className="row">
            {(Object.keys(SHIP_CLASSES) as Array<keyof typeof SHIP_CLASSES>).map((classId) => (
              <Button key={classId} onClick={() => props.onShip(classId)}>{SHIP_CLASSES[classId].name}</Button>
            ))}
          </div>
        </>
      ) : null}
      {world?.buildings.map((building) => (
        <Card key={building.id} title={RECIPES[building.kind].name} extra={<Hint text={explainBuilding(props.sim, building.id)} label="Почему так" />}>
          <p>{building.remainingDays > 0 ? `строится ${building.remainingDays} дн.` : building.stopReason ?? "работает"}</p>
          {building.ownerId === props.houseId ? (
            <Button onClick={() => props.onToggle(building.id, !building.enabled)}>{building.enabled ? "Остановить" : "Запустить"}</Button>
          ) : null}
        </Card>
      ))}
    </div>
  );
}

export function FleetPanel(props: {
  sim: SimState;
  houseId: string;
  shipId: string;
  simple: boolean;
  draftName: string;
  minLoad: number;
  maxWait: number;
  stops: RouteStop[];
  stopWorld: string;
  action: StopAction;
  onShip: (id: string) => void;
  onName: (value: string) => void;
  onMinLoad: (value: number) => void;
  onMaxWait: (value: number) => void;
  onStopWorld: (id: string) => void;
  onAction: (action: StopAction) => void;
  onAddStop: () => void;
  onAddAction: () => void;
  onRemoveStop: (index: number) => void;
  onClear: () => void;
  onCreate: () => void;
  onCreateSimple: (draft: { shipId: string; fromId: string; toId: string; good: GoodId; amount: number; mode: StopAction["mode"]; price: number; keep: number; minLoad: number; maxWait: number }) => void;
  onPause: (routeId: string, paused: boolean) => void;
  onAssign: (shipId: string, routeId: string | null) => void;
  onUpdate: (routeId: string) => void;
  onLoadRoute: (routeId: string) => void;
}) {
  const ships = props.sim.ships.filter((ship) => ship.houseId === props.houseId && ship.status !== "building");
  const routes = props.sim.routes.filter((route) => route.houseId === props.houseId);
  const selected = ships.find((ship) => ship.id === props.shipId) ?? ships[0];
  return (
    <>
      <div className="stack">
        {ships.map((ship) => <ShipCard key={ship.id} sim={props.sim} ship={ship} selected={ship.id === selected?.id} onShip={() => props.onShip(ship.id)} />)}
        {props.simple ? (
          <FirstVoyage sim={props.sim} houseId={props.houseId} shipId={selected?.id ?? ""} onCreate={props.onCreateSimple} />
        ) : (
          <RouteEditor {...props} ship={selected} />
        )}
        {routes.map((route) => (
          <Card key={route.id} title={route.name} extra={<Badge tone={route.paused ? "warn" : "ok"}>{route.paused ? "на паузе" : "идёт"}</Badge>}>
            <table>
              <thead><tr><th></th><th>это окно</th><th>прошлое</th></tr></thead>
              <tbody>
                <tr><th>выручка</th><td className="num">{groupInt(route.revenue)}</td><td className="num">{groupInt(route.lastRevenue)}</td></tr>
                <tr><th>расход</th><td className="num">{groupInt(route.cost)}</td><td className="num">{groupInt(route.lastCost)}</td></tr>
                <tr><th>топливо</th><td className="num">{groupInt(route.fuelUsed)}</td><td className="num">{groupInt(route.lastFuelUsed)}</td></tr>
                <tr><th>груз</th><td className="num">{groupInt(route.movedWindow)}</td><td className="num">{groupInt(route.lastMoved)}</td></tr>
              </tbody>
            </table>
            <p>В пути {route.daysFlying} дн., у причала {route.daysPort}, в очереди {route.daysWaiting}.</p>
            <div className="card-head">
              <span className="muted">минимум {route.minLoad}, ждать {route.maxWait} дн.</span>
              <Hint text={props.sim.ships.find((ship) => ship.routeId === route.id) ? explainShip(props.sim, props.sim.ships.find((ship) => ship.routeId === route.id)!.id) : "Корабль на этом маршруте пока не назначен."} label="Почему рейс такой" />
            </div>
            <div className="row">
              <Button onClick={() => props.onLoadRoute(route.id)}>В черновик</Button>
              <Button onClick={() => props.onUpdate(route.id)}>Записать черновик</Button>
              <Button onClick={() => props.onPause(route.id, !route.paused)}>{route.paused ? "Снять паузу" : "Пауза маршрута"}</Button>
              <Button onClick={() => selected && props.onAssign(selected.id, route.id)} disabled={!selected}>Назначить корабль</Button>
            </div>
          </Card>
        ))}
      </div>
      {props.simple ? null : (
        <div className="panel-foot">
          <Button variant="primary" onClick={props.onCreate}>Проложить маршрут</Button>
          <Button variant="ghost" onClick={props.onClear}>Очистить</Button>
        </div>
      )}
    </>
  );
}

function ShipCard(props: { sim: SimState; ship: SimState["ships"][number]; selected: boolean; onShip: () => void }) {
  const shipClass = SHIP_CLASSES[props.ship.classId];
  const held = holdLoad(props.ship.cargo);
  const destination = props.ship.status === "transit" && props.ship.toId
    ? `к ${worldOf(props.sim, props.ship.toId)?.name ?? "миру"}, осталось ≈ ${Math.max(1, Math.ceil(props.ship.distanceLeft / shipClass.speed))} дн.`
    : props.ship.stopReason;
  return (
    <Card title={props.ship.name} extra={<Badge tone={props.ship.status === "blocked" ? "error" : props.ship.status === "transit" ? "info" : "neutral"}>{shipStatusLabel(props.ship.status)}</Badge>}>
      {destination ? <p>{destination}</p> : null}
      <div className="hold">
        <Icon name="good-food" size={18} />
        <span className="num">{held === 0 ? "пусто" : `${held}/${shipClass.capacity}`}</span>
        <Meter value={held} max={shipClass.capacity} label={`Трюм ${held} из ${shipClass.capacity}`} />
      </div>
      <div className="hold">
        <Icon name="good-fuel" size={18} />
        <span className="num">{props.ship.cargo.fuel}/{shipClass.capacity}</span>
        <Meter value={props.ship.cargo.fuel} max={shipClass.capacity} label={`Бак ${props.ship.cargo.fuel} из ${shipClass.capacity}`} />
      </div>
      <div className="card-head">
        <Button variant={props.selected ? "primary" : "secondary"} pressed={props.selected} onClick={props.onShip}>Выбрать</Button>
        <Hint text={explainShip(props.sim, props.ship.id)} label="Почему рейс такой" />
      </div>
    </Card>
  );
}

function FirstVoyage(props: {
  sim: SimState;
  houseId: string;
  shipId: string;
  onCreate: (draft: { shipId: string; fromId: string; toId: string; good: GoodId; amount: number; mode: StopAction["mode"]; price: number; keep: number; minLoad: number; maxWait: number }) => void;
}) {
  const player = props.sim.houses.find((house) => house.id === props.houseId);
  const capital = player?.capitalId ?? "";
  const [fromId, setFromId] = useState(props.sim.worlds.some((world) => world.id === "w-bread") ? "w-bread" : props.sim.worlds[0]?.id ?? "");
  const [toId, setToId] = useState(capital && capital !== "w-bread" ? capital : props.sim.worlds.find((world) => world.id !== fromId)?.id ?? "");
  const [good, setGood] = useState<GoodId>("food");
  const [amount, setAmount] = useState(40);
  const [mode, setMode] = useState<StopAction["mode"]>("unload");
  const [price, setPrice] = useState(0);
  const [keep, setKeep] = useState(0);
  const [minLoad, setMinLoad] = useState(0);
  const [maxWait, setMaxWait] = useState(0);
  const ship = props.sim.ships.find((item) => item.id === props.shipId);
  const preview = ship ? previewVoyage(props.sim, ship, fromId, toId, good, amount) : null;
  const shipClass = ship ? SHIP_CLASSES[ship.classId] : null;
  return (
    <>
      <Card title="Первый рейс">
        <Field label="Откуда">
          <select value={fromId} onChange={(event) => setFromId(event.target.value)}>
            {props.sim.worlds.map((world) => <option key={world.id} value={world.id}>{world.name}</option>)}
          </select>
        </Field>
        <Field label="Куда">
          <select value={toId} onChange={(event) => setToId(event.target.value)}>
            {props.sim.worlds.map((world) => <option key={world.id} value={world.id}>{world.name}</option>)}
          </select>
        </Field>
        <Field label="Товар">
          <select value={good} onChange={(event) => setGood(event.target.value as GoodId)}>
            {GOODS.map((item) => <option key={item} value={item}>{GOOD_NAME[item]}</option>)}
          </select>
        </Field>
        <Field label="Сколько"><input type="number" value={amount} onChange={(event) => setAmount(Number(event.target.value))} /></Field>
        {ship && shipClass ? <p className="muted">Трюм {holdLoad(ship.cargo)}/{shipClass.capacity}. Бак {ship.cargo.fuel}/{shipClass.capacity}.</p> : null}
        <details>
          <summary>Дополнительно</summary>
          <div className="stack">
            <Field label="На месте">
              <select value={mode} onChange={(event) => setMode(event.target.value as StopAction["mode"])}>
                <option value="unload">выгрузить своё</option>
                <option value="sell">продать</option>
                <option value="load">погрузить своё</option>
                <option value="buy">купить</option>
              </select>
            </Field>
            <Field label="Предел цены"><input type="number" value={price} onChange={(event) => setPrice(Number(event.target.value))} /></Field>
            <Field label="Резерв"><input type="number" value={keep} onChange={(event) => setKeep(Number(event.target.value))} /></Field>
            <Field label="Минимум груза без топлива"><input type="number" value={minLoad} onChange={(event) => setMinLoad(Number(event.target.value))} /></Field>
            <Field label="Ждать, дней"><input type="number" value={maxWait} onChange={(event) => setMaxWait(Number(event.target.value))} /></Field>
          </div>
        </details>
        {preview ? (
          <div className="stack">
            <p>{preview.fromName} → {preview.toName}, ≈ {preview.days} дн.</p>
            <p>Топливо из бака {preview.fuelNeed} / есть {preview.fuelHave}.</p>
            <p>Пошлины: {preview.tolls.length === 0 ? "нет" : preview.tolls.map((toll) => `${toll.name} ${groupInt(toll.fee)}`).join(", ")}.</p>
            <p>Еда «{preview.capitalName}»: {preview.capitalDaysNow} дн. сейчас, ≈ {preview.capitalDaysArrive} дн. к прибытию.</p>
            <p className="muted">{preview.note}</p>
          </div>
        ) : null}
      </Card>
      <div className="panel-foot">
        <Button variant="primary" disabled={!ship} onClick={() => ship && props.onCreate({ shipId: ship.id, fromId, toId, good, amount, mode, price, keep, minLoad, maxWait })}>Отправить рейс</Button>
      </div>
    </>
  );
}

function RouteEditor(props: {
  sim: SimState;
  draftName: string;
  minLoad: number;
  maxWait: number;
  stops: RouteStop[];
  stopWorld: string;
  action: StopAction;
  ship?: SimState["ships"][number];
  onName: (value: string) => void;
  onMinLoad: (value: number) => void;
  onMaxWait: (value: number) => void;
  onStopWorld: (id: string) => void;
  onAction: (action: StopAction) => void;
  onAddStop: () => void;
  onAddAction: () => void;
  onRemoveStop: (index: number) => void;
}) {
  const shipClass = props.ship ? SHIP_CLASSES[props.ship.classId] : null;
  return (
    <Card title="Редактор маршрута">
      <p>Изменения начнутся после текущего перегона. Груз сам не переносится.</p>
      <Field label="Название"><input value={props.draftName} onChange={(event) => props.onName(event.target.value)} /></Field>
      <Field label="Корабль">
        <span className="muted">{props.ship ? props.ship.name : "не выбран"}</span>
      </Field>
      {props.ship && shipClass ? <p className="num">Трюм {holdLoad(props.ship.cargo)}/{shipClass.capacity}. Бак {props.ship.cargo.fuel}/{shipClass.capacity}.</p> : null}
      <Field label="Мир остановки">
        <select value={props.stopWorld} onChange={(event) => props.onStopWorld(event.target.value)}>
          {props.sim.worlds.map((world) => <option key={world.id} value={world.id}>{world.name}</option>)}
        </select>
      </Field>
      <Button onClick={props.onAddStop}>Добавить остановку</Button>
      <div className="row">
        <select aria-label="Товар правила" value={props.action.good} onChange={(event) => props.onAction({ ...props.action, good: event.target.value as GoodId })}>
          {GOODS.map((good) => <option key={good} value={good}>{GOOD_NAME[good]}</option>)}
        </select>
        <select aria-label="Действие правила" value={props.action.mode} onChange={(event) => props.onAction({ ...props.action, mode: event.target.value as StopAction["mode"] })}>
          <option value="load">погрузить своё</option>
          <option value="unload">выгрузить своё</option>
          <option value="buy">купить</option>
          <option value="sell">продать</option>
        </select>
        <Field label="Количество"><input type="number" value={props.action.amount} onChange={(event) => props.onAction({ ...props.action, amount: Number(event.target.value) })} /></Field>
      </div>
      <Button onClick={props.onAddAction}>Добавить правило на последнюю остановку</Button>
      <ol>
        {props.stops.map((stop, index) => (
          <li key={`${stop.worldId}-${index}`}>
            {worldOf(props.sim, stop.worldId)?.name}: {stop.actions.map((item) => `${MODE_LABEL[item.mode]} ${item.amount} ${GOOD_NAME[item.good]}`).join("; ") || "без правил"}
            <Button variant="ghost" onClick={() => props.onRemoveStop(index)}>Убрать</Button>
          </li>
        ))}
      </ol>
      <details>
        <summary>Дополнительно</summary>
        <div className="stack">
          <Field label="Предел цены"><input type="number" value={props.action.price} onChange={(event) => props.onAction({ ...props.action, price: Number(event.target.value) })} /></Field>
          <Field label="Резерв"><input type="number" value={props.action.keep} onChange={(event) => props.onAction({ ...props.action, keep: Number(event.target.value) })} /></Field>
          <Field label="Минимум груза без топлива" hint="0 — уходит с тем, что успел взять."><input type="number" value={props.minLoad} onChange={(event) => props.onMinLoad(Number(event.target.value))} /></Field>
          <Field label="Ждать, дней"><input type="number" value={props.maxWait} onChange={(event) => props.onMaxWait(Number(event.target.value))} /></Field>
        </div>
      </details>
    </Card>
  );
}

export function CashPanel(props: { sim: SimState; houseId: string }) {
  const house = houseOf(props.sim, props.houseId)!;
  const outlook = treasuryOutlook(props.sim, house.id);
  const warning = treasuryWarning(props.sim, house.id);
  const current = netFlow(house.flow);
  const past = netFlow(house.lastFlow);
  const rows = FLOW_LABELS.filter(([key]) => house.flow[key] !== 0 || house.lastFlow[key] !== 0);
  return (
    <div className="stack">
      <div className="kpis">
        <KpiTile label="Баланс" value={`${groupInt(house.credits)} кред.`} />
        <KpiTile label="Свободно" value={`${groupInt(house.credits - house.reserved)} кред.`} sub={`резерв ${groupInt(house.reserved)}`} />
        <KpiTile label="Хватит на" value={outlook ? `≈ ${outlook.runway} дн.` : "—"} sub="при расходе этого окна" />
        <KpiTile label="Итог окна" value={`${signedInt(current)} кред.`} tone={current < 0 ? "error" : "neutral"} sub={`прошлое ${signedInt(past)}`} />
      </div>
      {warning ? <Hint text={warning} label="Как посчитан запас казны" /> : null}
      <p className="muted">Окно {house.flowDays} / {props.sim.rules.window} дн. Резерв в казне есть, второй раз его не потратить.</p>
      <table>
        <tbody>
          {rows.map(([key, label]) => {
            const now = house.flow[key] * flowSign(key);
            const last = house.lastFlow[key] * flowSign(key);
            return (
              <tr key={key}>
                <th>{label}</th>
                <td className={now < 0 ? "neg num" : "num"}>{signedInt(now)}</td>
                <td className={last < 0 ? "neg num" : "num"}>{signedInt(last)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function GapPanel(props: { sim: SimState; houseId: string }) {
  const items = bottlenecks(props.sim, props.houseId);
  if (items.length === 0) return <p>Явных остановок нет. Дни еды смотрите на мирах.</p>;
  return (
    <div className="stack">
      {items.map((item) => (
        <Card key={`${item.title}-${item.detail}`} title={item.title}>
          <p>{item.detail}</p>
        </Card>
      ))}
    </div>
  );
}

export function DealPanel(props: {
  sim: SimState;
  houseId: string;
  otherId: string;
  tariff: number;
  treatyQty: number;
  treatyTariff: number;
  worldId: string;
  onOther: (id: string) => void;
  onTariff: (value: number) => void;
  onQty: (value: number) => void;
  onTreatyTariff: (value: number) => void;
  onSetTariff: (worldId: string) => void;
  onEmbargo: (otherId: string, embargo: boolean) => void;
  onPropose: (otherId: string) => void;
  onRespond: (treatyId: string, accept: boolean) => void;
  onCommand: (command: Command) => void;
}) {
  const [good, setGood] = useState<GoodId>("food");
  const [qty, setQty] = useState(8);
  const [windows, setWindows] = useState(2);
  const [price, setPrice] = useState(10);
  const [shortfall, setShortfall] = useState(1);
  const [deposit, setDeposit] = useState(20);
  const [destination, setDestination] = useState("");
  const [openId, setOpenId] = useState(props.otherId);
  const house = houseOf(props.sim, props.houseId)!;
  const others = props.sim.houses.filter((item) => item.id !== house.id);
  const expanded = others.some((item) => item.id === openId) ? openId : others[0]?.id ?? "";
  const lines = dependencyRows(props.sim, house);
  const buyerWorlds = props.sim.worlds.filter((world) => world.ownerId === expanded);
  const buyerWorldId = buyerWorlds.some((world) => world.id === destination) ? destination : buyerWorlds[0]?.id ?? "";
  const preview = buyerWorldId ? contractEstimate(props.sim, house.id, expanded, good, buyerWorldId, qty, windows, price, deposit) : null;
  return (
    <>
      <div className="stack">
        {others.map((other) => {
          const line = lines.find((item) => item.startsWith(other.name)) ?? `${other.name}: отношения ${house.relation[other.id] ?? 0}.`;
          const open = other.id === expanded;
          return (
            <Card key={other.id} title={other.name} extra={<Seal crest={other.crest} size={24} />}>
              <div className="card-head">
                <p>{house.embargo[other.id] ? "эмбарго" : `отношения ${house.relation[other.id] ?? 0}`}</p>
                <Hint text={line} label={`Отношения с ${other.name}`} />
              </div>
              <Button variant={open ? "primary" : "secondary"} pressed={open} onClick={() => { setOpenId(other.id); props.onOther(other.id); }}>{open ? "Карточка открыта" : "Открыть"}</Button>
              {open ? (
                <div className="stack">
                  <div className="row">
                    <Button
                      variant="danger"
                      confirm={{ title: `Эмбарго: ${other.name}`, lines: ["Торговля и новые договоры с этим домом остановятся. Уже идущие рейсы дом не отзывает сам."] }}
                      onClick={() => props.onEmbargo(other.id, true)}
                    >Эмбарго</Button>
                    <Button onClick={() => props.onEmbargo(other.id, false)}>Открыть доступ</Button>
                  </div>
                  <Field label="Пошлина своего мира, б.п."><input type="number" value={props.tariff} onChange={(event) => props.onTariff(Number(event.target.value))} /></Field>
                  <Button onClick={() => props.onSetTariff(props.worldId)}>Поставить пошлину</Button>
                  <Field label="Продовольствие за окно"><input type="number" value={props.treatyQty} onChange={(event) => props.onQty(Number(event.target.value))} /></Field>
                  <Field label="Просимая пошлина, б.п."><input type="number" value={props.treatyTariff} onChange={(event) => props.onTreatyTariff(Number(event.target.value))} /></Field>
                  <Button onClick={() => props.onPropose(other.id)}>Предложить скидку за поставки</Button>
                  <h3>Контракт</h3>
                  <Field label="Товар">
                    <select value={good} onChange={(event) => setGood(event.target.value as GoodId)}>
                      {GOODS.map((item) => <option key={item} value={item}>{GOOD_NAME[item]}</option>)}
                    </select>
                  </Field>
                  <Field label="Мир покупателя">
                    <select value={buyerWorldId} onChange={(event) => setDestination(event.target.value)}>
                      {buyerWorlds.map((world) => <option key={world.id} value={world.id}>{world.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Объём за окно"><input type="number" value={qty} onChange={(event) => setQty(Number(event.target.value))} /></Field>
                  <Field label="Окон, 2–6"><input type="number" value={windows} onChange={(event) => setWindows(Number(event.target.value))} /></Field>
                  <Field label="Цена за единицу"><input type="number" value={price} onChange={(event) => setPrice(Number(event.target.value))} /></Field>
                  <Field label="Недовоз"><input type="number" value={shortfall} onChange={(event) => setShortfall(Number(event.target.value))} /></Field>
                  <Field label="Залог"><input type="number" value={deposit} onChange={(event) => setDeposit(Number(event.target.value))} /></Field>
                  {preview ? (
                    <div className="tiles">
                      <div className="tile"><span>выручка</span><strong className="num">{groupInt(preview.revenue)}</strong></div>
                      <div className="tile"><span>дней пути</span><strong className="num">{preview.voyageDays}</strong></div>
                      <div className="tile"><span>рейсов</span><strong className="num">{preview.trips}</strong></div>
                      <div className="tile"><span>трюм</span><strong className="num">{preview.capacity}</strong></div>
                    </div>
                  ) : null}
                  {preview ? <Hint text={preview.assumptions.join(" ")} label="Допущения оценки" /> : null}
                </div>
              ) : null}
            </Card>
          );
        })}
        {props.sim.treaties.map((treaty) => (
          <Card key={treaty.id} title={treatyStatusLabel(treaty.status)}>
            <p>{treaty.note}</p>
            <p>Поставлено {treaty.delivered} / {treaty.qtyPerWindow}. До дня {treaty.endTick}.</p>
            {treaty.status === "proposed" && treaty.targetId === house.id ? (
              <div className="row">
                <Button onClick={() => props.onRespond(treaty.id, true)}>Принять</Button>
                <Button variant="danger" confirm={{ title: "Отказать в договоре", lines: ["Предложение будет отклонено."] }} onClick={() => props.onRespond(treaty.id, false)}>Отказать</Button>
              </div>
            ) : null}
          </Card>
        ))}
        {props.sim.contracts.map((contract) => {
          const seller = props.sim.houses.find((item) => item.id === contract.sellerId);
          const buyer = props.sim.houses.find((item) => item.id === contract.buyerId);
          const place = props.sim.worlds.find((item) => item.id === contract.worldId);
          return (
            <Card key={contract.id} title={`${seller?.name ?? "продавец"} → ${buyer?.name ?? "покупатель"}`} extra={<Badge>{contractStatusLabel(contract.status)}</Badge>}>
              <p>{GOOD_NAME[contract.good]} в «{place?.name ?? "мир"}». Принято {contract.delivered} / {contract.qtyPerWindow}.</p>
              <Meter value={contract.delivered} max={Math.max(1, contract.qtyPerWindow)} label={`Принято ${contract.delivered} из ${contract.qtyPerWindow}`} />
              <p className="muted">Окно {contract.windowIndex + 1} / {contract.windows}, день {contract.windowDays} / {props.sim.rules.window}.</p>
              <details>
                <summary>Подробнее</summary>
                <p>{contract.note}</p>
                <p>{contractRisks(props.sim, contract).join(" ")}</p>
                {contract.history.length > 0 ? <p>Прошлые окна: {contract.history.map((item) => `${item.delivered} ед., оплата ${item.paid}, штраф ${item.penalty}`).join("; ")}.</p> : null}
                {contract.trades.length > 0 ? <p>Приёмки: {contract.trades.map((item) => `день ${item.tick} ${item.qty} по ${item.price}`).join("; ")}.</p> : null}
              </details>
              {contract.status === "proposed" && contract.buyerId === house.id ? (
                <div className="row">
                  <Button onClick={() => props.onCommand({ type: "respondContract", houseId: house.id, contractId: contract.id, accept: true })}>Принять контракт</Button>
                  <Button variant="danger" confirm={{ title: "Отклонить контракт", lines: ["Предложение будет закрыто без поставки."] }} onClick={() => props.onCommand({ type: "respondContract", houseId: house.id, contractId: contract.id, accept: false })}>Отклонить</Button>
                </div>
              ) : null}
              {contract.status === "proposed" || contract.status === "active" ? (
                <Button variant="danger" confirm={{ title: "Отменить контракт", lines: ["Дальнейшие приёмки по этому контракту остановятся."] }} onClick={() => props.onCommand({ type: "cancelContract", houseId: house.id, contractId: contract.id })}>Отменить контракт</Button>
              ) : null}
            </Card>
          );
        })}
      </div>
      <div className="panel-foot">
        <Button variant="primary" disabled={!buyerWorldId} onClick={() => props.onCommand({
          type: "proposeContract",
          sellerId: house.id,
          buyerId: expanded,
          good,
          worldId: buyerWorldId,
          qtyPerWindow: qty,
          windows,
          price,
          shortfall,
          deposit,
        })}>Предложить контракт</Button>
      </div>
    </>
  );
}

export function PoliticsPanel(props: {
  sim: SimState;
  houseId: string;
  onChoose: (situationId: string, choice: SituationChoice) => void;
  onRefuse: (situationId: string) => void;
  onWorld: (worldId: string) => void;
  onDeals: () => void;
}) {
  const house = props.sim.houses.find((item) => item.id === props.houseId);
  const goal = house ? describeGoal(props.sim, house) : null;
  const open = props.sim.situations.filter((item) => item.houseId === props.houseId && item.status === "open");
  return (
    <div className="stack">
      <Card title="Цель дома"><p>{goal ? `${goal.title}. ${goal.reason}` : "Дом не выбран."}</p></Card>
      {open.length === 0 ? <p>Открытых решений нет.</p> : null}
      {open.map((situation) => (
        <Card key={situation.id} title={SITUATION_LABEL[situation.kind]} extra={<Badge tone="warn">осталось {Math.max(0, situation.deadlineTick - props.sim.tick)} дн.</Badge>}>
          <div className="card-head">
            <p>{situation.cause}</p>
            <Hint text="Пауза срок не тратит. Повторное нажатие после выбора казну не списывает." label="Срок решения" />
          </div>
          <div className="choices">
            <Button onClick={() => props.onChoose(situation.id, "yield")}>{CHOICE_LABEL.yield}</Button>
            <Button onClick={() => props.onChoose(situation.id, "pay")}>{CHOICE_LABEL.pay}</Button>
            <Button
              variant="danger"
              confirm={{ title: `${SITUATION_LABEL[situation.kind]}: ${CHOICE_LABEL.refuse}`, lines: choicePreview(situation, "refuse") }}
              onClick={() => props.onRefuse(situation.id)}
            >{CHOICE_LABEL.refuse}</Button>
          </div>
          <div className="row">
            {situation.worldId ? <Button variant="ghost" onClick={() => props.onWorld(situation.worldId!)}>К миру</Button> : null}
            {situation.treatyId || situation.contractId ? <Button variant="ghost" onClick={props.onDeals}>К договору</Button> : null}
          </div>
        </Card>
      ))}
    </div>
  );
}

export function HousePanel(props: { sim: SimState; houseId: string; onAppoint: (worldId: string, personId: string) => void }) {
  const people = props.sim.people.filter((person) => person.houseId === props.houseId);
  const head = people.find((person) => person.alive && person.role === "head");
  const heir = people.find((person) => person.alive && person.role === "heir");
  const years = props.sim.rules.ticksPerYear;
  return (
    <div className="stack">
      <p>{head ? officeLine("Глава", head.name, "Глава: нет") : "Глава: нет"}{head ? `, ${Math.floor(head.ageDays / years)} лет` : ""}. {heir ? officeLine("Наследник", heir.name, "Наследник: не назначен") : "Наследник: не назначен"}.</p>
      <Hint text="Смерть главы не обнуляет казну. Если наследника нет, дом берёт губернатор с наибольшей лояльностью, иначе старшая родня, иначе регент." label="Как сменяется глава" />
      {people.map((person) => (
        <Card key={person.id} title={person.name}>
          <p>{person.alive ? personRoleLabel(person.role) : "умер"}, {Math.floor(person.ageDays / years)} лет. Черты: {person.traits.join(", ") || "нет"}.</p>
          <div className="hold">
            <span className="muted">лояльность</span>
            <span className="num">{person.loyalty}</span>
            <Meter value={person.loyalty} max={100} label={`Лояльность ${person.loyalty}`} />
          </div>
        </Card>
      ))}
      <Appoint governorId={people.find((person) => person.alive && person.role !== "head")?.id ?? ""} worlds={props.sim.worlds.filter((world) => world.ownerId === props.houseId)} people={people.filter((person) => person.alive && person.role !== "head")} onAppoint={props.onAppoint} />
    </div>
  );
}

function Appoint(props: {
  governorId: string;
  worlds: SimState["worlds"];
  people: SimState["people"];
  onAppoint: (worldId: string, personId: string) => void;
}) {
  const [worldId, setWorldId] = useState(props.worlds[0]?.id ?? "");
  const [personId, setPersonId] = useState(props.governorId);
  const selectedWorld = props.worlds.some((world) => world.id === worldId) ? worldId : (props.worlds[0]?.id ?? "");
  const selectedPerson = props.people.some((person) => person.id === personId) ? personId : (props.people[0]?.id ?? "");
  return (
    <div className="card stack">
      <h3>Назначить губернатора</h3>
      <select aria-label="Мир губернатора" value={selectedWorld} onChange={(event) => setWorldId(event.target.value)}>
        {props.worlds.map((world) => <option key={world.id} value={world.id}>{world.name}</option>)}
      </select>
      <select aria-label="Кандидат в губернаторы" value={selectedPerson} onChange={(event) => setPersonId(event.target.value)}>
        {props.people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
      </select>
      <Button onClick={() => props.onAppoint(selectedWorld, selectedPerson)} disabled={!selectedPerson}>Назначить</Button>
    </div>
  );
}

export function LogPanel(props: { sim: SimState }) {
  return (
    <div className="stack">
      <h2>Журнал</h2>
      {[...props.sim.journal].reverse().map((entry, index) => <p key={`${entry.tick}-${index}`}>День {entry.tick}. {entry.text}</p>)}
      <h2>Соседи</h2>
      {[...props.sim.aiLog].reverse().map((entry, index) => <p key={`${entry.tick}-ai-${index}`}>День {entry.tick}. {entry.text}</p>)}
    </div>
  );
}

export function GamePanel(props: {
  sim: SimState;
  onSave: () => void;
  onExport: () => void;
  onImport: (raw: string) => void;
  onBase: () => void;
  onDiag: (kind: "grain" | "succession" | "fallback" | "colony" | "crisis") => void;
}) {
  return (
    <div className="stack">
      <p className="muted">Seed {props.sim.seed}. Запись версии 6. Чужой номер или битый файл текущую партию не затирает.</p>
      <Hint text="Сохранение хранит ход, рейсы, контракты, портовые очереди, путь развития, политические решения и флаг обучения. Записи версий 1–5 открываются: у старых партий обучение включено, список решений пуст, если его не было." label="Что внутри сохранения" />
      <div className="row">
        <Button onClick={props.onSave}>Сохранить в браузер</Button>
        <Button onClick={props.onExport}>Экспорт файла</Button>
        <label className="btn btn-secondary">
          Импорт
          <input aria-label="Импорт сохранения в партии" hidden type="file" accept="application/json,.json" onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) file.text().then(props.onImport);
          }} />
        </label>
      </div>
      <Button
        variant="danger"
        confirm={{ title: "Новая базовая партия", lines: ["Партия на экране сменится базовым сектором того же зерна. Запись в браузере останется, пока вы сами её не перезапишете."] }}
        onClick={props.onBase}
      >Новая базовая партия</Button>
      <details className="card">
        <summary>Проверочные сценарии</summary>
        <div className="row">
          <Button onClick={() => props.onDiag("grain")}>Дефицит зерна</Button>
          <Button onClick={() => props.onDiag("succession")}>Быстрая смена главы</Button>
          <Button onClick={() => props.onDiag("fallback")}>Нет наследника</Button>
          <Button onClick={() => props.onDiag("colony")}>Экспансия ИИ</Button>
          <Button onClick={() => props.onDiag("crisis")}>Спор о пошлине</Button>
        </div>
      </details>
    </div>
  );
}

export function TabButton(props: { selected: boolean; count?: number; children: string; onClick: () => void }) {
  return <Tab selected={props.selected} count={props.count} onClick={props.onClick}>{props.children}</Tab>;
}
