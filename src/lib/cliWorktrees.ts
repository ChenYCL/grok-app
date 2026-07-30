/**
 * Grok Build CLI worktree list helpers (`grok worktree list`).
 * Pure parsers for --json and text fallback; used by host tests mirrors + UI.
 */

export type CliWorktreeEntry = {
  /** CLI index id (stable when present). */
  id: string;
  /** Display name (folder basename, else short id). */
  name: string;
  /** Absolute worktree path when known. */
  path: string;
  /** Branch / git ref when known. */
  branch?: string | null;
  /** Lifecycle status (`alive`, `stale`, …). */
  status?: string | null;
  /** Kind: `user` / `subagent` / etc. */
  kind?: string | null;
  repoName?: string | null;
  sourceRepo?: string | null;
  /** True when path exists as a directory (safe to open as cwd). */
  pathOk?: boolean;
  head?: string | null;
};

export type CliWorktreesResult = {
  available: boolean;
  worktrees: CliWorktreeEntry[];
  reason?: string | null;
  cliFound: boolean;
  /** `json` | `text` | `none` */
  source?: string | null;
};

const LIST_CAP = 200;

export function normalizeCliWtPath(path: string | null | undefined): string {
  let p = (path ?? "").trim().replace(/\\/g, "/");
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/** Expand `~/…` using a provided absolute home (tests + pure UI). */
export function expandTildePath(
  path: string | null | undefined,
  home: string | null | undefined,
): string {
  const t = (path ?? "").trim();
  const h = normalizeCliWtPath(home);
  if (t === "~" && h) return h;
  if ((t.startsWith("~/") || t.startsWith("~\\")) && h) {
    return normalizeCliWtPath(`${h}/${t.slice(2)}`);
  }
  return normalizeCliWtPath(t);
}

/** Display name: last path segment, else id (capped). */
export function deriveCliWorktreeName(
  id: string | null | undefined,
  path: string | null | undefined,
): string {
  const p = normalizeCliWtPath(path);
  if (p) {
    const base = p.split("/").filter(Boolean).pop() || "";
    if (base && base !== "." && base !== "..") return base;
  }
  const raw = (id ?? "").trim();
  if (!raw) return "worktree";
  if (raw.length > 48) return `${raw.slice(0, 40)}…`;
  return raw;
}

function jsonStr(
  item: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = item[k];
    if (typeof v === "string") {
      const t = v.trim();
      if (t) return t;
    }
  }
  return null;
}

/**
 * Parse `grok worktree list --json` stdout.
 * Accepts array or `{ worktrees | items | entries: [...] }`.
 */
