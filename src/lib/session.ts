export type SessionState =
  | "idle"
  | "connecting"
  | "ready"
  | "streaming"
  | "awaiting_permission"
  | "disconnected";

export type AgentErrorCode =
  | "CLI_NOT_FOUND"
  | "AUTH_FAILED"
  | "NETWORK_PROVIDER"
  | "AGENT_CRASHED";

export interface AgentError {
  code: AgentErrorCode;
  message: string;
}

export interface SessionSnapshot {
  sessionId: string | null;
  agentSessionId?: string | null;
  state: SessionState;
  lastError: AgentError | null;
  streamingMessageId: string | null;
  backend: string;
  modelId?: string | null;
  projectPath?: string | null;
  title?: string;
}

export interface MessageAttachment {
  path: string;
  name: string;
  isDir: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  thought?: string;
  streaming?: boolean;
  toolStatus?: string;
  /** Turn failed (retries exhausted / provider error) — show as chat error record. */
  isError?: boolean;
  /** Local file/folder refs shown as cards (also embedded as @path for agent). */
  attachments?: MessageAttachment[];
  /** ISO timestamp when the message was created (for hover footer). */
  createdAt?: string;
  /** System markers: context_compact, tool_step, turn_cancelled, etc. */
  marker?: "context_compact" | "tool_step" | "turn_cancelled" | string;
  /** Compact event details (UI). */
  compactMeta?: ContextCompactMeta;
  /** Live / persisted tool activity. */
  toolCallId?: string;
  toolKind?: string;
  toolDetail?: string;
  toolPath?: string;
}

export interface ToolEventPayload {
  sessionId?: string;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  path?: string | null;
  detail?: string | null;
}

export interface TurnMarkerPayload {
  sessionId?: string;
  messageId?: string;
  marker?: string;
  reason?: string;
  content?: string;
}

export interface ContextCompactMeta {
  trigger: "auto" | "manual" | string;
  tokensBefore?: number;
  tokensAfter?: number;
  summaryPreview?: string;
  note?: string;
}

export interface ContextCompactPayload {
  sessionId?: string;
  messageId?: string;
  trigger?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  summaryPreview?: string;
  note?: string;
  content?: string;
}

/** Append a context-compact marker row (dedupe by messageId). */
export function applyContextCompact(
  messages: ChatMessage[],
  payload: ContextCompactPayload,
): ChatMessage[] {
  const id = payload.messageId || `compact-${Date.now()}`;
  if (messages.some((m) => m.id === id)) return messages;
  const trigger = (payload.trigger || "auto").toLowerCase();
  const meta: ContextCompactMeta = {
    trigger: trigger === "manual" ? "manual" : trigger === "auto" ? "auto" : trigger,
    tokensBefore: payload.tokensBefore,
    tokensAfter: payload.tokensAfter,
    summaryPreview: payload.summaryPreview,
    note: payload.note,
  };
  return [
    ...messages,
    {
      id,
      role: "tool",
      content: payload.content || "context_compact",
      marker: "context_compact",
      compactMeta: meta,
      createdAt: new Date().toISOString(),
    },
  ];
}

/** Upsert a tool activity row by toolCallId (Codex-style live activity). */
export function applyToolEvent(
  messages: ChatMessage[],
  payload: ToolEventPayload,
): ChatMessage[] {
  const tcid = (payload.toolCallId || "").trim();
  if (!tcid) return messages;
  const status = (payload.status || "in_progress").toLowerCase();
  const running =
    status === "in_progress" ||
    status === "pending" ||
    status === "running" ||
    status === "";
  const title = (payload.title || payload.kind || "tool").trim();
  const id = `tool-${tcid}`;
  const now = new Date().toISOString();
  const nextRow: ChatMessage = {
    id,
    role: "tool",
    content: title,
    toolCallId: tcid,
    toolKind: payload.kind || undefined,
    toolStatus: status || "in_progress",
    toolDetail: payload.detail?.trim() || undefined,
    toolPath: payload.path?.trim() || undefined,
    streaming: running,
    marker: "tool_step",
    createdAt: now,
    isError: status === "failed" || status === "error",
  };
  const idx = messages.findIndex(
    (m) => m.id === id || m.toolCallId === tcid,
  );
  if (idx < 0) return [...messages, nextRow];
  const prev = messages[idx]!;
  const copy = messages.slice();
  copy[idx] = {
    ...prev,
    ...nextRow,
    createdAt: prev.createdAt || now,
    // Keep earliest start; refresh fields from latest event
    content: title || prev.content,
    toolDetail: nextRow.toolDetail || prev.toolDetail,
    toolPath: nextRow.toolPath || prev.toolPath,
    toolKind: nextRow.toolKind || prev.toolKind,
  };
  return copy;
}

