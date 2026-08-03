/**
 * Catalog/list helpers for the redesigned Settings → Plugins page
 * (ChatGPT-style: installed strip + 2-col featured cards).
 */

import type { AvailablePluginLike } from "./pluginMarketplace";
import {
  buildAvailableCard,
  buildInstalledCard,
  type PluginCardKind,
  type PluginCardModel,
  type PluginManifestLike,
} from "./pluginCard";
import { isChatCutInstalled } from "./pluginRecommended";

export const PLUGIN_CATALOG_PAGE_SIZE = 24;

export function sliceCatalogPage<T>(
  items: readonly T[],
  page: number,
  pageSize = PLUGIN_CATALOG_PAGE_SIZE,
): { visible: T[]; hasMore: boolean; total: number } {
  const n = Math.max(1, pageSize);
  const p = Math.max(1, page);
  const end = p * n;
  return {
    visible: items.slice(0, end) as T[],
    hasMore: end < items.length,
    total: items.length,
  };
}

/**
 * Dedupe catalog rows by plugin name (case-insensitive).
 * Same plugin often appears under multiple marketplace sources (xAI + openai).
 * Prefer: longer description, then xAI Official, then first seen.
 */
export function dedupeAvailablePluginsByName<
  T extends {
    name: string;
    description?: string | null;
    marketplace?: string | null;
  },
>(plugins: readonly T[]): T[] {
  const best = new Map<string, T>();
  const score = (p: T): number => {
    let s = 0;
    const desc = (p.description ?? "").trim().length;
    s += Math.min(desc, 500);
    const m = (p.marketplace ?? "").toLowerCase();
    if (m.includes("xai") || m.includes("official")) s += 50;
    if (m.includes("openai") || m === "plugins") s += 20;
    return s;
  };
  for (const p of plugins) {
    const key = (p.name ?? "").trim().toLowerCase();
    if (!key) continue;
    const prev = best.get(key);
    if (!prev || score(p) > score(prev)) {
      best.set(key, p);
    }
  }
  return [...best.values()];
}

/** Dedupe cards by stable name key (for UI list). */
export function dedupePluginCardsByName(
  cards: readonly PluginCardModel[],
): PluginCardModel[] {
  const best = new Map<string, PluginCardModel>();
  for (const c of cards) {
    const key = (c.name ?? "").trim().toLowerCase();
    if (!key) continue;
    const prev = best.get(key);
    if (!prev) {
      best.set(key, c);
      continue;
    }
    // Prefer row with logo + richer description
    const prevScore =
      (prev.iconUrl ? 100 : 0) + (prev.description?.length ?? 0);
    const nextScore = (c.iconUrl ? 100 : 0) + (c.description?.length ?? 0);
    if (nextScore > prevScore) best.set(key, c);
  }
  return [...best.values()];
}

/** Filter available rows by free-text query. */
export function filterPluginCardsByQuery(
  cards: readonly PluginCardModel[],
  query: string,
): PluginCardModel[] {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return [...cards];
  return cards.filter((c) => {
    const hay = [
      c.displayName,
      c.name,
      c.description,
      c.marketplace ?? "",
      c.categoryLabel,
      c.providesLine ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

export function availableToCards(
  plugins: readonly AvailablePluginLike[],
  opts?: {
    installedNames?: Set<string>;
    categoryLabel?: (k: PluginCardKind) => string;
    enrich?: Map<string, { manifest?: PluginManifestLike | null; iconUrl?: string | null }>;
  },
): PluginCardModel[] {
  const installed = opts?.installedNames ?? new Set<string>();
  const unique = dedupeAvailablePluginsByName(plugins);
  return unique.map((p) => {
    const key = `${(p.marketplace ?? "").trim().toLowerCase()}:${p.name.trim().toLowerCase()}`;
    const extra = opts?.enrich?.get(key) ?? opts?.enrich?.get(p.name.trim().toLowerCase());
    const base = buildAvailableCard(p, {
      installed: installed.has(p.name.trim().toLowerCase()),
      installSource: p.marketplace
        ? `${p.name}@${p.marketplace}`
        : p.name,
      categoryLabel: opts?.categoryLabel,
    });
    const iface = extra?.manifest?.interface;
    const displayName =
      iface?.displayName?.trim() ||
      extra?.manifest?.name?.trim() ||
      base.displayName;
    const description =
      iface?.shortDescription?.trim() ||
      extra?.manifest?.description?.trim() ||
      base.description;
    return {
      ...base,
      // Stable id by name only so React keys never double-render same plugin
      id: p.name.trim().toLowerCase(),
      displayName,
      description,
      iconUrl: extra?.iconUrl ?? base.iconUrl,
    };
  });
}

export function installedToCards(
  plugins: readonly {
    name: string;
    version?: string | null;
    path?: string | null;
    marketplace?: string | null;
    source?: string | null;
    enabled: boolean;
    provides?: {
      skills?: number | null;
      agents?: number | null;
      hooks?: boolean | null;
      mcpServers?: number | null;
    } | null;
  }[],
  opts?: {
    chatcutLabel?: string;
    categoryLabel?: (k: PluginCardKind) => string;
    enrich?: Map<
      string,
      { manifest?: PluginManifestLike | null; iconUrl?: string | null }
    >;
  },
): PluginCardModel[] {
  return plugins.map((p) => {
    const extra =
      opts?.enrich?.get(p.name.trim().toLowerCase()) ??
      opts?.enrich?.get((p.path ?? "").trim());
    const card = buildInstalledCard(p, {
      chatcutLabel: opts?.chatcutLabel,
      categoryLabel: opts?.categoryLabel,
      manifest: extra?.manifest,
      iconUrl: extra?.iconUrl,
    });
    if (isChatCutInstalled([p]) && opts?.chatcutLabel) {
      return { ...card, displayName: opts.chatcutLabel };
    }
    return card;
  });
}

/**
 * Resolve logo relative path against a plugin root directory.
 * Supports `assets/logo.svg`, `./assets/logo.png`, `../../assets/x.svg`.
 */
export function resolvePluginLogoPath(
  pluginRoot: string,
  logoField: string | null | undefined,
): string | null {
  const root = pluginRoot.replace(/[/\\]+$/, "");
  const logo = (logoField ?? "").trim();
  if (!root || !logo) return null;
  if (logo.startsWith("http://") || logo.startsWith("https://") || logo.startsWith("data:")) {
    return logo;
  }
  // Normalize ./ and ../ segments simply against root
  const parts = root.split(/[/\\]/);
  const segs = logo.replace(/^\.\//, "").split(/[/\\]/);
  for (const s of segs) {
    if (!s || s === ".") continue;
    if (s === "..") {
      parts.pop();
      continue;
    }
    parts.push(s);
  }
  return parts.join("/");
}

/** Candidate marketplace-cache roots for a plugin name. */
export function marketplacePluginRootCandidates(
  cacheRoot: string,
  pluginName: string,
): string[] {
  const cache = cacheRoot.replace(/[/\\]+$/, "");
  const name = pluginName.trim();
  if (!cache || !name) return [];
  return [
    `${cache}/plugins/${name}`,
    `${cache}/external_plugins/${name}`,
    // nested one-level scan pattern used by some marketplaces
    // callers may also pass resolved path
  ];
}
