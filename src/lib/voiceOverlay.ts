/**
 * Pure helpers for Live Voice overlay — delegate phase, transcript merge,
 * Build tool-loop status (VOX-BUILD-LOOP), and optional “send transcript
 * as prompt” gating.
 *
 * Sources: host `voice://state` / transcript / tool events only.
 * Never invent STT partials, fake tool results, or speech text.
 */

/** High-level UI phase for the Live Voice overlay status line. */
export type VoiceDelegatePhase =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "error"
  | "ended";

/**
 * Stable error classes for Live Voice + Build tool loop (i18n keys).
 * Mic failures are soft when the host session is otherwise alive.
 */
export type VoiceLiveErrorClass =
  | "mic_denied"
  | "mic_missing"
  | "cli_missing"
  | "auth"
  | "network"
  | "timeout"
  | "tool_failed"
  | "not_available"
  | "unknown";

/** Host Build tool lifecycle for voice → agent delegation. */
export type VoiceToolLoopStatus =
  | "idle"
  | "running"
  | "ok"
  | "soft_fail"
  | "error";

/** Client-side tool-loop snapshot (from host events only). */
export type VoiceToolLoopState = {
  status: VoiceToolLoopStatus;
  /** Tool name when known; null when idle / absent. */
  name: string | null;
  /** Soft-fail / error reason token when present (e.g. cli_missing). */
  reason: string | null;
  /** Delegated session id from tool result when present. */
  sessionId: string | null;
};

/** Subset of host VoiceSessionState used for phase derivation. */
export type VoiceHostStateLike = {
  active?: boolean | null;
  mode?: string | null;
  phase?: string | null;
  listening?: boolean | null;
  speaking?: boolean | null;
  thinking?: boolean | null;
  error?: string | null;
  /** Host-reported in-flight tool name (optional). */
  activeTool?: string | null;
  delegatedSessionIds?: string[] | null;
  mock?: boolean | null;
};

/** One transcript row (user / assistant / system). */
export type VoiceTranscriptLine = {
  id: string;
  role: string;
  text: string;
  final?: boolean;
};

export type DeriveVoiceDelegatePhaseInput = {
  /** True while voiceStart has not resolved. */
  connecting?: boolean;
  /** Overlay closed after stop. */
  ended?: boolean;
  /**
   * Fatal UI/host error text. Soft mic warnings should not be passed here
   * when the host session is still active (use softMicWarning instead).
   */
  uiError?: string | null;
  /**
   * Soft mic failure class (denied / missing). Does not force error phase
   * while the host session remains active — voice can still play / tools run.
   */
  softMicWarning?: VoiceLiveErrorClass | null;
  /** Host snapshot from voice_state / voice://state. */
  state?: VoiceHostStateLike | null;
  /**
   * True while a host tool is in-flight (from events). Prefer host
   * `thinking` / `activeTool` when present; this is a client-side supplement.
   */
  toolBusy?: boolean;
  /**
   * True after a final user transcript until assistant audio/text starts.
   * Derived from host transcript events only — never synthetic STT.
   */
  awaitingResponse?: boolean;
};

const KNOWN_LIVE_ERRORS: readonly VoiceLiveErrorClass[] = [
  "mic_denied",
  "mic_missing",
  "cli_missing",
  "auth",
  "network",
  "timeout",
  "tool_failed",
  "not_available",
  "unknown",
] as const;

function isLiveErrorClass(s: string): s is VoiceLiveErrorClass {
  return (KNOWN_LIVE_ERRORS as readonly string[]).includes(s);
}

/**
 * Map host/UI failure text (or stable errorClass token) to a Live Voice class.
 * Never invents success — unknown stays unknown.
 */
export function classifyLiveVoiceError(
  raw: string | null | undefined,
  errorClass?: string | null,
): VoiceLiveErrorClass {
  const token = (errorClass ?? "").trim().toLowerCase();
  if (token && isLiveErrorClass(token)) return token;

  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return "unknown";
  if (isLiveErrorClass(s)) return s;

  if (
    s.includes("cli not found") ||
    s.includes("cli_missing") ||
    s.includes("grok build not found") ||
    s.includes("grok build cli not found") ||
    s.includes("install grok build")
  ) {
    return "cli_missing";
  }
  if (
    s.includes("not_available") ||
    s.includes("not available") ||
    s.includes("no speech auth")
  ) {
    return "not_available";
  }
  if (
    s.includes("permission") ||
    s.includes("denied") ||
    s.includes("notallowed") ||
    s.includes("mic_denied")
  ) {
    return "mic_denied";
  }
  if (
    s.includes("notfound") ||
    s.includes("no device") ||
    s.includes("no microphone") ||
    s.includes("mic_missing") ||
    s.includes("device not found")
  ) {
    return "mic_missing";
  }
  if (
    s.includes("timeout") ||
    s.includes("timed out") ||
    s.includes("deadline")
  ) {
    return "timeout";
  }
  if (
    s.includes("network") ||
    s.includes("fetch") ||
    s.includes("connection") ||
    s.includes("websocket") ||
    s.includes("ws ") ||
    s.includes("dns") ||
    s.includes("econn")
  ) {
    return "network";
  }
  if (
    s.includes("401") ||
    s.includes("403") ||
    s.includes("unauthor") ||
    s.includes("auth") ||
    s.includes("bearer") ||
    s.includes("credential")
  ) {
    return "auth";
  }
  if (s.includes("tool ") || s.includes("tool_failed") || s.includes("unknown tool")) {
    return "tool_failed";
  }
  return "unknown";
}

