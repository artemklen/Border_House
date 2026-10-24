import { describe, expect, it } from "vitest";
import { nextSpaceClaim, releaseClaimedSpace, routeTimeHotkey, type HotkeyInput } from "../src/ui/hotkeys";

function press(patch: Partial<HotkeyInput>): HotkeyInput {
  return {
    code: "Space",
    key: " ",
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    composing: false,
    target: "plain",
    focusFrom: "pointer",
    dialogOpen: false,
    ...patch,
  };
}

describe("хоткеи времени", () => {
  it("после мышиного фокуса на кнопке пробел и 1/2/3 управляют временем", () => {
    for (const target of ["activatable", "plain"] as const) {
      const space = routeTimeHotkey(press({ target, focusFrom: "pointer" }));
      expect(space).toEqual({ action: "toggle-pause", preventDefault: true });
      expect(routeTimeHotkey(press({ code: "Digit1", key: "1", target }))).toEqual({ action: "speed-1", preventDefault: false });
      expect(routeTimeHotkey(press({ code: "Digit2", key: "2", target }))).toEqual({ action: "speed-2", preventDefault: false });
      expect(routeTimeHotkey(press({ code: "Digit3", key: "3", target }))).toEqual({ action: "speed-3", preventDefault: false });
    }
  });

  it("удержание пробела не переключает паузу повторно, а keyup не нажимает кнопку", () => {
    expect(routeTimeHotkey(press({ repeat: true }))).toEqual({ action: "none", preventDefault: true });
    expect(releaseClaimedSpace("Space", true)).toEqual({ preventDefault: true, claimed: false });
    expect(releaseClaimedSpace("Space", false)).toEqual({ preventDefault: false, claimed: false });
    expect(releaseClaimedSpace("Enter", true)).toEqual({ preventDefault: false, claimed: true });
  });

  it("потеря фокуса окна забывает зажатый пробел и не гасит следующее нажатие кнопки", () => {
    const down = routeTimeHotkey(press({ focusFrom: "pointer", target: "plain" }));
    let claimed = nextSpaceClaim(false, "keydown", "Space", down.preventDefault);
    expect(claimed).toBe(true);
    claimed = nextSpaceClaim(claimed, "blur", "Space", false);
    expect(claimed).toBe(false);
    const native = routeTimeHotkey(press({ focusFrom: "keyboard", target: "activatable" }));
    claimed = nextSpaceClaim(claimed, "keydown", "Space", native.preventDefault);
    expect(native).toEqual({ action: "none", preventDefault: false });
    expect(releaseClaimedSpace("Space", claimed).preventDefault).toBe(false);
  });

  it("пробел по кнопке, выбранной с клавиатуры, остаётся нажатием кнопки", () => {
    expect(routeTimeHotkey(press({ target: "activatable", focusFrom: "keyboard" }))).toEqual({ action: "none", preventDefault: false });
    expect(routeTimeHotkey(press({ target: "plain", focusFrom: "keyboard" }))).toEqual({ action: "toggle-pause", preventDefault: true });
    expect(routeTimeHotkey(press({ code: "Digit1", key: "1", target: "activatable", focusFrom: "keyboard" }))).toEqual({ action: "speed-1", preventDefault: false });
  });

  it("поле, список, диалог, набор и модификаторы не запускают время", () => {
    expect(routeTimeHotkey(press({ target: "editable" })).action).toBe("none");
    expect(routeTimeHotkey(press({ code: "Digit1", key: "1", target: "editable" })).action).toBe("none");
    expect(routeTimeHotkey(press({ dialogOpen: true })).action).toBe("none");
    expect(routeTimeHotkey(press({ composing: true })).action).toBe("none");
    expect(routeTimeHotkey(press({ ctrlKey: true })).action).toBe("none");
    expect(routeTimeHotkey(press({ metaKey: true, code: "Digit1", key: "1" })).action).toBe("none");
    expect(routeTimeHotkey(press({ altKey: true, code: "Digit3", key: "3" })).action).toBe("none");
    expect(routeTimeHotkey(press({ code: "Enter", key: "Enter" })).action).toBe("none");
  });
});
