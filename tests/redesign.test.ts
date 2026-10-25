import { describe, expect, it } from "vitest";
import { createGame } from "../src/sim/create";
import { pickMapTarget, treasuryTicker } from "../src/sim/view";
import { foodRaw, holdAlarm, treasuryRaw } from "../src/ui/alarms";
import { snapSheet } from "../src/ui/sheet";

describe("редизайн", () => {
  it("тикер казны короткий и считает дни", () => {
    const state = createGame({ seed: 21, scenario: "base" });
    const player = state.houses.find((house) => house.player)!;
    expect(treasuryTicker(state, player.id)).toBe("на 35 дн.");
  });

  it("касание 22 px берёт корабль там, где мышь проходит мимо", () => {
    const state = createGame({ seed: 21, scenario: "base" });
    const bread = state.worlds.find((world) => world.id === "w-bread")!;
    expect(pickMapTarget(state, { x: bread.x + 20, y: bread.y }, 1)).toBeNull();
    expect(pickMapTarget(state, { x: bread.x + 20, y: bread.y }, 1, 22)?.kind).toBe("ship");
    expect(pickMapTarget(state, { x: bread.x + 10, y: bread.y }, 1)?.kind).toBe("world");
  });

  it("шторка встаёт в свёрнутую, половину и полную высоту", () => {
    expect(snapSheet(100, 844)).toBe(168);
    expect(snapSheet(400, 844)).toBe(464);
    expect(snapSheet(700, 844)).toBe(780);
  });

  it("пороги казны и еды держат гистерезис", () => {
    expect(treasuryRaw(35, 18000, 510, 0)).toBe("ok");
    expect(treasuryRaw(19, 9000, 510, -100)).toBe("low");
    expect(treasuryRaw(2, 1000, 510, -100)).toBe("critical");
    expect(treasuryRaw(2, 1000, 510, 100)).toBe("low");
    expect(foodRaw(14)).toBe("ok");
    expect(foodRaw(7)).toBe("low");
    expect(foodRaw(2)).toBe("critical");
    expect(holdAlarm("treasury", "low", "ok", 26)).toBe("low");
    expect(holdAlarm("treasury", "low", "ok", 27)).toBe("ok");
    expect(holdAlarm("treasury", "critical", "low", 9)).toBe("critical");
    expect(holdAlarm("treasury", "critical", "ok", 11)).toBe("low");
    expect(holdAlarm("food", "critical", "ok", 5)).toBe("critical");
    expect(holdAlarm("food", "low", "ok", 12)).toBe("ok");
  });
});
