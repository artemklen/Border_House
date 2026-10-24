import { useEffect, useRef, useState } from "react";
import { createClock, planFrame, type SpeedId } from "../sim/clock";
import { dispatch, planBuild, planShip, treatyText } from "../sim/commands";
import { contractEstimate, contractRisks } from "../sim/contracts";
import { RECIPES, SHIP_CLASSES } from "../sim/config";
import { createGame } from "../sim/create";
import { createExpansionScenario, createGrainScenario, createSuccessionScenario } from "../sim/diagnostics";
import { GOODS, GOOD_NAME, type GoodId } from "../sim/goods";
import { foodCover, houseOf, worldOf } from "../sim/mutate";
import { deserialize, serialize, SaveError, storeSave } from "../sim/save";
import { tick } from "../sim/simulate";
import type { Command, Flow, RouteStop, SimState, StopAction } from "../sim/types";
import {
  bottlenecks,
  dependencyRows,
  explainBuilding,
  explainPrice,
  colonyShip,
  explainShip,
  fleetPickId,
  fleetCommandShipId,
  foodPerDay,
  formatDay,
  governorBlurb,
  hintLines,
  keptOtherHouseId,
  keptShipId,
  keptWorldId,
  pickMapTarget,
  worldOwnerName,
} from "../sim/view";
import { drawMap, frameCamera, unproject, type Camera } from "./drawMap";

const AUTOSAVE_KEY = "border-house.autosave.v1";
const TABS = [
  ["world", "Мир"],
  ["build", "Стройка"],
  ["fleet", "Флот"],
  ["cash", "Касса"],
  ["gaps", "Сбои"],
  ["deals", "Договоры"],
  ["house", "Дом"],
  ["log", "Журнал"],
  ["game", "Партия"],
] as const;
type TabId = (typeof TABS)[number][0];
type Selection = { kind: "world" | "ship"; id: string } | null;

const FLOW_LABELS: Array<[keyof Flow, string]> = [
  ["sales", "продажи"],
  ["purchases", "закупки"],
  ["tariffsIn", "полученные пошлины"],
  ["tariffsOut", "уплаченные пошлины"],
  ["taxes", "налоги"],
  ["wages", "зарплаты"],
  ["upkeep", "содержание, денежный сток"],
  ["construction", "плата за стройку населению"],
];

