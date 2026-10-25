import { SHIP_CLASSES } from "../sim/config";
import { houseOf } from "../sim/mutate";
import { shipPoint } from "../sim/view";
import type { GoodId } from "../sim/goods";
import type { House, Route, Ship, SimState, World } from "../sim/types";
import type { MapEffect } from "./effects";
import { crestFile } from "./icons";
import { iconReady, tintedIcon } from "./mapAssets";

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface DrawMapOptions {
  paused?: boolean;
  alpha?: number;
  now?: number;
  reducedMotion?: boolean;
  playerId?: string;
  effects?: MapEffect[];
  selectedRouteId?: string | null;
}

export function project(camera: Camera, width: number, height: number, x: number, y: number): { x: number; y: number } {
  return {
    x: width / 2 + (x - camera.x) * camera.zoom,
    y: height / 2 + (y - camera.y) * camera.zoom,
  };
}

export function unproject(camera: Camera, width: number, height: number, x: number, y: number): { x: number; y: number } {
  return {
    x: camera.x + (x - width / 2) / camera.zoom,
    y: camera.y + (y - height / 2) / camera.zoom,
  };
}

/** Ставит камеру на середину миров так, чтобы они помещались в текущий холст. */
export function frameCamera(worlds: Array<{ x: number; y: number }>, width: number, height: number): Camera {
  if (worlds.length === 0 || width < 2 || height < 2) return { x: 560, y: 380, zoom: 0.68 };
  let minX = worlds[0].x;
  let maxX = worlds[0].x;
  let minY = worlds[0].y;
  let maxY = worlds[0].y;
  for (const world of worlds) {
    minX = Math.min(minX, world.x);
    maxX = Math.max(maxX, world.x);
    minY = Math.min(minY, world.y);
    maxY = Math.max(maxY, world.y);
  }
  const spanX = Math.max(160, maxX - minX + 120);
  const spanY = Math.max(160, maxY - minY + 120);
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    zoom: Math.max(0.28, Math.min(2.2, Math.min(width / spanX, height / spanY))),
  };
}

const COLOR_NAMES = [
  "--color-bg-app",
  "--color-bg-raised",
  "--color-border-default",
  "--color-text-primary",
  "--color-text-secondary",
  "--color-text-disabled",
  "--color-text-on-accent",
  "--color-status-ok",
  "--color-status-warn",
  "--color-status-error",
  "--color-map-dim",
  "--color-house-solar",
  "--color-house-vega",
  "--color-house-orion",
  "--color-house-lyra",
] as const;

function readColors(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const colors: Record<string, string> = {};
  for (const name of COLOR_NAMES) colors[name] = style.getPropertyValue(name).trim();
  return colors;
}

function houseColor(colors: Record<string, string>, house: House | undefined): string {
  if (!house) return "";
  if (house.crest === "СЛ") return colors["--color-house-solar"] ?? "";
  if (house.crest === "ВГ") return colors["--color-house-vega"] ?? "";
  if (house.crest === "ОР") return colors["--color-house-orion"] ?? "";
  if (house.crest === "ЛР") return colors["--color-house-lyra"] ?? "";
  return colors["--color-text-secondary"] ?? "";
}

function specialtyFile(specialty: string): string {
  const text = specialty.toLowerCase();
  if (text.includes("хлеб") || text.includes("еда") || text.includes("зерн") || text.includes("прод")) return "good-food";
  if (text.includes("руд")) return "good-ore";
  if (text.includes("сплав")) return "good-alloys";
  if (text.includes("комплект") || text.includes("верф")) return "good-parts";
  if (text.includes("топлив")) return "good-fuel";
  return "ui-port";
}

type Band = "far" | "mid" | "near";

function bandOf(zoom: number, minDistance: number): Band {
  if (zoom < 0.5 || minDistance < 28) return "far";
  if (zoom < 1.2) return "mid";
  return "near";
}

function minWorldDistance(points: Array<{ x: number; y: number }>): number {
  let min = Number.POSITIVE_INFINITY;
  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      min = Math.min(min, Math.hypot(points[left].x - points[right].x, points[left].y - points[right].y));
    }
  }
  return min;
}