/** Mic denied / missing — soft when host is otherwise alive. */
export function isSoftMicFailure(cls: VoiceLiveErrorClass | null | undefined): boolean {
  return cls === "mic_denied" || cls === "mic_missing";
}

/**
 * Whether a Live Voice error should force the overlay error phase.
 * Soft mic failures do not, so playback / tool loop can continue.
 */
export function isFatalLiveVoiceError(
  cls: VoiceLiveErrorClass | null | undefined,
): boolean {
  if (!cls) return false;
  if (isSoftMicFailure(cls)) return false;
  return true;
}

/** i18n MessageKey fragment for a classified Live Voice error. */
export function liveVoiceErrorMessageKey(
  cls: VoiceLiveErrorClass,
): `voice.err.${VoiceLiveErrorClass}` {
  return `voice.err.${cls}`;
}

export function initialToolLoopState(): VoiceToolLoopState {
  return { status: "idle", name: null, reason: null, sessionId: null };
}

/**
 * Normalize a host `voice://tool` payload. Returns null when name is absent
 * (never invents a tool). Status defaults: result present → ok, else running
 * when status omitted for backward compatibility with finish-only events.
 */
export function parseToolLoopEvent(payload: {
  name?: string | null;
  status?: string | null;
  reason?: string | null;
  message?: string | null;
  sessionId?: string | null;
  session_id?: string | null;
  result?: unknown;
  errorClass?: string | null;
} | null | undefined): VoiceToolLoopState | null {
  const name = toolEventName(payload);
  if (!name) return null;

  const statusRaw = (payload?.status ?? "").trim().toLowerCase();
  let status: VoiceToolLoopStatus;
  if (
    statusRaw === "running" ||
    statusRaw === "ok" ||
    statusRaw === "soft_fail" ||
    statusRaw === "error" ||
    statusRaw === "idle"
  ) {
    status = statusRaw;
  } else if (payload?.result !== undefined && payload?.result !== null) {
    // Legacy finish event with result but no status.
    const soft = softFailReasonFromToolResult(payload.result);
    status = soft ? "soft_fail" : "ok";
  } else if (statusRaw === "failed" || statusRaw === "err") {
    status = "error";
  } else {
    // Name-only without status: treat as in-flight (start event).
    status = "running";
  }

  let reason =
    (payload?.reason ?? "").trim() ||
    softFailReasonFromToolResult(payload?.result) ||
    null;
  if (!reason && status === "error") {
    const cls = classifyLiveVoiceError(
      payload?.message,
      payload?.errorClass,
    );
    reason = cls === "unknown" ? null : cls;
  }

  const sessionId =
    (payload?.sessionId ?? payload?.session_id ?? "").trim() ||
    sessionIdFromToolResult(payload?.result) ||
    null;

  return {
    status,
    name,
    reason,
    sessionId,
  };
}

/** Reduce tool-loop state from a parsed event (host order only). */
export function reduceToolLoopState(
  prev: VoiceToolLoopState,
  next: VoiceToolLoopState | null,
): VoiceToolLoopState {
  if (!next) return prev;
  if (next.status === "idle") return initialToolLoopState();
  return {
    status: next.status,
    name: next.name ?? prev.name,
    reason: next.reason,
    sessionId: next.sessionId ?? prev.sessionId,
  };
}

/** True while a Build tool is in-flight. */
export function isToolLoopBusy(loop: VoiceToolLoopState | null | undefined): boolean {
  return loop?.status === "running";
}

/**
 * Extract soft-fail reason from a host tool result object.
 * Only trusts explicit `ok: false` + `reason` — never invents failures.
 */
export function softFailReasonFromToolResult(
  result: unknown,
): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (r.ok === false) {
    const reason = typeof r.reason === "string" ? r.reason.trim() : "";
    return reason || "unknown";
  }
  return null;
}

function sessionIdFromToolResult(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const sid = r.session_id ?? r.sessionId;
  if (typeof sid === "string" && sid.trim()) return sid.trim();
  return null;
}

/**
 * i18n key for the tool-loop status line. Null when idle (no chrome).
 * Callers interpolate `{name}` / `{reason}` as needed.
 */
export function toolLoopStatusMessageKey(
  loop: VoiceToolLoopState | null | undefined,
):
  | "voice.toolRunning"
  | "voice.toolRan"
  | "voice.toolSoftFail"
  | "voice.toolFailed"
  | null {
  if (!loop || loop.status === "idle" || !loop.name) return null;
  switch (loop.status) {
    case "running":
      return "voice.toolRunning";
    case "ok":
      return "voice.toolRan";
    case "soft_fail":
      return "voice.toolSoftFail";
    case "error":
      return "voice.toolFailed";
    default:
      return null;
  }
}

