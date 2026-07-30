/** Pure helpers for the sidebar / command-palette search. */

export type SearchableSession = {
  id: string;
  title: string;
  projectId?: string | null;
  archived?: boolean;
};

export type SearchableProject = {
  id: string;
  name: string;
  path: string;
};

/** Content hit from journal scan (`sessions_search`). */
export type SessionContentHit = {
  id: string;
  title: string;
  projectId?: string | null;
  snippet: string;
  matchCount: number;
  updatedAt?: string;
  archived?: boolean;
};

export type SessionSearchHits = {
  matchedSessions: SearchableSession[];
  matchedProjects: SearchableProject[];
};

/**
 * Keyword hybrid search scope (no embeddings).
 * - `all` — title/project + message content (default hybrid)
 * - `title` — session title / id / project only; skip journal scan
 * - `content` — message body only; prefer content ranking
 */
export type SessionSearchMode = "all" | "title" | "content";

export const SESSION_SEARCH_MODES: readonly SessionSearchMode[] = [
  "all",
  "title",
  "content",
] as const;

export type SessionSearchFilterOpts = {
  maxSessions?: number;
  maxProjects?: number;
  includeArchived?: boolean;
  mode?: SessionSearchMode;
};

export type SessionSearchMergeOpts = {
  maxSessions?: number;
  includeArchived?: boolean;
  mode?: SessionSearchMode;
};

/** Palette row: title/project hit and/or content match. */
export type MergedSessionHit = {
  id: string;
  title: string;
  projectId?: string | null;
  /** First content snippet when the journal matched. */
  snippet?: string;
  matchCount?: number;
  /** True when title/id/project matched the query. */
  titleMatch: boolean;
  /** True when message body matched. */
  contentMatch: boolean;
  archived?: boolean;
};

/** Compact badge kind for a merged row (UI labels via i18n). */
export type SessionSearchBadge = "title" | "content" | "both";

/**
 * Whether the UI should invoke `sessions_search` for this query + mode.
 * Title-only mode skips the journal scan; empty query never scans.
 */
export function shouldScanSessionContent(
  query: string,
  mode: SessionSearchMode = "all",
): boolean {
  if (mode === "title") return false;
  return query.trim().length > 0;
}

/**
 * Badge kind from match flags. Null when neither (e.g. empty-query recents).
 */
export function sessionSearchBadge(
  hit: Pick<MergedSessionHit, "titleMatch" | "contentMatch">,
): SessionSearchBadge | null {
  if (hit.titleMatch && hit.contentMatch) return "both";
  if (hit.titleMatch) return "title";
  if (hit.contentMatch) return "content";
  return null;
}

/**
 * Stable i18n message key for a search badge.
 * Callers pass the key to `tr()` / `t()`.
 */
export function sessionSearchBadgeLabelKey(
  badge: SessionSearchBadge,
): "search.badgeTitle" | "search.badgeContent" | "search.badgeBoth" {
  switch (badge) {
    case "title":
      return "search.badgeTitle";
    case "content":
      return "search.badgeContent";
    case "both":
      return "search.badgeBoth";
  }
}

/**
 * Filter sessions and projects by a free-text query.
 * Matches session title / id, and project name / path.
 * When a query matches a project, its sessions are also included.
 *
 * Mode:
 * - `content` + non-empty query → no title/project session hits (content merge only)
 * - `title` / `all` → normal title/project matching
 * Empty query always returns recent items (respecting includeArchived).
 */
export function filterSessionSearch(
  query: string,
  sessions: SearchableSession[],
  projects: SearchableProject[],
  opts?: SessionSearchFilterOpts,
): SessionSearchHits {
  const maxSessions = opts?.maxSessions ?? 20;
  const maxProjects = opts?.maxProjects ?? 10;
  const includeArchived = opts?.includeArchived ?? false;
  const mode: SessionSearchMode = opts?.mode ?? "all";

  const live = includeArchived
    ? sessions
    : sessions.filter((s) => !s.archived);

  const q = query.trim().toLowerCase();
  if (!q) {
    return {
      matchedSessions: live.slice(0, Math.min(12, maxSessions)),
      matchedProjects: projects.slice(0, Math.min(6, maxProjects)),
    };
  }

  // Content-only mode: title/project filters stay empty; content hits fill the list.
  if (mode === "content") {
    return { matchedSessions: [], matchedProjects: [] };
  }

  const projectById = new Map(projects.map((p) => [p.id, p]));
  const matchedProjects = projects
    .filter(
      (p) =>
        p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
    )
    .slice(0, maxProjects);
  const matchedProjectIds = new Set(matchedProjects.map((p) => p.id));

  const matchedSessions = live
    .filter((s) => {
      if (s.title.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)) {
        return true;
      }
      if (s.projectId && matchedProjectIds.has(s.projectId)) {
        return true;
      }
      // Also match project name even if project list itself is full.
      if (s.projectId) {
        const p = projectById.get(s.projectId);
        if (
          p &&
          (p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
        ) {
          return true;
        }
      }
      return false;
    })
    .slice(0, maxSessions);

  return { matchedSessions, matchedProjects };
}

