import { emptyGoods, type GoodId } from "./goods";
import type { GameRules, Recipe, ShipClass, ShipClassId } from "./types";

export const SAVE_VERSION = 2;

export const RECIPES: Record<Recipe["kind"], Recipe> = {
  farm: {
    kind: "farm",
    name: "ферма",
    workers: 16,
    credits: 900,
    parts: 4,
    days: 6,
    upkeep: 3,
    inputs: {},
    outputs: { grain: 14 },
    renewable: true,
    deposit: null,
  },
  mill: {
    kind: "mill",
    name: "мельница",
    workers: 10,
    credits: 1100,
    parts: 6,
    days: 6,
    upkeep: 4,
    inputs: { grain: 10 },
    outputs: { food: 10 },
    renewable: true,
    deposit: null,
  },
  mine: {
    kind: "mine",
    name: "рудник",
    workers: 18,
    credits: 1400,
    parts: 8,
    days: 8,
    upkeep: 5,
    inputs: {},
    outputs: { ore: 8 },
    renewable: false,
    deposit: "ore",
  },
  smelter: {
    kind: "smelter",
    name: "плавильня",
    workers: 14,
    credits: 1800,
    parts: 10,
    days: 8,
    upkeep: 6,
    inputs: { ore: 6 },
    outputs: { alloys: 5 },
    renewable: true,
    deposit: null,
  },
  workshop: {
    kind: "workshop",
    name: "мастерская",
    workers: 14,
    credits: 2200,
    parts: 12,
    days: 10,
    upkeep: 7,
    inputs: { alloys: 4 },
    outputs: { parts: 3 },
    renewable: true,
    deposit: null,
  },
  fuelwell: {
    kind: "fuelwell",
    name: "топливный колодец",
    workers: 12,
    credits: 1600,
    parts: 8,
    days: 8,
    upkeep: 5,
    inputs: {},
    outputs: { fuel: 8 },
    renewable: false,
    deposit: "fuel",
  },
};

export const SHIP_CLASSES: Record<ShipClassId, ShipClass> = {
  skiff: {
    id: "skiff",
    name: "шкута",
    capacity: 24,
    speed: 90,
    fuelPer1000: 18,
    upkeep: 2,
    credits: 1800,
    parts: 4,
    days: 5,
  },
  freighter: {
    id: "freighter",
    name: "грузовоз",
    capacity: 70,
    speed: 58,
    fuelPer1000: 28,
    upkeep: 5,
    credits: 4200,
    parts: 8,
    days: 8,
  },
  barge: {
    id: "barge",
    name: "баржа",
    capacity: 140,
    speed: 34,
    fuelPer1000: 46,
    upkeep: 9,
    credits: 8000,
    parts: 16,
    days: 12,
  },
};

export function defaultRules(): GameRules {
  return {
    ticksPerYear: 48,
    foodPer100: 1,
    wage: 5,
    taxPer100: 6,
    territoryRadius: 100,
    colonizeFood: 30,
    colonizeParts: 12,
    colonizeCost: 2000,
    colonizePop: 70,
    aiInterval: 5,
    window: 24,
    stockCapacity: 4000,
    deathStartAge: 72,
    deathCertainAge: 90,
    basePrice: { grain: 6, food: 12, ore: 8, alloys: 16, parts: 28, fuel: 10 },
  };
}

export function basePrices(rules: GameRules): Record<GoodId, number> {
  return { ...rules.basePrice };
}

export function zeroDeposits(): Record<GoodId, number> {
  return emptyGoods();
}