export function applyTurnMarker(
  messages: ChatMessage[],
  payload: TurnMarkerPayload,
): ChatMessage[] {
  const id = payload.messageId || `marker-${Date.now()}`;
  if (messages.some((m) => m.id === id)) return messages;
  const marker = payload.marker || "turn_cancelled";
  return [
    ...messages.map((m) =>
      m.streaming ? { ...m, streaming: false } : m,
    ),
    {
      id,
      role: "tool",
      content: payload.content || marker,
      marker,
      toolStatus: payload.reason || "cancelled",
      createdAt: new Date().toISOString(),
      isError: marker === "turn_cancelled",
    },
  ];
}

/** True for journal / live tool_step activity rows. */
export function isToolStepMessage(m: ChatMessage): boolean {
  return (
    m.marker === "tool_step" ||
    (m.role === "tool" && !!m.content?.startsWith("tool_step|"))
  );
}

/**
 * Latest tool in the current turn (after last user message).
 * Prefer a still-running tool; else the most recent tool row.
 */
export function pickLatestTurnTool(
  messages: ChatMessage[],
): ChatMessage | null {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      lastUser = i;
      break;
    }
  }
  const from = lastUser + 1;
  let latest: ChatMessage | null = null;
  let latestRunning: ChatMessage | null = null;
  for (let i = from; i < messages.length; i++) {
    const m = messages[i]!;
    if (!isToolStepMessage(m)) continue;
    latest = m;
    if (m.streaming) latestRunning = m;
  }
  return latestRunning || latest;
}

/** Parse persisted tool_step journal lines. */
export function parseToolStepContent(content: string): {
  status: string;
  kind: string;
  title: string;
  detail?: string;
  path?: string;
} | null {
  if (!content.startsWith("tool_step|")) return null;
  const [header, ...rest] = content.split("\n");
  const parts = (header || "").split("|");
  // tool_step|status|kind|title
  const status = parts[1] || "completed";
  const kind = parts[2] || "";
  const title = parts.slice(3).join("|") || kind || "tool";
  const detailLine = rest[0]?.trim();
  const pathLine = rest[1]?.trim();
  return {
    status,
    kind,
    title,
    detail: detailLine || undefined,
    path: pathLine || undefined,
  };
}

/** Parse journal content written by Host for compact markers. */
export function parseCompactContent(
  content: string,
): ContextCompactMeta | null {
  if (!content.startsWith("context_compact|") && !content.startsWith("context_compact")) {
    return null;
  }
  const [header, ...rest] = content.split("\n");
  const parts = (header || "").split("|").slice(1);
  const meta: ContextCompactMeta = { trigger: "auto" };
  for (const p of parts) {
    if (p === "auto" || p === "manual") meta.trigger = p;
    else if (p.startsWith("tokens:")) {
      const m = /^tokens:(\d+)->(\d+)$/.exec(p);
      if (m) {
        meta.tokensBefore = Number(m[1]);
        meta.tokensAfter = Number(m[2]);
      }
    } else if (p.startsWith("tokens_before:")) {
      meta.tokensBefore = Number(p.slice("tokens_before:".length)) || undefined;
    } else if (p.startsWith("tokens_after:")) {
      meta.tokensAfter = Number(p.slice("tokens_after:".length)) || undefined;
    } else if (p.startsWith("note:")) {
      meta.note = p.slice(5);
    }
  }
  const summary = rest.join("\n").trim();
  if (summary) meta.summaryPreview = summary;
  return meta;
}

export interface TurnErrorPayload {
  sessionId?: string;
  messageId?: string;
  code?: string;
  message?: string;
  content?: string;
}

/**
 * Convert in-flight thinking bubble into a persistent error row in the thread.
 * If no streaming assistant exists, append a new error message.
 *
 * Stores a friendly, locale-aware body (not raw RPC/MCP dumps).
 */
