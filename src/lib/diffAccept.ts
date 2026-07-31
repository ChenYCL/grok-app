/**
 * Diff accept / reject / restore helpers for the Changes panel.
 * Pure functions: parse unified diffs, apply or reverse hunks, and
 * decide when reject needs untracked wipe confirmation or git checkout.
 */

/** One unified-diff hunk (@@ … @@ body). */
export interface UnifiedHunk {
  /** 1-based old-file start line (0 for pure additions). */
  oldStart: number;
  oldCount: number;
  /** 1-based new-file start line (0 for pure deletions). */
  newStart: number;
  newCount: number;
  /** Body lines including leading ' ', '+', or '-'. */
  lines: string[];
  /** Original header without leading @@ markers trimmed. */
  header: string;
}

export interface ParsedUnifiedDiff {
  /** Best-effort path from --- / +++ headers. */
  filePath: string | null;
  hunks: UnifiedHunk[];
}

export type PatchApplyOk = { ok: true; content: string };
export type PatchApplyErr = { ok: false; error: string };
export type PatchApplyResult = PatchApplyOk | PatchApplyErr;

/** Workspace / session change kinds that matter for reject safety. */
export type DiffAcceptFileKind =
  | "modified"
  | "added"
  | "deleted"
  | "untracked"
  | "renamed"
  | "copied"
  | "typechange"
  | "conflict"
  | "ignored"
  | "unknown";

/** True when rejecting would delete an untracked (or pure-added) file. */
export function needsUntrackedWipeConfirm(
  kind: string | null | undefined,
): boolean {
  const k = (kind || "").toLowerCase().trim();
  return k === "untracked" || k === "added";
}

/**
 * Prefer `git checkout` / restore for reject when the project is a git repo
 * and the file is not an untracked wipe that still needs explicit confirm.
 * Callers still pass `confirmUntracked` into the host for untracked paths.
 */
export function preferGitCheckoutReject(
  hasGitRepo: boolean,
  kind?: string | null,
): boolean {
  if (!hasGitRepo) return false;
  const k = (kind || "").toLowerCase().trim();
  // Conflicts: soft-fail at host; still allow attempt
  if (k === "ignored") return false;
  return true;
}

/** Whether we have enough content to restore agent "after" state. */
export function canRestoreAfter(
  after: string | null | undefined,
): after is string {
  return typeof after === "string";
}

/** Whether we can write a full-file accept (keep after content). */
export function canAcceptWithContent(
  after: string | null | undefined,
): after is string {
  return typeof after === "string";
}

/** Whether we can reject by rewriting before content (no git). */
export function canRejectWithBefore(
  before: string | null | undefined,
): before is string {
  return typeof before === "string";
}

/**
 * Normalize line endings and split into lines without a trailing empty
 * element from a final newline (same semantics as sessionChanges).
 */
export function splitPatchLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function joinPatchLines(lines: string[]): string {
  if (lines.length === 0) return "";
  return lines.join("\n") + "\n";
}

const HUNK_HEADER_RE =
  /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s@@/;

/**
 * Parse a unified diff into hunks. Ignores file headers and binary markers.
 * Returns empty hunks when nothing parseable is found (caller soft-fails).
 */
