/**
 * In-memory catalog cache for Settings → Extensions → Marketplace.
 * Avoids re-running `plugin list --json --available` on every tab visit.
 */

import type { AvailablePluginLike, MarketplaceSourceLike } from "./pluginMarketplace";

/** Default TTL: 6 hours. Refresh button / mutations force a reload. */
export const MARKETPLACE_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

export type MarketplaceCatalogSnapshot = {
  fetchedAt: number;
  sources: MarketplaceSourceLike[];
  available: AvailablePluginLike[];
};

export type MarketplaceCatalogLoadResult = MarketplaceCatalogSnapshot & {
  error: string | null;
  fromCache: boolean;
};

export type MarketplaceCatalogFetcher = () => Promise<{
  sources: MarketplaceSourceLike[];
  available: AvailablePluginLike[];
  error?: string | null;
}>;

let memory: MarketplaceCatalogSnapshot | null = null;
let inflight: Promise<MarketplaceCatalogLoadResult> | null = null;

export function getMarketplaceCatalogCache(): MarketplaceCatalogSnapshot | null {
  return memory;
}

export function isMarketplaceCatalogFresh(
  now = Date.now(),
  ttlMs = MARKETPLACE_CATALOG_TTL_MS,
): boolean {
  if (!memory) return false;
  return now - memory.fetchedAt < ttlMs;
}

/** Drop cache so the next load hits the CLI. */
export function invalidateMarketplaceCatalogCache(): void {
  memory = null;
}

/** Remove one available plugin after a successful install (keeps rest of cache). */
export function removeAvailablePluginFromCache(
  name: string,
  marketplace?: string | null,
): void {
  if (!memory) return;
  const n = name.trim().toLowerCase();
  const m = (marketplace ?? "").trim().toLowerCase();
  memory = {
    ...memory,
    available: memory.available.filter((p) => {
      if (p.name.trim().toLowerCase() !== n) return true;
      if (!m) return false;
      return (p.marketplace ?? "").trim().toLowerCase() !== m;
    }),
  };
}

/**
 * Load marketplace sources + available plugins.
 * Uses memory cache when fresh unless `force` is set.
 * Concurrent callers share one in-flight fetch.
 */
export async function loadMarketplaceCatalog(
  fetch: MarketplaceCatalogFetcher,
  opts?: { force?: boolean; ttlMs?: number },
): Promise<MarketplaceCatalogLoadResult> {
  const force = !!opts?.force;
  const ttlMs = opts?.ttlMs ?? MARKETPLACE_CATALOG_TTL_MS;
  const now = Date.now();

  if (!force && memory && now - memory.fetchedAt < ttlMs) {
    return {
      ...memory,
      error: null,
      fromCache: true,
    };
  }

  if (inflight && !force) {
    return inflight;
  }

  const run = (async (): Promise<MarketplaceCatalogLoadResult> => {
    try {
      const res = await fetch();
      const snap: MarketplaceCatalogSnapshot = {
        fetchedAt: Date.now(),
        sources: res.sources ?? [],
        available: res.available ?? [],
      };
      memory = snap;
      return {
        ...snap,
        error: res.error?.trim() || null,
        fromCache: false,
      };
    } finally {
      inflight = null;
    }
  })();

  inflight = run;
  return run;
}

/** Test helper — reset module state. */
export function __resetMarketplaceCatalogCacheForTests(): void {
  memory = null;
  inflight = null;
}
