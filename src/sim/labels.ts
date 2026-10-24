import { CHOICE_LABEL, SITUATION_LABEL } from "./politics";
import type { ContractStatus, PersonRole, ShipStatus, SituationChoice, SituationKind, Treaty } from "./types";

export type TreatyStatus = Treaty["status"];

export const PERSON_ROLE_LABEL: Record<PersonRole, string> = {
  head: "глава",
  heir: "наследник",
  spouse: "в браке",
  kin: "родня",
  governor: "губернатор",
};

export const PERSON_ROLE_TITLE: Record<PersonRole, string> = {
  head: "Глава",
  heir: "Наследник",
  spouse: "Супруг",
  kin: "Родня",
  governor: "Губернатор",
};

export const SHIP_STATUS_LABEL: Record<ShipStatus, string> = {
  docked: "у причала",
  transit: "в пути",
  blocked: "стоит",
  building: "строится",
};

export const TREATY_STATUS_LABEL: Record<TreatyStatus, string> = {
  proposed: "предложен",
  active: "действует",
  broken: "разорван",
  rejected: "отклонён",
  expired: "истёк",
};

export const CONTRACT_STATUS_LABEL: Record<ContractStatus, string> = {
  proposed: "предложен",
  active: "идёт",
  completed: "завершён",
  broken: "сорван",
  cancelled: "отменён",
  rejected: "отклонён",
};

export function labelOf<T extends string>(dict: Record<T, string>, value: string | null | undefined, fallback: string): string {
  if (!value || !Object.prototype.hasOwnProperty.call(dict, value)) return fallback;
  return dict[value as T];
}

export function personRoleLabel(value: string | null | undefined): string {
  return labelOf(PERSON_ROLE_LABEL, value, "Роль не указана");
}

export function shipStatusLabel(value: string | null | undefined): string {
  return labelOf(SHIP_STATUS_LABEL, value, "Статус неизвестен");
}

export function treatyStatusLabel(value: string | null | undefined): string {
  return labelOf(TREATY_STATUS_LABEL, value, "Статус неизвестен");
}

export function contractStatusLabel(value: string | null | undefined): string {
  return labelOf(CONTRACT_STATUS_LABEL, value, "Статус неизвестен");
}

export function situationKindLabel(value: string | null | undefined): string {
  return labelOf(SITUATION_LABEL, value, "Ситуация не указана");
}

export function situationChoiceLabel(value: string | null | undefined): string {
  return labelOf(CHOICE_LABEL, value as SituationChoice, "Решение не указано");
}

/** Имя уже может начинаться с титула. Второй раз титул не ставится, само имя не режется. */
export function officeLine(title: string, name: string | undefined, empty: string): string {
  if (!name) return empty;
  if (name === title || name.startsWith(`${title} `)) return name;
  return `${title}: ${name}`;
}

export function situationKindKeys(): SituationKind[] {
  return Object.keys(SITUATION_LABEL) as SituationKind[];
}