export function App() {
  const [sim, setSim] = useState<SimState | null>(null);
  const simRef = useRef<SimState | null>(null);
  simRef.current = sim;
  const clockRef = useRef(createClock());
  const cameraRef = useRef<Camera>({ x: 560, y: 380, zoom: 0.7 });
  const selectedRef = useRef<Selection>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; camX: number; camY: number; moved: boolean } | null>(null);
  const [selected, setSelected] = useState<Selection>(null);
  const [tab, setTab] = useState<TabId>("world");
  const [paused, setPaused] = useState(true);
  const [speed, setSpeed] = useState<SpeedId>(1);
  const [message, setMessage] = useState("");
  const [seed, setSeed] = useState(21);
  const [worldCount, setWorldCount] = useState(16);
  const [houseCount, setHouseCount] = useState(4);
  const [confirm, setConfirm] = useState<{ title: string; lines: string[]; run: () => void } | null>(null);
  const [draftName, setDraftName] = useState("Хлебный рейс");
  const [draftStops, setDraftStops] = useState<RouteStop[]>([]);
  const [stopWorld, setStopWorld] = useState("w-bread");
  const [action, setAction] = useState<StopAction>({ good: "food", mode: "load", amount: 20, price: 12, keep: 20 });
  const [shipId, setShipId] = useState("");
  const [otherHouse, setOtherHouse] = useState("");
  const [tariff, setTariff] = useState(300);
  const [treatyQty, setTreatyQty] = useState(12);
  const [treatyTariff, setTreatyTariff] = useState(300);
  selectedRef.current = selected;

  const mapReady = Boolean(sim);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const place = () => {
      if (!simRef.current || canvas.clientWidth < 2) return;
      cameraRef.current = frameCamera(simRef.current.worlds, canvas.clientWidth, canvas.clientHeight);
    };
    place();
    const frame = requestAnimationFrame(place);
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const next = cameraRef.current.zoom * (event.deltaY > 0 ? 0.9 : 1.1);
      cameraRef.current.zoom = Math.max(0.28, Math.min(2.2, next));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      cancelAnimationFrame(frame);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [mapReady]);

  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const current = simRef.current;
      if (current) {
        const plan = planFrame(clockRef.current, dt, current.tick, 24);
        if (plan.steps > 0) {
          for (let index = 0; index < plan.steps; index += 1) tick(current);
          if (plan.autosave && !storeSave(() => localStorage, AUTOSAVE_KEY, serialize(current))) {
            setMessage("Автосохранение не записалось. Партия продолжается.");
          }
          setSim({ ...current });
        }
        const canvas = canvasRef.current;
        if (canvas) drawMap(canvas, current, cameraRef.current, selectedRef.current?.id ?? null);
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement) return;
      if (event.code === "Space") {
        event.preventDefault();
        togglePause();
      }
      if (event.key === "1") changeSpeed(1);
      if (event.key === "2") changeSpeed(2);
      if (event.key === "3") changeSpeed(3);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function togglePause() {
    clockRef.current.paused = !clockRef.current.paused;
    setPaused(clockRef.current.paused);
  }

  function changeSpeed(next: SpeedId) {
    clockRef.current.speed = next;
    clockRef.current.paused = false;
    setSpeed(next);
    setPaused(false);
  }

  function adopt(next: SimState) {
    clockRef.current = createClock();
    setPaused(true);
    setSpeed(1);
    setSim(next);
    setSelected({ kind: "world", id: next.worlds[0]?.id ?? "" });
    setTab("world");
    setMessage("Партия на паузе. Пробел продолжает время. Подсказки снизу не блокируют приказы.");
    const playerId = next.houses.find((house) => house.player)?.id ?? "";
    setShipId(keptShipId(next.ships, playerId, shipId));
    setOtherHouse(keptOtherHouseId(next.houses, playerId, otherHouse));
    setStopWorld(keptWorldId(next.worlds, ""));
    setDraftStops([]);
    setConfirm(null);
    const canvas = canvasRef.current;
    cameraRef.current = frameCamera(next.worlds, canvas?.clientWidth ?? 0, canvas?.clientHeight ?? 0);
  }

  function act(command: Command) {
    const current = simRef.current;
    if (!current) return;
    const result = dispatch(current, command);
    setMessage(result.ok ? result.reason || "Приказ выполнен." : result.reason);
    setSim({ ...current });
    setConfirm(null);
  }

  function loadRaw(raw: string) {
    try {
      adopt(deserialize(raw));
      setMessage("Сохранение загружено. Партия на паузе.");
    } catch (error) {
      const text = error instanceof SaveError ? error.message : "Файл сохранения повреждён.";
      setMessage(text);
    }
  }

  const player = sim?.houses.find((house) => house.player) ?? null;
  const selectedWorld = sim && selected?.kind === "world" ? worldOf(sim, selected.id) : undefined;
  const selectedShip = sim && selected?.kind === "ship" ? sim.ships.find((ship) => ship.id === selected.id) : undefined;

  function pickAt(x: number, y: number) {
    const current = simRef.current;
    const canvas = canvasRef.current;
    if (!current || !canvas) return;
    const point = unproject(cameraRef.current, canvas.clientWidth, canvas.clientHeight, x, y);
    const hit = pickMapTarget(current, point, cameraRef.current.zoom);
    if (!hit) return;
    if (hit.kind === "ship") {
      setSelected({ kind: "ship", id: hit.id });
      const owned = current.ships.find((ship) => ship.id === hit.id);
      const playerId = current.houses.find((house) => house.player)?.id ?? "";
      const picked = owned ? fleetPickId(owned, playerId) : null;
      if (picked) setShipId(picked);
      setTab("fleet");
      return;
    }
    setSelected({ kind: "world", id: hit.id });
    setTab("world");
  }

  return (
    <div className="app">
      {!sim || !player ? (
        <Menu
          seed={seed}
          worldCount={worldCount}
          houseCount={houseCount}
          message={message}
          onSeed={setSeed}
          onWorlds={setWorldCount}
          onHouses={setHouseCount}
          onBase={() => adopt(createGame({ seed, scenario: "base" }))}
          onCustom={() => {
            try {
              adopt(createGame({ seed, scenario: "generated", worlds: worldCount, houses: houseCount }));
            } catch (error) {
              setMessage(error instanceof Error ? error.message : "Не удалось создать сектор.");
            }
          }}
          onLoad={() => {
            try {
              const raw = localStorage.getItem(AUTOSAVE_KEY);
              if (!raw) setMessage("Автосохранения нет.");
              else loadRaw(raw);
            } catch {
              setMessage("Браузер не отдал автосохранение.");
            }
          }}
          onImport={(raw) => loadRaw(raw)}
        />
      ) : (
        <>
          <header className="topbar">
            <div className="brand">Дома Пограничья</div>
            <span className="crest" style={{ background: player.color }}>{player.crest}</span>
            <strong>{player.name}</strong>
            <span className="credits">{player.credits} кред.</span>
            <span>{formatDay(sim)}</span>
            <span className="muted">день симуляции № {sim.tick}</span>
            <button aria-pressed={paused} onClick={togglePause}>{paused ? "Пауза" : "Идёт время"}</button>
            <button aria-pressed={speed === 1 && !paused} onClick={() => changeSpeed(1)}>1×</button>
            <button aria-pressed={speed === 2 && !paused} onClick={() => changeSpeed(2)}>3×</button>
            <button aria-pressed={speed === 3 && !paused} onClick={() => changeSpeed(3)}>8×</button>
          </header>
          {message ? <div className="banner" role="status">{message}</div> : null}
          <div className="stage">
            <div className="map-wrap">
              <canvas
                ref={canvasRef}
                aria-label="Карта сектора"
                onPointerDown={(event) => {
                  dragRef.current = { x: event.clientX, y: event.clientY, camX: cameraRef.current.x, camY: cameraRef.current.y, moved: false };
                  event.currentTarget.setPointerCapture(event.pointerId);
                  event.currentTarget.classList.add("dragging");
                }}
                onPointerMove={(event) => {
                  const drag = dragRef.current;
                  if (!drag) return;
                  const dx = event.clientX - drag.x;
                  const dy = event.clientY - drag.y;
                  if (Math.hypot(dx, dy) > 4) drag.moved = true;
                  cameraRef.current.x = drag.camX - dx / cameraRef.current.zoom;
                  cameraRef.current.y = drag.camY - dy / cameraRef.current.zoom;
                }}
                onPointerUp={(event) => {
                  const drag = dragRef.current;
                  event.currentTarget.classList.remove("dragging");
                  if (drag && !drag.moved) {
                    const rect = event.currentTarget.getBoundingClientRect();
                    pickAt(event.clientX - rect.left, event.clientY - rect.top);
                  }
                  dragRef.current = null;
                }}
              />
              <div className="legend">
                Кольцо — предел владения. Пунктир — маршрут на паузе. Корабль не прыгает между мирами: он идёт по отрезку.
              </div>
            </div>
            <aside>
              <div className="tabs" role="tablist">
                {TABS.map(([id, label]) => (
                  <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>
                ))}
              </div>
              <div className="panel" role="tabpanel">
                {tab === "world" ? (
                  <WorldPanel
                    sim={sim}
                    worldId={selectedWorld?.id ?? sim.worlds[0].id}
                    onSelect={(id) => setSelected({ kind: "world", id })}
                    onExplain={(good) => setMessage(explainPrice(sim, selectedWorld?.id ?? sim.worlds[0].id, good))}
                    onColonize={() => {
                      const world = selectedWorld;
                      const ship = colonyShip(sim.ships, player.id, shipId);
                      if (!world || !ship) return;
                      setConfirm({
                        title: `Основать колонию на «${world.name}»`,
                        lines: [
                          `Корабль ${ship.name} должен довезти ${sim.rules.colonizeFood} продовольствия и ${sim.rules.colonizeParts} комплектующих.`,
                          `По прибытии казна отдаст населению ${sim.rules.colonizeCost} кред. Предприятий не появится, мир не станет сразу доходным.`,
                        ],
                        run: () => act({ type: "colonize", houseId: player.id, shipId: ship.id, worldId: world.id }),
                      });
                    }}
                  />
                ) : null}
                {tab === "build" ? (
                  <BuildPanel
                    sim={sim}
                    houseId={player.id}
                    worldId={selectedWorld?.id ?? player.capitalId}
                    onPreview={(kind) => {
                      const worldId = selectedWorld?.id ?? player.capitalId;
                      const plan = planBuild(sim, player.id, worldId, kind);
                      if (!plan.ok) setMessage(plan.reason);
                      else setConfirm({ title: `Построить ${RECIPES[kind].name}`, lines: plan.lines, run: () => act({ type: "build", houseId: player.id, worldId, kind }) });
                    }}
                    onShip={(classId) => {
                      const worldId = selectedWorld?.id ?? player.capitalId;
                      const plan = planShip(sim, player.id, worldId, classId);
                      if (!plan.ok) setMessage(plan.reason);
                      else setConfirm({ title: `Заложить ${SHIP_CLASSES[classId].name}`, lines: plan.lines, run: () => act({ type: "buildShip", houseId: player.id, worldId, classId }) });
                    }}
                    onToggle={(buildingId, enabled) => act({ type: "toggleBuilding", houseId: player.id, buildingId, enabled })}
                    onWhy={(buildingId) => setMessage(explainBuilding(sim, buildingId))}
                  />
                ) : null}
                {tab === "fleet" ? (
                  <FleetPanel
                    sim={sim}
                    houseId={player.id}
                    shipId={fleetCommandShipId(selectedShip, player.id, shipId)}
                    draftName={draftName}
                    stops={draftStops}
                    stopWorld={stopWorld}
                    action={action}
                    onShip={(id) => {
                      setShipId(id);
                      setSelected({ kind: "ship", id });
                    }}
                    onName={setDraftName}
                    onStopWorld={setStopWorld}
                    onAction={setAction}
                    onAddStop={() => setDraftStops((stops) => [...stops, { worldId: stopWorld, actions: [] }])}
                    onAddAction={() => setDraftStops((stops) => {
                      if (stops.length === 0) return stops;
                      const copy = stops.map((stop) => ({ ...stop, actions: [...stop.actions] }));
                      copy[copy.length - 1].actions.push({ ...action });
                      return copy;
                    })}
                    onClear={() => setDraftStops([])}
                    onCreate={() => act({ type: "createRoute", houseId: player.id, name: draftName, stops: draftStops, shipId: fleetCommandShipId(selectedShip, player.id, shipId) || undefined })}
                    onPause={(routeId, next) => act({ type: "pauseRoute", routeId, paused: next })}
                    onAssign={(id, routeId) => act({ type: "assignShip", shipId: id, routeId })}
                    onUpdate={(routeId) => act({ type: "updateRoute", routeId, name: draftName, stops: draftStops })}
                    onWhy={(id) => setMessage(explainShip(sim, id))}
                    onLoadRoute={(routeId) => {
                      const route = sim.routes.find((item) => item.id === routeId);
                      if (!route) return;
                      setDraftName(route.name);
                      setDraftStops(route.stops.map((stop) => ({ worldId: stop.worldId, actions: stop.actions.map((item) => ({ ...item })) })));
                    }}
                  />
                ) : null}
                {tab === "cash" ? <CashPanel sim={sim} houseId={player.id} /> : null}
                {tab === "gaps" ? <GapPanel sim={sim} houseId={player.id} /> : null}
                {tab === "deals" ? (
                  <DealPanel
                    sim={sim}
                    houseId={player.id}
                    otherId={otherHouse || sim.houses.find((house) => !house.player)?.id || ""}
                    tariff={tariff}
                    treatyQty={treatyQty}
                    treatyTariff={treatyTariff}
                    worldId={selectedWorld?.ownerId === player.id ? selectedWorld.id : player.capitalId}
                    onOther={setOtherHouse}
                    onTariff={setTariff}
                    onQty={setTreatyQty}
                    onTreatyTariff={setTreatyTariff}
                    onSetTariff={(worldId) => act({ type: "setTariff", houseId: player.id, worldId, tariffBps: tariff })}
                    onEmbargo={(otherId, embargo) => act({ type: "setEmbargo", houseId: player.id, otherId, embargo })}
                    onPropose={(otherId) => {
                      const other = houseOf(sim, otherId);
                      const text = treatyText("exchange", player.name, other?.name ?? "дом", treatyTariff, "food", treatyQty, 96, sim.rules.window);
                      setConfirm({
                        title: "Предложить обмен пошлины на продовольствие",
                        lines: [text, "До принятия ничего не списывается и не привозится."],
                        run: () => act({
                          type: "proposeTreaty",
                          houseId: player.id,
                          otherId,
                          kind: "exchange",
                          tariffBps: treatyTariff,
                          good: "food",
                          qtyPerWindow: treatyQty,
                          duration: 96,
                        }),
                      });
                    }}
                    onRespond={(treatyId, accept) => act({ type: "respondTreaty", houseId: player.id, treatyId, accept })}
                    onCommand={act}
                  />
                ) : null}
                {tab === "house" ? <HousePanel sim={sim} houseId={player.id} onAppoint={(worldId, personId) => act({ type: "appointGovernor", houseId: player.id, worldId, personId })} /> : null}
                {tab === "log" ? <LogPanel sim={sim} /> : null}
                {tab === "game" ? (
                  <GamePanel
                    sim={sim}
                    onSave={() => {
                      const saved = storeSave(() => localStorage, AUTOSAVE_KEY, serialize(sim));
                      setMessage(saved ? "Партия записана в браузер." : "Браузер не принял запись. Партия на экране сохранена.");
                    }}
                    onExport={() => download(serialize(sim), `border-house-${sim.seed}.json`)}
                    onImport={(raw) => loadRaw(raw)}
                    onBase={() => adopt(createGame({ seed: sim.seed, scenario: "base" }))}
                    onDiag={(kind) => {
                      if (kind === "grain") adopt(createGrainScenario(sim.seed));
                      if (kind === "succession") adopt(createSuccessionScenario(sim.seed, true));
                      if (kind === "fallback") adopt(createSuccessionScenario(sim.seed, false));
                      if (kind === "colony") adopt(createExpansionScenario(sim.seed));
                      setMessage("Открыт проверочный сценарий. Это не продолжение кампании.");
                    }}
                  />
                ) : null}
              </div>
            </aside>
          </div>
          <footer className="ticker">
            {hintLines(sim).map((hint) => <span key={hint}>{hint}</span>)}
          </footer>
        </>
      )}
      {confirm ? (
        <dialog open>
          <h2>{confirm.title}</h2>
          {confirm.lines.map((line) => <p key={line}>{line}</p>)}
          <div className="row">
            <button className="primary" onClick={confirm.run}>Подтвердить</button>
            <button onClick={() => setConfirm(null)}>Отмена</button>
          </div>
        </dialog>
      ) : null}
    </div>
  );
}

