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
 * Ranking strategy for session search.
 * - `keyword` — substring match only (default; stable order)
 * - `hybrid` — keyword + lightweight token-overlap ranking on titles/snippets
 *
 * Honest local hybrid only — no cloud embeddings / embedding API.
 */
export type SessionSearchRankMode = "keyword" | "hybrid";

export const SESSION_SEARCH_RANK_MODES: readonly SessionSearchRankMode[] = [
  "keyword",
  "hybrid",
] as const;

export const DEFAULT_SESSION_SEARCH_RANK_MODE: SessionSearchRankMode =
  "keyword";

export type SessionSearchFilterOpts = {
  maxSessions?: number;
  maxProjects?: number;
  includeArchived?: boolean;
  /** Ranking / match expansion mode. Default `keyword`. */
  rankMode?: SessionSearchRankMode;
};

export type SessionSearchMergeOpts = {
  maxSessions?: number;
  includeArchived?: boolean;
  /** Re-rank merged rows when `hybrid`. Default `keyword`. */
  rankMode?: SessionSearchRankMode;
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
  /** Optional score when hybrid ranking is active (higher = better). */
  score?: number;
};

/**
 * Parse / normalize a rank mode. Invalid → keyword.
 */
export function parseSessionSearchRankMode(
  raw: unknown,
): SessionSearchRankMode {
  if (raw === "hybrid" || raw === "semantic" || raw === "token") {
    return "hybrid";
  }
  return "keyword";
}

/** Tiny English stop set — not a full NLP pipeline. */
const SEARCH_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "to",
  "of",
  "in",
  "on",
  "for",
  "and",
  "or",
  "is",
  "it",
  "at",
  "by",
  "as",
  "be",
  "with",
]);

/**
 * Tokenize free text for lightweight overlap ranking.
 * Lowercases, splits on non-alphanumeric (CJK ideographs as single tokens).
 */
export function tokenizeSearchText(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  // Letters/digits runs; CJK ideographs as individual tokens for better overlap.
  const parts = lower.match(/[a-z0-9]+|[\u3400-\u9fff\uf900-\ufaff]/g);
  if (!parts) return [];
  // Drop ultra-short / stopword latin noise (keep CJK singles).
  return parts.filter((t) => {
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(t)) return true;
    if (t.length < 2) return false;
    if (SEARCH_STOPWORDS.has(t)) return false;
    return true;
  });
}

/**
 * Fraction of query tokens that appear in `text` (recall over query tokens).
 * Returns 0..1. Empty query tokens → 0.
 */
export function tokenOverlapScore(queryTokens: string[], text: string): number {
  if (queryTokens.length === 0) return 0;
  const hay = text.toLowerCase();
  if (!hay) return 0;
  let hits = 0;
  for (const t of queryTokens) {
    if (hay.includes(t)) hits += 1;
  }
  return hits / queryTokens.length;
}

/**
 * Score a candidate row for hybrid ranking (higher is better).
 * Keyword mode callers typically skip sorting by this.
 *
 * Weights (local heuristic only — not embeddings):
 * - full phrase in title/id
 * - token recall on title / snippet
 * - content match count
 */
export function scoreSessionSearchHit(
  query: string,
  hit: {
    title: string;
    id?: string;
    snippet?: string;
    titleMatch?: boolean;
    contentMatch?: boolean;
    matchCount?: number;
  },
): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;

  const tokens = tokenizeSearchText(q);
  const title = hit.title ?? "";
  const titleLower = title.toLowerCase();
  const idLower = (hit.id ?? "").toLowerCase();
  const snippet = hit.snippet ?? "";
  const snippetLower = snippet.toLowerCase();

  let score = 0;

  if (titleLower.includes(q)) score += 100;
  if (idLower.includes(q)) score += 40;

  score += tokenOverlapScore(tokens, title) * 45;
  if (snippet) {
    if (snippetLower.includes(q)) score += 20;
    score += tokenOverlapScore(tokens, snippet) * 30;
  }

  if (hit.titleMatch) score += 5;
  if (hit.contentMatch) {
    score += 10;
    score += Math.min(hit.matchCount ?? 0, 10);
  }

  return score;
}

