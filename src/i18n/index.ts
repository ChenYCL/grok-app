/**
 * App i18n helpers. All user-visible copy must go through `t()`.
 * See docs/llm-wiki/i18n.md for agent maintenance rules.
 */

import {
  isLocale,
  messages,
  type Locale,
  type MessageKey,
} from "./messages";

export type { Locale, MessageKey };
export { isLocale, messages };

export type Vars = Record<string, string | number | undefined | null>;

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = vars[key];
    return v == null ? "" : String(v);
  });
}

/** Translate a key for the given locale. Missing keys fall back to English then the key. */
export function t(locale: Locale, key: MessageKey, vars?: Vars): string {
  const table = messages[locale] ?? messages.en;
  const raw = table[key] ?? messages.en[key] ?? String(key);
  return interpolate(raw, vars);
}

export function createT(locale: Locale) {
  return (key: MessageKey, vars?: Vars) => t(locale, key, vars);
}

/**
 * Best-effort normalization of a raw locale id to a canonical {@link Locale}.
 * Accepts common case/alias variants (e.g. "zh-tw", "zh_Hant", "EN-US") so a
 * hand-edited settings value still resolves. Returns `null` when the id is not
 * a recognizable variant, leaving the fallback to the caller. Mirrors the
 * case-insensitive parsing on the Rust side (see tray_i18n.rs `Locale::parse`).
 */
function normalizeLocale(raw: string): Locale | null {
  const v = raw.trim().toLowerCase();
  if (v === "zh-tw" || v === "zh_tw" || v === "zh-hant" || v === "zh_hant") {
    return "zh-TW";
  }
  if (v === "zh" || v === "zh-cn" || v === "zh_cn" || v === "zh-hans") {
    return "zh";
  }
  if (v === "en" || v === "en-us" || v === "en_us" || v === "en-gb") {
    return "en";
  }
  return null;
}

export function resolveLocale(raw: string | undefined | null): Locale {
  if (!raw) return "en";
  if (isLocale(raw)) return raw;
  return normalizeLocale(raw) ?? "en";
}