function visualShipPoint(state: SimState, ship: Ship, alpha: number): { x: number; y: number } {
  const here = shipPoint(state, ship);
  if (alpha <= 0 || ship.status !== "transit" || !ship.fromId || !ship.toId || ship.legDistance <= 0) return here;
  const from = state.worlds.find((world) => world.id === ship.fromId);
  const to = state.worlds.find((world) => world.id === ship.toId);
  if (!from || !to) return here;
  const extra = Math.min(ship.distanceLeft, SHIP_CLASSES[ship.classId].speed * alpha);
  const progress = 1 - (ship.distanceLeft - extra) / ship.legDistance;
  return { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress };
}

function drawGlyph(ctx: CanvasRenderingContext2D, file: string, color: string, x: number, y: number, size: number): void {
  const icon = color ? tintedIcon(file, color, size) : iconReady(file);
  if (!icon) return;
  ctx.drawImage(icon, Math.round(x - size / 2), Math.round(y - size / 2), size, size);
}

function drawSeal(ctx: CanvasRenderingContext2D, crest: string, x: number, y: number, size: number, fallback: string, ink: string): void {
  const file = crestFile(crest);
  const image = file ? iconReady(`${file}-${size === 16 ? 16 : 24}`) : null;
  if (image) {
    ctx.drawImage(image, Math.round(x - size / 2), Math.round(y - size / 2), size, size);
    return;
  }
  if (fallback) {
    ctx.fillStyle = fallback;
    ctx.beginPath();
    ctx.arc(x, y, size / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  if (!file && crest && ink) {
    ctx.fillStyle = ink;
    ctx.font = "700 11px PT Sans, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(crest, x, y);
  }
}

interface Segment {
  a: { x: number; y: number };
  b: { x: number; y: number };
  ux: number;
  uy: number;
}

function trimSegment(from: { x: number; y: number }, to: { x: number; y: number }, pad: number): Segment | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len <= pad * 2) return null;
  const ux = dx / len;
  const uy = dy / len;
  return {
    a: { x: from.x + ux * pad, y: from.y + uy * pad },
    b: { x: to.x - ux * pad, y: to.y - uy * pad },
    ux,
    uy,
  };
}

function plaqueAmount(route: Route, worldId: string): { good: GoodId; amount: number } | null {
  const stop = route.stops.find((item) => item.worldId === worldId);
  let best: { good: GoodId; amount: number } | null = null;
  for (const action of stop?.actions ?? []) {
    if (action.mode !== "load" && action.mode !== "buy") continue;
    if (!best || action.amount > best.amount) best = { good: action.good, amount: action.amount };
  }
  return best && best.amount > 0 ? best : null;
}

function strokeRoute(ctx: CanvasRenderingContext2D, segment: Segment, color: string, width: number, dash: number[], alpha = 1): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(segment.a.x, segment.a.y);
  ctx.lineTo(segment.b.x, segment.b.y);
  ctx.stroke();
  ctx.restore();
}