function Menu(props: {
  seed: number;
  worldCount: number;
  houseCount: number;
  message: string;
  onSeed: (value: number) => void;
  onWorlds: (value: number) => void;
  onHouses: (value: number) => void;
  onBase: () => void;
  onCustom: () => void;
  onLoad: () => void;
  onImport: (raw: string) => void;
}) {
  return (
    <main className="menu">
      <h1>Дома Пограничья</h1>
      <p>Торговый дом в пограничном секторе. Зерно становится едой только на мельнице, руда — сплавами, а груз доезжает сам. Короткий путь к богатому рынку лежит через чужую заставу.</p>
      {props.message ? <p className="warn" role="status">{props.message}</p> : null}
      <div className="row">
        <button className="primary" onClick={props.onBase}>Базовый сценарий: 16 миров и 4 дома</button>
        <button onClick={props.onLoad}>Загрузить автосохранение</button>
        <label>
          Импорт файла
          <input aria-label="Импорт сохранения" type="file" accept="application/json,.json" onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            file.text().then(props.onImport);
          }} />
        </label>
      </div>
      <div className="row">
        <label>Зерно seed<input type="number" value={props.seed} onChange={(event) => props.onSeed(Number(event.target.value))} /></label>
        <label>Миры 12–20<input type="number" min={12} max={20} value={props.worldCount} onChange={(event) => props.onWorlds(Number(event.target.value))} /></label>
        <label>Дома 3–4<input type="number" min={3} max={4} value={props.houseCount} onChange={(event) => props.onHouses(Number(event.target.value))} /></label>
        <button onClick={props.onCustom}>Случайный сектор</button>
      </div>
    </main>
  );
}