/**
 * Derive overlay status: speaking > thinking > listening > connecting/idle.
 * Prefers explicit host `phase` / `thinking` when present.
 * Soft mic warnings do not force error while the host session is active.
 */
export function deriveVoiceDelegatePhase(
  input: DeriveVoiceDelegatePhaseInput,
): VoiceDelegatePhase {
  if (input.ended) return "ended";
  if (input.connecting) return "connecting";

  const hostErr = input.state?.error?.trim() || null;
  const uiErr = input.uiError?.trim() || null;
  if (hostErr || uiErr) return "error";

  const st = input.state;
  if (!st?.active) {
    // Soft mic only and no host yet → still surface error so the user sees it.
    if (input.softMicWarning && isSoftMicFailure(input.softMicWarning)) {
      return "error";
    }
    return "idle";
  }

  const phaseRaw = (st.phase ?? "").trim().toLowerCase();
  if (
    phaseRaw === "speaking" ||
    phaseRaw === "listening" ||
    phaseRaw === "thinking" ||
    phaseRaw === "connecting" ||
    phaseRaw === "error" ||
    phaseRaw === "idle"
  ) {
    return phaseRaw as VoiceDelegatePhase;
  }

  if (st.speaking) return "speaking";
  const hostToolBusy = Boolean(st.activeTool?.trim());
  if (st.thinking || input.toolBusy || hostToolBusy || input.awaitingResponse) {
    return "thinking";
  }
  if (st.listening) return "listening";
  // Active but neither listening nor speaking — model / tools mid-turn.
  return "thinking";
}

/** Roles that carry conversational content (not system chrome). */
export function isConversationalRole(role: string): boolean {
  const r = role.trim().toLowerCase();
  return r === "user" || r === "assistant";
}

/**
 * Merge a host transcript delta into the line list.
 * Partial (non-final) deltas append to the last same-role open line.
 */
export function mergeTranscriptLine(
  prev: VoiceTranscriptLine[],
  role: string,
  text: string,
  final?: boolean,
  idFactory: () => string = () =>
    `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
): VoiceTranscriptLine[] {
  if (!text) return prev;
  const last = prev.length ? prev[prev.length - 1] : null;
  if (!final && last && last.role === role && !last.final) {
    const next = prev.slice();
    next[next.length - 1] = { ...last, text: last.text + text };
    return next;
  }
  return [
    ...prev,
    {
      id: idFactory(),
      role,
      text,
      final,
    },
  ];
}

/**
 * Format host transcript lines as a single prompt for the active session.
 * Uses only real conversational text — skips empty / system-only rows.
 * Returns "" when there is nothing honest to send (no invented STT).
 */
export function formatTranscriptAsPrompt(
  lines: readonly VoiceTranscriptLine[],
): string {
  const chunks: string[] = [];
  for (const line of lines) {
    if (!isConversationalRole(line.role)) continue;
    const t = line.text.trim();
    if (!t) continue;
    const label = line.role.trim().toLowerCase() === "user" ? "User" : "Assistant";
    chunks.push(`${label}: ${t}`);
  }
  return chunks.join("\n\n").trim();
}

/**
 * Whether the “send transcript to active session” control should show.
 * Requires explicit host/app support (callback), an active chat session,
 * and non-empty conversational transcript from real host events.
 */
export function canSendTranscriptAsPrompt(opts: {
  /** App passed onSendTranscriptAsPrompt (host supports). */
  supportsSend: boolean;
  hasActiveSession: boolean;
  transcriptText: string;
}): boolean {
  return (
    opts.supportsSend &&
    opts.hasActiveSession &&
    opts.transcriptText.trim().length > 0
  );
}

/** Why the transcript pane is empty — for honest empty copy. */
export type TranscriptEmptyKind = "none" | "system_only" | "has_content";

export function transcriptEmptyKind(
  lines: readonly VoiceTranscriptLine[],
): TranscriptEmptyKind {
  for (const line of lines) {
    if (isConversationalRole(line.role) && line.text.trim()) {
      return "has_content";
    }
  }
  if (lines.length > 0) return "system_only";
  return "none";
}

/** True when delegated session chips have at least one id. */
export function hasDelegatedSessions(
  state: VoiceHostStateLike | null | undefined,
): boolean {
  return (state?.delegatedSessionIds?.length ?? 0) > 0;
}

/**
 * Normalize a host tool event name. Returns null when absent — never invents.
 */
export function toolEventName(payload: {
  name?: string | null;
} | null | undefined): string | null {
  const n = payload?.name?.trim();
  return n ? n : null;
}

/**
 * After a final user transcript (host event), we may await model response.
 * After assistant partial/final or speaking, clear awaiting.
 */
export function nextAwaitingResponse(opts: {
  prev: boolean;
  role: string;
  final?: boolean;
  speaking?: boolean;
}): boolean {
  if (opts.speaking) return false;
  const role = opts.role.trim().toLowerCase();
  if (role === "user" && opts.final) return true;
  if (role === "assistant") return false;
  return opts.prev;
}
