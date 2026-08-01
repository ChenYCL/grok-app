/**
 * Lightweight tool display registry — shared by turn activity + tasks panel.
 * Summaries only; live mid-stream still prefers Host title via toolStepDisplayTitle.
 */

export type ToolDisplayKind =
  | "bash"
  | "read"
  | "edit"
  | "search"
  | "browse"
  | "subagent"
  | "fallback";

export interface ToolDisplayInfo {
  kind: ToolDisplayKind;
  /** Short i18n-neutral label (English token; UI may map). */
  shortLabel: string;
  /** One-line summary for lists. */
  summary: string;
  /** True when this kind is "gathering context" (read/list/search/browse). */
  isContext: boolean;
}

function lower(s: string | null | undefined): string {
  return (s || "").toLowerCase().trim().replace(/-/g, "_");
}

function basename(path: string): string {
  const p = path.replace(/\\/g, "/");
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

function clip(s: string, max = 56): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Recover kind when Host journal left kind empty (common for completed tools).
 * Grok CLI call ids often encode the tool: `ws_…` web search, `…web_fetch…`, etc.
 */
export function inferKindFromToolCallId(
  toolCallId: string | null | undefined,
): string | null {
  const s = (toolCallId || "").toLowerCase();
  if (!s) return null;
  if (
    s.startsWith("ws_") ||
    s.includes("_ws_") ||
    /web_search|websearch|web_keyword|web_semantic|x_search|x_keyword/.test(s)
  ) {
    return "web_search";
  }
  if (
    /web_fetch|webfetch|open_page|browse_page|web_browse|open_url|fetch_url/.test(
      s,
    )
  ) {
    return "web_fetch";
  }
  if (/run_terminal|bash|shell/.test(s)) return "run_terminal_command";
  if (/read_file|read_/.test(s)) return "read_file";
  if (/search_replace|str_replace|write|edit/.test(s)) return "search_replace";
  if (/spawn_subagent|subagent/.test(s)) return "spawn_subagent";
  return null;
}

/** Web page open / fetch — Grok shows "Browsed host/path" with a globe. */
export function isBrowseToolKind(
  kind: string | null | undefined,
  title?: string | null,
  toolCallId?: string | null,
): boolean {
  const inferred = inferKindFromToolCallId(toolCallId);
  const k = lower(kind || inferred);
  const t = lower(title);
  const blob = `${k} ${t}`;
  // ACP uses kind "fetch" / title "Fetch: https://…" / "web_fetch"
  return /web_fetch|webfetch|open_page|browse_page|browse|web_open|open_url|fetch_url|web_browse|\bfetch\b|^fetch:/.test(
    blob,
  );
}

/** Pure search tools (not browse) — Grok collapses consecutive into "Ran N searches". */
export function isSearchToolKind(
  kind: string | null | undefined,
  title?: string | null,
  toolCallId?: string | null,
): boolean {
  if (isBrowseToolKind(kind, title, toolCallId)) return false;
  // Host official-aux X pre-search is a single chip, not "Ran N searches".
  const id = (toolCallId || "").toLowerCase();
  if (id.startsWith("host-x") || id.startsWith("host-vision")) return false;
  const t = (title || "").toLowerCase();
  if (/搜索\s*x\s*信息|识别图片内容/.test(t)) return false;
  return classifyToolKind(kind, title, toolCallId) === "search";
}

/** Classify a raw tool kind / title into a display bucket. */
export function classifyToolKind(
  kind: string | null | undefined,
  title?: string | null,
  toolCallId?: string | null,
): ToolDisplayKind {
  const inferred = inferKindFromToolCallId(toolCallId);
  const k = lower(kind || inferred);
  const t = lower(title);
  const blob = `${k} ${t} ${lower(toolCallId)}`;
  if (
    /bash|shell|terminal|execute|run_terminal|command/.test(blob) ||
    k === "run" ||
    k === "execute"
  ) {
    return "bash";
  }
  if (/subagent|spawn_agent|spawn_subagent|\bagent\b/.test(blob)) {
    return "subagent";
  }
  if (
    /search_replace|str_replace|write|edit|apply_patch|create_file|multi_edit|notebook_edit/.test(
      blob,
    ) ||
    (k.includes("edit") && !k.includes("read"))
  ) {
    return "edit";
  }
  // Browse before generic search (web_fetch must not become "search").
  if (isBrowseToolKind(kind || inferred, title, toolCallId)) {
    return "browse";
  }
  // Host vision side-channel — never collapse into "Ran 1 search".
  if (
    k === "vision" ||
    /host[-_]?vision|识图|识别图片|recogniz(e|ing)\s*image|image\s*descri/i.test(
      blob,
    )
  ) {
    return "read";
  }
  // Host often persists titles like "Web search:" / "X search:" with empty kind.
  // Call ids `ws_…` also mark web search when kind/title were lost on journal.
  // Exclude host-vision ids even if title mentions "search".
  if (/host[-_]?vision/.test(lower(toolCallId))) {
    return "read";
  }
  if (
    /grep|glob|search|find_files|web_search|web_keyword|web_semantic|x_search|x_keyword|x_semantic|\bweb search\b|\bx search\b|^ws_/.test(
      blob,
    )
  ) {
    return "search";
  }
  if (/^read\b|read_file|list_dir|list_directory|ls\b|glob/.test(blob)) {
    return "read";
  }
  if (k.includes("read") || k.includes("list")) return "read";
  return "fallback";
}

export function isContextToolKind(
  kind: string | null | undefined,
  title?: string | null,
  toolCallId?: string | null,
): boolean {
  const c = classifyToolKind(kind, title, toolCallId);
  return c === "read" || c === "search" || c === "browse";
}

export function toolShortLabel(kind: ToolDisplayKind): string {
  switch (kind) {
    case "bash":
      return "Shell";
    case "read":
      return "Read";
    case "edit":
      return "Edit";
    case "search":
      return "Search";
    case "browse":
      return "Browse";
    case "subagent":
      return "Agent";
    default:
      return "Tool";
  }
}

/**
 * Human summary for a tool row.
 * Prefer path basename / detail snippet over bare kind.
 */
export function summarizeToolDisplay(input: {
  kind?: string | null;
  title?: string | null;
  detail?: string | null;
  path?: string | null;
  toolCallId?: string | null;
}): ToolDisplayInfo {
  const kind =
    input.kind || inferKindFromToolCallId(input.toolCallId) || input.kind;
  const bucket = classifyToolKind(kind, input.title, input.toolCallId);
  const path = (input.path || "").trim();
  const detail = (input.detail || "").trim();
  const title = (input.title || "").trim();
  let summary = "";
  // Strip trailing colon noise from Host titles ("Web search:", "X search:").
  const cleanTitle = title.replace(/:+\s*$/, "").trim();
  // Prefer detail first-line when title is empty/generic ("tool").
  const detailFirst = detail
    ? (detail.split("\n")[0] || detail).trim()
    : "";
  // Host side-channel: always prefer stable title over stream body / status.
  const hostSide = /host[-_]?(vision|x)/i.test(lower(input.toolCallId));
  const statusyDetail =
    /^(done|ok|failed|unavailable|识别完成|识别失败|搜索完成|搜索失败|\d+\s*image)/i.test(
      detailFirst,
    );
  if (bucket === "bash" && detailFirst) {
    summary = clip(detailFirst);
  } else if (hostSide && cleanTitle && !/^tool$/i.test(cleanTitle)) {
    summary = clip(cleanTitle);
  } else if (path && !/^tool$/i.test(cleanTitle || "tool")) {
    summary = basename(path);
  } else if (path && /^tool$/i.test(cleanTitle || "tool")) {
    summary = basename(path);
  } else if (cleanTitle && !/^tool$/i.test(cleanTitle) && hostSide) {
    summary = clip(cleanTitle);
  } else if (
    detailFirst &&
    !/^tool$/i.test(detailFirst) &&
    !(cleanTitle && statusyDetail) &&
    !hostSide
  ) {
    summary = clip(detailFirst);
  } else if (cleanTitle && !/^tool$/i.test(cleanTitle)) {
    summary = clip(cleanTitle);
  } else if (path) {
    summary = basename(path);
  } else if (input.kind && !/^tool$/i.test(input.kind)) {
    summary = clip(input.kind.replace(/[_./]+/g, " "));
  } else if (bucket === "browse") {
    summary = "Browse";
  } else if (bucket === "search") {
    summary = "Search";
  } else {
    summary = toolShortLabel(bucket);
  }
  return {
    kind: bucket,
    shortLabel: toolShortLabel(bucket),
    summary,
    isContext:
      bucket === "read" || bucket === "search" || bucket === "browse",
  };
}

/** Last N non-empty lines of tool detail (expanded activity). */
export function toolDetailTail(
  detail: string | null | undefined,
  maxLines = 8,
): string {
  if (!detail?.trim()) return "";
  const lines = detail.replace(/\r\n/g, "\n").split("\n");
  const kept = lines.filter((l, i) => l.trim() || i === lines.length - 1);
  if (kept.length <= maxLines) return kept.join("\n");
  return kept.slice(-maxLines).join("\n");
}