function drawChevron(ctx: CanvasRenderingContext2D, x: number, y: number, ux: number, uy: number, color: string, size: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.atan2(uy, ux));
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(size / 2, 0);
  ctx.lineTo(-size / 2, size / 3);
  ctx.lineTo(-size / 2, -size / 3);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function placeLabels(
  ctx: CanvasRenderingContext2D,
  state: SimState,
  camera: Camera,
  width: number,
  height: number,
  selectedId: string | null,
  playerId: string,
  colors: Record<string, string>,
  band: Band,
  minDistance: number,
): void {
  const player = state.houses.find((house) => house.id === playerId);
  const capitals = new Set(state.houses.map((house) => house.capitalId));
  const stops = new Set(state.routes.filter((route) => route.houseId === playerId).flatMap((route) => route.stops.map((stop) => stop.worldId)));
  const tight = minDistance < 56;
  const ranked = state.worlds.map((world) => {
    let priority = 5;
    if (world.id === selectedId) priority = 0;
    else if (player && world.id === player.capitalId) priority = 1;
    else if (world.ownerId === playerId) priority = 2;
    else if (capitals.has(world.id)) priority = 3;
    else if (stops.has(world.id)) priority = 4;
    return { world, priority };
  });
  ranked.sort((left, right) => left.priority - right.priority || left.world.name.localeCompare(right.world.name, "ru"));
  const placed: LabelBox[] = [];
  const ink = colors["--color-text-primary"];
  const back = colors["--color-bg-app"];
  if (!ink || !back) return;
  for (const item of ranked) {
    if (band === "far" && item.priority !== 0 && item.priority !== 1 && item.priority !== 3) continue;
    const anchor = project(camera, width, height, item.world.x, item.world.y);
    const second = tight && item.world.id !== selectedId ? "" : item.world.id === player?.capitalId ? "столица" : item.world.specialty;
    ctx.font = "700 13px PT Sans, sans-serif";
    const firstWidth = ctx.measureText(item.world.name).width;
    ctx.font = "400 12px PT Sans, sans-serif";
    const secondWidth = second ? ctx.measureText(second).width : 0;
    const boxW = Math.ceil(Math.max(firstWidth, secondWidth) + 8);
    const boxH = second ? 34 : 18;
    const spots = [
      { x: anchor.x + 18, y: anchor.y - boxH / 2 },
      { x: anchor.x - 18 - boxW, y: anchor.y - boxH / 2 },
      { x: anchor.x - boxW / 2, y: anchor.y + 20 },
      { x: anchor.x - boxW / 2, y: anchor.y - 20 - boxH },
    ];
    const spot = spots.find((candidate) => {
      const box = { ...candidate, w: boxW, h: boxH };
      return placed.every((other) => !overlaps(box, { x: other.x - 4, y: other.y - 4, w: other.w + 8, h: other.h + 8 }));
    });
    if (!spot) continue;
    placed.push({ ...spot, w: boxW, h: boxH });
    ctx.save();
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = back;
    ctx.fillRect(spot.x, spot.y, boxW, boxH);
    ctx.restore();
    ctx.fillStyle = ink;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = "700 13px PT Sans, sans-serif";
    ctx.fillText(item.world.name, spot.x + 4, spot.y + 1);
    if (second) {
      ctx.font = "400 12px PT Sans, sans-serif";
      ctx.fillText(second, spot.x + 4, spot.y + 17);
    }
  }
}