export function applyTurnError(
  messages: ChatMessage[],
  payload: TurnErrorPayload,
  locale: "zh" | "en" = "zh",
): ChatMessage[] {
  const content = formatTurnErrorBody(payload, locale);
  const mid = payload.messageId || "";

  let idx = mid ? messages.findIndex((m) => m.id === mid) : -1;
  if (idx < 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role === "assistant" && m.streaming) {
        idx = i;
        break;
      }
    }
  }
  if (idx < 0) {
    // Last empty assistant (host may have already cleared streaming)
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role === "assistant" && !m.content.trim() && !m.isError) {
        idx = i;
        break;
      }
    }
  }

  if (idx >= 0) {
    const next = messages.slice();
    const prev = next[idx]!;
    next[idx] = {
      ...prev,
      id: mid || prev.id,
      content,
      thought: undefined,
      streaming: false,
      isError: true,
    };
    // Clear any other lingering streaming flags
    return next.map((m, i) =>
      i !== idx && m.streaming ? { ...m, streaming: false } : m,
    );
  }

  return [
    ...messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
    {
      id: mid || `err-${Date.now()}`,
      role: "assistant",
      content,
      streaming: false,
      isError: true,
    },
  ];
}

export interface StreamPayload {
  sessionId: string;
  messageId: string;
  text: string;
  done: boolean;
  kind?: "assistant" | "thought";
}

export interface PermissionPayload {
  rpcId: number;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  title: string;
  preview: string;
  scopeKey: string;
  options: unknown;
}

export const IDLE_SNAPSHOT: SessionSnapshot = {
  sessionId: null,
  agentSessionId: null,
  state: "idle",
  lastError: null,
  streamingMessageId: null,
  backend: "grok_agent_stdio",
  modelId: null,
  projectPath: null,
  title: "",
};

export function statusPresentation(state: SessionState): {
  label: string;
  dot: "success" | "warning" | "danger" | "info" | "idle";
} {
  switch (state) {
    case "idle":
      return { label: "Idle", dot: "idle" };
    case "connecting":
      return { label: "Connecting…", dot: "warning" };
    case "ready":
      return { label: "Ready", dot: "success" };
    case "streaming":
      return { label: "working…", dot: "info" };
    case "awaiting_permission":
      return { label: "Awaiting permission", dot: "warning" };
    case "disconnected":
      return { label: "Disconnected", dot: "danger" };
  }
}

/** Allow drafting anytime except mid-stream / mid-permission. */
export function canType(state: SessionState): boolean {
  return state !== "streaming" && state !== "awaiting_permission";
}

/**
 * UI may enable Send before Host is ready; App ensures silent connect on submit.
 */
export function canSend(state: SessionState): boolean {
  return state !== "streaming" && state !== "awaiting_permission";
}

export function canStop(state: SessionState): boolean {
  return state === "streaming" || state === "awaiting_permission";
}

/** Host / UI “in progress” — sidebar spinner and cache preference. */
export function isSessionBusy(state: SessionState): boolean {
  return (
    state === "connecting" ||
    state === "streaming" ||
    state === "awaiting_permission"
  );
}

/**
 * Drop the last user message and everything after it (assistant reply, errors, tools).
 * Used by edit-resend so the prior turn is fully replaced, not stacked.
 */
export function truncateBeforeLastUser(messages: ChatMessage[]): ChatMessage[] {
  let cut = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      cut = i;
      break;
    }
  }
  return messages.slice(0, cut);
}

/**
 * When reopening a session, prefer the in-memory cache over disk if the cache
 * is ahead (optimistic user bubble, partial stream, longer history).
 */
export function preferSessionMessages(
  cached: ChatMessage[] | undefined,
  stored: ChatMessage[],
): ChatMessage[] {
  if (!cached?.length) return stored;
  if (!stored.length) return cached;
  if (cached.some((m) => m.streaming)) return cached;
  if (cached.length > stored.length) return cached;
  const cacheChars = cached.reduce(
    (n, m) => n + m.content.length + (m.thought?.length ?? 0),
    0,
  );
  const storeChars = stored.reduce(
    (n, m) => n + m.content.length + (m.thought?.length ?? 0),
    0,
  );
  if (cacheChars > storeChars) return cached;
  return stored;
}

/**
 * Apply one stream chunk. Pure reducer — each chunk's text is appended once.
 * Prefer stable messageId from Host; fall back to last streaming assistant.
 */
export interface GeneratedImagePayload {
  sessionId?: string;
  messageId?: string;
  path: string;
  name?: string;
}

/**
 * Attach an image_gen / image_edit result to the current assistant bubble.
 * Prefer streaming assistant; fall back to last assistant; create one if needed.
 */