/** True when free text matches query under the given rank mode. */
function textMatchesQuery(
  text: string,
  qLower: string,
  tokens: string[],
  rankMode: SessionSearchRankMode,
): boolean {
  const lower = text.toLowerCase();
  if (lower.includes(qLower)) return true;
  if (rankMode !== "hybrid") return false;
  // Hybrid expands recall: any significant query token is enough to include.
  return tokens.some((t) => lower.includes(t));
}

/**
 * Filter sessions and projects by a free-text query.
 * Matches session title / id, and project name / path.
 * When a query matches a project, its sessions are also included.
 *
 * With `rankMode: "hybrid"`, matching expands to per-token includes and
 * sessions are sorted by lightweight token-overlap score (title).
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
  const rankMode: SessionSearchRankMode =
    opts?.rankMode ?? DEFAULT_SESSION_SEARCH_RANK_MODE;

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

  const tokens = tokenizeSearchText(q);
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const matchedProjects = projects
    .filter(
      (p) =>
        textMatchesQuery(p.name, q, tokens, rankMode) ||
        textMatchesQuery(p.path, q, tokens, rankMode),
    )
    .slice(0, maxProjects);
  const matchedProjectIds = new Set(matchedProjects.map((p) => p.id));

  let matchedSessions = live.filter((s) => {
    if (
      textMatchesQuery(s.title, q, tokens, rankMode) ||
      textMatchesQuery(s.id, q, tokens, rankMode)
    ) {
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
        (textMatchesQuery(p.name, q, tokens, rankMode) ||
          textMatchesQuery(p.path, q, tokens, rankMode))
      ) {
        return true;
      }
    }
    return false;
  });

  if (rankMode === "hybrid") {
    matchedSessions = matchedSessions
      .slice()
      .sort(
        (a, b) =>
          scoreSessionSearchHit(q, { title: b.title, id: b.id, titleMatch: true }) -
          scoreSessionSearchHit(q, { title: a.title, id: a.id, titleMatch: true }),
      );
  }

  return {
    matchedSessions: matchedSessions.slice(0, maxSessions),
    matchedProjects,
  };
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
 * Title matches first; content-only rows append. Empty query → title list only.
 *
 * With `rankMode: "hybrid"`, re-ranks the merged list by token-overlap score on
 * title + snippet (still local keyword hybrid — no embeddings).
 */
export function mergeSessionSearchHits(
  query: string,
  titleHits: SearchableSession[],
  contentHits: SessionContentHit[],
  opts?: SessionSearchMergeOpts,
): MergedSessionHit[] {
  const maxSessions = opts?.maxSessions ?? 20;
  const includeArchived = opts?.includeArchived ?? false;
  const rankMode: SessionSearchRankMode =
    opts?.rankMode ?? DEFAULT_SESSION_SEARCH_RANK_MODE;
  const q = query.trim();

  const contentById = new Map<string, SessionContentHit>();
  for (const h of contentHits) {
    if (!includeArchived && h.archived) continue;
    contentById.set(h.id, h);
  }

  const out: MergedSessionHit[] = [];
  const seen = new Set<string>();

  for (const s of titleHits) {
    if (!includeArchived && s.archived) continue;
    const c = contentById.get(s.id);
    out.push({
      id: s.id,
      title: s.title,
      projectId: s.projectId,
      snippet: c?.snippet,
      matchCount: c?.matchCount,
      titleMatch: q.length > 0,
      contentMatch: !!c,
    });
    seen.add(s.id);
    if (out.length >= maxSessions && rankMode !== "hybrid") return out;
  }

  if (!q) return out.slice(0, maxSessions);

  // Content-only: prefer higher match counts, then original order.
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
    });
    if (rankMode !== "hybrid" && out.length >= maxSessions) break;
  }

  if (rankMode === "hybrid") {
    for (const hit of out) {
      hit.score = scoreSessionSearchHit(q, hit);
    }
    out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  return out.slice(0, maxSessions);
}