export function parseUnifiedDiff(diff: string): ParsedUnifiedDiff {
  const raw = (diff || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = raw.split("\n");
  let filePath: string | null = null;
  const hunks: UnifiedHunk[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const rest = line.slice(4).trim();
      // Prefer +++ b/path
      if (line.startsWith("+++ ") && rest && rest !== "/dev/null") {
        filePath = rest.replace(/^[ab]\//, "");
      } else if (
        !filePath &&
        line.startsWith("--- ") &&
        rest &&
        rest !== "/dev/null"
      ) {
        filePath = rest.replace(/^[ab]\//, "");
      }
      i++;
      continue;
    }

    const m = line.match(HUNK_HEADER_RE);
    if (!m) {
      i++;
      continue;
    }

    const oldStart = Number(m[1]);
    const oldCount = m[2] != null ? Number(m[2]) : 1;
    const newStart = Number(m[3]);
    const newCount = m[4] != null ? Number(m[4]) : 1;
    const header = line;
    i++;
    const body: string[] = [];
    while (i < lines.length) {
      const b = lines[i] ?? "";
      if (b.startsWith("@@")) break;
      if (b.startsWith("diff ") || b.startsWith("--- ") || b.startsWith("+++ ")) {
        break;
      }
      // Body: ' ', '+', '-', or '\' (No newline at end of file).
      // Do not treat bare empty strings (EOF split residue) as context — that
      // injects a phantom equal line and breaks apply.
      if (
        b.startsWith(" ") ||
        b.startsWith("+") ||
        b.startsWith("-") ||
        b.startsWith("\\")
      ) {
        body.push(b);
        i++;
        continue;
      }
      break;
    }
    hunks.push({
      oldStart,
      oldCount,
      newStart,
      newCount,
      lines: body,
      header,
    });
  }

  return { filePath, hunks };
}

function hunkOldLines(hunk: UnifiedHunk): string[] {
  const out: string[] = [];
  for (const l of hunk.lines) {
    if (l.startsWith("\\")) continue;
    if (l.startsWith("-") || l.startsWith(" ")) {
      out.push(l.slice(1));
    }
  }
  return out;
}

function hunkNewLines(hunk: UnifiedHunk): string[] {
  const out: string[] = [];
  for (const l of hunk.lines) {
    if (l.startsWith("\\")) continue;
    if (l.startsWith("+") || l.startsWith(" ")) {
      out.push(l.slice(1));
    }
  }
  return out;
}

/**
 * Apply ordered hunks to the original text (forward patch).
 * Hunks must match the original at their oldStart positions.
 */
export function applyHunks(
  original: string,
  hunks: readonly UnifiedHunk[],
): PatchApplyResult {
  if (!hunks.length) {
    return { ok: true, content: original };
  }
  const src = splitPatchLines(original);
  // Work on a mutable list; apply from bottom so line numbers stay valid
  const ordered = hunks.slice().sort((a, b) => b.oldStart - a.oldStart);
  let lines = src.slice();

  for (const hunk of ordered) {
    const oldLines = hunkOldLines(hunk);
    const newLines = hunkNewLines(hunk);

    if (hunk.oldCount === 0 || oldLines.length === 0) {
      // Pure insertion. oldStart 0 or 1 both mean "at beginning" for empty files;
      // otherwise insert before 1-based line oldStart+1 (i.e. index oldStart).
      const insertAt =
        lines.length === 0
          ? 0
          : Math.min(lines.length, Math.max(0, hunk.oldStart));
      lines = [
        ...lines.slice(0, insertAt),
        ...newLines,
        ...lines.slice(insertAt),
      ];
      continue;
    }

    // oldStart is 1-based
    const start = Math.max(0, hunk.oldStart - 1);

    if (start + oldLines.length > lines.length) {
      return {
        ok: false,
        error: `hunk apply failed: old range past EOF (${hunk.header})`,
      };
    }
    for (let i = 0; i < oldLines.length; i++) {
      if (lines[start + i] !== oldLines[i]) {
        return {
          ok: false,
          error: `hunk apply failed: context mismatch at line ${start + i + 1}`,
        };
      }
    }
    lines = [
      ...lines.slice(0, start),
      ...newLines,
      ...lines.slice(start + oldLines.length),
    ];
  }

  // Preserve "no trailing newline" only when original had none and result empty?
  // Always end text files with newline when non-empty (same as joinPatchLines).
  return { ok: true, content: joinPatchLines(lines) };
}

/**
 * Reverse-apply hunks (undo a forward patch on content that already has it).
 * Useful for rejecting selected hunks without git.
 */
export function reverseHunks(
  current: string,
  hunks: readonly UnifiedHunk[],
): PatchApplyResult {
  // Reverse of a hunk: swap +/- and use newStart as the match position
  const reversed: UnifiedHunk[] = hunks.map((h) => {
    const lines = h.lines.map((l) => {
      if (l.startsWith("+")) return "-" + l.slice(1);
      if (l.startsWith("-")) return "+" + l.slice(1);
      return l;
    });
    return {
      oldStart: h.newStart,
      oldCount: h.newCount,
      newStart: h.oldStart,
      newCount: h.oldCount,
      lines,
      header: h.header + " (reverse)",
    };
  });
  return applyHunks(current, reversed);
}

/** Apply full unified patch text to original file content. */
export function applyUnifiedPatch(
  original: string,
  patch: string,
): PatchApplyResult {
  const parsed = parseUnifiedDiff(patch);
  if (parsed.hunks.length === 0) {
    // Empty / unparseable patch: treat as no-op only when patch is blank
    if (!(patch || "").trim()) {
      return { ok: true, content: original };
    }
    return { ok: false, error: "no hunks in unified patch" };
  }
  return applyHunks(original, parsed.hunks);
}

/**
 * Accept only selected hunks (by index into `hunks`). Other hunks stay
 * unapplied — result is original with selected forward hunks applied.
 */
export function applySelectedHunks(
  original: string,
  hunks: readonly UnifiedHunk[],
  selectedIndices: readonly number[],
): PatchApplyResult {
  const set = new Set(selectedIndices);
  const picked = hunks.filter((_, i) => set.has(i));
  if (picked.length === 0) {
    return { ok: true, content: original };
  }
  return applyHunks(original, picked);
}

/**
 * Reject selected hunks from content that already includes the full patch.
 * Keeps unselected hunks applied.
 */
export function rejectSelectedHunks(
  currentWithAll: string,
  hunks: readonly UnifiedHunk[],
  rejectIndices: readonly number[],
): PatchApplyResult {
  const set = new Set(rejectIndices);
  const picked = hunks.filter((_, i) => set.has(i));
  if (picked.length === 0) {
    return { ok: true, content: currentWithAll };
  }
  return reverseHunks(currentWithAll, picked);
}

/**
 * Decide the host action for a full-file reject.
 * - git: use git_checkout_file (confirmUntracked when wipe needed)
 * - write_before: rewrite before snapshot via apply_file_patch
 * - delete: remove untracked without git (still needs confirm)
 * - unavailable: soft-fail
 */
export type RejectPlan =
  | { mode: "git"; confirmUntracked: boolean }
  | { mode: "write_before"; content: string }
  | { mode: "delete"; confirmUntracked: true }
  | { mode: "unavailable"; reason: string };

export function planFileReject(opts: {
  hasGitRepo: boolean;
  kind?: string | null;
  before?: string | null;
  /** File exists on disk (false → nothing to wipe). */
  fileExists?: boolean;
}): RejectPlan {
  const kind = (opts.kind || "").toLowerCase().trim();
  const untrackedWipe = needsUntrackedWipeConfirm(kind);

  if (opts.hasGitRepo) {
    return {
      mode: "git",
      confirmUntracked: untrackedWipe,
    };
  }

  if (untrackedWipe) {
    if (opts.fileExists === false) {
      return { mode: "unavailable", reason: "file already absent" };
    }
    return { mode: "delete", confirmUntracked: true };
  }

  if (canRejectWithBefore(opts.before)) {
    return { mode: "write_before", content: opts.before };
  }

  return {
    mode: "unavailable",
    reason: "no git repo and no before snapshot",
  };
}

/**
 * Decide the host action for a full-file accept / restore.
 * Accept and restore both write the "after" content when available.
 */
export type AcceptPlan =
  | { mode: "write_after"; content: string }
  | { mode: "keep_current" }
  | { mode: "unavailable"; reason: string };

export function planFileAccept(opts: {
  after?: string | null;
  /** When true, disk already matches intent — no write needed. */
  alreadyApplied?: boolean;
}): AcceptPlan {
  if (opts.alreadyApplied) {
    return { mode: "keep_current" };
  }
  if (canAcceptWithContent(opts.after)) {
    return { mode: "write_after", content: opts.after };
  }
  // No snapshot: accepting means keep working tree as-is
  return { mode: "keep_current" };
}

export function planFileRestore(opts: {
  after?: string | null;
}): AcceptPlan {
  if (canRestoreAfter(opts.after)) {
    return { mode: "write_after", content: opts.after };
  }
  return { mode: "unavailable", reason: "no after snapshot to restore" };
}
