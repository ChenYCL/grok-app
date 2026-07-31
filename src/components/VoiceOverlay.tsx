/**
 * Live Voice overlay — full-duplex session UI + delegated agent chips.
 *
 * Status (listening / thinking / speaking / Build tool loop) comes from
 * host voice:// events only. Transcript text is never invented (no fake STT).
 * Mic / CLI missing soft-fails with clear copy; host tools surface running →
 * ok / soft_fail / error. Optional “send transcript to active session”
 * only when host/app provides a send callback and conversational text exists.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  voiceInvokeTool,
  voicePushPcm,
  voiceStart,
  voiceState,
  voiceStop,
  type VoiceSessionState,
} from "@/lib/api";
import { playPcm16Base64, startPcmCapture } from "@/lib/voiceAudio";
import {
  canSendTranscriptAsPrompt,
  classifyLiveVoiceError,
  deriveVoiceDelegatePhase,
  formatTranscriptAsPrompt,
  hasDelegatedSessions,
  initialToolLoopState,
  isSoftMicFailure,
  isToolLoopBusy,
  liveVoiceErrorMessageKey,
  mergeTranscriptLine,
  nextAwaitingResponse,
  parseToolLoopEvent,
  reduceToolLoopState,
  toolLoopStatusMessageKey,
  transcriptEmptyKind,
  type VoiceDelegatePhase,
  type VoiceLiveErrorClass,
  type VoiceToolLoopState,
  type VoiceTranscriptLine,
} from "@/lib/voiceOverlay";
import type { Locale, MessageKey } from "@/i18n";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

export type VoiceOverlayProps = {
  locale: Locale;
  open: boolean;
  projectPath?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  voiceId?: string | null;
  keepAgentsOnEnd?: boolean;
  /** When true, the workbench has an active chat that can accept a prompt. */
  hasActiveSession?: boolean;
  onClose: () => void;
  onOpenSession?: (sessionId: string) => void;
  /**
   * Optional: send formatted host transcript as a user prompt on the active
   * session. Omit when host/app does not support it — control stays hidden.
   */
  onSendTranscriptAsPrompt?: (prompt: string) => void | Promise<void>;
};

function phaseMessageKey(phase: VoiceDelegatePhase): MessageKey {
  switch (phase) {
    case "connecting":
      return "voice.connecting";
    case "speaking":
      return "voice.speaking";
    case "thinking":
      return "voice.thinking";
    case "listening":
      return "voice.listening";
    case "error":
      return "voice.statusError";
    case "ended":
      return "voice.statusEnded";
    case "idle":
    default:
      return "voice.live";
  }
}

/** Humanize a classified Live Voice error (i18n). Falls back to generic. */
function formatLiveError(
  tt: (key: MessageKey, vars?: Record<string, string | number>) => string,
  raw: string | null | undefined,
  errorClass?: string | null,
): string {
  const cls = classifyLiveVoiceError(raw, errorClass);
  const key = liveVoiceErrorMessageKey(cls) as MessageKey;
  const localized = tt(key);
  // If catalog missing for some reason, still surface something honest.
  if (localized && localized !== key) return localized;
  if (raw?.trim()) return tt("voice.error", { message: raw.trim() });
  return tt("voice.err.unknown");
}