export function applyGeneratedImage(
  messages: ChatMessage[],
  payload: GeneratedImagePayload,
): ChatMessage[] {
  const path = (payload.path || "").trim();
  if (!path) return messages;
  const name =
    (payload.name || "").trim() ||
    path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ||
    path;
  const att: MessageAttachment = { path, name, isDir: false };

  let idx = payload.messageId
    ? messages.findIndex((m) => m.id === payload.messageId)
    : -1;
  if (idx < 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role === "assistant" && m.streaming) {
        idx = i;
        break;
      }
    }
  }
  if (idx < 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "assistant") {
        idx = i;
        break;
      }
    }
  }

  if (idx < 0) {
    return [
      ...messages,
      {
        id: payload.messageId || `a-img-${Date.now()}`,
        role: "assistant",
        content: "",
        streaming: true,
        attachments: [att],
      },
    ];
  }

  const prev = messages[idx]!;
  const existing = prev.attachments ?? [];
  if (existing.some((a) => a.path === path)) return messages;
  const next = messages.slice();
  next[idx] = {
    ...prev,
    attachments: [...existing, att],
  };
  return next;
}

export function applyStreamChunk(
  messages: ChatMessage[],
  chunk: StreamPayload,
): ChatMessage[] {
  // done-only with empty text: just clear streaming flag
  if (chunk.done && !chunk.text) {
    return messages.map((m) =>
      m.role === "assistant" && m.streaming ? { ...m, streaming: false } : m,
    );
  }

  if (chunk.kind === "thought") {
    if (!chunk.text) return messages;
    const idx = findStreamingAssistant(messages, chunk.messageId);
    if (idx != null) {
      const next = messages.slice();
      const prev = next[idx]!;
      next[idx] = {
        ...prev,
        thought: (prev.thought ?? "") + chunk.text,
      };
      return next;
    }
    return [
      ...messages,
      {
        id: chunk.messageId || `t-${Date.now()}`,
        role: "assistant",
        content: "",
        thought: chunk.text,
        streaming: true,
      },
    ];
  }

  // assistant (default)
  if (!chunk.text && !chunk.done) return messages;

  let idx = chunk.messageId
    ? messages.findIndex((m) => m.id === chunk.messageId)
    : -1;
  if (idx < 0) {
    const fallback = findStreamingAssistant(messages, undefined);
    idx = fallback ?? -1;
  }

  if (idx < 0) {
    if (!chunk.text) return messages;
    return [
      ...messages,
      {
        id: chunk.messageId || `a-${Date.now()}`,
        role: "assistant",
        content: chunk.text,
        streaming: !chunk.done,
      },
    ];
  }

  const next = messages.slice();
  const prev = next[idx]!;
  next[idx] = {
    ...prev,
    // Keep first assigned id stable for subsequent chunks
    id: prev.id || chunk.messageId || prev.id,
    content: prev.content + (chunk.text || ""),
    streaming: !chunk.done,
  };
  return next;
}

function findStreamingAssistant(
  messages: ChatMessage[],
  messageId: string | undefined,
): number | undefined {
  if (messageId) {
    const byId = messages.findIndex((m) => m.id === messageId);
    if (byId >= 0) return byId;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.streaming) return i;
  }
  return undefined;
}

const KNOWN_ERROR_CODES: AgentErrorCode[] = [
  "CLI_NOT_FOUND",
  "AUTH_FAILED",
  "NETWORK_PROVIDER",
  "AGENT_CRASHED",
];

export function isAgentErrorCode(code: string | undefined | null): code is AgentErrorCode {
  return !!code && (KNOWN_ERROR_CODES as string[]).includes(code);
}

export function errorCopy(code: AgentErrorCode, locale: "zh" | "en" = "zh"): string {
  const zh: Record<AgentErrorCode, string> = {
    CLI_NOT_FOUND: "未找到 Grok Build CLI。请安装或在设置中指定路径。",
    AUTH_FAILED: "鉴权失败。请重新登录、更换 Key 或导入配置。",
    NETWORK_PROVIDER:
      "网络或模型服务异常。请检查网络、额度，或切换模型/渠道后重试。",
    AGENT_CRASHED: "Agent 进程异常退出。可尝试重新连接。",
  };
  const en: Record<AgentErrorCode, string> = {
    CLI_NOT_FOUND: "Grok Build CLI not found. Install or set path in Settings.",
    AUTH_FAILED: "Authentication failed. Re-login, change key, or import config.",
    NETWORK_PROVIDER:
      "Network or model provider error. Check connection, quota, or switch model/provider, then retry.",
    AGENT_CRASHED: "Agent process crashed. Try reconnect.",
  };
  return (locale === "en" ? en : zh)[code];
}

/** Turn took too long (Host session/prompt timeout) — more specific than generic network. */
export function turnTimeoutCopy(locale: "zh" | "en" = "zh"): string {
  return locale === "en"
    ? "This turn timed out and was stopped. You can retry — long tasks (e.g. image generation) may need more time."
    : "本轮执行超时已中止。可重试；生图等长任务可能需要更久。";
}

