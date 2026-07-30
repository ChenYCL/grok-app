import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RESOLVED_THEME } from "./theme";
import {
  DEFAULT_THEME_SCHEDULE,
  THEME_SCHEDULE_CHANGE_EVENT,
  THEME_SCHEDULE_STORAGE_KEY,
  isThemeScheduleActive,
  loadThemeSchedule,
  parseThemeSchedule,
  resolveThemeFromSchedule,
  resolveThemeWithSchedule,
  saveThemeSchedule,
  type ThemeScheduleStorage,
} from "./themeSchedule";

function memoryStorage(
  initial: Record<string, string> = {},
): ThemeScheduleStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem(key) {
      return key in data ? data[key]! : null;
    },
    setItem(key, value) {
      data[key] = value;
    },
  };
}

/** Fixed local clock (year/month irrelevant for HH:mm windows). */
function at(hours: number, minutes: number): Date {
  return new Date(2026, 0, 15, hours, minutes, 0, 0);
}

describe("resolveThemeFromSchedule", () => {
  const day: Pick<typeof DEFAULT_THEME_SCHEDULE, "lightFrom" | "darkFrom"> = {
    lightFrom: "07:00",
    darkFrom: "19:00",
  };

  it("uses light in [lightFrom, darkFrom) for same-day windows", () => {
    expect(resolveThemeFromSchedule(at(7, 0), day)).toBe("light");
    expect(resolveThemeFromSchedule(at(12, 0), day)).toBe("light");
    expect(resolveThemeFromSchedule(at(18, 59), day)).toBe("light");
    expect(resolveThemeFromSchedule(at(19, 0), day)).toBe("dark");
    expect(resolveThemeFromSchedule(at(23, 30), day)).toBe("dark");
    expect(resolveThemeFromSchedule(at(0, 0), day)).toBe("dark");
    expect(resolveThemeFromSchedule(at(6, 59), day)).toBe("dark");
  });

  it("supports light window wrapping midnight (lightFrom > darkFrom)", () => {
    const wrap = { lightFrom: "20:00", darkFrom: "08:00" };
    expect(resolveThemeFromSchedule(at(20, 0), wrap)).toBe("light");
    expect(resolveThemeFromSchedule(at(23, 0), wrap)).toBe("light");
    expect(resolveThemeFromSchedule(at(0, 0), wrap)).toBe("light");
    expect(resolveThemeFromSchedule(at(7, 59), wrap)).toBe("light");
    expect(resolveThemeFromSchedule(at(8, 0), wrap)).toBe("dark");
    expect(resolveThemeFromSchedule(at(12, 0), wrap)).toBe("dark");
    expect(resolveThemeFromSchedule(at(19, 59), wrap)).toBe("dark");
  });

  it("falls back when times equal or invalid", () => {
    expect(
      resolveThemeFromSchedule(at(12, 0), {
        lightFrom: "10:00",
        darkFrom: "10:00",
      }),
    ).toBe(DEFAULT_RESOLVED_THEME);
    expect(
      resolveThemeFromSchedule(at(12, 0), {
        lightFrom: "bad",
        darkFrom: "19:00",
      }),
    ).toBe(DEFAULT_RESOLVED_THEME);
  });

  it("is pure for a fixed clock (no Date.now dependency)", () => {
    const fixed = at(8, 30);
    expect(resolveThemeFromSchedule(fixed, day)).toBe("light");
    // Same inputs always same output.
    expect(resolveThemeFromSchedule(fixed, day)).toBe(
      resolveThemeFromSchedule(fixed, day),
    );
  });
});

