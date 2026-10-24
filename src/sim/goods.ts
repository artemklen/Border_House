export const GOODS = ["grain", "food", "ore", "alloys", "parts", "fuel"] as const;
export type GoodId = (typeof GOODS)[number];

export const GOOD_NAME: Record<GoodId, string> = {
  grain: "зерно",
  food: "продовольствие",
  ore: "руда",
  alloys: "сплавы",
  parts: "комплектующие",
  fuel: "топливо",
};

export type Goods = Record<GoodId, number>;

export function emptyGoods(): Goods {
  return { grain: 0, food: 0, ore: 0, alloys: 0, parts: 0, fuel: 0 };
}

export function cloneGoods(goods: Goods): Goods {
  return { ...goods };
}

export function sumGoods(goods: Goods): number {
  let total = 0;
  for (const good of GOODS) total += goods[good];
  return total;
}

/** Груз без топлива. Топливо лежит в баке того же размера и трюм не занимает. */
export function holdLoad(goods: Goods): number {
  return sumGoods(goods) - goods.fuel;
}

export function freeBay(capacity: number, goods: Goods, good: GoodId): number {
  const used = good === "fuel" ? goods.fuel : holdLoad(goods);
  return Math.max(0, capacity - used);
}

export function addGoods(target: Goods, good: GoodId, amount: number): void {
  target[good] += amount;
}