function drawEffects(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  width: number,
  height: number,
  effects: MapEffect[],
  now: number,
  colors: Record<string, string>,
  reduced: boolean,
): void {
  for (const effect of effects) {
    const point = project(camera, width, height, effect.x, effect.y);
    const t = Math.max(0, Math.min(1, effect.life <= 0 ? 1 : (now - effect.born) / effect.life));
    if (effect.kind === "popup") {
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = effect.text.startsWith("−") || effect.text.startsWith("-") ? colors["--color-status-error"] : colors["--color-status-ok"];
      ctx.font = "700 15px PT Sans, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(effect.text, point.x, point.y - 16 - (reduced ? 0 : 18 * t));
      ctx.restore();
    } else {
      const radius = reduced ? 16 : 8 + 24 * t;
      ctx.save();
      ctx.globalAlpha = reduced ? 0.8 : 1 - t;
      ctx.strokeStyle = effect.kind === "stuck" ? colors["--color-status-error"] : colors["--color-status-ok"];
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
}

export function drawMap(canvas: HTMLCanvasElement, state: SimState, camera: Camera, selectedId: string | null, options: DrawMapOptions = {}): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width < 2 || height < 2) return;
  const pixelWidth = Math.floor(width * dpr);
  const pixelHeight = Math.floor(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const colors = readColors();
  const bg = colors["--color-bg-app"];
  ctx.clearRect(0, 0, width, height);
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
  }

  const playerId = options.playerId || state.houses.find((house) => house.player)?.id || "";
  const alpha = options.alpha ?? 0;
  const now = options.now ?? 0;
  const reduced = Boolean(options.reducedMotion);
  const many = state.worlds.length > 16;
  const points = state.worlds.map((world) => project(camera, width, height, world.x, world.y));
  const minDistance = minWorldDistance(points);
  const band = bandOf(camera.zoom, minDistance);
  const capitals = new Set(state.houses.map((house) => house.capitalId));

  const grid = colors["--color-border-default"];
  if (grid) {
    const step = camera.zoom < 0.4 ? 200 : 100;
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    const origin = project(camera, width, height, 0, 0);
    ctx.beginPath();
    for (let x = origin.x % step; x < width; x += step) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let y = origin.y % step; y < height; y += step) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  for (const world of state.worlds) {
    if (!world.ownerId) continue;
    const color = houseColor(colors, houseOf(state, world.ownerId));
    if (!color) continue;
    const center = project(camera, width, height, world.x, world.y);
    const radius = state.rules.territoryRadius * camera.zoom;
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
    ctx.save();
    ctx.globalAlpha = many ? 0.04 : 0.07;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = many ? 0.4 : 0.5;
    ctx.strokeStyle = color;
    ctx.lineWidth = many ? 1 : 1.5;
    ctx.stroke();
    ctx.restore();
  }

  for (const route of state.routes) {
    const house = houseOf(state, route.houseId);
    const color = route.paused ? colors["--color-text-disabled"] : houseColor(colors, house);
    if (!color) continue;
    const own = route.houseId === playerId;
    const selected = options.selectedRouteId != null && route.id === options.selectedRouteId;
    for (let index = 0; index < route.stops.length; index += 1) {
      const from = state.worlds.find((world) => world.id === route.stops[index].worldId);
      const to = state.worlds.find((world) => world.id === route.stops[(index + 1) % route.stops.length].worldId);
      if (!from || !to) continue;
      const segment = trimSegment(project(camera, width, height, from.x, from.y), project(camera, width, height, to.x, to.y), 16);
      if (!segment) continue;
      if (selected) strokeRoute(ctx, segment, color, 10, [], 0.22);
      const widthPx = band === "far" ? 1.5 : route.paused ? 1.5 : selected ? 3 : own ? 2 : 1.5;
      const dash = route.paused ? [2, 6] : own || selected ? [8, 6] : [4, 6];
      strokeRoute(ctx, segment, color, widthPx, dash, own || selected || route.paused ? 1 : 0.5);
      if (band !== "far") drawChevron(ctx, (segment.a.x + segment.b.x) / 2, (segment.a.y + segment.b.y) / 2, segment.ux, segment.uy, color, 8);
      const cargo = plaqueAmount(route, from.id);
      if (cargo && band !== "far" && (band === "near" || own)) {
        const px = segment.a.x + (segment.b.x - segment.a.x) * 0.22 - segment.uy * 18;
        const py = segment.a.y + (segment.b.y - segment.a.y) * 0.22 + segment.ux * 18;
        ctx.fillStyle = colors["--color-bg-raised"] || bg;
        ctx.fillRect(Math.round(px - 16), Math.round(py - 10), 32, 20);
        drawGlyph(ctx, `good-${cargo.good}`, colors["--color-text-primary"], px - 6, py, 14);
        ctx.fillStyle = colors["--color-text-primary"];
        ctx.font = "700 12px PT Sans, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(String(cargo.amount), px + 2, py);
      }
      if (!reduced && band !== "far" && own && !route.paused) {
        const dx = segment.b.x - segment.a.x;
        const dy = segment.b.y - segment.a.y;
        const len = Math.hypot(dx, dy);
        const phase = (now / 40) % 24;
        ctx.fillStyle = color;
        for (let dist = phase; dist < len; dist += 24) {
          ctx.beginPath();
          ctx.arc(segment.a.x + (dx / len) * dist, segment.a.y + (dy / len) * dist, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }
  ctx.setLineDash([]);

  state.worlds.forEach((world, index) => drawWorld(ctx, state, world, points[index], selectedId, capitals, colors, band, bg));
  drawShips(ctx, state, camera, width, height, selectedId, colors, band, alpha, bg);
  placeLabels(ctx, state, camera, width, height, selectedId, playerId, colors, band, minDistance);

  if (options.paused && colors["--color-map-dim"]) {
    ctx.fillStyle = colors["--color-map-dim"];
    ctx.fillRect(0, 0, width, height);
  }
  drawEffects(ctx, camera, width, height, options.effects ?? [], now, colors, reduced);
}

function drawWorld(
  ctx: CanvasRenderingContext2D,
  state: SimState,
  world: World,
  point: { x: number; y: number },
  selectedId: string | null,
  capitals: Set<string>,
  colors: Record<string, string>,
  band: Band,
  bg: string,
): void {
  const owner = houseOf(state, world.ownerId ?? "");
  const color = houseColor(colors, owner);
  if (!world.ownerId) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 6, 0, Math.PI * 2);
    ctx.strokeStyle = colors["--color-text-secondary"];
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else {
    const seal = band === "far" ? 16 : 24;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 15, 0, Math.PI * 2);
    ctx.fillStyle = bg;
    ctx.fill();
    if (capitals.has(world.id) && band !== "far") {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 18, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
      drawGlyph(ctx, "ui-capital", color, point.x, point.y - 24, 18);
    }
    drawSeal(ctx, owner?.crest ?? "", point.x, point.y, seal, color || colors["--color-text-secondary"], colors["--color-text-on-accent"]);
    if (band !== "far") {
      drawGlyph(ctx, specialtyFile(world.specialty), colors["--color-text-primary"], point.x + 14, point.y + 12, 18);
      if (world.tariffBps >= 400) drawGlyph(ctx, "ui-toll", colors["--color-status-warn"], point.x + 14, point.y - 12, 18);
      const coverDays = world.population > 0 ? Math.floor((world.stock.food * 100) / (world.population * state.rules.foodPer100)) : 999;
      if (coverDays <= 9) {
        const problem = coverDays <= 3 ? colors["--color-status-error"] : colors["--color-status-warn"];
        drawGlyph(ctx, "ui-food-days", problem, point.x, point.y + 24, 18);
      }
    }
  }
  if (world.id === selectedId) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 23, 0, Math.PI * 2);
    ctx.strokeStyle = colors["--color-text-primary"];
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawShips(
  ctx: CanvasRenderingContext2D,
  state: SimState,
  camera: Camera,
  width: number,
  height: number,
  selectedId: string | null,
  colors: Record<string, string>,
  band: Band,
  alpha: number,
  bg: string,
): void {
  const visible = state.ships.filter((ship) => ship.status !== "building");
  const docked = new Map<string, Ship[]>();
  for (const ship of visible) {
    if (ship.status !== "docked" && ship.status !== "blocked") continue;
    const worldId = ship.worldId ?? ship.fromId ?? "";
    const list = docked.get(worldId) ?? [];
    list.push(ship);
    docked.set(worldId, list);
  }
  for (const ship of visible) {
    const house = houseOf(state, ship.houseId);
    const color = houseColor(colors, house);
    if (!color) continue;
    const worldPoint = visualShipPoint(state, ship, alpha);
    let screen = project(camera, width, height, worldPoint.x, worldPoint.y);
    if (ship.status === "docked" || ship.status === "blocked") {
      const group = docked.get(ship.worldId ?? ship.fromId ?? "") ?? [ship];
      group.sort((left, right) => left.id.localeCompare(right.id));
      const index = group.indexOf(ship);
      if (index > 2) continue;
      const angles = [Math.PI, (145 * Math.PI) / 180, (215 * Math.PI) / 180];
      screen = { x: screen.x + Math.cos(angles[index]) * 33, y: screen.y + Math.sin(angles[index]) * 33 };
      if (index === 0 && group.length > 3) {
        ctx.fillStyle = colors["--color-text-primary"];
        ctx.font = "700 12px PT Sans, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`+${group.length - 3}`, screen.x, screen.y + 28);
      }
    }
    if (band === "far") {
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      if (ship.id === selectedId) {
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, 8, 0, Math.PI * 2);
        ctx.strokeStyle = colors["--color-text-primary"];
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      continue;
    }
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, 11, 0, Math.PI * 2);
    ctx.fillStyle = colors["--color-bg-raised"] || bg;
    ctx.fill();
    ctx.lineWidth = ship.status === "blocked" ? 2 : 1.5;
    ctx.strokeStyle = ship.status === "blocked" ? colors["--color-status-error"] : color;
    ctx.stroke();
    const icon = ship.classId === "barge" ? 16 : ship.classId === "freighter" ? 14 : 12;
    drawGlyph(ctx, `ship-${ship.classId}`, color, screen.x, screen.y, icon);
    if (ship.status === "transit" && ship.fromId && ship.toId) {
      const from = state.worlds.find((world) => world.id === ship.fromId);
      const to = state.worlds.find((world) => world.id === ship.toId);
      if (from && to) {
        const angle = Math.atan2(to.y - from.y, to.x - from.x);
        drawChevron(ctx, screen.x + Math.cos(angle) * 17, screen.y + Math.sin(angle) * 17, Math.cos(angle), Math.sin(angle), color, 8);
      }
    }
    if (ship.status === "blocked") {
      ctx.fillStyle = colors["--color-status-error"];
      ctx.font = "700 12px PT Sans, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText("стоит", screen.x, screen.y - 14);
    }
    if (ship.id === selectedId) {
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, 16, 0, Math.PI * 2);
      ctx.strokeStyle = colors["--color-text-primary"];
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}