describe("resolveThemeWithSchedule / isThemeScheduleActive", () => {
  const on = {
    enabled: true,
    lightFrom: "07:00",
    darkFrom: "19:00",
  };
  const off = { ...on, enabled: false };

  it("forced light/dark ignore schedule", () => {
    expect(resolveThemeWithSchedule("light", "dark", on, at(23, 0))).toBe(
      "light",
    );
    expect(resolveThemeWithSchedule("dark", "light", on, at(12, 0))).toBe(
      "dark",
    );
    expect(isThemeScheduleActive("light", on)).toBe(false);
    expect(isThemeScheduleActive("dark", on)).toBe(false);
  });

  it("system + schedule enabled uses wall clock", () => {
    expect(resolveThemeWithSchedule("system", "dark", on, at(10, 0))).toBe(
      "light",
    );
    expect(resolveThemeWithSchedule("system", "light", on, at(22, 0))).toBe(
      "dark",
    );
    expect(isThemeScheduleActive("system", on)).toBe(true);
  });

  it("system + schedule disabled follows OS theme", () => {
    expect(resolveThemeWithSchedule("system", "dark", off, at(10, 0))).toBe(
      "dark",
    );
    expect(resolveThemeWithSchedule("system", "light", off, at(22, 0))).toBe(
      "light",
    );
    expect(isThemeScheduleActive("system", off)).toBe(false);
  });
});

describe("load / save / parse ThemeSchedule", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults when empty or invalid", () => {
    expect(DEFAULT_THEME_SCHEDULE.enabled).toBe(false);
    expect(parseThemeSchedule(null)).toEqual(DEFAULT_THEME_SCHEDULE);
    expect(parseThemeSchedule("")).toEqual(DEFAULT_THEME_SCHEDULE);
    expect(parseThemeSchedule("not-json")).toEqual(DEFAULT_THEME_SCHEDULE);
    expect(loadThemeSchedule(memoryStorage())).toEqual(DEFAULT_THEME_SCHEDULE);
  });

  it("parses enabled + times (normalizes HH:mm)", () => {
    expect(
      parseThemeSchedule(
        JSON.stringify({
          enabled: true,
          lightFrom: "7:30",
          darkFrom: "21:05:00",
        }),
      ),
    ).toEqual({
      enabled: true,
      lightFrom: "07:30",
      darkFrom: "21:05",
    });
  });

  it("round-trips preference", () => {
    const s = memoryStorage();
    saveThemeSchedule(
      { enabled: true, lightFrom: "06:30", darkFrom: "18:00" },
      s,
    );
    expect(s.data[THEME_SCHEDULE_STORAGE_KEY]).toBe(
      JSON.stringify({
        enabled: true,
        lightFrom: "06:30",
        darkFrom: "18:00",
      }),
    );
    expect(loadThemeSchedule(s)).toEqual({
      enabled: true,
      lightFrom: "06:30",
      darkFrom: "18:00",
    });
  });

  it("dispatches change event on save when window exists", () => {
    const listeners = new Map<string, Set<EventListener>>();
    const stubWindow = {
      addEventListener(type: string, listener: EventListener) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener(type: string, listener: EventListener) {
        listeners.get(type)?.delete(listener);
      },
      dispatchEvent(ev: Event) {
        const set = listeners.get(ev.type);
        if (set) for (const fn of set) fn(ev);
        return true;
      },
    };
    vi.stubGlobal("window", stubWindow);
    vi.stubGlobal(
      "CustomEvent",
      class CustomEvent<T = unknown> extends Event {
        detail: T;
        constructor(type: string, init?: CustomEventInit<T>) {
          super(type);
          this.detail = init?.detail as T;
        }
      },
    );

    const handler = vi.fn();
    stubWindow.addEventListener(THEME_SCHEDULE_CHANGE_EVENT, handler);
    saveThemeSchedule(
      { enabled: true, lightFrom: "08:00", darkFrom: "20:00" },
      memoryStorage(),
    );
    expect(handler).toHaveBeenCalledTimes(1);
    const ev = handler.mock.calls[0][0] as CustomEvent;
    expect(ev.detail).toEqual({
      enabled: true,
      lightFrom: "08:00",
      darkFrom: "20:00",
    });
  });
});
