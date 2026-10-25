import { useEffect, useRef, useState } from "react";
import { createClock, planFrame, type SpeedId } from "../sim/clock";
import { dispatch, planBuild, planShip, treatyText } from "../sim/commands";
import { RECIPES, SHIP_CLASSES } from "../sim/config";
import { createBorderContractScenario, createCrowdedHarborScenario, createIndustryDependenceScenario, campaignBrief } from "../sim/campaign";
import { createGame } from "../sim/create";
import { createCrisisScenario, createExpansionScenario, createGrainScenario, createSuccessionScenario } from "../sim/diagnostics";
import { foodCover, houseOf, worldOf } from "../sim/mutate";
import { BERTH_COST, BERTH_DAYS, BERTH_PARTS, SPEED_COST, SPEED_DAYS, SPEED_PARTS } from "../sim/port";
import { CHOICE_LABEL, SITUATION_LABEL, choicePreview } from "../sim/politics";
import { PATH_LABEL, developmentBlock, levelCost } from "../sim/specialty";
import type { DevelopmentPath, SituationChoice } from "../sim/types";
import { deserialize, serialize, SaveError, storeSave } from "../sim/save";
import { tick } from "../sim/simulate";
import { classifyHotkeyTarget, nextSpaceClaim, releaseClaimedSpace, routeTimeHotkey, type FocusFrom } from "./hotkeys";
import { lessonViews } from "../sim/tutorial";
import type { Command, RouteStop, SimState, StopAction } from "../sim/types";
import {
  bottlenecks,
  colonyShip,
  fleetCommandShipId,
  fleetPickId,
  formatDay,
  keptOtherHouseId,
  keptShipId,
  keptWorldId,
  pickMapTarget,
  treasuryOutlook,
  treasuryWarning,
} from "../sim/view";
import { foodRaw, holdAlarm, treasuryRaw, worsened, type AlarmLevel } from "./alarms";
import { ConfirmDialog } from "./components";
import { drawMap, frameCamera, project, unproject, type Camera } from "./drawMap";
import { liveEffects, makeEffect, motionMs, prefersReducedMotion, type MapEffect } from "./effects";
import { groupInt, netFlow, signedInt } from "./format";
import { Icon, Seal } from "./icons";
import {
  BuildPanel,
  CashPanel,
  DealPanel,
  FleetPanel,
  GamePanel,
  GapPanel,
  HousePanel,
  LearnStrip,
  LogPanel,
  MenuScreen,
  PoliticsPanel,
  TabButton,
  WorldPanel,
} from "./panels";
import { clampSheet, snapSheet } from "./sheet";
import { createToast, ToastStack, type ToastItem, type ToastTone } from "./toasts";

const AUTOSAVE_KEY = "border-house.autosave.v1";
const GOAL_KEY = "border-house.goal.v1";
const MAIN_TABS = [
  ["world", "Мир"],
  ["fleet", "Флот"],
  ["cash", "Касса"],
  ["deals", "Договоры"],
] as const;
const PHONE_MORE = [
  ["gaps", "Сбои"],
  ["politics", "Решения"],
  ["build", "Стройка"],
  ["house", "Дом"],
  ["log", "Журнал"],
  ["game", "Партия"],
] as const;
const DESKTOP_MORE = [
  ["build", "Стройка"],
  ["house", "Дом"],
  ["log", "Журнал"],
  ["game", "Партия"],
] as const;
type TabId = (typeof MAIN_TABS)[number][0] | (typeof PHONE_MORE)[number][0];
type Selection = { kind: "world" | "ship"; id: string } | null;

interface Snap {
  credits: number;
  flowDays: number;
  ships: Array<{ id: string; status: string }>;
}

