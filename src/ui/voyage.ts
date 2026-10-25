import { SHIP_CLASSES } from "../sim/config";
import { GOOD_NAME, type GoodId } from "../sim/goods";
import { foodCover, tariffBetween, worldOf } from "../sim/mutate";
import { territoriesOnRoute } from "../sim/simulate";
import { transitFuelDiscount } from "../sim/specialty";
import type { Ship, SimState } from "../sim/types";
import { foodPerDay } from "../sim/view";

export interface VoyagePreview {
  fromName: string;
  toName: string;
  days: number;
  fuelNeed: number;
  fuelHave: number;
  tolls: Array<{ name: string; fee: number }>;
  capitalName: string;
  capitalDaysNow: number;
  capitalDaysArrive: number;
  note: string;
}

export function previewVoyage(state: SimState, ship: Ship, fromId: string, toId: string, good: GoodId, amount: number): VoyagePreview | null {
  const from = worldOf(state, fromId);
  const to = worldOf(state, toId);
  const player = state.houses.find((house) => house.id === ship.houseId);
  const capital = player ? worldOf(state, player.capitalId) : undefined;
  if (!from || !to || !capital) return null;
  const shipClass = SHIP_CLASSES[ship.classId];
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const days = from.id === to.id || shipClass.speed <= 0 ? 0 : Math.max(1, Math.ceil(distance / shipClass.speed));
  const fuelNeed = from.id === to.id ? 0 : Math.max(1, Math.ceil((distance * shipClass.fuelPer1000) / 1000) - transitFuelDiscount(from, ship.houseId));
  const crossings = from.id === to.id ? [] : territoriesOnRoute(state, from.id, to.id, ship.houseId);
  const value = Math.max(0, amount) * from.prices[good];
  const tolls = crossings.map((world) => ({
    name: world.name,
    fee: world.ownerId ? Math.floor((value * tariffBetween(state, ship.houseId, world.ownerId, world.tariffBps, world.id)) / 10000) : 0,
  }));
  const perDay = foodPerDay(capital.population, state.rules.foodPer100);
  const delivered = to.id === capital.id && (good === "food") ? Math.max(0, amount) : 0;
  const left = Math.max(0, capital.stock.food - perDay * days + delivered);
  return {
    fromName: from.name,
    toName: to.name,
    days,
    fuelNeed,
    fuelHave: ship.cargo.fuel,
    tolls,
    capitalName: capital.name,
    capitalDaysNow: foodCover(capital.population, capital.stock.food, state.rules.foodPer100),
    capitalDaysArrive: foodCover(capital.population, left, state.rules.foodPer100),
    note: `Оценка одного перегона ${GOOD_NAME[good]}: путь и топливо из бака. Выручка сюда не входит — первое окно на этом балансе может закрыться в минусе.`,
  };
}