/**
 * Pure content matcher: case-insensitive substring over user/assistant texts.
 * Returns match count (messages that hit) and a short snippet from the first hit.
 * Used for unit tests; runtime search scans on the host via `sessions_search`.
 */
export function matchMessageContent(
  query: string,
  messages: Array<{ role: string; content: string }>,
  opts?: { snippetRadius?: number; snippetMax?: number },
): { matchCount: number; snippet: string } | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;

  const radius = opts?.snippetRadius ?? 48;
  const maxLen = opts?.snippetMax ?? 120;
  let matchCount = 0;
  let snippet: string | undefined;

  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const content = m.content ?? "";
    if (!content) continue;
    const lower = content.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx < 0) continue;
    matchCount += 1;
    if (snippet === undefined) {
      snippet = makeContentSnippet(content, idx, q.length, radius, maxLen);
    }
  }

  if (matchCount === 0) return null;
  return { matchCount, snippet: snippet ?? "" };
}

/** Single-line snippet around a match index (character-based). */
export function makeContentSnippet(
  content: string,
  matchIndex: number,
  matchLen: number,
  radius = 48,
  maxLen = 120,
): string {
  const start = Math.max(0, matchIndex - radius);
  const end = Math.min(content.length, matchIndex + matchLen + radius + 16);
  let slice = content.slice(start, end);
  if (start > 0) slice = `…${slice}`;
  if (end < content.length) slice = `${slice}…`;
  const collapsed = slice.split(/\s+/).filter(Boolean).join(" ");
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxLen - 1))}…`;
}

/**
 * Merge title/project hits with journal content hits for the palette.
 *
 * Mode:
 * - `all` (default) — title matches first; content-only rows append
 * - `title` — ignore content hits entirely
 * - `content` — content hits first (by matchCount); no title-only rows
 *
 * Empty query → title list only (recents), no content-only rows.
 */
export function mergeSessionSearchHits(
  query: string,
  titleHits: SearchableSession[],
  contentHits: SessionContentHit[],
  opts?: SessionSearchMergeOpts,
): MergedSessionHit[] {
  const maxSessions = opts?.maxSessions ?? 20;
  const includeArchived = opts?.includeArchived ?? false;
  const mode: SessionSearchMode = opts?.mode ?? "all";
  const q = query.trim();

  const contentById = new Map<string, SessionContentHit>();
  if (mode !== "title") {
    for (const h of contentHits) {
      if (!includeArchived && h.archived) continue;
      contentById.set(h.id, h);
    }
  }

  const out: MergedSessionHit[] = [];
  const seen = new Set<string>();

  if (mode === "content" && q) {
    // Prefer content: higher match counts first; no title-only rows.
    const ranked = contentHits
      .filter((h) => includeArchived || !h.archived)
      .slice()
      .sort((a, b) => (b.matchCount ?? 0) - (a.matchCount ?? 0));

    for (const h of ranked) {
      if (seen.has(h.id)) continue;
      // Title match flag when the same id also appeared in titleHits (rare in content mode).
      const titleHit = titleHits.find((s) => s.id === h.id);
      out.push({
        id: h.id,
        title: h.title || titleHit?.title || "",
        projectId: h.projectId ?? titleHit?.projectId,
        snippet: h.snippet,
        matchCount: h.matchCount,
        titleMatch: !!titleHit,
        contentMatch: true,
        archived: h.archived ?? titleHit?.archived,
      });
      seen.add(h.id);
      if (out.length >= maxSessions) break;
    }
    return out;
  }

  // title / all: title hits first (with optional content snippets).
  for (const s of titleHits) {
    if (!includeArchived && s.archived) continue;
    const c = mode === "title" ? undefined : contentById.get(s.id);
    out.push({
      id: s.id,
      title: s.title,
      projectId: s.projectId,
      snippet: c?.snippet,
      matchCount: c?.matchCount,
      titleMatch: q.length > 0,
      contentMatch: !!c,
      archived: s.archived,
    });
    seen.add(s.id);
    if (out.length >= maxSessions) return out;
  }

  if (!q || mode === "title") return out;

  // Content-only (all mode): prefer higher match counts, then original order.
  const contentOnly = contentHits
    .filter((h) => !seen.has(h.id) && (includeArchived || !h.archived))
    .slice()
    .sort((a, b) => (b.matchCount ?? 0) - (a.matchCount ?? 0));

  for (const h of contentOnly) {
    out.push({
      id: h.id,
      title: h.title,
      projectId: h.projectId,
      snippet: h.snippet,
      matchCount: h.matchCount,
      titleMatch: false,
      contentMatch: true,
      archived: h.archived,
    });
    if (out.length >= maxSessions) break;
  }

  return out;
}
