import { describe, expect, it } from "vitest";
import { createBorderContractScenario } from "../src/sim/campaign";
import { createGame } from "../src/sim/create";
import {
  CONTRACT_STATUS_LABEL,
  PERSON_ROLE_LABEL,
  SHIP_STATUS_LABEL,
  TREATY_STATUS_LABEL,
  contractStatusLabel,
  officeLine,
  personRoleLabel,
  shipStatusLabel,
  situationChoiceLabel,
  situationKindLabel,
  treatyStatusLabel,
} from "../src/sim/labels";
import { CHOICE_LABEL, SITUATION_LABEL } from "../src/sim/politics";
import { lessonViews } from "../src/sim/tutorial";
import { hintLines, hintSentence } from "../src/sim/view";

const RAW = /\b(head|heir|spouse|kin|governor|docked|transit|blocked|building|proposed|active|broken|rejected|expired|completed|cancelled|yield|pay|refuse|foodDependence|tariffDispute|brokenContract|congestedPort|exportShortage|successionReview)\b/;

describe("русские подписи", () => {
  it("покрывает известные enum и не отдаёт сырой код", () => {
    for (const [key, label] of Object.entries(PERSON_ROLE_LABEL)) expect(label, key).not.toMatch(RAW);
    for (const [key, label] of Object.entries(SHIP_STATUS_LABEL)) expect(label, key).not.toMatch(RAW);
    for (const [key, label] of Object.entries(TREATY_STATUS_LABEL)) expect(label, key).not.toMatch(RAW);
    for (const [key, label] of Object.entries(CONTRACT_STATUS_LABEL)) expect(label, key).not.toMatch(RAW);
    for (const [key, label] of Object.entries(SITUATION_LABEL)) expect(situationKindLabel(key), key).toBe(label);
    for (const [key, label] of Object.entries(CHOICE_LABEL)) expect(situationChoiceLabel(key), key).toBe(label);
    expect(personRoleLabel("spouse")).toBe("в браке");
    expect(personRoleLabel("")).toBe("Роль не указана");
    expect(personRoleLabel("captain")).toBe("Роль не указана");
    expect(treatyStatusLabel(null)).toBe("Статус неизвестен");
    expect(contractStatusLabel("nope")).toBe("Статус неизвестен");
    expect(shipStatusLabel(undefined)).toBe("Статус неизвестен");
    expect(situationKindLabel("mystery")).toBe("Ситуация не указана");
    expect(situationChoiceLabel("")).toBe("Решение не указано");
  });

  it("не повторяет титул и не режет похожее имя", () => {
    expect(officeLine("Глава", "Глава Астерий", "Глава: нет")).toBe("Глава Астерий");
    expect(officeLine("Наследник", "Наследник Ивар", "Наследник: не назначен")).toBe("Наследник Ивар");
    expect(officeLine("Глава", "Астерий", "Глава: нет")).toBe("Глава: Астерий");
    expect(officeLine("Глава", "Главарь", "Глава: нет")).toBe("Глава: Главарь");
    expect(officeLine("Глава", "", "Глава: нет")).toBe("Глава: нет");
    expect(officeLine("Глава", undefined, "Глава: нет")).toBe("Глава: нет");
  });

  it("не ставит вторую точку после сокращения и бережёт многоточие", () => {
    expect(hintSentence("Солнечная Гавань: еда на 0 дн.", "Население 640 съедает 6.4 ед./день.")).toBe(
      "Узкое место: Солнечная Гавань: еда на 0 дн. Население 640 съедает 6.4 ед./день.",
    );
    expect(hintSentence("Маршрут ждёт…", "Корабль в очереди.")).toBe("Узкое место: Маршрут ждёт… Корабль в очереди.");
    expect(hintSentence("Мельница стоит", "Нет зерна.")).toBe("Узкое место: Мельница стоит. Нет зерна.");
  });

  it("в обучении и подсказке нет сырых статусов", () => {
    const state = createBorderContractScenario();
    const player = state.houses.find((house) => house.player)!;
    const ship = state.ships.find((item) => item.houseId === player.id)!;
    ship.status = "transit";
    ship.traveled = 4;
    const contract = state.contracts[0]!;
    contract.delivered = 2;
    state.situations.push({
      id: "sit-label",
      kind: "tariffDispute",
      status: "resolved",
      houseId: player.id,
      otherId: null,
      worldId: player.capitalId,
      routeId: null,
      contractId: null,
      treatyId: null,
      shipId: null,
      openedTick: 0,
      deadlineTick: 10,
      choice: "yield",
      cause: "проверка подписи",
      cost: 0,
      days: 0,
      tariffBps: 0,
      qty: 0,
      good: "food",
    });
    const lessons = lessonViews(state);
    const voyage = lessons.find((lesson) => lesson.id === "voyage")!;
    const deal = lessons.find((lesson) => lesson.id === "contract")!;
    const politics = lessons.find((lesson) => lesson.id === "politics")!;
    expect(voyage.detail).toContain("в пути");
    expect(voyage.detail).not.toMatch(RAW);
    expect(deal.detail).toContain("продовольствие");
    expect(deal.detail).not.toContain(contract.id);
    expect(deal.detail).toContain("идёт");
    expect(deal.detail).not.toMatch(RAW);
    expect(politics.detail).toContain("Уступить");
    expect(politics.detail).toContain("Спор из-за пошлины");
    expect(politics.detail).not.toMatch(RAW);

    const base = createGame({ seed: 21, scenario: "base" });
    const hungry = base.worlds.find((world) => world.ownerId === base.houses.find((house) => house.player)!.id && world.population > 0)!;
    hungry.stock.food = 0;
    const hint = hintLines(base).join(" ");
    expect(hint).toContain("дн.");
    expect(hint).not.toContain("дн..");
  });
});
