/**
 * Pure helpers for “Continue last agent for this project” (CLI `grok -c/--continue`).
 *
 * Host scans `{GROK_HOME}/sessions/{percent-encoded-cwd}/` and imports/opens the
 * newest agent session. These helpers stay I/O-free for unit tests and UI gates.
 */

/** Normalize a project / cwd path for equality (trim, unify slashes, drop trailing sep, lower). */
export function normalizeCwdPath(path: string | null | undefined): string {
  let s = String(path ?? "")
    .trim()
    .replace(/\\/g, "/");
  while (s.length > 1 && s.endsWith("/")) {
    s = s.slice(0, -1);
  }
  return s.toLowerCase();
}

/** True when two cwd strings refer to the same project folder. */
export function cwdPathsMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = normalizeCwdPath(a);
  const nb = normalizeCwdPath(b);
  return na.length > 0 && na === nb;
}

export type ContinueCwdSessionRow = {
  agentSessionId: string;
  cwd?: string | null;
  updatedAt?: string | null;
};

/**
 * Pick the newest session among rows whose `cwd` matches `projectPath`.
 * Compares `updatedAt` lexicographically (RFC3339-friendly). Soft-fails → null.
 */
export function pickLatestCliSessionForCwd<T extends ContinueCwdSessionRow>(
  rows: readonly T[],
  projectPath: string | null | undefined,
): T | null {
  const target = normalizeCwdPath(projectPath);
  if (!target) return null;
  let best: T | null = null;
  let bestUpdated = "";
  for (const row of rows) {
    if (!cwdPathsMatch(row.cwd, projectPath)) continue;
    const updated = (row.updatedAt ?? "").trim();
    if (!best || updated > bestUpdated) {
      best = row;
      bestUpdated = updated;
    }
  }
  return best;
}

/**
 * Whether the project menu / palette should offer “Continue last agent…”.
 * Needs a non-empty bound project path.
 */
export function canOfferContinueCwd(
  projectPath: string | null | undefined,
): boolean {
  return normalizeCwdPath(projectPath).length > 0;
}
