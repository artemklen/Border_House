export type HotkeyTarget = "editable" | "activatable" | "plain";
export type FocusFrom = "pointer" | "keyboard";

export interface HotkeyInput {
  code: string;
  key: string;
  repeat: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  composing: boolean;
  target: HotkeyTarget;
  focusFrom: FocusFrom;
  dialogOpen: boolean;
}

export interface HotkeyRoute {
  action: "none" | "toggle-pause" | "speed-1" | "speed-2" | "speed-3";
  preventDefault: boolean;
}

/** Куда деть клавишу времени. Пробел по кнопке, до которой дошли Tab, остаётся нативной активацией. */
export function routeTimeHotkey(input: HotkeyInput): HotkeyRoute {
  const none: HotkeyRoute = { action: "none", preventDefault: false };
  if (input.composing || input.ctrlKey || input.metaKey || input.altKey || input.dialogOpen || input.target === "editable") return none;
  if (input.code === "Space") {
    if (input.focusFrom === "keyboard" && input.target === "activatable") return none;
    if (input.repeat) return { action: "none", preventDefault: true };
    return { action: "toggle-pause", preventDefault: true };
  }
  if (input.repeat) return none;
  if (input.key === "1") return { action: "speed-1", preventDefault: false };
  if (input.key === "2") return { action: "speed-2", preventDefault: false };
  if (input.key === "3") return { action: "speed-3", preventDefault: false };
  return none;
}

/** Keyup пробела, который уже забрали как команду времени, не должен ещё раз нажать кнопку. */
export function releaseClaimedSpace(code: string, claimed: boolean): { preventDefault: boolean; claimed: boolean } {
  if (code === "Space" && claimed) return { preventDefault: true, claimed: false };
  return { preventDefault: false, claimed };
}

export function classifyHotkeyTarget(target: EventTarget | null): HotkeyTarget {
  if (!target || typeof target !== "object" || !("closest" in target) || typeof target.closest !== "function") return "plain";
  const element = target as HTMLElement;
  if (element.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']") || element.isContentEditable) return "editable";
  if (element.closest("button, a, summary, [role='menuitem']")) return "activatable";
  return "plain";
}
