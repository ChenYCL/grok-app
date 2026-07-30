/**
 * Optional clock-based light/dark schedule (sub-option under Theme → System).
 * localStorage-only — does not touch Host AppSettings.
 *
 * When enabled and the user preference is not locked light/dark, the app
 * resolves light | dark from local wall-clock times instead of the OS scheme.
 *
 * Range semantics (mirrors quiet-hours style windows):
 * - lightFrom → darkFrom is the light period (end exclusive)
 * - darkFrom → lightFrom is the dark period (may wrap midnight)
 * - lightFrom === darkFrom → invalid / zero-width → DEFAULT_RESOLVED_THEME
 */

import { DEFAULT_RESOLVED_THEME, type Theme, type ThemePreference } from "./theme";
import {
  normalizeHHmm,
  parseTimeToMinutes,
} from "./notifyQuietHours";

export type ThemeScheduleConfig = {
  enabled: boolean;
  /** Local time when light theme starts (HH:mm, 24h). */
  lightFrom: string;
  /** Local time when dark theme starts (HH:mm, 24h). */
  darkFrom: string;
};

export const THEME_SCHEDULE_STORAGE_KEY = "grok-app.themeSchedule";

/** Fired on `window` after a successful save (detail = config). */
export const THEME_SCHEDULE_CHANGE_EVENT = "grok-theme-schedule-change";

/** Default off; light 07:00 → dark 19:00. */
export const DEFAULT_THEME_SCHEDULE: ThemeScheduleConfig = {
  enabled: false,
  lightFrom: "07:00",
  darkFrom: "19:00",
};

/** How often the app re-evaluates the schedule while active. */
export const THEME_SCHEDULE_TICK_MS = 60_000;

/** Minimal storage surface so unit tests need no jsdom. */
export interface ThemeScheduleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): ThemeScheduleStorage {
  if (typeof localStorage !== "undefined") return localStorage;
  return { getItem: () => null, setItem: () => {} };
}

/**
 * Pure: which concrete theme is active at `now` given light/dark start times.
 * Does not consult `enabled` — callers decide when schedule applies.
 *
 * - light period: [lightFrom, darkFrom) (wraps midnight when lightFrom > darkFrom)
 * - otherwise dark
 * - invalid or equal times → DEFAULT_RESOLVED_THEME
 */
export function resolveThemeFromSchedule(
  now: Date,
  cfg: Pick<ThemeScheduleConfig, "lightFrom" | "darkFrom">,
): Theme {
  const light = parseTimeToMinutes(cfg.lightFrom);
  const dark = parseTimeToMinutes(cfg.darkFrom);
  if (light == null || dark == null) return DEFAULT_RESOLVED_THEME;
  if (light === dark) return DEFAULT_RESOLVED_THEME;

  const mins = now.getHours() * 60 + now.getMinutes();

  if (light < dark) {
    // Same calendar day light window, e.g. 07:00 → 19:00.
    return mins >= light && mins < dark ? "light" : "dark";
  }
  // Light wraps midnight, e.g. 19:00 → 07:00 (unusual but supported).
  return mins >= light || mins < dark ? "light" : "dark";
}

/**
 * Schedule applies only when preference is not forced light/dark
 * (i.e. System path) and the user enabled the schedule.
 */
export function isThemeScheduleActive(
  preference: ThemePreference,
  cfg: ThemeScheduleConfig | null | undefined,
): boolean {
  return preference === "system" && !!cfg?.enabled;
}

/**
 * Resolve concrete theme: forced light/dark win; else schedule if active;
 * else OS system theme.
 */
export function resolveThemeWithSchedule(
  preference: ThemePreference,
  systemTheme: Theme,
  schedule: ThemeScheduleConfig,
  now: Date = new Date(),
): Theme {
  if (preference === "light" || preference === "dark") return preference;
  if (schedule.enabled) {
    return resolveThemeFromSchedule(now, schedule);
  }
  return systemTheme;
}

/** Parse stored JSON / object; invalid → defaults. */
export function parseThemeSchedule(raw: unknown): ThemeScheduleConfig {
  if (raw == null || raw === "") return { ...DEFAULT_THEME_SCHEDULE };

  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw) as unknown;
    } catch {
      return { ...DEFAULT_THEME_SCHEDULE };
    }
  }
  if (!obj || typeof obj !== "object") {
    return { ...DEFAULT_THEME_SCHEDULE };
  }

  const rec = obj as Record<string, unknown>;
  const enabled = rec.enabled === true;
  const lightFrom =
    typeof rec.lightFrom === "string"
      ? normalizeHHmm(rec.lightFrom) ?? DEFAULT_THEME_SCHEDULE.lightFrom
      : DEFAULT_THEME_SCHEDULE.lightFrom;
  const darkFrom =
    typeof rec.darkFrom === "string"
      ? normalizeHHmm(rec.darkFrom) ?? DEFAULT_THEME_SCHEDULE.darkFrom
      : DEFAULT_THEME_SCHEDULE.darkFrom;

  return { enabled, lightFrom, darkFrom };
}

export function loadThemeSchedule(
  storage: ThemeScheduleStorage = defaultStorage(),
): ThemeScheduleConfig {
  try {
    return parseThemeSchedule(storage.getItem(THEME_SCHEDULE_STORAGE_KEY));
  } catch {
    /* private mode */
    return { ...DEFAULT_THEME_SCHEDULE };
  }
}

export function saveThemeSchedule(
  cfg: ThemeScheduleConfig,
  storage: ThemeScheduleStorage = defaultStorage(),
): void {
  const lightFrom =
    normalizeHHmm(cfg.lightFrom) ?? DEFAULT_THEME_SCHEDULE.lightFrom;
  const darkFrom =
    normalizeHHmm(cfg.darkFrom) ?? DEFAULT_THEME_SCHEDULE.darkFrom;
  const next: ThemeScheduleConfig = {
    enabled: !!cfg.enabled,
    lightFrom,
    darkFrom,
  };
  try {
    storage.setItem(THEME_SCHEDULE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota */
  }
  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function"
  ) {
    try {
      window.dispatchEvent(
        new CustomEvent(THEME_SCHEDULE_CHANGE_EVENT, { detail: next }),
      );
    } catch {
      /* ignore */
    }
  }
}
