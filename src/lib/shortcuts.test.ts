import { describe, expect, it } from "vitest";
import {
  GLOBAL_MOD_SHORTCUT_IDS,
  matchGlobalShortcut,
  SHORTCUT_IDS,
  SHORTCUTS,
  sendShortcutDisplay,
  shortcutsByGroup,
  shortcutsForPlatform,
  type GlobalModShortcutId,
  type ShortcutChordContext,
} from "./shortcuts";

describe("sendShortcutDisplay", () => {
  it("defaults to plain Enter", () => {
    expect(sendShortcutDisplay()).toEqual({ mac: "↵", win: "Enter" });
    expect(sendShortcutDisplay("enter")).toEqual({ mac: "↵", win: "Enter" });
  });

  it("shows mod-enter chords", () => {
    expect(sendShortcutDisplay("mod-enter")).toEqual({
      mac: "⌘ ↵",
      win: "Ctrl Enter",
    });
  });
});
function chord(
  partial: Partial<ShortcutChordContext> & Pick<ShortcutChordContext, "key">,
): ShortcutChordContext {
  return {
    mod: true,
    shift: false,
    alt: false,
    typing: false,
    ...partial,
  };
}

describe("shortcuts catalog", () => {
  it("has stable unique ids", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("SHORTCUT_IDS matches catalog rows in order", () => {
    expect([...SHORTCUT_IDS]).toEqual(SHORTCUTS.map((s) => s.id));
  });

  it("every row has mac and win bindings and a group", () => {
    for (const s of SHORTCUTS) {
      expect(s.mac.trim().length).toBeGreaterThan(0);
      expect(s.win.trim().length).toBeGreaterThan(0);
      expect(s.labelKey.startsWith("shortcuts.")).toBe(true);
      expect(s.group).toBeTruthy();
    }
  });

  it("picks platform-specific keys", () => {
    const mac = shortcutsForPlatform("mac", "enter");
    const win = shortcutsForPlatform("win", "enter");
    const searchMac = mac.find((s) => s.id === "search");
    const searchWin = win.find((s) => s.id === "search");
    expect(searchMac?.keys).toContain("⌘");
    expect(searchWin?.keys.toLowerCase()).toContain("ctrl");
  });

  it("groups for settings panel cover every shortcut once", () => {
    const grouped = shortcutsByGroup("enter");
    const flat = grouped.flatMap((g) => g.rows.map((r) => r.id));
    expect(flat.sort()).toEqual([...SHORTCUTS.map((s) => s.id)].sort());
  });

  it("lists find-in-chat (Cmd/Ctrl+F) in workbench near search", () => {
    const row = SHORTCUTS.find((s) => s.id === "findInChat");
    expect(row).toBeDefined();
    expect(row!.labelKey).toBe("shortcuts.findInChat");
    expect(row!.group).toBe("workbench");
    expect(row!.mac).toBe("⌘ F");
    expect(row!.win).toBe("Ctrl F");
    const searchIdx = SHORTCUTS.findIndex((s) => s.id === "search");
    const findIdx = SHORTCUTS.findIndex((s) => s.id === "findInChat");
    expect(findIdx).toBeGreaterThan(searchIdx);
  });

  it("lists default send as plain Enter, not only mod-enter", () => {
    const row = SHORTCUTS.find((s) => s.id === "send");
    expect(row).toBeDefined();
    // Default product pref is plain Enter; ⌘/Ctrl+Enter is a Settings → Composer option.
    expect(row!.mac).toMatch(/↵|Return/);
    expect(row!.win.toLowerCase()).toBe("enter");
    expect(row!.mac).not.toMatch(/⌘/);
    expect(row!.win.toLowerCase()).not.toMatch(/ctrl/);
  });

  it("patches send keys from composer preference in platform list", () => {
    const enterMac = shortcutsForPlatform("mac", "enter").find(
      (s) => s.id === "send",
    );
    const enterWin = shortcutsForPlatform("win", "enter").find(
      (s) => s.id === "send",
    );
    expect(enterMac?.keys).toBe("↵");
    expect(enterWin?.keys).toBe("Enter");

    const modMac = shortcutsForPlatform("mac", "mod-enter").find(
      (s) => s.id === "send",
    );
    const modWin = shortcutsForPlatform("win", "mod-enter").find(
      (s) => s.id === "send",
    );
    expect(modMac?.keys).toBe("⌘ ↵");
    expect(modWin?.keys).toBe("Ctrl Enter");
  });

  it("patches send keys from composer preference in settings groups", () => {
    const enterSend = shortcutsByGroup("enter")
      .flatMap((g) => g.rows)
      .find((r) => r.id === "send");
    expect(enterSend?.mac).toBe("↵");
    expect(enterSend?.win).toBe("Enter");

    const modSend = shortcutsByGroup("mod-enter")
      .flatMap((g) => g.rows)
      .find((r) => r.id === "send");
    expect(modSend?.mac).toBe("⌘ ↵");
    expect(modSend?.win).toBe("Ctrl Enter");
  });

  it("lists Ctrl+Space dictation on both platforms (not Cmd)", () => {
    const row = SHORTCUTS.find((s) => s.id === "dictation");
    expect(row).toBeDefined();
    expect(row!.group).toBe("input");
    expect(row!.mac).toMatch(/Ctrl/i);
    expect(row!.mac).not.toMatch(/⌘/);
    expect(row!.win).toMatch(/Ctrl/i);
    expect(row!.mac.toLowerCase()).toContain("space");
    expect(row!.win.toLowerCase()).toContain("space");
  });

  it("lists copy last reply (Cmd/Ctrl+Shift+C) in workbench", () => {
    const row = SHORTCUTS.find((s) => s.id === "copyLastReply");
    expect(row).toBeDefined();
    expect(row!.labelKey).toBe("shortcuts.copyLastReply");
    expect(row!.group).toBe("workbench");
    expect(row!.mac).toBe("⌘ ⇧ C");
    expect(row!.win).toBe("Ctrl Shift C");
  });

  it("lists toggle sidebar (Cmd/Ctrl+B) in navigation", () => {
    const row = SHORTCUTS.find((s) => s.id === "toggleSidebar");
    expect(row).toBeDefined();
    expect(row!.labelKey).toBe("shortcuts.toggleSidebar");
    expect(row!.group).toBe("navigation");
    expect(row!.mac).toBe("⌘ B");
    expect(row!.win).toBe("Ctrl B");
  });
});

describe("matchGlobalShortcut", () => {
  /** Canonical chords that App handles via the mod matcher. */
  const cases: Array<{
    id: GlobalModShortcutId;
    key: string;
    shift?: boolean;
    typing?: boolean;
  }> = [
    { id: "search", key: "k" },
    { id: "findInChat", key: "f" },
    { id: "newChat", key: "n", typing: false },
    { id: "settings", key: ",", typing: false },
    { id: "help", key: "/" },
    { id: "doctor", key: "d", shift: true },
    { id: "liveVoice", key: "v", shift: true },
    { id: "copyLastReply", key: "c", shift: true },
  ];

  it("covers every GLOBAL_MOD_SHORTCUT_IDS entry", () => {
    const covered = new Set(cases.map((c) => c.id));
    for (const id of GLOBAL_MOD_SHORTCUT_IDS) {
      expect(covered.has(id)).toBe(true);
    }
    expect(covered.size).toBe(GLOBAL_MOD_SHORTCUT_IDS.length);
  });

  it("matches each global mod catalog action", () => {
    for (const c of cases) {
      expect(
        matchGlobalShortcut(
          chord({
            key: c.key,
            shift: c.shift ?? false,
            typing: c.typing ?? false,
          }),
        ),
      ).toBe(c.id);
    }
  });

  it("findInChat / search / help work while typing", () => {
    expect(matchGlobalShortcut(chord({ key: "f", typing: true }))).toBe(
      "findInChat",
    );
    expect(matchGlobalShortcut(chord({ key: "k", typing: true }))).toBe(
      "search",
    );
    expect(matchGlobalShortcut(chord({ key: "/", typing: true }))).toBe("help");
    expect(
      matchGlobalShortcut(chord({ key: "d", shift: true, typing: true })),
    ).toBe("doctor");
    expect(
      matchGlobalShortcut(chord({ key: "c", shift: true, typing: true })),
    ).toBe("copyLastReply");
    expect(
      matchGlobalShortcut(chord({ key: "v", shift: true, typing: true })),
    ).toBe("liveVoice");
  });

  it("skips newChat and settings while typing", () => {
    expect(matchGlobalShortcut(chord({ key: "n", typing: true }))).toBeNull();
    expect(matchGlobalShortcut(chord({ key: ",", typing: true }))).toBeNull();
  });

  it("does not match without mod", () => {
    expect(matchGlobalShortcut(chord({ key: "k", mod: false }))).toBeNull();
    expect(
      matchGlobalShortcut(chord({ key: "d", mod: false, shift: true })),
    ).toBeNull();
  });

  it("does not match plain keys or unrelated chords", () => {
    expect(matchGlobalShortcut(chord({ key: "a" }))).toBeNull();
    expect(matchGlobalShortcut(chord({ key: "f", shift: true }))).toBeNull(); // not find
    expect(matchGlobalShortcut(chord({ key: "c" }))).toBeNull(); // needs shift
    expect(matchGlobalShortcut(chord({ key: "v" }))).toBeNull();
    expect(matchGlobalShortcut(chord({ key: "d" }))).toBeNull();
    expect(matchGlobalShortcut(chord({ key: "escape" }))).toBeNull();
    expect(matchGlobalShortcut(chord({ key: " ", mod: false }))).toBeNull();
  });

  it("does not match with alt held", () => {
    expect(matchGlobalShortcut(chord({ key: "k", alt: true }))).toBeNull();
  });

  it("does not claim send / stop / dictation (special-cased elsewhere)", () => {
    const special = new Set(["send", "stop", "dictation"]);
    for (const id of SHORTCUT_IDS) {
      if (special.has(id)) {
        expect(
          (GLOBAL_MOD_SHORTCUT_IDS as readonly string[]).includes(id),
        ).toBe(false);
      }
    }
  });
});