export function VoiceOverlay({
  locale,
  open,
  projectPath,
  projectId,
  projectName,
  voiceId,
  keepAgentsOnEnd = true,
  hasActiveSession = false,
  onClose,
  onOpenSession,
  onSendTranscriptAsPrompt,
}: VoiceOverlayProps) {
  const tt = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) => t(locale, key, vars),
    [locale],
  );
  const [state, setState] = useState<VoiceSessionState | null>(null);
  const [lines, setLines] = useState<VoiceTranscriptLine[]>([]);
  /** Fatal UI/host error (forces error phase). */
  const [error, setError] = useState<string | null>(null);
  /** Soft mic warning — host may still be active (playback / tools). */
  const [softMicWarning, setSoftMicWarning] =
    useState<VoiceLiveErrorClass | null>(null);
  const [busy, setBusy] = useState(false);
  const [awaitingResponse, setAwaitingResponse] = useState(false);
  const [sendingPrompt, setSendingPrompt] = useState(false);
  const [toolLoop, setToolLoop] = useState<VoiceToolLoopState>(
    initialToolLoopState,
  );
  const stopCapture = useRef<(() => void) | null>(null);
  const started = useRef(false);

  const appendLine = useCallback(
    (role: string, text: string, final?: boolean) => {
      setLines((prev) => mergeTranscriptLine(prev, role, text, final));
      setAwaitingResponse((prev) =>
        nextAwaitingResponse({ prev, role, final }),
      );
    },
    [],
  );

  const applyToolEvent = useCallback(
    (payload: {
      name?: string | null;
      status?: string | null;
      reason?: string | null;
      message?: string | null;
      sessionId?: string | null;
      session_id?: string | null;
      result?: unknown;
      errorClass?: string | null;
    }) => {
      const parsed = parseToolLoopEvent(payload);
      if (!parsed) return;
      setToolLoop((prev) => reduceToolLoopState(prev, parsed));
      const key = toolLoopStatusMessageKey(parsed);
      if (key && parsed.name) {
        const vars: Record<string, string | number> = { name: parsed.name };
        if (parsed.reason) vars.reason = parsed.reason;
        appendLine("system", tt(key, vars), true);
      }
      if (
        parsed.name === "create_agent_session" ||
        parsed.name === "prompt_agent"
      ) {
        window.dispatchEvent(
          new CustomEvent("grok-app:voice-session-changed"),
        );
      }
      // Refresh delegated chips after host tool updates.
      void voiceState()
        .then(setState)
        .catch(() => {});
    },
    [appendLine, tt],
  );

  useEffect(() => {
    if (!open) {
      started.current = false;
      stopCapture.current?.();
      stopCapture.current = null;
      setAwaitingResponse(false);
      setToolLoop(initialToolLoopState());
      setSoftMicWarning(null);
      return;
    }
    if (started.current) return;
    started.current = true;
    setBusy(true);
    setError(null);
    setSoftMicWarning(null);
    setLines([]);
    setAwaitingResponse(false);
    setToolLoop(initialToolLoopState());

    let unsubs: Array<() => void> = [];

    (async () => {
      try {
        const st = await voiceStart({
          projectPath,
          projectId,
          projectName,
          voiceId: voiceId ?? null,
          keepAgentsOnEnd,
        });
        setState(st);
        appendLine(
          "system",
          st.mock ? tt("voice.mockReady") : tt("voice.ready"),
          true,
        );

        // Mic → host. Soft-fail when missing/denied: session stays up for
        // playback + Build tools; only warn (do not hard-kill the overlay).
        try {
          const cap = await startPcmCapture((b64) => {
            void voicePushPcm(b64).catch(() => {});
          });
          stopCapture.current = cap.stop;
        } catch (micErr) {
          const cls = classifyLiveVoiceError(String(micErr));
          if (isSoftMicFailure(cls)) {
            setSoftMicWarning(cls);
            appendLine("system", tt(liveVoiceErrorMessageKey(cls) as MessageKey), true);
          } else {
            setError(formatLiveError(tt, String(micErr)));
          }
        }

        const u1 = await listen<VoiceSessionState>("voice://state", (e) => {
          setState(e.payload);
          if (e.payload.speaking) {
            setAwaitingResponse(false);
          }
          // Host activeTool mirrors tool-loop busy when present.
          const active = e.payload.activeTool?.trim();
          if (active) {
            setToolLoop((prev) =>
              prev.status === "running" && prev.name === active
                ? prev
                : {
                    status: "running",
                    name: active,
                    reason: null,
                    sessionId: prev.sessionId,
                  },
            );
          }
        });
        unsubs.push(u1);

        const u2 = await listen<{ role?: string; text?: string; final?: boolean }>(
          "voice://transcript",
          (e) => {
            const role = e.payload.role ?? "assistant";
            const text = e.payload.text ?? "";
            // Host text only — never invent STT when payload is empty.
            if (text) appendLine(role, text, e.payload.final);
          },
        );
        unsubs.push(u2);

        const u3 = await listen<{ delta?: string }>("voice://audio", (e) => {
          if (e.payload.delta) {
            setAwaitingResponse(false);
            void playPcm16Base64(e.payload.delta).catch(() => {});
          }
        });
        unsubs.push(u3);

        const u4 = await listen<{
          message?: string;
          errorClass?: string;
        }>("voice://error", (e) => {
          const cls = classifyLiveVoiceError(
            e.payload.message,
            e.payload.errorClass,
          );
          if (isSoftMicFailure(cls)) {
            setSoftMicWarning(cls);
            appendLine(
              "system",
              tt(liveVoiceErrorMessageKey(cls) as MessageKey),
              true,
            );
            return;
          }
          setError(formatLiveError(tt, e.payload.message, e.payload.errorClass));
        });
        unsubs.push(u4);

        const u5 = await listen<Record<string, unknown>>("voice://tool", (e) => {
          applyToolEvent(e.payload as Parameters<typeof applyToolEvent>[0]);
        });
        unsubs.push(u5);

        const u6 = await listen("voice://tool_result", () => {
          // Lifecycle lines come from voice://tool (running/ok/soft_fail/error).
          // tool_result only refreshes delegated chips — avoid double-append.
          void voiceState()
            .then(setState)
            .catch(() => {});
        });
        unsubs.push(u6);
      } catch (e) {
        setError(formatLiveError(tt, String(e)));
      } finally {
        setBusy(false);
      }
    })();

    return () => {
      unsubs.forEach((u) => {
        try {
          u();
        } catch {
          /* ignore */
        }
      });
    };
  }, [
    open,
    projectPath,
    projectId,
    projectName,
    voiceId,
    keepAgentsOnEnd,
    appendLine,
    applyToolEvent,
    tt,
  ]);

  const handleEnd = async () => {
    stopCapture.current?.();
    stopCapture.current = null;
    try {
      await voiceStop();
    } catch {
      /* ignore */
    }
    onClose();
  };

  /** Dev/demo: simulate “start agent task” without S2S tool frames. */
  const demoDelegate = async () => {
    try {
      await voiceInvokeTool(
        "create_agent_session",
        JSON.stringify({
          title: "Voice task",
          prompt:
            "Summarize the project status and list the next three safe coding tasks.",
        }),
      );
      const st = await voiceState();
      setState(st);
    } catch (e) {
      setError(formatLiveError(tt, String(e)));
    }
  };

  const transcriptPrompt = useMemo(
    () => formatTranscriptAsPrompt(lines),
    [lines],
  );
  const supportsSend = typeof onSendTranscriptAsPrompt === "function";
  const showSend = canSendTranscriptAsPrompt({
    supportsSend,
    hasActiveSession,
    transcriptText: transcriptPrompt,
  });
  const emptyKind = transcriptEmptyKind(lines);
  const toolBusy = isToolLoopBusy(toolLoop);
  const phase = deriveVoiceDelegatePhase({
    connecting: busy,
    uiError: error,
    softMicWarning,
    state,
    toolBusy,
    awaitingResponse,
  });
  const statusLabel = tt(phaseMessageKey(phase));
  const toolStatusKey = toolLoopStatusMessageKey(toolLoop);
  const softMicLabel = softMicWarning
    ? tt(liveVoiceErrorMessageKey(softMicWarning) as MessageKey)
    : null;

  const handleSendTranscript = async () => {
    if (!showSend || !onSendTranscriptAsPrompt || !transcriptPrompt.trim()) {
      return;
    }
    setSendingPrompt(true);
    try {
      await onSendTranscriptAsPrompt(transcriptPrompt);
    } catch (e) {
      setError(formatLiveError(tt, String(e)));
    } finally {
      setSendingPrompt(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="voice-overlay"
      role="dialog"
      aria-label={tt("voice.live")}
    >
      <div className="voice-overlay__panel">
        <header className="voice-overlay__header">
          <div>
            <div className="voice-overlay__title">{tt("voice.live")}</div>
            <div
              className={cn(
                "voice-overlay__status",
                `voice-overlay__status--${phase}`,
              )}
              data-phase={phase}
              data-tool-status={toolLoop.status}
              data-tool-name={toolLoop.name ?? undefined}
            >
              <span
                className={cn(
                  "voice-overlay__phase-dot",
                  `is-${phase}`,
                )}
                aria-hidden
              />
              {statusLabel}
              {toolStatusKey && toolLoop.name && toolBusy ? (
                <span className="voice-overlay__tool-chip">
                  {tt(toolStatusKey, {
                    name: toolLoop.name,
                    reason: toolLoop.reason ?? "",
                  })}
                </span>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            className="voice-overlay__end"
            onClick={() => void handleEnd()}
          >
            {tt("voice.stop")}
          </button>
        </header>

        {error ? <div className="voice-overlay__error">{error}</div> : null}
        {!error && softMicLabel ? (
          <div className="voice-overlay__warn" role="status">
            {softMicLabel}
          </div>
        ) : null}

        <div className="voice-overlay__wave" aria-hidden>
          <span
            className={cn(
              "voice-overlay__bar",
              (phase === "listening" || phase === "thinking") && "is-on",
            )}
          />
          <span
            className={cn(
              "voice-overlay__bar",
              (phase === "speaking" || phase === "thinking") && "is-on",
            )}
          />
          <span
            className={cn(
              "voice-overlay__bar",
              phase === "listening" && "is-on",
            )}
          />
          <span
            className={cn(
              "voice-overlay__bar",
              phase === "speaking" && "is-on",
            )}
          />
          <span
            className={cn(
              "voice-overlay__bar",
              (phase === "listening" || phase === "thinking") && "is-on",
            )}
          />
        </div>

        <div className="voice-overlay__transcript">
          {emptyKind === "none" ? (
            <div className="voice-overlay__muted">{tt("voice.transcriptEmpty")}</div>
          ) : null}
          {emptyKind === "system_only" ? (
            <div className="voice-overlay__muted">
              {tt("voice.transcriptSystemOnly")}
            </div>
          ) : null}
          {lines.map((l) => (
            <div
              key={l.id}
              className={cn(
                "voice-overlay__line",
                l.role === "user" && "is-user",
                l.role === "assistant" && "is-assistant",
                l.role === "system" && "is-system",
              )}
            >
              <span className="voice-overlay__role">{l.role}</span>
              <span>{l.text}</span>
            </div>
          ))}
        </div>

        <div className="voice-overlay__actions">
          {supportsSend ? (
            showSend ? (
              <button
                type="button"
                className="voice-overlay__send"
                disabled={sendingPrompt}
                onClick={() => void handleSendTranscript()}
              >
                {sendingPrompt
                  ? tt("voice.sendingTranscript")
                  : tt("voice.sendTranscript")}
              </button>
            ) : (
              <div className="voice-overlay__muted">
                {hasActiveSession
                  ? tt("voice.sendTranscriptNeedSpeech")
                  : tt("voice.sendTranscriptNeedSession")}
              </div>
            )
          ) : null}
        </div>

        <section className="voice-overlay__delegated">
          <div className="voice-overlay__delegated-title">
            {tt("voice.delegated")}
          </div>
          {!hasDelegatedSessions(state) ? (
            <div className="voice-overlay__muted">{tt("voice.noDelegated")}</div>
          ) : (
            <ul className="voice-overlay__chips">
              {(state?.delegatedSessionIds ?? []).map((id) => (
                <li key={id}>
                  <button type="button" onClick={() => onOpenSession?.(id)}>
                    {tt("voice.openSession")} · {id.slice(0, 8)}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {state?.mock ? (
            <button
              type="button"
              className="voice-overlay__demo"
              onClick={() => void demoDelegate()}
            >
              {tt("voice.demoDelegate")}
            </button>
          ) : null}
        </section>
      </div>
    </div>
  );
}
