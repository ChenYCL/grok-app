/**
 * Pure helpers for Live Voice overlay — delegate phase, transcript merge,
 * and optional “send transcript as prompt” gating.
 *
 * Sources: host `voice://state` / transcript / tool events only.
 * Never invent STT partials or fake speech text.
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

/** Subset of host VoiceSessionState used for phase derivation. */
export type VoiceHostStateLike = {
  active?: boolean | null;
  mode?: string | null;
  phase?: string | null;
  listening?: boolean | null;
  speaking?: boolean | null;
  thinking?: boolean | null;
  error?: string | null;
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
  /** Local UI error (mic denied, start failure). */
  uiError?: string | null;
  /** Host snapshot from voice_state / voice://state. */
  state?: VoiceHostStateLike | null;
  /**
   * True while a host tool is in-flight (from events). Prefer host
   * `thinking` when present; this is a client-side supplement.
   */
  toolBusy?: boolean;
  /**
   * True after a final user transcript until assistant audio/text starts.
   * Derived from host transcript events only — never synthetic STT.
   */
  awaitingResponse?: boolean;
};

/**
 * Derive overlay status: speaking > thinking > listening > connecting/idle.
 * Prefers explicit host `phase` / `thinking` when present.
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
  if (!st?.active) return "idle";

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
  if (st.thinking || input.toolBusy || input.awaitingResponse) {
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