export function agentDisconnectedCopy(locale: "zh" | "en" = "zh"): string {
  return locale === "en"
    ? "The agent connection was interrupted. Try reconnecting and send again."
    : "与 Agent 的连接已中断。请重新连接后再试。";
}

const AGENT_ERROR_CODE_RE =
  /^(CLI_NOT_FOUND|AUTH_FAILED|NETWORK_PROVIDER|AGENT_CRASHED)(?::\s*|\s+)([\s\S]*)$/;

const MARKDOWN_CODE_RE =
  /^\*\*(CLI_NOT_FOUND|AUTH_FAILED|NETWORK_PROVIDER|AGENT_CRASHED)\*\*(?:\s*[\r\n]+([\s\S]*))?$/;

/** Strip ANSI SGR sequences from CLI/MCP stderr dumps. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

/** Drop stderr tails and other bulky transport noise from error strings. */
export function stripErrorNoise(text: string): string {
  let s = stripAnsi(text).trim();
  const stderrIdx = s.search(/;?\s*stderr:/i);
  if (stderrIdx >= 0) s = s.slice(0, stderrIdx).trim();
  // Collapse multi-line dumps to first useful line for classification.
  return s;
}

/**
 * Parse a stored / live turn-error payload into a friendly chat body.
 * Prefer stable codes; never show raw MCP Connection refused walls of text.
 */
export function formatTurnErrorBody(
  payload: Pick<TurnErrorPayload, "code" | "message" | "content">,
  locale: "zh" | "en" = "zh",
): string {
  const rawCombined = [payload.content, payload.message, payload.code]
    .filter(Boolean)
    .join("\n");
  const cleaned = stripErrorNoise(rawCombined);

  let code: AgentErrorCode | null = isAgentErrorCode(payload.code)
    ? payload.code
    : null;
  let rest = stripErrorNoise(payload.message || "");

  const md = (payload.content || "").trim().match(MARKDOWN_CODE_RE);
  if (md) {
    code = md[1] as AgentErrorCode;
    rest = stripErrorNoise(md[2] || rest);
  } else {
    const coded = cleaned.match(AGENT_ERROR_CODE_RE);
    if (coded) {
      code = coded[1] as AgentErrorCode;
      rest = stripErrorNoise(coded[2] || rest);
    }
  }

  const lower = `${rest}\n${cleaned}`.toLowerCase();
  if (
    rest === "turn_timeout" ||
    /rpc timeout.*session\/prompt|after\s*\d+s/.test(lower)
  ) {
    return turnTimeoutCopy(locale);
  }
  if (rest === "agent_disconnected" || /rpc channel closed|transport channel closed/i.test(lower)) {
    return agentDisconnectedCopy(locale);
  }

  if (code) {
    // Known code → friendly copy only (no technical rest in the bubble).
    return errorCopy(code, locale);
  }

  // Unknown: keep a short, non-bulky line.
  const first =
    cleaned
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !/connection refused|worker quit|hyper_util|reqwest/i.test(l)) ||
    (locale === "en" ? "Request failed. Please retry." : "请求失败，请重试。");
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
}

/**
 * Compact banner copy: short user-facing summary by default;
 * technical detail only when short and non-noisy (no MCP stderr walls).
 */
export function presentErrorBanner(
  error: AgentError | null,
  localError: string | null,
  locale: "zh" | "en" = "zh",
): {
  code: string | null;
  summary: string;
  detail: string | null;
  reconnectHint: boolean;
} | null {
  if (error) {
    const summary = formatTurnErrorBody(
      { code: error.code, message: error.message, content: undefined },
      locale,
    );
    return {
      code: error.code,
      summary,
      detail: null,
      reconnectHint: true,
    };
  }
  if (!localError?.trim()) return null;

  const cleaned = stripErrorNoise(localError);
  const coded = cleaned.match(AGENT_ERROR_CODE_RE);
  if (coded) {
    const code = coded[1] as AgentErrorCode;
    return {
      code,
      summary: formatTurnErrorBody(
        { code, message: coded[2] || "", content: undefined },
        locale,
      ),
      detail: null,
      reconnectHint: true,
    };
  }

  const summary = formatTurnErrorBody(
    { code: undefined, message: cleaned, content: undefined },
    locale,
  );
  const isTimeoutish = /timeout|超时|中断|disconnect/i.test(summary);
  return {
    code: null,
    summary,
    detail: null,
    reconnectHint: isTimeoutish || /AGENT_CRASHED|NETWORK_PROVIDER/i.test(cleaned),
  };
}