export function parseCliWorktreeListJson(
  raw: string,
  home?: string | null,
): CliWorktreeEntry[] {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return [];
  const start = trimmed.search(/[\[{]/);
  if (start < 0) return [];
  let value: unknown;
  try {
    value = JSON.parse(trimmed.slice(start));
  } catch {
    return [];
  }

  let items: unknown[] = [];
  if (Array.isArray(value)) {
    items = value;
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const arr =
      obj.worktrees ?? obj.items ?? obj.entries ?? null;
    if (Array.isArray(arr)) items = arr;
    else items = [value];
  }

  const out: CliWorktreeEntry[] = [];
  for (const row of items) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const id =
      jsonStr(item, ["id", "worktree_id", "worktreeId"]) ?? "";
    const rawPath =
      jsonStr(item, ["path", "worktree_path", "worktreePath", "dir"]) ?? "";
    const path = expandTildePath(rawPath, home);
    if (!id && !path) continue;
    const branch = jsonStr(item, [
      "git_ref",
      "gitRef",
      "branch",
      "ref",
      "worktree_ref",
      "worktreeRef",
    ]);
    const status = jsonStr(item, ["status", "state"]);
    const kind = jsonStr(item, [
      "kind",
      "type",
      "worktree_type",
      "worktreeType",
    ]);
    const repoName = jsonStr(item, ["repo_name", "repoName", "repo"]);
    const sourceRepoRaw = jsonStr(item, [
      "source_repo",
      "sourceRepo",
      "source",
    ]);
    const sourceRepo = sourceRepoRaw
      ? expandTildePath(sourceRepoRaw, home)
      : null;
    let head = jsonStr(item, [
      "head_commit",
      "headCommit",
      "head",
      "commit",
    ]);
    if (head && head.length > 12) head = head.slice(0, 12);
    const effectiveId = id || path;
    out.push({
      id: effectiveId,
      name: deriveCliWorktreeName(effectiveId, path),
      path,
      branch,
      status,
      kind,
      repoName,
      sourceRepo,
      pathOk: false, // host fills real existence
      head,
    });
    if (out.length >= LIST_CAP) break;
  }
  return out;
}

function isAgeToken(s: string): boolean {
  const lower = s.toLowerCase();
  if (lower === "ago") return true;
  const m = lower.match(/^(\d+)(d|h|m|s|w|mo|y|min|mins|hr|hrs)$/);
  return !!m;
}

function looksLikePath(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (t === "~" || t.startsWith("~/") || t.startsWith("~\\")) return true;
  if (t.startsWith("/")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(t)) return true;
  return false;
}

function extractTrailingPath(line: string): string | null {
  const t = line.trimEnd();
  for (let i = t.length - 1; i >= 0; i--) {
    const ch = t[i];
    if (ch === " " || ch === "\t") {
      const candidate = t.slice(i + 1).trim();
      if (looksLikePath(candidate)) return candidate;
    }
  }
  if (looksLikePath(t)) return t.trim();
  return null;
}

function isTextNoise(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  const lower = t.toLowerCase();
  if (lower.startsWith("id ") || lower === "id") return true;
  if (lower.includes(" type ") && lower.includes(" path")) return true;
  if (
    lower.includes("worktree") &&
    (lower.includes(" subagent") ||
      lower.endsWith("worktrees") ||
      lower.includes(" worktrees ")) &&
    /^\d/.test(t)
  ) {
    return true;
  }
  return false;
}

/**
 * Parse human table from `grok worktree list` (no --json).
 * Columns: ID TYPE REPO LABEL BRANCH AGE PATH
 */
export function parseCliWorktreeListText(
  raw: string,
  home?: string | null,
): CliWorktreeEntry[] {
  const text = (raw ?? "").replace(/\r\n/g, "\n");
  const out: CliWorktreeEntry[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (isTextNoise(t)) continue;
    const pathRaw = extractTrailingPath(t);
    if (!pathRaw) continue;
    const path = expandTildePath(pathRaw, home);
    if (!path) continue;
    const left = t.slice(0, Math.max(0, t.length - pathRaw.length)).trimEnd();
    let tokens = left.split(/\s+/).filter(Boolean);
    while (tokens.length && isAgeToken(tokens[tokens.length - 1]!)) {
      tokens = tokens.slice(0, -1);
    }
    if (!tokens.length) continue;
    const id = tokens[0] ?? "";
    const kind = tokens[1] ?? null;
    let branch: string | null = null;
    for (let i = tokens.length - 1; i >= 0; i--) {
      const s = tokens[i]!;
      if (!s || s === "…" || s === "..." || s.endsWith("…")) continue;
      if (s === id || s === kind) continue;
      if (
        s === "HEAD" ||
        s.includes("/") ||
        /^[A-Za-z0-9._-]+$/.test(s)
      ) {
        branch = s;
        break;
      }
    }
    const effectiveId = id || path;
    out.push({
      id: effectiveId,
      name: deriveCliWorktreeName(effectiveId, path),
      path,
      branch,
      status: null,
      kind,
      repoName: null,
      sourceRepo: null,
      pathOk: false,
      head: null,
    });
    if (out.length >= LIST_CAP) break;
  }
  return out;
}

/** True when a CLI worktree row is safe to bind as session cwd. */
export function canOpenCliWorktreeAsCwd(
  wt: Pick<CliWorktreeEntry, "path" | "pathOk" | "status">,
): boolean {
  const p = normalizeCliWtPath(wt.path);
  if (!p) return false;
  // Host marks pathOk when directory exists; without it, still allow if path present
  // but prefer explicit ok when known.
  if (wt.pathOk === false) return false;
  const st = (wt.status ?? "").toLowerCase();
  if (st === "missing" || st === "gone" || st === "removed") return false;
  return true;
}

/** Short meta line for list rows. */
export function cliWorktreeMetaLabel(
  wt: CliWorktreeEntry,
  labels?: { current?: string },
): string {
  const parts: string[] = [];
  if (wt.kind) parts.push(wt.kind);
  if (wt.branch) parts.push(wt.branch);
  if (wt.status && wt.status !== "alive") parts.push(wt.status);
  if (wt.repoName) parts.push(wt.repoName);
  if (labels?.current) parts.push(labels.current);
  return parts.filter(Boolean).join(" · ");
}

/**
 * Prefer rows for the active project: match sourceRepo path, else worktrees
 * folder slug, else repoName, else all.
 */
export function filterCliWorktreesForProject(
  list: CliWorktreeEntry[],
  projectPath: string | null | undefined,
  projectName?: string | null,
): CliWorktreeEntry[] {
  const proj = normalizeCliWtPath(projectPath).toLowerCase();
  if (!list.length) return list;
  if (!proj && !projectName?.trim()) return list;

  const bySource = proj
    ? list.filter((w) => {
        const src = normalizeCliWtPath(w.sourceRepo).toLowerCase();
        return (
          !!src &&
          (src === proj ||
            proj.startsWith(src + "/") ||
            src.startsWith(proj + "/"))
        );
      })
    : [];
  if (bySource.length) return bySource;

  // Active path already under ~/.grok/worktrees/<slug>/…
  const wtSlugMatch = proj.match(/\/\.grok\/worktrees\/([^/]+)/i);
  if (wtSlugMatch?.[1]) {
    const slug = wtSlugMatch[1].toLowerCase();
    const byWtFolder = list.filter((w) => {
      const p = normalizeCliWtPath(w.path).toLowerCase();
      return (
        p.includes(`/worktrees/${slug}/`) || p.endsWith(`/worktrees/${slug}`)
      );
    });
    if (byWtFolder.length) return byWtFolder;
  }

  const slug =
    (projectName ?? "").trim() ||
    (proj ? proj.split("/").filter(Boolean).pop() || "" : "");
  if (slug) {
    const lower = slug.toLowerCase();
    const byRepo = list.filter(
      (w) => (w.repoName ?? "").toLowerCase() === lower,
    );
    if (byRepo.length) return byRepo;
    // Path contains /worktrees/<basename>/
    const byPath = list.filter((w) => {
      const p = normalizeCliWtPath(w.path).toLowerCase();
      return (
        p.includes(`/worktrees/${lower}/`) || p.endsWith(`/worktrees/${lower}`)
      );
    });
    if (byPath.length) return byPath;
  }
  return list;
}
