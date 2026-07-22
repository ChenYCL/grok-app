/**
 * Theme store: dark default, durable persistence (localStorage key aligned
 * with App config preference). Pure helpers are unit-tested without Tauri.
 */

export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "grok-app.theme";
export const DEFAULT_THEME: Theme = "dark";

export function isTheme(value: unknown): value is Theme {
  return value === "dark" || value === "light";
}

/** Parse a stored theme; invalid → default dark. */
export function parseTheme(raw: unknown): Theme {
  if (typeof raw === "string" && isTheme(raw)) return raw;
  return DEFAULT_THEME;
}

export function toggleTheme(current: Theme): Theme {
  return current === "dark" ? "light" : "dark";
}

/** Apply theme to documentElement (data-theme attribute). */
export function applyThemeToDocument(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.setAttribute("data-theme", theme);
}

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Read persisted theme from a storage-like object (localStorage or mock). */
export function loadTheme(storage: ThemeStorage): Theme {
  try {
    return parseTheme(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

/** Persist theme. */
export function saveTheme(storage: ThemeStorage, theme: Theme): void {
  storage.setItem(THEME_STORAGE_KEY, theme);
}

/** Full switch: compute next, persist, apply DOM. */
export function switchTheme(
  current: Theme,
  storage: ThemeStorage,
  root?: HTMLElement,
): Theme {
  const next = toggleTheme(current);
  saveTheme(storage, next);
  if (typeof document !== "undefined" || root) {
    applyThemeToDocument(next, root ?? document.documentElement);
  }
  return next;
}