export function App() {
  const [sim, setSim] = useState<SimState | null>(null);
  const simRef = useRef<SimState | null>(null);
  simRef.current = sim;
  const clockRef = useRef(createClock());
  const cameraRef = useRef<Camera>({ x: 560, y: 380, zoom: 0.7 });
  const selectedRef = useRef<Selection>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; camX: number; camY: number; moved: boolean } | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ dist: number; zoom: number } | null>(null);
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  const hoverCardRef = useRef<HTMLDivElement | null>(null);
  const coachRef = useRef<HTMLDivElement | null>(null);
  const focusRef = useRef<string | null>(null);
  const routeRef = useRef<string | null>(null);
  const effectsRef = useRef<MapEffect[]>([]);
  const snapRef = useRef<Snap | null>(null);
  const alarmRef = useRef<{ treasury: AlarmLevel; food: AlarmLevel } | null>(null);
  const treasuryRef = useRef<HTMLButtonElement | null>(null);
  const toastRef = useRef<(tone: ToastTone, title: string, text: string) => void>(() => {});
  const [selected, setSelected] = useState<Selection>(null);
  const [tab, setTab] = useState<TabId>("world");
  const [paused, setPaused] = useState(true);
  const [speed, setSpeed] = useState<SpeedId>(1);
  const [seed, setSeed] = useState(21);
  const [worldCount, setWorldCount] = useState(16);
  const [houseCount, setHouseCount] = useState(4);
  const [confirm, setConfirm] = useState<{ title: string; lines: string[]; run: () => void } | null>(null);
  const [draftName, setDraftName] = useState("Хлебный рейс");
  const [draftMinLoad, setDraftMinLoad] = useState(0);
  const [draftMaxWait, setDraftMaxWait] = useState(0);
  const [draftStops, setDraftStops] = useState<RouteStop[]>([]);
  const [stopWorld, setStopWorld] = useState("w-bread");
  const [action, setAction] = useState<StopAction>({ good: "food", mode: "load", amount: 20, price: 12, keep: 20 });
  const [shipId, setShipId] = useState("");
  const [otherHouse, setOtherHouse] = useState("");
  const [tariff, setTariff] = useState(300);
  const [treatyQty, setTreatyQty] = useState(12);
  const [treatyTariff, setTreatyTariff] = useState(300);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [alarm, setAlarm] = useState<{ treasury: AlarmLevel; food: AlarmLevel }>({ treasury: "ok", food: "ok" });
  const [goalOpen, setGoalOpen] = useState(false);
  const [narrow, setNarrow] = useState(() => typeof matchMedia !== "undefined" && matchMedia("(max-width: 599px)").matches);
  const [sheetH, setSheetH] = useState(168);
  const sheetDrag = useRef<{ y: number; h: number } | null>(null);
  selectedRef.current = selected;

  function pushToast(tone: ToastTone, title: string, text: string) {
    setToasts((items) => [...items, createToast(tone, title, text)].slice(-3));
  }
  toastRef.current = pushToast;

  const mapReady = Boolean(sim);
  useEffect(() => {
    const query = matchMedia("(max-width: 599px)");
    const onChange = () => setNarrow(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !simRef.current) return undefined;
    const place = () => {
      const current = simRef.current;
      if (!current || canvas.clientWidth < 2) return;
      cameraRef.current = framed(current, canvas.clientWidth, canvas.clientHeight);
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
          const player = current.houses.find((house) => house.player);
          const before = snapRef.current;
          let closed: number | null = null;
          for (let index = 0; index < plan.steps; index += 1) {
            const flowDays = player?.flowDays ?? 0;
            tick(current);
            if (player && flowDays !== 0 && player.flowDays === 0) closed = netFlow(player.lastFlow);
          }
          if (plan.autosave && !storeSave(() => localStorage, AUTOSAVE_KEY, serialize(current))) {
            toastRef.current("warn", "Автосохранение", "Автосохранение не записалось. Партия продолжается.");
          }
          if (closed != null) toastRef.current("info", "Окно закрыто", `Итог ${signedInt(closed)} кред. Первое окно на этом балансе часто в минусе.`);
          if (player && before) noteEffects(current, player.id, before);
          snapRef.current = takeSnap(current);
          setSim({ ...current });
        }
        effectsRef.current = liveEffects(effectsRef.current, now);
        const canvas = canvasRef.current;
        if (canvas) {
          const reduced = prefersReducedMotion();
          drawMap(canvas, current, cameraRef.current, selectedRef.current?.id ?? null, {
            paused: clockRef.current.paused,
            alpha: reduced ? 0 : clockRef.current.accumulator,
            now,
            reducedMotion: reduced,
            playerId: current.houses.find((house) => house.player)?.id,
            effects: effectsRef.current,
            selectedRouteId: routeRef.current,
          });
          placeCoach(current, canvas);
          placeHover(current, canvas);
        }
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const timers = toasts.filter((item) => item.tone === "ok" || item.tone === "info").map((item) => window.setTimeout(() => {
      setToasts((list) => list.filter((toast) => toast.id !== item.id));
    }, 8000));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [toasts]);

  useEffect(() => {
    if (!sim) return;
    const player = sim.houses.find((house) => house.player);
    if (!player) return;
    const outlook = treasuryOutlook(sim, player.id);
    const burn = outlook ? outlook.wages + outlook.upkeep : 0;
    const rawTreasury = treasuryRaw(outlook?.runway ?? null, outlook?.free ?? 0, burn, netFlow(player.flow));
    const capital = worldOf(sim, player.capitalId);
    const foodDays = capital ? foodCover(capital.population, capital.stock.food, sim.rules.foodPer100) : 999;
    const rawFood = foodDays >= 999 ? "ok" : foodRaw(foodDays);
    const previous = alarmRef.current;
    const nextTreasury = previous ? holdAlarm("treasury", previous.treasury, rawTreasury, outlook?.runway ?? 999) : rawTreasury;
    const nextFood = previous ? holdAlarm("food", previous.food, rawFood, foodDays >= 999 ? 999 : foodDays) : rawFood;
    alarmRef.current = { treasury: nextTreasury, food: nextFood };
    if (previous) {
      if (worsened(previous.treasury, nextTreasury)) {
        pushToast(nextTreasury === "critical" ? "error" : "warn", nextTreasury === "critical" ? "Казна: критично" : "Казна: мало", treasuryWarning(sim, player.id) ?? "Запас хода казны стал короче.");
      } else if (previous.treasury !== "ok" && nextTreasury === "ok") {
        pushToast("ok", "Казна снова в норме", "Запас хода снова длиннее порога.");
      }
      if (worsened(previous.food, nextFood)) {
        pushToast(nextFood === "critical" ? "error" : "warn", "Еда столицы", foodDays <= 3 ? `Голод через ${foodDays} дн.` : `Запас на ${foodDays} дн.`);
      } else if (previous.food !== "ok" && nextFood === "ok") {
        pushToast("ok", "Еда столицы снова в норме", `Запас на ${foodDays} дн.`);
      }
      if (previous.treasury !== "critical" && nextTreasury === "critical" && !prefersReducedMotion()) {
        const chip = treasuryRef.current;
        if (chip) {
          chip.classList.remove("chip-pulse");
          void chip.offsetWidth;
          chip.classList.add("chip-pulse");
        }
      }
    }
    setAlarm((current) => current.treasury === nextTreasury && current.food === nextFood ? current : { treasury: nextTreasury, food: nextFood });
  }, [sim]);

  useEffect(() => {
    const focusFrom: { current: FocusFrom } = { current: "keyboard" };
    const spaceClaimed = { current: false };
    const onPointerDown = () => {
      focusFrom.current = "pointer";
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") focusFrom.current = "keyboard";
      if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
        setToasts((items) => items.slice(0, -1));
      }
      const route = routeTimeHotkey({
        code: event.code,
        key: event.key,
        repeat: event.repeat,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        composing: event.isComposing,
        target: classifyHotkeyTarget(event.target),
        focusFrom: focusFrom.current,
        dialogOpen: Boolean(document.querySelector("dialog[open]")),
      });
      if (route.preventDefault) event.preventDefault();
      spaceClaimed.current = nextSpaceClaim(spaceClaimed.current, "keydown", event.code, route.preventDefault);
      if (route.action === "toggle-pause") togglePause();
      if (route.action === "speed-1") changeSpeed(1);
      if (route.action === "speed-2") changeSpeed(2);
      if (route.action === "speed-3") changeSpeed(3);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const release = releaseClaimedSpace(event.code, spaceClaimed.current);
      spaceClaimed.current = nextSpaceClaim(spaceClaimed.current, "keyup", event.code, false);
      if (release.preventDefault) event.preventDefault();
    };
    const onBlur = () => {
      spaceClaimed.current = nextSpaceClaim(spaceClaimed.current, "blur", "", false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
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
    alarmRef.current = null;
    effectsRef.current = [];
    snapRef.current = takeSnap(next);
    setPaused(true);
    setSpeed(1);
    setSim(next);
    setSelected({ kind: "world", id: next.houses.find((house) => house.player)?.capitalId || next.worlds[0]?.id || "" });
    setTab("world");
    const playerId = next.houses.find((house) => house.player)?.id ?? "";
    const preferred = next.ships.find((ship) => ship.houseId === playerId && ship.worldId === "w-bread" && ship.classId === "freighter")
      ?? next.ships.find((ship) => ship.houseId === playerId && ship.status !== "building");
    setShipId(keptShipId(next.ships, playerId, shipId) || preferred?.id || "");
    setOtherHouse(keptOtherHouseId(next.houses, playerId, otherHouse));
    setStopWorld(next.worlds.some((world) => world.id === "w-bread") ? "w-bread" : keptWorldId(next.worlds, ""));
    setDraftStops([]);
    setConfirm(null);
    setGoalOpen(localStorage.getItem(GOAL_KEY) !== "1");
    const canvas = canvasRef.current;
    cameraRef.current = framed(next, canvas?.clientWidth ?? 0, canvas?.clientHeight ?? 0);
    pushToast("info", "Партия на паузе", "Пробел продолжает время. 1, 2 и 3 меняют скорость.");
  }

  function act(command: Command) {
    const current = simRef.current;
    if (!current) return;
    const result = dispatch(current, command);
    pushToast(result.ok ? "ok" : "error", result.ok ? "Готово" : "Не вышло", result.reason || (result.ok ? "Приказ выполнен." : "Приказ не принят."));
    setSim({ ...current });
    setConfirm(null);
  }

  function loadRaw(raw: string) {
    try {
      adopt(deserialize(raw));
      pushToast("ok", "Сохранение загружено", "Партия на паузе.");
    } catch (error) {
      const text = error instanceof SaveError ? error.message : "Файл сохранения повреждён.";
      pushToast("error", "Не открылось", text);
    }
  }

  function noteEffects(current: SimState, playerId: string, before: Snap) {
    const player = current.houses.find((house) => house.id === playerId);
    const capital = player ? worldOf(current, player.capitalId) : undefined;
    if (player && capital && player.credits !== before.credits) {
      effectsRef.current = [...effectsRef.current, makeEffect("popup", capital.x, capital.y, signedInt(player.credits - before.credits), motionMs("--motion-popup", 900))];
      treasuryRef.current?.classList.add("chip-flash");
      window.setTimeout(() => treasuryRef.current?.classList.remove("chip-flash"), motionMs("--motion-fast", 120));
    }
    for (const ship of current.ships) {
      const previous = before.ships.find((item) => item.id === ship.id);
      if (!previous || previous.status === ship.status) continue;
      const point = worldOf(current, ship.worldId ?? ship.toId);
      if (!point) continue;
      if (previous.status === "transit") {
        effectsRef.current = [...effectsRef.current, makeEffect("arrive", point.x, point.y, "", motionMs("--motion-alarm", 1200))];
      }
      if (ship.status === "blocked") {
        effectsRef.current = [...effectsRef.current, makeEffect("stuck", point.x, point.y, "стоит", motionMs("--motion-alarm", 1200))];
      }
    }
  }

  function placeCoach(current: SimState, canvas: HTMLCanvasElement) {
    const mark = coachRef.current;
    const focusId = focusRef.current;
    if (!mark) return;
    const world = focusId ? current.worlds.find((item) => item.id === focusId) : undefined;
    if (!world) {
      mark.style.visibility = "hidden";
      return;
    }
    const point = project(cameraRef.current, canvas.clientWidth, canvas.clientHeight, world.x, world.y);
    const outside = point.x < 0 || point.y < 0 || point.x > canvas.clientWidth || point.y > canvas.clientHeight;
    mark.style.visibility = outside ? "hidden" : "visible";
    mark.style.transform = `translate(${point.x}px, ${point.y}px)`;
  }

  function placeHover(current: SimState, canvas: HTMLCanvasElement) {
    const card = hoverCardRef.current;
    const hover = hoverRef.current;
    if (!card) return;
    if (!hover || dragRef.current) {
      card.classList.remove("show");
      return;
    }
    const point = unproject(cameraRef.current, canvas.clientWidth, canvas.clientHeight, hover.x, hover.y);
    const hit = pickMapTarget(current, point, cameraRef.current.zoom);
    if (!hit) {
      card.classList.remove("show");
      return;
    }
    const title = card.querySelector("strong");
    const sub = card.querySelector("span");
    if (hit.kind === "world") {
      const world = worldOf(current, hit.id);
      if (title) title.textContent = world?.name ?? "";
      if (sub) sub.textContent = world?.specialty ?? "";
    } else {
      const ship = current.ships.find((item) => item.id === hit.id);
      if (title) title.textContent = ship?.name ?? "";
      if (sub) sub.textContent = ship?.stopReason || ship?.status || "";
    }
    card.style.left = `${hover.x + 12}px`;
    card.style.top = `${hover.y + 12}px`;
    card.classList.add("show");
  }

  function pickAt(x: number, y: number, radiusPx?: number) {
    const current = simRef.current;
    const canvas = canvasRef.current;
    if (!current || !canvas) return;
    const point = unproject(cameraRef.current, canvas.clientWidth, canvas.clientHeight, x, y);
    const hit = pickMapTarget(current, point, cameraRef.current.zoom, radiusPx);
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

  function zoomBy(factor: number) {
    cameraRef.current.zoom = Math.max(0.28, Math.min(2.2, cameraRef.current.zoom * factor));
  }

  const player = sim?.houses.find((house) => house.player) ?? null;
  const selectedWorld = sim && selected?.kind === "world" ? worldOf(sim, selected.id) : undefined;
  const selectedShip = sim && selected?.kind === "ship" ? sim.ships.find((ship) => ship.id === selected.id) : undefined;
  const commandShipId = player ? fleetCommandShipId(selectedShip, player.id, shipId) : shipId;
  routeRef.current = (selectedShip?.routeId ?? sim?.ships.find((ship) => ship.id === commandShipId)?.routeId) || null;
  const lessons = sim ? lessonViews(sim) : [];
  const currentLesson = lessons.find((lesson) => !lesson.done) ?? null;
  focusRef.current = sim && !sim.tutorial.skipped ? currentLesson?.focusWorldId ?? null : null;
  const gapCount = sim && player ? bottlenecks(sim, player.id).length : 0;
  const decisionCount = sim && player ? sim.situations.filter((item) => item.houseId === player.id && item.status === "open").length : 0;
  const moreLabel = [...DESKTOP_MORE, ...PHONE_MORE].find(([id]) => id === tab)?.[1];

  const outlook = sim && player ? treasuryOutlook(sim, player.id) : null;
  const flow = player ? netFlow(player.flow) : 0;
  const capital = sim && player ? worldOf(sim, player.capitalId) : undefined;
  const foodDays = capital && sim ? foodCover(capital.population, capital.stock.food, sim.rules.foodPer100) : 999;
  const treasurySub = outlook
    ? `${flow < 0 ? "↓" : "↑"} ${signedInt(flow)} за окно${alarm.treasury === "critical" ? ` · критично, на ${outlook.runway} дн.` : alarm.treasury === "low" ? ` · мало, на ${outlook.runway} дн.` : ` · на ${outlook.runway} дн.`}`
    : "расхода нет";
  const foodSub = alarm.food === "critical" ? `еда столицы · голод через ${foodDays} дн.` : alarm.food === "low" ? "еда столицы · мало" : "еда столицы";
  const brief = sim ? campaignBrief(sim) : null;

  return (
    <div className="app">
      {!sim || !player ? (
        <MenuScreen
          seed={seed}
          worldCount={worldCount}
          houseCount={houseCount}
          onSeed={setSeed}
          onWorlds={setWorldCount}
          onHouses={setHouseCount}
          onBase={() => adopt(createGame({ seed, scenario: "base" }))}
          onScenario={(kind) => {
            if (kind === "border-contract") adopt(createBorderContractScenario());
            if (kind === "crowded-harbor") adopt(createCrowdedHarborScenario());
            if (kind === "industry-dependence") adopt(createIndustryDependenceScenario());
          }}
          onCustom={() => {
            try {
              adopt(createGame({ seed, scenario: "generated", worlds: worldCount, houses: houseCount }));
            } catch (error) {
              pushToast("error", "Сектор не собрался", error instanceof Error ? error.message : "Не удалось создать сектор.");
            }
          }}
          onLoad={() => {
            try {
              const raw = localStorage.getItem(AUTOSAVE_KEY);
              if (!raw) pushToast("warn", "Нет записи", "Автосохранения нет.");
              else loadRaw(raw);
            } catch {
              pushToast("error", "Нет записи", "Браузер не отдал автосохранение.");
            }
          }}
          onImport={(raw) => loadRaw(raw)}
        />
      ) : (
        <>
          <header className="topbar">
            <div className="brand">Дома Пограничья</div>
            <div className="house-name" data-crest={player.crest}>
              <Seal crest={player.crest} size={16} />
              <strong>{player.name}</strong>
            </div>
            <button
              ref={treasuryRef}
              type="button"
              className={`chip chip-${alarm.treasury}`}
              title={treasuryWarning(sim, player.id) ?? "Казна"}
              onClick={() => setTab("cash")}
              onAnimationEnd={(event) => {
                if (event.animationName === "chip-pulse") event.currentTarget.classList.remove("chip-pulse");
              }}
            >
              <span className="chip-main"><Icon name="ui-credits" size={16} />{groupInt(player.credits)} кред.{alarm.treasury !== "ok" ? " ›" : ""}</span>
              <span className="chip-sub">{treasurySub}</span>
            </button>
            {foodDays < 999 ? (
              <button
                type="button"
                className={`chip chip-${alarm.food}`}
                title={`${capital?.name ?? "Столица"}: еды на ${foodDays} дн.`}
                onClick={() => {
                  setSelected({ kind: "world", id: player.capitalId });
                  setTab("gaps");
                  cameraRef.current = { ...cameraRef.current, x: capital?.x ?? cameraRef.current.x, y: capital?.y ?? cameraRef.current.y };
                }}
              >
                <span className="chip-main"><Icon name="ui-food-days" size={16} />{foodDays} дн.{alarm.food !== "ok" ? " ›" : ""}</span>
                <span className="chip-sub">{foodSub}</span>
              </button>
            ) : null}
            <div className="date" title={`день симуляции № ${sim.tick}`}>
              <span>{formatDay(sim)} · окно {player.flowDays} / {sim.rules.window}</span>
            </div>
            <span className={`badge ${paused ? "badge-warn" : "badge-ok"}`}>{paused ? "На паузе" : "Идёт"}</span>
            <button type="button" className="btn btn-secondary" aria-pressed={paused} onClick={togglePause}>
              <Icon name={paused ? "ui-play" : "ui-pause"} size={18} />
              <span>{paused ? "Запустить" : "Пауза"}</span>
            </button>
            <div className="speed" role="group" aria-label="Скорость">
              {([[1, "1×"], [2, "3×"], [3, "8×"]] as const).map(([id, label]) => (
                <button key={id} type="button" className="btn" aria-pressed={speed === id} onClick={() => changeSpeed(id)}>{label}</button>
              ))}
            </div>
          </header>
          <div className="stage">
            <div className="map-wrap">
              <canvas
                ref={canvasRef}
                aria-label="Карта сектора"
                onPointerDown={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
                  pointersRef.current.set(event.pointerId, point);
                  event.currentTarget.setPointerCapture(event.pointerId);
                  if (pointersRef.current.size >= 2) {
                    const [a, b] = [...pointersRef.current.values()];
                    pinchRef.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: cameraRef.current.zoom };
                    dragRef.current = null;
                    return;
                  }
                  dragRef.current = { x: event.clientX, y: event.clientY, camX: cameraRef.current.x, camY: cameraRef.current.y, moved: false };
                  event.currentTarget.classList.add("dragging");
                }}
                onPointerMove={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
                  if (pointersRef.current.has(event.pointerId)) pointersRef.current.set(event.pointerId, point);
                  hoverRef.current = point;
                  if (pointersRef.current.size >= 2 && pinchRef.current && pinchRef.current.dist > 0) {
                    const [a, b] = [...pointersRef.current.values()];
                    const dist = Math.hypot(a.x - b.x, a.y - b.y);
                    cameraRef.current.zoom = Math.max(0.28, Math.min(2.2, pinchRef.current.zoom * (dist / pinchRef.current.dist)));
                    return;
                  }
                  const drag = dragRef.current;
                  if (!drag) return;
                  const dx = event.clientX - drag.x;
                  const dy = event.clientY - drag.y;
                  if (Math.hypot(dx, dy) > 4) drag.moved = true;
                  cameraRef.current.x = drag.camX - dx / cameraRef.current.zoom;
                  cameraRef.current.y = drag.camY - dy / cameraRef.current.zoom;
                }}
                onPointerUp={(event) => {
                  pointersRef.current.delete(event.pointerId);
                  if (pointersRef.current.size < 2) pinchRef.current = null;
                  const drag = dragRef.current;
                  event.currentTarget.classList.remove("dragging");
                  if (drag && !drag.moved && pointersRef.current.size === 0) {
                    const rect = event.currentTarget.getBoundingClientRect();
                    const coarse = event.pointerType === "touch" || matchMedia("(pointer: coarse)").matches;
                    pickAt(event.clientX - rect.left, event.clientY - rect.top, coarse ? 22 : undefined);
                  }
                  dragRef.current = null;
                }}
                onPointerLeave={() => {
                  hoverRef.current = null;
                }}
              />
              <div ref={hoverCardRef} className="hover-card"><strong /><span className="muted" /></div>
              <div ref={coachRef} className="coach"><span>{currentLesson?.title ?? ""}</span></div>
              <details className="legend">
                <summary>Легенда</summary>
                <p>Кольцо — предел владения. Печать — дом. Пунктир — маршрут. Надпись «стоит» — корабль не может идти.</p>
              </details>
              <div className="zoom-pad">
                <button type="button" className="btn" aria-label="Ближе" onClick={() => zoomBy(1.1)}>+</button>
                <button type="button" className="btn" aria-label="Дальше" onClick={() => zoomBy(0.9)}>−</button>
                <button type="button" className="btn" aria-label="К своим мирам" onClick={() => { cameraRef.current = framed(sim, canvasRef.current?.clientWidth ?? 0, canvasRef.current?.clientHeight ?? 0); }}>⌖</button>
              </div>
            </div>
            <aside className={narrow ? "sheet" : "side"} style={narrow ? { height: sheetH } : undefined}>
              {narrow ? (
                <div
                  className="sheet-handle"
                  aria-label="Потянуть панель"
                  onPointerDown={(event) => {
                    sheetDrag.current = { y: event.clientY, h: sheetH };
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  onPointerMove={(event) => {
                    const drag = sheetDrag.current;
                    if (!drag) return;
                    setSheetH(clampSheet(drag.h + (drag.y - event.clientY), window.innerHeight));
                  }}
                  onPointerUp={(event) => {
                    const drag = sheetDrag.current;
                    if (!drag) return;
                    setSheetH(snapSheet(drag.h + (drag.y - event.clientY), window.innerHeight));
                    sheetDrag.current = null;
                  }}
                />
              ) : (
                <div className="tabs" role="tablist">
                  {MAIN_TABS.map(([id, label]) => <TabButton key={id} selected={tab === id} onClick={() => setTab(id)}>{label}</TabButton>)}
                  {gapCount > 0 || tab === "gaps" ? <TabButton selected={tab === "gaps"} count={gapCount} onClick={() => setTab("gaps")}>Сбои</TabButton> : null}
                  {decisionCount > 0 || tab === "politics" ? <TabButton selected={tab === "politics"} count={decisionCount} onClick={() => setTab("politics")}>Решения</TabButton> : null}
                  <details className="more">
                    <summary className="tab" aria-selected={Boolean(moreLabel)}>{moreLabel ?? "Ещё"} ▾</summary>
                    <div className="more-menu">
                      {DESKTOP_MORE.map(([id, label]) => <TabButton key={id} selected={tab === id} onClick={() => { setTab(id); }}>{label}</TabButton>)}
                    </div>
                  </details>
                </div>
              )}
              <div className="panel" role="tabpanel">
                <div className="panel-body">
                  <LearnStrip
                    sim={sim}
                    onSkip={() => act({ type: "skipTutorial" })}
                    onResume={() => act({ type: "resumeTutorial" })}
                    onFocus={(worldId) => {
                      setSelected({ kind: "world", id: worldId });
                      setTab("world");
                    }}
                  />
                  {tab === "world" ? (
                    <WorldPanel
                      sim={sim}
                      worldId={selectedWorld?.id ?? sim.worlds[0].id}
                      onSelect={(id) => setSelected({ kind: "world", id })}
                      onDevelop={(path) => openDevelop(path)}
                      onCancelDevelopment={() => openCancelDevelopment()}
                      onExpand={(kind) => openExpand(kind)}
                      onColonize={() => openColonize()}
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
                        if (!plan.ok) pushToast("warn", "Пока нельзя", plan.reason);
                        else setConfirm({ title: `Построить ${RECIPES[kind].name}`, lines: plan.lines, run: () => act({ type: "build", houseId: player.id, worldId, kind }) });
                      }}
                      onShip={(classId) => {
                        const worldId = selectedWorld?.id ?? player.capitalId;
                        const plan = planShip(sim, player.id, worldId, classId);
                        if (!plan.ok) pushToast("warn", "Пока нельзя", plan.reason);
                        else setConfirm({ title: `Заложить ${SHIP_CLASSES[classId].name}`, lines: plan.lines, run: () => act({ type: "buildShip", houseId: player.id, worldId, classId }) });
                      }}
                      onToggle={(buildingId, enabled) => act({ type: "toggleBuilding", houseId: player.id, buildingId, enabled })}
                    />
                  ) : null}
                  {tab === "fleet" ? (
                    <FleetPanel
                      sim={sim}
                      houseId={player.id}
                      shipId={commandShipId}
                      simple={sim.routes.every((route) => route.houseId !== player.id)}
                      draftName={draftName}
                      minLoad={draftMinLoad}
                      maxWait={draftMaxWait}
                      stops={draftStops}
                      stopWorld={stopWorld}
                      action={action}
                      onShip={(id) => {
                        setShipId(id);
                        setSelected({ kind: "ship", id });
                      }}
                      onName={setDraftName}
                      onMinLoad={setDraftMinLoad}
                      onMaxWait={setDraftMaxWait}
                      onStopWorld={setStopWorld}
                      onAction={setAction}
                      onAddStop={() => setDraftStops((stops) => [...stops, { worldId: stopWorld, actions: [] }])}
                      onAddAction={() => setDraftStops((stops) => {
                        if (stops.length === 0) return stops;
                        const copy = stops.map((stop) => ({ ...stop, actions: [...stop.actions] }));
                        copy[copy.length - 1].actions.push({ ...action });
                        return copy;
                      })}
                      onRemoveStop={(index) => setDraftStops((stops) => stops.filter((_, item) => item !== index))}
                      onClear={() => setDraftStops([])}
                      onCreate={() => act({ type: "createRoute", houseId: player.id, name: draftName, stops: draftStops, shipId: commandShipId || undefined, minLoad: draftMinLoad, maxWait: draftMaxWait, autoFuel: false })}
                      onCreateSimple={(draft) => act({
                        type: "createRoute",
                        houseId: player.id,
                        name: "Первый рейс",
                        shipId: draft.shipId,
                        autoFuel: false,
                        minLoad: draft.minLoad,
                        maxWait: draft.maxWait,
                        stops: [
                          { worldId: draft.fromId, actions: [{ good: draft.good, mode: "load", amount: draft.amount, price: 0, keep: 0 }] },
                          { worldId: draft.toId, actions: [{ good: draft.good, mode: draft.mode, amount: draft.amount, price: draft.price, keep: draft.keep }] },
                        ],
                      })}
                      onPause={(routeId, next) => act({ type: "pauseRoute", routeId, paused: next })}
                      onAssign={(id, routeId) => act({ type: "assignShip", shipId: id, routeId })}
                      onUpdate={(routeId) => act({ type: "updateRoute", routeId, name: draftName, stops: draftStops, minLoad: draftMinLoad, maxWait: draftMaxWait })}
                      onLoadRoute={(routeId) => {
                        const route = sim.routes.find((item) => item.id === routeId);
                        if (!route) return;
                        setDraftName(route.name);
                        setDraftMinLoad(route.minLoad);
                        setDraftMaxWait(route.maxWait);
                        setDraftStops(route.stops.map((stop) => ({ worldId: stop.worldId, actions: stop.actions.map((item) => ({ ...item })) })));
                      }}
                    />
                  ) : null}
                  {tab === "cash" ? <CashPanel sim={sim} houseId={player.id} /> : null}
                  {tab === "gaps" ? <GapPanel sim={sim} houseId={player.id} /> : null}
                  {tab === "politics" ? (
                    <PoliticsPanel
                      sim={sim}
                      houseId={player.id}
                      onChoose={(situationId, choice) => openChoice(situationId, choice)}
                      onRefuse={(situationId) => {
                        const live = simRef.current?.situations.find((item) => item.id === situationId);
                        if (!live || live.status !== "open") {
                          pushToast("warn", "Уже закрыто", "Решение уже закрыто. Повторно казна не списывается.");
                          return;
                        }
                        act({ type: "resolveSituation", houseId: player.id, situationId, choice: "refuse" });
                      }}
                      onWorld={(worldId) => {
                        setSelected({ kind: "world", id: worldId });
                        setTab("world");
                      }}
                      onDeals={() => setTab("deals")}
                    />
                  ) : null}
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
                          run: () => act({ type: "proposeTreaty", houseId: player.id, otherId, kind: "exchange", tariffBps: treatyTariff, good: "food", qtyPerWindow: treatyQty, duration: 96 }),
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
                        pushToast(saved ? "ok" : "warn", saved ? "Записано" : "Не записалось", saved ? "Партия записана в браузер." : "Браузер не принял запись. Партия на экране сохранена.");
                      }}
                      onExport={() => download(serialize(sim), `border-house-${sim.seed}.json`)}
                      onImport={(raw) => loadRaw(raw)}
                      onBase={() => adopt(createGame({ seed: sim.seed, scenario: "base" }))}
                      onDiag={(kind) => {
                        if (kind === "grain") adopt(createGrainScenario(sim.seed));
                        if (kind === "succession") adopt(createSuccessionScenario(sim.seed, true));
                        if (kind === "fallback") adopt(createSuccessionScenario(sim.seed, false));
                        if (kind === "colony") adopt(createExpansionScenario(sim.seed));
                        if (kind === "crisis") adopt(createCrisisScenario(sim.seed));
                        pushToast("info", "Проверочный сценарий", "Это не продолжение кампании.");
                      }}
                    />
                  ) : null}
                </div>
              </div>
            </aside>
            {narrow ? (
              <nav className="bottom-nav" aria-label="Разделы">
                {MAIN_TABS.map(([id, label]) => <TabButton key={id} selected={tab === id} onClick={() => setTab(id)}>{label}</TabButton>)}
                <details className="more">
                  <summary className="tab">
                    {moreLabel ?? "Ещё"}
                    {gapCount > 0 ? <span className="tab-count">{gapCount}</span> : null}
                  </summary>
                  <div className="more-menu">
                    {PHONE_MORE.map(([id, label]) => (
                      <TabButton key={id} selected={tab === id} count={id === "gaps" ? gapCount : id === "politics" ? decisionCount : undefined} onClick={() => { setTab(id); }}>{label}</TabButton>
                    ))}
                  </div>
                </details>
              </nav>
            ) : null}
          </div>
        </>
      )}
      <ToastStack items={toasts} onClose={(id) => setToasts((items) => items.filter((item) => item.id !== id))} />
      {confirm ? (
        <ConfirmDialog title={confirm.title} lines={confirm.lines} onConfirm={confirm.run} onCancel={() => setConfirm(null)} />
      ) : null}
      {goalOpen && sim ? (
        <dialog open className="goal">
          <h2>{brief?.title ?? "Цель партии"}</h2>
          <p>{brief?.text ?? "Держите столицу сытой и проведите первый рейс. Обучение идёт по состоянию партии. Первое окно может закрыться в минусе."}</p>
          {brief ? <ul className="goal-list">{brief.measures.map((measure) => <li key={measure.id}>{measure.title}</li>)}</ul> : null}
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={() => { localStorage.setItem(GOAL_KEY, "1"); setGoalOpen(false); }}>К карте</button>
          </div>
        </dialog>
      ) : null}
    </div>
  );

  function openDevelop(path: DevelopmentPath) {
    if (!sim || !player) return;
    const world = selectedWorld ?? sim.worlds[0];
    const blocked = developmentBlock(sim, player.id, world.id, path);
    if (blocked) {
      pushToast("warn", "Пока нельзя", blocked);
      return;
    }
    const dev = world.development;
    const target = dev?.path === path && dev.level === 1 ? 2 : 1;
    const price = levelCost(path, target as 1 | 2);
    const switching = Boolean(dev?.path && dev.path !== path);
    const worldId = world.id;
    setConfirm({
      title: `${world.name}: ${PATH_LABEL[path]} путь, уровень ${target}`,
      lines: [
        `${price.cost} кред. уйдут населению, ${price.parts} комплектующих спишутся, срок ${price.days} дн.`,
        switching ? `Сейчас действует другой путь. На время стройки его бонус погаснет, вложенные ${dev?.invested ?? 0} кред. не вернутся.` : "Пока стройка не закончена, бонус этого уровня не действует.",
        "Склад не вырастет. Смена туда-обратно и отмена не возвращают комплектующие и не выдают повторный бонус.",
      ],
      run: () => {
        const current = simRef.current;
        const live = current?.worlds.find((item) => item.id === worldId);
        const liveTarget = live?.development?.path === path && live.development.level === 1 ? 2 : 1;
        const stillBlocked = current ? developmentBlock(current, player.id, worldId, path) : "нет партии";
        if (!live || liveTarget !== target || stillBlocked) {
          pushToast("warn", "Условия изменились", stillBlocked && liveTarget === target ? stillBlocked : `Подтверждён уровень ${target}, сейчас доступен уровень ${liveTarget}.`);
          setConfirm(null);
          return;
        }
        act({ type: "developWorld", houseId: player.id, worldId, path });
      },
    });
  }

  function openCancelDevelopment() {
    if (!sim || !player) return;
    const world = selectedWorld ?? sim.worlds[0];
    const spent = world.development?.project?.spent ?? 0;
    setConfirm({
      title: `${world.name}: отменить перестройку`,
      lines: [
        `Вернётся ${Math.floor(spent / 2)} кред., если они ещё у населения. Вторая половина и комплектующие останутся потраченными.`,
        "Завершённый уровень этой отменой не снимается и заново не выдаётся.",
      ],
      run: () => act({ type: "cancelDevelopment", houseId: player.id, worldId: world.id }),
    });
  }

  function openExpand(kind: "berth" | "speed") {
    if (!sim || !player) return;
    const world = selectedWorld ?? sim.worlds[0];
    const cost = kind === "berth" ? BERTH_COST : SPEED_COST;
    const parts = kind === "berth" ? BERTH_PARTS : SPEED_PARTS;
    const days = kind === "berth" ? BERTH_DAYS : SPEED_DAYS;
    const title = kind === "berth" ? "дополнительный причал" : "ускорение обработки";
    setConfirm({
      title: `${world.name}: ${title}`,
      lines: [
        `${cost} кред. уйдут населению, ${parts} комплектующих спишутся, срок ${days} дн.`,
        "Складская ёмкость мира не вырастет. Пока стройка идёт, второй проект начать нельзя.",
      ],
      run: () => act({ type: "expandPort", houseId: player.id, worldId: world.id, kind }),
    });
  }

  function openColonize() {
    if (!sim || !player || !selectedWorld) return;
    const ship = colonyShip(sim.ships, player.id, shipId);
    if (!ship) return;
    const world = selectedWorld;
    setConfirm({
      title: `Основать колонию на «${world.name}»`,
      lines: [
        `Корабль ${ship.name} должен довезти ${sim.rules.colonizeFood} продовольствия и ${sim.rules.colonizeParts} комплектующих.`,
        `По прибытии казна отдаст населению ${sim.rules.colonizeCost} кред. Предприятий не появится, мир не станет сразу доходным.`,
      ],
      run: () => act({ type: "colonize", houseId: player.id, shipId: ship.id, worldId: world.id }),
    });
  }

  function openChoice(situationId: string, choice: SituationChoice) {
    if (!sim || !player) return;
    const situation = sim.situations.find((item) => item.id === situationId);
    if (!situation || situation.status !== "open") {
      pushToast("warn", "Уже закрыто", "Решение уже закрыто. Повторно казна не списывается.");
      return;
    }
    setConfirm({
      title: `${SITUATION_LABEL[situation.kind]}: ${CHOICE_LABEL[choice]}`,
      lines: choicePreview(situation, choice),
      run: () => {
        const live = simRef.current?.situations.find((item) => item.id === situationId);
        if (!live || live.status !== "open") {
          pushToast("warn", "Уже закрыто", "Решение уже закрыто. Повторно казна не списывается.");
          setConfirm(null);
          return;
        }
        act({ type: "resolveSituation", houseId: player.id, situationId, choice });
      },
    });
  }
}

function framed(state: SimState, width: number, height: number): Camera {
  const owner = state.houses.find((house) => house.player)?.id;
  const own = owner ? state.worlds.filter((world) => world.ownerId === owner) : [];
  return frameCamera(own.length > 0 ? own : state.worlds, width, height);
}

function takeSnap(state: SimState): Snap {
  const player = state.houses.find((house) => house.player);
  return {
    credits: player?.credits ?? 0,
    flowDays: player?.flowDays ?? 0,
    ships: state.ships.map((ship) => ({ id: ship.id, status: ship.status })),
  };
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
