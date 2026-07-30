/**
 * Pure helpers for chat fork + optional restore-code (git worktree bind)
 * and CLI `--fork-session` (new agent session id on resume) semantics.
 *
 * Host `session_fork` clones the App journal; worktree + project bind run in UI.
 * When the user opts into CLI fork, Host sets `forkAgentSession` and on next
 * connect uses ACP `session/fork` (CLI `--fork-session` semantics) so the
 * child agent session gets a **new** id with the parent’s context, leaving
 * the source agent session unchanged.
 */

import { sanitizeWorktreeName } from "@/lib/gitWorktree";

/** Minimal git-status shape used for dirty / availability checks. */
export type ForkGitStatusSnapshot = {
  available?: boolean | null;
  files?: readonly unknown[] | null;
  reason?: string | null;
};

/**
 * CLI top-level flag: `grok --fork-session` (requires `--resume` / `--continue`
 * in the TUI). Host ACP path implements the same semantics via `session/fork`.
 */
export const FORK_SESSION_CLI_FLAG = "--fork-session";

/**
 * Top-level CLI args for fork-session: `["--fork-session"]` or `[]`.
 * Host spawn for `agent stdio` does **not** pass this alone (CLI requires
 * `--resume`/`--continue`); use for docs / parity tests. Runtime uses ACP.
 */
export function forkSessionSpawnArgs(enabled: boolean): string[] {
  return enabled ? [FORK_SESSION_CLI_FLAG] : [];
}

/**
 * Whether the UI should offer “fork CLI agent session” (new agent id).
 * Needs a non-empty source agent session id to fork from.
 */
export function canOfferForkAgentSession(
  agentSessionId: string | null | undefined,
): boolean {
  return (agentSessionId ?? "").trim().length > 0;
}

/**
 * Resolve whether connect should fork the agent session.
 * `wantFork` is the UI checkbox; `agentSessionId` is the source to fork.
 */
export function resolveForkAgentSession(input: {
  wantFork?: boolean | null;
  agentSessionId?: string | null;
}): { fork: boolean; sourceAgentId: string | null } {
  const source = (input.agentSessionId ?? "").trim();
  if (!source) return { fork: false, sourceAgentId: null };
  if (!input.wantFork) return { fork: false, sourceAgentId: source };
  return { fork: true, sourceAgentId: source };
}

/**
 * True when porcelain lists any changed / untracked paths.
 * Unavailable status is not dirty (caller handles missing git separately).
 */
export function isGitWorkingTreeDirty(
  status: ForkGitStatusSnapshot | null | undefined,
): boolean {
  if (!status?.available) return false;
  return (status.files?.length ?? 0) > 0;
}

export type ForkRestoreCodeGate =
  | { ok: true }
  | { ok: false; reason: "no_project" | "unavailable" | "dirty" };

/**
 * Gate for optional restore-code on fork.
 * - no_project: source chat has no bound folder
 * - unavailable: not a git work tree / git missing
 * - dirty: uncommitted changes — never force checkout / destroy work
 */
export function canRestoreCodeOnFork(
  projectPath: string | null | undefined,
  status: ForkGitStatusSnapshot | null | undefined,
): ForkRestoreCodeGate {
  const path = (projectPath ?? "").trim();
  if (!path) return { ok: false, reason: "no_project" };
  if (!status?.available) return { ok: false, reason: "unavailable" };
  if (isGitWorkingTreeDirty(status)) return { ok: false, reason: "dirty" };
  return { ok: true };
}

/**
 * Sanitize a short fragment from a session id for worktree branch names.
 * Keeps letters, digits, `.` `_` `-` only; empty → `"chat"`.
 */
export function sanitizeForkNameFragment(
  raw: string | null | undefined,
  maxLen = 8,
): string {
  const cleaned = (raw ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/^-+/, "");
  const slice = cleaned.slice(0, Math.max(1, maxLen));
  return slice || "chat";
}

/**
 * Unique-ish worktree / branch name for a fork restore:
 *   `fork-<sessionFrag>-<base36time>[-<attempt>]`
 *
 * Safe for `git worktree add -b` via {@link sanitizeWorktreeName}.
 */
export function buildForkWorktreeName(
  sourceSessionId: string | null | undefined,
  opts?: { attempt?: number; now?: number },
): string {
  const frag = sanitizeForkNameFragment(sourceSessionId, 8);
  const now = opts?.now ?? Date.now();
  const attempt = Math.max(0, opts?.attempt ?? 0);
  const time = Math.abs(now).toString(36);
  let candidate =
    attempt > 0 ? `fork-${frag}-${time}-${attempt}` : `fork-${frag}-${time}`;
  // hard cap before sanitize (64 max inside sanitizeWorktreeName)
  if (candidate.length > 64) {
    candidate = candidate.slice(0, 64).replace(/-+$/, "") || `fork-${time}`;
  }
  // Must not start with '-' after truncation edge cases
  if (candidate.startsWith("-")) {
    candidate = `fork${candidate}`;
  }
  return sanitizeWorktreeName(candidate);
}

