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
  /** Local file/folder refs shown as cards (also embedded as @path for agent). */
  attachments?: MessageAttachment[];
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

/**
 * Apply one stream chunk. Pure reducer — each chunk's text is appended once.
 * Prefer stable messageId from Host; fall back to last streaming assistant.
 */
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

export function errorCopy(code: AgentErrorCode, locale: "zh" | "en" = "zh"): string {
  const zh: Record<AgentErrorCode, string> = {
    CLI_NOT_FOUND: "未找到 Grok Build CLI。请安装或在设置中指定路径。",
    AUTH_FAILED: "鉴权失败。请重新登录、更换 Key 或导入配置。",
    NETWORK_PROVIDER:
      "请求超时或网络/供应商错误。可点「重新连接」；若多次失败请检查网络与 CLI 登录。",
    AGENT_CRASHED: "Agent 进程异常退出。可尝试重新连接。",
  };
  const en: Record<AgentErrorCode, string> = {
    CLI_NOT_FOUND: "Grok Build CLI not found. Install or set path in Settings.",
    AUTH_FAILED: "Authentication failed. Re-login, change key, or import config.",
    NETWORK_PROVIDER:
      "Request timed out or network/provider error. Reconnect; check network and CLI login.",
    AGENT_CRASHED: "Agent process crashed. Try reconnect.",
  };
  return (locale === "en" ? en : zh)[code];
}

const AGENT_ERROR_CODE_RE =
  /^(CLI_NOT_FOUND|AUTH_FAILED|NETWORK_PROVIDER|AGENT_CRASHED)(?::\s*|\s+)([\s\S]*)$/;

/** Strip ANSI SGR sequences from CLI/MCP stderr dumps. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Compact banner copy: short user-facing summary by default;
 * put raw RPC/MCP dumps behind a Details toggle.
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
    const raw = stripAnsi(error.message || "").trim();
    const summary = errorCopy(error.code, locale);
    const detail =
      raw && raw !== summary && raw !== error.code ? raw : null;
    return {
      code: error.code,
      summary,
      detail,
      reconnectHint: true,
    };
  }
  if (!localError?.trim()) return null;

  const cleaned = stripAnsi(localError).trim();
  const coded = cleaned.match(AGENT_ERROR_CODE_RE);
  if (coded) {
    const code = coded[1] as AgentErrorCode;
    const rest = (coded[2] || "").trim();
    return {
      code,
      summary: errorCopy(code, locale),
      detail: rest && rest !== errorCopy(code, locale) ? rest : null,
      reconnectHint: true,
    };
  }

  // Heuristic: long / multi-line dumps (timeouts, stack-ish) → collapse
  const firstLine = cleaned.split(/\r?\n/).find((l) => l.trim())?.trim() ?? cleaned;
  const isBulky =
    cleaned.includes("\n") ||
    cleaned.length > 160 ||
    /rpc timeout|stderr:|Connection refused|Transport channel/i.test(cleaned);
  if (isBulky) {
    const summary =
      firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
    return {
      code: null,
      summary,
      detail: cleaned,
      reconnectHint:
        /AGENT_CRASHED|NETWORK_PROVIDER|rpc timeout|Connection refused/i.test(
          cleaned,
        ),
    };
  }

  return {
    code: null,
    summary: cleaned,
    detail: null,
    reconnectHint: false,
  };
}