function WorldPanel(props: {
  sim: SimState;
  worldId: string;
  onSelect: (id: string) => void;
  onExplain: (good: GoodId) => void;
  onColonize: () => void;
}) {
  const world = worldOf(props.sim, props.worldId) ?? props.sim.worlds[0];
  const need = foodPerDay(world.population, props.sim.rules.foodPer100);
  return (
    <>
      <div className="row">
        {props.sim.worlds.map((item) => (
          <button key={item.id} aria-pressed={item.id === world.id} onClick={() => props.onSelect(item.id)}>{item.name}</button>
        ))}
      </div>
      <article className="card">
        <h2>{world.name}</h2>
        <p>{world.specialty}. Владелец: {worldOwnerName(props.sim, world)}. Население {world.population}, кошелёк {world.popWallet} кред., удовлетворённость {world.satisfaction}.</p>
        <p>Еда: {need} ед./день, запас на {foodCover(world.population, world.stock.food, props.sim.rules.foodPer100)} дн. Склад {Object.values(world.stock).reduce((sum, value) => sum + value, 0)} / {world.capacity} ед. Пошлина {world.tariffBps / 100}%.</p>
        <p>{governorBlurb(props.sim, world)}</p>
        {!world.ownerId ? <button onClick={props.onColonize}>Готовить колонию</button> : null}
        <table>
          <tbody>
            {GOODS.map((good) => (
              <tr key={good}>
                <th>{GOOD_NAME[good]}</th>
                <td>{world.stock[good]} ед.</td>
                <td>{world.prices[good]} кред./ед.</td>
                <td><button onClick={() => props.onExplain(good)}>Почему цена</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>
    </>
  );
}

function BuildPanel(props: {
  sim: SimState;
  houseId: string;
  worldId: string;
  onPreview: (kind: keyof typeof RECIPES) => void;
  onShip: (classId: keyof typeof SHIP_CLASSES) => void;
  onToggle: (buildingId: string, enabled: boolean) => void;
  onWhy: (buildingId: string) => void;
}) {
  const world = worldOf(props.sim, props.worldId);
  const owned = world?.ownerId === props.houseId;
  return (
    <>
      <p>{owned ? "Стройка только в своём мире. Комплектующие списываются со склада этого мира, деньги уходят местным жителям." : "Чужой мир: предприятия можно смотреть, но не переключать и не строить."}</p>
      {owned ? (
        <>
          <div className="row">
            {(Object.keys(RECIPES) as Array<keyof typeof RECIPES>).map((kind) => (
              <button key={kind} onClick={() => props.onPreview(kind)}>{RECIPES[kind].name}: {RECIPES[kind].parts} компл., {RECIPES[kind].credits} кред., {RECIPES[kind].days} дн.</button>
            ))}
          </div>
          <div className="row">
            {(Object.keys(SHIP_CLASSES) as Array<keyof typeof SHIP_CLASSES>).map((classId) => (
              <button key={classId} onClick={() => props.onShip(classId)}>Корабль «{SHIP_CLASSES[classId].name}»</button>
            ))}
          </div>
        </>
      ) : null}
      {world?.buildings.map((building) => (
        <article key={building.id} className="card">
          <h3>{RECIPES[building.kind].name}</h3>
          <p>{building.remainingDays > 0 ? `строится ${building.remainingDays} дн.` : building.stopReason ?? "работает"}</p>
          <div className="row">
            {building.ownerId === props.houseId ? (
              <button onClick={() => props.onToggle(building.id, !building.enabled)}>{building.enabled ? "Остановить" : "Запустить"}</button>
            ) : null}
            <button onClick={() => props.onWhy(building.id)}>Почему так</button>
          </div>
        </article>
      ))}
    </>
  );
}

function FleetPanel(props: {
  sim: SimState;
  houseId: string;
  shipId: string;
  draftName: string;
  stops: RouteStop[];
  stopWorld: string;
  action: StopAction;
  onShip: (id: string) => void;
  onName: (value: string) => void;
  onStopWorld: (id: string) => void;
  onAction: (action: StopAction) => void;
  onAddStop: () => void;
  onAddAction: () => void;
  onClear: () => void;
  onCreate: () => void;
  onPause: (routeId: string, paused: boolean) => void;
  onAssign: (shipId: string, routeId: string | null) => void;
  onUpdate: (routeId: string) => void;
  onWhy: (shipId: string) => void;
  onLoadRoute: (routeId: string) => void;
}) {
  const ships = props.sim.ships.filter((ship) => ship.houseId === props.houseId);
  const routes = props.sim.routes.filter((route) => route.houseId === props.houseId);
  return (
    <>
      {ships.map((ship) => (
        <article key={ship.id} className="card">
          <h3>{ship.name}</h3>
          <p>{ship.status === "transit" ? "в пути" : ship.status === "blocked" ? "стоит" : ship.status === "building" ? "строится" : "у причала"}. {ship.stopReason ?? "рейс свободен"}.</p>
          <p>Груз: {GOODS.map((good) => `${GOOD_NAME[good]} ${ship.cargo[good]}`).join(", ")}.</p>
          <div className="row">
            <button onClick={() => props.onShip(ship.id)}>Выбрать</button>
            <button onClick={() => props.onWhy(ship.id)}>Почему рейс такой</button>
          </div>
        </article>
      ))}
      <article className="card stack">
        <h3>Редактор маршрута</h3>
        <p>Пока корабль в пути, новое расписание начнётся после текущего перегона. Груз при этом не переносится сам.</p>
        <label>Название<input value={props.draftName} onChange={(event) => props.onName(event.target.value)} /></label>
        <label>Мир остановки
          <select value={props.stopWorld} onChange={(event) => props.onStopWorld(event.target.value)}>
            {props.sim.worlds.map((world) => <option key={world.id} value={world.id}>{world.name}</option>)}
          </select>
        </label>
        <button onClick={props.onAddStop}>Добавить остановку</button>
        <div className="row">
          <select value={props.action.good} onChange={(event) => props.onAction({ ...props.action, good: event.target.value as GoodId })}>
            {GOODS.map((good) => <option key={good} value={good}>{GOOD_NAME[good]}</option>)}
          </select>
          <select value={props.action.mode} onChange={(event) => props.onAction({ ...props.action, mode: event.target.value as StopAction["mode"] })}>
            <option value="load">погрузить своё</option>
            <option value="unload">выгрузить своё</option>
            <option value="buy">купить</option>
            <option value="sell">продать</option>
          </select>
          <label>Количество<input type="number" value={props.action.amount} onChange={(event) => props.onAction({ ...props.action, amount: Number(event.target.value) })} /></label>
          <label>Предел цены<input type="number" value={props.action.price} onChange={(event) => props.onAction({ ...props.action, price: Number(event.target.value) })} /></label>
          <label>Резерв<input type="number" value={props.action.keep} onChange={(event) => props.onAction({ ...props.action, keep: Number(event.target.value) })} /></label>
        </div>
        <button onClick={props.onAddAction}>Добавить правило на последнюю остановку</button>
        <ol>
          {props.stops.map((stop, index) => (
            <li key={`${stop.worldId}-${index}`}>{worldOf(props.sim, stop.worldId)?.name}: {stop.actions.map((item) => `${{ load: "погрузка", unload: "выгрузка", buy: "покупка", sell: "продажа" }[item.mode]} ${item.amount} ${GOOD_NAME[item.good]}`).join("; ") || "без правил"}</li>
          ))}
        </ol>
        <div className="row">
          <button className="primary" onClick={props.onCreate}>Проложить маршрут</button>
          <button onClick={props.onClear}>Очистить черновик</button>
        </div>
      </article>
      {routes.map((route) => (
        <article key={route.id} className="card">
          <h3>{route.name}</h3>
          <p>{route.paused ? "на паузе" : "идёт"}. Это окно: выручка {route.revenue}, расход {route.cost}, топливо {route.fuelUsed}. Прошлое окно: {route.lastRevenue} / {route.lastCost}.</p>
          <div className="row">
            <button onClick={() => props.onLoadRoute(route.id)}>В черновик</button>
            <button onClick={() => props.onUpdate(route.id)}>Записать черновик в этот маршрут</button>
            <button onClick={() => props.onPause(route.id, !route.paused)}>{route.paused ? "Снять паузу" : "Пауза маршрута"}</button>
            <button onClick={() => props.shipId && props.onAssign(props.shipId, route.id)} disabled={!props.shipId}>Назначить выбранный корабль</button>
          </div>
        </article>
      ))}
    </>
  );
}

function CashPanel(props: { sim: SimState; houseId: string }) {
  const house = houseOf(props.sim, props.houseId)!;
  return (
    <article className="card">
      <h2>Касса {house.name}</h2>
      <p>Баланс {house.credits} кред., из них свободно {house.credits - house.reserved}, в резерве контрактов {house.reserved}. Окно учёта {house.flowDays} / {props.sim.rules.window} дн. Резерв остаётся в казне, но его нельзя потратить второй раз. Начальные деньги — явное наделение, содержание кораблей и предприятий сжигается и пишется как сток.</p>
      <table>
        <tbody>
          {FLOW_LABELS.map(([key, label]) => (
            <tr key={key}><th>{label}</th><td>сейчас {house.flow[key]}</td><td>прошлое окно {house.lastFlow[key]}</td></tr>
          ))}
        </tbody>
      </table>
      {props.sim.routes.filter((route) => route.houseId === house.id).map((route) => (
        <p key={route.id}>«{route.name}»: выручка {route.revenue + route.lastRevenue} кред. против расхода {route.cost + route.lastCost} кред. и {route.fuelUsed + route.lastFuelUsed} ед. топлива за текущее и прошлое окна.</p>
      ))}
    </article>
  );
}

function GapPanel(props: { sim: SimState; houseId: string }) {
  const items = bottlenecks(props.sim, props.houseId);
  return (
    <>
      {items.length === 0 ? <p>Явных остановок нет. Это не значит, что запас бесконечный: смотрите дни еды на мирах.</p> : null}
      {items.map((item) => (
        <article key={`${item.title}-${item.detail}`} className="card">
          <h3>{item.title}</h3>
          <p>{item.detail}</p>
        </article>
      ))}
    </>
  );
}

function DealPanel(props: {
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
  const house = houseOf(props.sim, props.houseId)!;
  const buyerWorlds = props.sim.worlds.filter((world) => world.ownerId === props.otherId);
  const buyerWorldId = buyerWorlds.some((world) => world.id === destination) ? destination : buyerWorlds[0]?.id ?? "";
  const preview = buyerWorldId ? contractEstimate(props.sim, house.id, props.otherId, good, buyerWorldId, qty, windows, price, deposit) : null;
  return (
    <>
      {dependencyRows(props.sim, house).map((line) => <p key={line}>{line}</p>)}
      <label>Другой дом
        <select value={props.otherId} onChange={(event) => props.onOther(event.target.value)}>
          {props.sim.houses.filter((item) => item.id !== house.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <div className="row">
        <button onClick={() => props.onEmbargo(props.otherId, true)}>Эмбарго</button>
        <button onClick={() => props.onEmbargo(props.otherId, false)}>Открыть доступ</button>
      </div>
      <label>Пошлина выбранного своего мира, базисные пункты
        <input type="number" value={props.tariff} onChange={(event) => props.onTariff(Number(event.target.value))} />
      </label>
      <button onClick={() => props.onSetTariff(props.worldId)}>Поставить пошлину</button>
      <label>Продовольствие за окно учёта
        <input type="number" value={props.treatyQty} onChange={(event) => props.onQty(Number(event.target.value))} />
      </label>
      <label>Просимая пошлина, б.п.
        <input type="number" value={props.treatyTariff} onChange={(event) => props.onTreatyTariff(Number(event.target.value))} />
      </label>
      <button className="primary" onClick={() => props.onPropose(props.otherId)}>Предложить скидку за поставки</button>
      <h3>Коммерческий контракт</h3>
      <p>Цена фиксируется при принятии. Рыночная цена потом может измениться, контрактная нет. Дипломатический договор этой пары остаётся отдельным.</p>
      <label>Товар
        <select value={good} onChange={(event) => setGood(event.target.value as GoodId)}>
          {GOODS.map((item) => <option key={item} value={item}>{GOOD_NAME[item]}</option>)}
        </select>
      </label>
      <label>Мир покупателя
        <select value={buyerWorldId} onChange={(event) => setDestination(event.target.value)}>
          {buyerWorlds.map((world) => <option key={world.id} value={world.id}>{world.name}</option>)}
        </select>
      </label>
      <label>Объём за окно <input type="number" value={qty} onChange={(event) => setQty(Number(event.target.value))} /></label>
      <label>Окон, 2–6 <input type="number" value={windows} onChange={(event) => setWindows(Number(event.target.value))} /></label>
      <label>Цена за единицу <input type="number" value={price} onChange={(event) => setPrice(Number(event.target.value))} /></label>
      <label>Допустимый недовоз <input type="number" value={shortfall} onChange={(event) => setShortfall(Number(event.target.value))} /></label>
      <label>Залог продавца <input type="number" value={deposit} onChange={(event) => setDeposit(Number(event.target.value))} /></label>
      {preview ? (
        <article className="card">
          <p>Оценка выручки {preview.revenue} кред. Путь около {preview.voyageDays} дн., рейсов на окно {preview.trips}, трюм {preview.capacity}. Топливо по текущей цене около {preview.fuelCost} кред. Залог {preview.collateral}.</p>
          {preview.assumptions.map((line) => <p key={line}>{line}</p>)}
        </article>
      ) : null}
      <button className="primary" onClick={() => props.onCommand({
        type: "proposeContract",
        sellerId: house.id,
        buyerId: props.otherId,
        good,
        worldId: buyerWorldId,
        qtyPerWindow: qty,
        windows,
        price,
        shortfall,
        deposit,
      })}>Предложить контракт</button>
      {props.sim.treaties.map((treaty) => (
        <article key={treaty.id} className="card">
          <h3>{treaty.status}</h3>
          <p>{treaty.note}</p>
          <p>Поставлено в этом окне {treaty.delivered} / {treaty.qtyPerWindow}. До дня {treaty.endTick}.</p>
          {treaty.status === "proposed" && treaty.targetId === house.id ? (
            <div className="row">
              <button onClick={() => props.onRespond(treaty.id, true)}>Принять</button>
              <button onClick={() => props.onRespond(treaty.id, false)}>Отказать</button>
            </div>
          ) : null}
        </article>
      ))}
      {props.sim.contracts.map((contract) => {
        const seller = props.sim.houses.find((item) => item.id === contract.sellerId);
        const buyer = props.sim.houses.find((item) => item.id === contract.buyerId);
        const destination = props.sim.worlds.find((item) => item.id === contract.worldId);
        return (
        <article key={contract.id} className="card">
          <h3>Контракт {{ proposed: "предложен", active: "идёт", completed: "завершён", broken: "сорван", cancelled: "отменён", rejected: "отклонён" }[contract.status]}</h3>
          <p>{seller?.name ?? "продавец"} поставляет {buyer?.name ?? "покупателю"} {GOOD_NAME[contract.good]} в «{destination?.name ?? "мир"}». Цена {contract.price}, объём {contract.qtyPerWindow} за окно, допустимый недовоз {contract.shortfall}, срок {contract.windows} окон.</p>
          <p>{contract.note}</p>
          <p>Окно {contract.windowIndex + 1} / {contract.windows}, день {contract.windowDays} / {props.sim.rules.window}. Принято {contract.delivered} / {contract.qtyPerWindow} по {contract.price} кред. Резерв покупателя {contract.buyerReserve}, залог {contract.deposit}.</p>
          <p>{contractRisks(props.sim, contract).join(" ")}</p>
          {contract.history.length > 0 ? <p>Прошлые окна: {contract.history.map((item) => `${item.delivered} ед., оплата ${item.paid}, штраф ${item.penalty}`).join("; ")}.</p> : null}
          {contract.trades.length > 0 ? <p>Приёмки: {contract.trades.map((item) => `день ${item.tick} ${item.qty} по ${item.price}`).join("; ")}.</p> : null}
          {contract.status === "proposed" && contract.buyerId === house.id ? (
            <div className="row">
              <button onClick={() => props.onCommand({ type: "respondContract", houseId: house.id, contractId: contract.id, accept: true })}>Принять контракт</button>
              <button onClick={() => props.onCommand({ type: "respondContract", houseId: house.id, contractId: contract.id, accept: false })}>Отклонить</button>
            </div>
          ) : null}
          {contract.status === "proposed" || contract.status === "active" ? (
            <button onClick={() => props.onCommand({ type: "cancelContract", houseId: house.id, contractId: contract.id })}>Отменить контракт</button>
          ) : null}
        </article>
        );
      })}
    </>
  );
}

function HousePanel(props: { sim: SimState; houseId: string; onAppoint: (worldId: string, personId: string) => void }) {
  const people = props.sim.people.filter((person) => person.houseId === props.houseId);
  const head = people.find((person) => person.alive && person.role === "head");
  const heir = people.find((person) => person.alive && person.role === "heir");
  return (
    <>
      <p>Глава: {head?.name ?? "нет"}, {head ? Math.floor(head.ageDays / props.sim.rules.ticksPerYear) : "—"} лет, черты {head?.traits.join(", ")}. Наследник: {heir?.name ?? "не назначен"}. Смерть главы не обнуляет казну. Если наследника нет, дом берёт губернатор с наибольшей лояльностью, иначе старшая родня, иначе регент.</p>
      {people.map((person) => (
        <article key={person.id} className="card">
          <h3>{person.name}</h3>
          <p>{person.alive ? person.role : "умер"}, {Math.floor(person.ageDays / props.sim.rules.ticksPerYear)} лет, лояльность {person.loyalty}, черты {person.traits.join(", ") || "нет"}.</p>
        </article>
      ))}
      <Appoint governorId={people.find((person) => person.alive && person.role !== "head")?.id ?? ""} worlds={props.sim.worlds.filter((world) => world.ownerId === props.houseId)} people={people.filter((person) => person.alive && person.role !== "head")} onAppoint={props.onAppoint} />
    </>
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
      <select value={selectedWorld} onChange={(event) => setWorldId(event.target.value)}>
        {props.worlds.map((world) => <option key={world.id} value={world.id}>{world.name}</option>)}
      </select>
      <select aria-label="Кандидат в губернаторы" value={selectedPerson} onChange={(event) => setPersonId(event.target.value)}>
        {props.people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
      </select>
      <button onClick={() => props.onAppoint(selectedWorld, selectedPerson)} disabled={!selectedPerson}>Назначить</button>
    </div>
  );
}

function LogPanel(props: { sim: SimState }) {
  return (
    <>
      <h2>Журнал</h2>
      {[...props.sim.journal].reverse().map((entry, index) => <p key={`${entry.tick}-${index}`}>День {entry.tick}. {entry.text}</p>)}
      <h2>Почему так решили соседи</h2>
      {[...props.sim.aiLog].reverse().map((entry, index) => <p key={`${entry.tick}-ai-${index}`}>День {entry.tick}. {entry.text}</p>)}
    </>
  );
}

function GamePanel(props: {
  sim: SimState;
  onSave: () => void;
  onExport: () => void;
  onImport: (raw: string) => void;
  onBase: () => void;
  onDiag: (kind: "grain" | "succession" | "fallback" | "colony") => void;
}) {
  return (
    <>
      <p>Seed {props.sim.seed}. Сохранение версии 2 хранит весь ход, генератор, рейсы и коммерческие контракты. Запись версии 1 открывается без контрактов и без резерва. Чужой номер версии или битый файл не затирают текущую партию.</p>
      <div className="row">
        <button onClick={props.onSave}>Сохранить в браузер</button>
        <button onClick={props.onExport}>Экспорт файла</button>
        <label>Импорт
          <input aria-label="Импорт сохранения в партии" type="file" accept="application/json,.json" onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            file.text().then(props.onImport);
          }} />
        </label>
        <button onClick={props.onBase}>Новая базовая партия</button>
      </div>
      <fieldset className="card">
        <legend>Проверочные сценарии, не кампания</legend>
        <div className="row">
          <button onClick={() => props.onDiag("grain")}>Дефицит зерна</button>
          <button onClick={() => props.onDiag("succession")}>Быстрая смена главы</button>
          <button onClick={() => props.onDiag("fallback")}>Нет наследника</button>
          <button onClick={() => props.onDiag("colony")}>Экспансия ИИ</button>
        </div>
      </fieldset>
    </>
  );
}

function download(contents: string, name: string) {
  const blob = new Blob([contents], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
