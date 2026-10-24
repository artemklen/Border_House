import { houseOf } from "../sim/mutate";
import { shipPoint } from "../sim/view";
import type { SimState } from "../sim/types";

export interface Camera {
  x: number;
  y: number;
  zoom: number;
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

export function drawMap(canvas: HTMLCanvasElement, state: SimState, camera: Camera, selectedId: string | null): void {
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
  const sky = ctx.createLinearGradient(0, 0, width, height);
  sky.addColorStop(0, "#1a140f");
  sky.addColorStop(0.55, "#10141a");
  sky.addColorStop(1, "#081016");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);
  for (let index = 0; index < 80; index += 1) {
    const sx = ((state.seed * 17 + index * 53) % 997) / 997;
    const sy = ((state.seed * 29 + index * 91) % 991) / 991;
    ctx.fillStyle = index % 6 === 0 ? "rgba(224,168,74,0.75)" : "rgba(243,239,228,0.4)";
    ctx.fillRect(sx * width, sy * height, index % 8 === 0 ? 2 : 1, 1);
  }

  for (const world of state.worlds) {
    if (!world.ownerId) continue;
    const center = project(camera, width, height, world.x, world.y);
    ctx.beginPath();
    ctx.arc(center.x, center.y, state.rules.territoryRadius * camera.zoom, 0, Math.PI * 2);
    ctx.strokeStyle = `${houseOf(state, world.ownerId)?.color ?? "#888"}40`;
    ctx.stroke();
  }

  for (const route of state.routes) {
    const house = houseOf(state, route.houseId);
    ctx.strokeStyle = route.paused ? "#6d6458" : house?.color ?? "#e0a84a";
    ctx.lineWidth = route.paused ? 1 : 1.7;
    ctx.setLineDash(route.paused ? [5, 6] : []);
    for (let index = 0; index < route.stops.length; index += 1) {
      const from = state.worlds.find((world) => world.id === route.stops[index].worldId);
      const to = state.worlds.find((world) => world.id === route.stops[(index + 1) % route.stops.length].worldId);
      if (!from || !to) continue;
      const a = project(camera, width, height, from.x, from.y);
      const b = project(camera, width, height, to.x, to.y);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);

  for (const world of state.worlds) {
    const point = project(camera, width, height, world.x, world.y);
    const owner = houseOf(state, world.ownerId ?? "");
    ctx.beginPath();
    ctx.arc(point.x, point.y, world.ownerId ? 12 : 8, 0, Math.PI * 2);
    ctx.fillStyle = owner?.color ?? "#8d8478";
    ctx.fill();
    if (world.id === selectedId) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#f6f1e6";
      ctx.stroke();
    }
    ctx.fillStyle = "#1a120c";
    ctx.font = "12px Georgia, serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(owner?.crest ?? "·", point.x, point.y + 1);
    ctx.fillStyle = "#f6f1e6";
    ctx.font = "13px Georgia, serif";
    ctx.textAlign = "left";
    ctx.fillText(world.name, point.x + 16, point.y);
  }

  for (const ship of state.ships) {
    if (ship.status === "building") continue;
    const point = shipPoint(state, ship);
    const screen = project(camera, width, height, point.x, point.y);
    ctx.save();
    ctx.translate(screen.x, screen.y);
    if (ship.status === "transit" && ship.fromId && ship.toId) {
      const from = state.worlds.find((world) => world.id === ship.fromId);
      const to = state.worlds.find((world) => world.id === ship.toId);
      if (from && to) ctx.rotate(Math.atan2(to.y - from.y, to.x - from.x));
    }
    ctx.fillStyle = houseOf(state, ship.houseId)?.color ?? "#f6f1e6";
    ctx.beginPath();
    ctx.moveTo(9, 0);
    ctx.lineTo(-7, 5);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-7, -5);
    ctx.closePath();
    ctx.fill();
    if (ship.id === selectedId) {
      ctx.strokeStyle = "#f6f1e6";
      ctx.stroke();
    }
    ctx.restore();
  }
}
