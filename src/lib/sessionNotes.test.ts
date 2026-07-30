import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_NOTE_MAX_LENGTH,
  SESSION_NOTES_CHANGE_EVENT,
  SESSION_NOTES_STORAGE_KEY,
  clampNoteText,
  clearNote,
  getNote,
  hasNote,
  load,
  loadSessionNotes,
  notePreview,
  parseSessionNotes,
  save,
  saveSessionNotes,
  setNote,
  type SessionNotesStorage,
} from "./sessionNotes";

function memoryStorage(
  initial: Record<string, string> = {},
): SessionNotesStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem(key) {
      return key in data ? data[key]! : null;
    },
    setItem(key, value) {
      data[key] = value;
    },
    removeItem(key) {
      delete data[key];
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("clampNoteText", () => {
  it("returns empty for non-strings and zero max", () => {
    // @ts-expect-error intentional
    expect(clampNoteText(null)).toBe("");
    expect(clampNoteText("hi", 0)).toBe("");
  });

  it("truncates to max length", () => {
    const long = "a".repeat(SESSION_NOTE_MAX_LENGTH + 50);
    const clamped = clampNoteText(long);
    expect(clamped.length).toBe(SESSION_NOTE_MAX_LENGTH);
    expect(clampNoteText("short")).toBe("short");
  });
});

describe("notePreview", () => {
  it("collapses whitespace and truncates with ellipsis", () => {
    expect(notePreview(null)).toBe("");
    expect(notePreview("  hello   world  ")).toBe("hello world");
    expect(notePreview("abcdefghij", 5)).toBe("abcd…");
    expect(notePreview("ab", 5)).toBe("ab");
  });
});

describe("parseSessionNotes", () => {
  it("returns empty object for empty / invalid input", () => {
    expect(parseSessionNotes(null)).toEqual({});
    expect(parseSessionNotes(undefined)).toEqual({});
    expect(parseSessionNotes("")).toEqual({});
    expect(parseSessionNotes("not-json")).toEqual({});
    expect(parseSessionNotes("[]")).toEqual({});
    expect(parseSessionNotes(42)).toEqual({});
  });

  it("parses map of non-empty string notes and clamps", () => {
    const long = "x".repeat(SESSION_NOTE_MAX_LENGTH + 10);
    const map = parseSessionNotes(
      JSON.stringify({
        a: "  keep  ",
        "  b  ": "trimmed-id",
        "": "skip-empty-id",
        c: "   ",
        d: 1,
        e: long,
      }),
    );
    expect(map.a).toBe("  keep  ");
    expect(map.b).toBe("trimmed-id");
    expect(map.c).toBeUndefined();
    expect(map.d).toBeUndefined();
    expect(map.e?.length).toBe(SESSION_NOTE_MAX_LENGTH);
    expect(Object.keys(map).sort()).toEqual(["a", "b", "e"]);
  });

  it("accepts already-parsed objects", () => {
    expect(parseSessionNotes({ s1: "note" })).toEqual({ s1: "note" });
  });
});

describe("load / save", () => {
  it("load returns empty map when missing", () => {
    const storage = memoryStorage();
    expect(loadSessionNotes(storage)).toEqual({});
    expect(load(storage)).toEqual({});
  });

  it("round-trips notes and drops blanks; sorts keys on write", () => {
    const storage = memoryStorage();
    saveSessionNotes(
      { z: "Z", a: "A", m: "  ", "  b  ": "B" },
      storage,
    );
    const raw = JSON.parse(storage.data[SESSION_NOTES_STORAGE_KEY]!);
    expect(Object.keys(raw)).toEqual(["a", "b", "z"]);
    expect(raw).toEqual({ a: "A", b: "B", z: "Z" });
    expect(loadSessionNotes(storage)).toEqual({ a: "A", b: "B", z: "Z" });
    save({ only: "one" }, storage);
    expect(load(storage)).toEqual({ only: "one" });
  });

  it("removes storage key when map becomes empty", () => {
    const storage = memoryStorage({
      [SESSION_NOTES_STORAGE_KEY]: JSON.stringify({ a: "x" }),
    });
    saveSessionNotes({}, storage);
    expect(storage.data[SESSION_NOTES_STORAGE_KEY]).toBeUndefined();
  });

  it("load survives corrupt JSON", () => {
    const storage = memoryStorage({
      [SESSION_NOTES_STORAGE_KEY]: "{broken",
    });
    expect(loadSessionNotes(storage)).toEqual({});
  });

  it("dispatches change event after save when window is available", () => {
    const storage = memoryStorage();
    const handler = vi.fn();
    const prevWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      value: {
        dispatchEvent: handler,
      },
      configurable: true,
      writable: true,
    });
    try {
      saveSessionNotes({ s1: "n" }, storage);
      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as CustomEvent;
      expect(ev.type).toBe(SESSION_NOTES_CHANGE_EVENT);
      expect(ev.detail).toEqual(["s1"]);
    } finally {
      if (prevWindow === undefined) {
        // @ts-expect-error cleanup
        delete globalThis.window;
      } else {
        Object.defineProperty(globalThis, "window", {
          value: prevWindow,
          configurable: true,
          writable: true,
        });
      }
    }
  });
});

describe("getNote / hasNote / setNote / clearNote", () => {
  it("getNote and hasNote handle missing / blank ids", () => {
    const storage = memoryStorage();
    expect(getNote(null, storage)).toBe("");
    expect(getNote("  ", storage)).toBe("");
    expect(hasNote("missing", storage)).toBe(false);
  });

  it("setNote writes, clamps, and clearNote removes", () => {
    const storage = memoryStorage();
    const long = "y".repeat(SESSION_NOTE_MAX_LENGTH + 20);
    expect(setNote("sess-1", "  hello  ", storage)).toBe("  hello  ");
    expect(getNote("sess-1", storage)).toBe("  hello  ");
    expect(hasNote("sess-1", storage)).toBe(true);
    expect(setNote("sess-1", long, storage).length).toBe(SESSION_NOTE_MAX_LENGTH);
    expect(setNote("sess-1", "   ", storage)).toBe("");
    expect(hasNote("sess-1", storage)).toBe(false);
    setNote("sess-2", "keep", storage);
    clearNote("sess-2", storage);
    expect(getNote("sess-2", storage)).toBe("");
  });

  it("setNote ignores blank session ids", () => {
    const storage = memoryStorage();
    expect(setNote("", "x", storage)).toBe("");
    expect(setNote("   ", "x", storage)).toBe("");
    expect(loadSessionNotes(storage)).toEqual({});
  });

  it("trims session ids on get", () => {
    const storage = memoryStorage();
    setNote("sess-x", "note", storage);
    expect(getNote("  sess-x  ", storage)).toBe("note");
    expect(hasNote("  sess-x  ", storage)).toBe(true);
  });
});
