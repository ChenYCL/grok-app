/**
 * Pure helpers for `grok plugin validate` output / targets.
 * Host runs the CLI; UI parses and displays messages in-panel.
 */

export type PluginValidateReason = "cli_too_old" | "cli_missing" | string;

/** Envelope from host `plugin_validate` (and pure parse helpers). */
export interface PluginValidateResult {
  ok: boolean;
  messages: string[];
  /** Resolved path that was validated (when known). */
  path?: string | null;
  /** Soft-fail machine reason (e.g. `cli_too_old` when CLI lacks the subcommand). */
  reason?: PluginValidateReason | null;
}

/**
 * Split stdout + stderr into non-empty message lines (stderr first).
 * Pure — used by tests and optional client-side re-parse.
 */
export function parsePluginValidateMessages(
  stdout: string | null | undefined,
  stderr: string | null | undefined,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of [stderr ?? "", stdout ?? ""]) {
    for (const line of part.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Build a validate result from raw CLI streams + exit status.
 * Exit code is authoritative for `ok` (informational "no plugin.json" is still ok).
 */
export function parsePluginValidateOutput(
  stdout: string | null | undefined,
  stderr: string | null | undefined,
  exitOk: boolean,
): Pick<PluginValidateResult, "ok" | "messages"> {
  const messages = parsePluginValidateMessages(stdout, stderr);
  return { ok: exitOk, messages };
}

/**
 * Heuristic: old CLI rejects `plugin validate` as an unknown subcommand.
 * Matches clap-style errors from older grok builds.
 */
export function looksLikeUnsupportedPluginValidate(
  stderr: string | null | undefined,
  stdout: string | null | undefined = "",
): boolean {
  const s = `${stderr ?? ""}\n${stdout ?? ""}`.toLowerCase();
  if (!s.trim()) return false;
  if (
    s.includes("unrecognized subcommand") ||
    s.includes("unknown subcommand") ||
    s.includes("unexpected subcommand") ||
    s.includes("invalid subcommand")
  ) {
    return true;
  }
  // `error: unexpected argument 'validate'` / similar
  if (
    s.includes("validate") &&
    (s.includes("unexpected argument") ||
      s.includes("unrecognized") ||
      s.includes("unknown command") ||
      s.includes("unknown argument"))
  ) {
    return true;
  }
  return false;
}

export function isPluginValidateCliTooOld(
  result: Pick<PluginValidateResult, "reason" | "messages"> | null | undefined,
): boolean {
  if (!result) return false;
  if (result.reason === "cli_too_old") return true;
  const joined = (result.messages ?? []).join("\n").toLowerCase();
  return (
    joined.includes("does not support") && joined.includes("plugin validate")
  );
}

/** Join messages for compact display (panel body / title attribute). */
export function formatPluginValidateMessages(
  messages: string[] | null | undefined,
  fallback = "",
): string {
  const lines = (messages ?? []).map((m) => m.trim()).filter(Boolean);
  if (lines.length === 0) return fallback;
  return lines.join("\n");
}

/**
 * True when install source looks like a local filesystem path
 * (Validate pre-install only makes sense for paths, not git / owner/repo).
 */
export function isLocalPluginPath(raw: string | null | undefined): boolean {
  const s = (raw ?? "").trim();
  if (!s) return false;
  if (s.startsWith("git@") || s.includes("://")) return false;
  // Absolute / home / relative / Windows drive
  if (
    s.startsWith("/") ||
    s.startsWith("~") ||
    s.startsWith("./") ||
    s.startsWith("../") ||
    s.startsWith(".\\") ||
    s.startsWith("..\\")
  ) {
    return true;
  }
  if (s.length >= 3) {
    const c0 = s.charCodeAt(0);
    const isLetter =
      (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122);
    if (isLetter && s[1] === ":" && (s[2] === "\\" || s[2] === "/")) {
      return true;
    }
  }
  // Bare name or owner/repo → not a local path for pre-install validate
  return false;
}

/**
 * Prefer installed plugin path for validate; fall back to name.
 * Host also resolves bare names to install paths when possible.
 */
export function pluginValidateTarget(plugin: {
  path?: string | null;
  name: string;
}): string {
  const path = (plugin.path ?? "").trim();
  if (path) return path;
  return plugin.name.trim();
}
