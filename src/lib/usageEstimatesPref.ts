/**
 * Settings → Appearance: “Show usage estimates” (token + optional $ cost in context chip).
 * localStorage-only — does not touch Host AppSettings.
 * Default: on, with an honest disclaimer in the chip menu.
 */

export const USAGE_ESTIMATES_STORAGE_KEY = "grok.showUsageEstimates";

/** Fired on `window` after a successful save (detail = boolean show). */
export const USAGE_ESTIMATES_CHANGE_EVENT = "grok-usage-estimates-change";

/**
 * On by default so the context chip can surface token breakdown + optional $
 * when rates exist. Always labeled as an estimate (never invoice-grade).
 */
export const DEFAULT_SHOW_USAGE_ESTIMATES = true;

/** Minimal storage surface so unit tests need no jsdom. */
export interface UsageEstimatesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): UsageEstimatesStorage {
  if (typeof localStorage !== "undefined") return localStorage;
  return { getItem: () => null, setItem: () => {} };
}

/** Parse stored value; invalid / empty → default on. */
export function parseShowUsageEstimatesPref(raw: unknown): boolean {
  if (raw === "0" || raw === "false" || raw === false) return false;
  if (raw === "1" || raw === "true" || raw === true) return true;
  return DEFAULT_SHOW_USAGE_ESTIMATES;
}

export function loadShowUsageEstimatesPref(
  storage: UsageEstimatesStorage = defaultStorage(),
): boolean {
  try {
    return parseShowUsageEstimatesPref(
      storage.getItem(USAGE_ESTIMATES_STORAGE_KEY),
    );
  } catch {
    /* private mode */
    return DEFAULT_SHOW_USAGE_ESTIMATES;
  }
}

export function saveShowUsageEstimatesPref(
  show: boolean,
  storage: UsageEstimatesStorage = defaultStorage(),
): void {
  try {
    storage.setItem(USAGE_ESTIMATES_STORAGE_KEY, show ? "1" : "0");
  } catch {
    /* private mode / quota */
  }
  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function"
  ) {
    try {
      window.dispatchEvent(
        new CustomEvent(USAGE_ESTIMATES_CHANGE_EVENT, { detail: show }),
      );
    } catch {
      /* ignore */
    }
  }
}
