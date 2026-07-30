/**
 * Pure helpers for Settings → Agent → Memory browser content search.
 *
 * Host `memory_search` scans file bodies under GROK_HOME/memory (capped);
 * the UI merges list rows with search hits and shows redacted snippets.
 */

export const MEMORY_SEARCH_DEFAULT_LIMIT = 50;
export const MEMORY_SEARCH_MAX_LIMIT = 50;
/** Debounce before calling host content search (ms). */
export const MEMORY_SEARCH_DEBOUNCE_MS = 280;

export type MemorySearchHitLike = {
  path: string;
  name: string;
  relativePath: string;
  kind: string;
  workspaceSlug?: string | null;
  size: number;
  mtimeMs: number;
  snippet: string;
  contentMatch: boolean;
  matched: boolean;
};

export type MemoryListEntryLike = {
  path: string;
  name: string;
  relativePath: string;
  kind: string;
  workspaceSlug?: string | null;
  size: number;
  mtimeMs: number;
  preview: string;
  matched: boolean;
};

/** Display row for the memory browser list (list entry + optional search hit). */
export type MemoryBrowserRow = MemoryListEntryLike & {
  /** Redacted content snippet when host search found a body match. */
  snippet?: string;
  contentMatch?: boolean;
  /** True when the row is shown only because of a search hit (not in empty-query list). */
  fromSearch?: boolean;
};

/** Clamp host search limit into the hard range. */
export function clampMemorySearchLimit(limit?: number | null): number {
  if (limit == null || !Number.isFinite(limit)) {
    return MEMORY_SEARCH_DEFAULT_LIMIT;
  }
  const n = Math.floor(Number(limit));
  if (n < 1) return 1;
  if (n > MEMORY_SEARCH_MAX_LIMIT) return MEMORY_SEARCH_MAX_LIMIT;
  return n;
}

/** Whether the free-text query should trigger host content search. */
export function shouldRunMemoryContentSearch(query: string | undefined | null): boolean {
  return (query ?? "").trim().length > 0;
}

/**
 * Case-insensitive name / path / preview match for instant client filter
 * while host content search is in flight (or as a soft fallback).
 */
export function memoryEntryNameMatches(
  entry: Pick<MemoryListEntryLike, "name" | "relativePath" | "preview" | "kind" | "workspaceSlug">,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    entry.name,
    entry.relativePath,
    entry.kind,
    entry.preview,
    entry.workspaceSlug || "",
  ]
    .join("\n")
    .toLowerCase();
  return hay.includes(q);
}

/**
 * Merge list entries with host search hits for display.
 *
 * - Empty query → all list entries (no snippets).
 * - Non-empty query → union of name-matching list rows and search hits;
 *   content matches first, then name-only; preserves stable path order within tier.
 */
export function mergeMemoryBrowserRows(
  entries: MemoryListEntryLike[],
  hits: MemorySearchHitLike[] | undefined | null,
  query: string,
): MemoryBrowserRow[] {
  const q = query.trim();
  if (!q) {
    return entries.map((e) => ({ ...e }));
  }

  const hitByPath = new Map<string, MemorySearchHitLike>();
  for (const h of hits ?? []) {
    if (h?.path) hitByPath.set(h.path, h);
  }

  const seen = new Set<string>();
  const rows: MemoryBrowserRow[] = [];

  // Content hits first (host already ranks content_match first, but re-assert).
  const orderedHits = [...(hits ?? [])].sort((a, b) => {
    if (a.contentMatch !== b.contentMatch) return a.contentMatch ? -1 : 1;
    return a.relativePath.localeCompare(b.relativePath, undefined, {
      sensitivity: "base",
    });
  });

  for (const h of orderedHits) {
    if (!h.path || seen.has(h.path)) continue;
    seen.add(h.path);
    const base = entries.find((e) => e.path === h.path);
    if (base) {
      rows.push({
        ...base,
        snippet: h.snippet || undefined,
        contentMatch: h.contentMatch,
        fromSearch: true,
      });
    } else {
      rows.push({
        path: h.path,
        name: h.name,
        relativePath: h.relativePath,
        kind: h.kind,
        workspaceSlug: h.workspaceSlug,
        size: h.size,
        mtimeMs: h.mtimeMs,
        preview: "",
        matched: h.matched,
        snippet: h.snippet || undefined,
        contentMatch: h.contentMatch,
        fromSearch: true,
      });
    }
  }

  // Name/preview matches from the list that host may not have returned yet
  // (or while search is still loading).
  for (const e of entries) {
    if (seen.has(e.path)) continue;
    if (!memoryEntryNameMatches(e, q)) continue;
    seen.add(e.path);
    const h = hitByPath.get(e.path);
    rows.push({
      ...e,
      snippet: h?.snippet || undefined,
      contentMatch: h?.contentMatch,
      fromSearch: false,
    });
  }

  return rows;
}

/** Human-friendly truncated flag line for the toolbar. */
export function memorySearchTruncatedHint(truncated: boolean, hitCount: number): boolean {
  return truncated && hitCount > 0;
}
