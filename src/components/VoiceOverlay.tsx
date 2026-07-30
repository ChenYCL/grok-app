/**
 * Live Voice overlay — full-duplex session UI + delegated agent chips.
 *
 * Status (listening / thinking / speaking) comes from host voice:// events
 * only. Transcript text is never invented (no fake STT). Optional “send
 * transcript to active session as prompt” appears only when the host/app
 * provides a send callback and conversational host text exists.
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
  deriveVoiceDelegatePhase,
  formatTranscriptAsPrompt,
  hasDelegatedSessions,
  mergeTranscriptLine,
  nextAwaitingResponse,
  toolEventName,
  transcriptEmptyKind,
  type VoiceDelegatePhase,
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [awaitingResponse, setAwaitingResponse] = useState(false);
  const [sendingPrompt, setSendingPrompt] = useState(false);
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

  useEffect(() => {
    if (!open) {
      started.current = false;
      stopCapture.current?.();
      stopCapture.current = null;
      setAwaitingResponse(false);
      return;
    }
    if (started.current) return;
    started.current = true;
    setBusy(true);
    setError(null);
    setLines([]);
    setAwaitingResponse(false);

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

        // Mic → host (skip in pure mock if getUserMedia fails)
        try {
          const cap = await startPcmCapture((b64) => {
            void voicePushPcm(b64).catch(() => {});
          });
          stopCapture.current = cap.stop;
        } catch {
          setError(tt("voice.micDenied"));
        }

        const u1 = await listen<VoiceSessionState>("voice://state", (e) => {
          setState(e.payload);
          if (e.payload.speaking) {
            setAwaitingResponse(false);
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

        const u4 = await listen<{ message?: string }>("voice://error", (e) => {
          setError(
            tt("voice.error", { message: e.payload.message ?? "unknown" }),
          );
        });
        unsubs.push(u4);

        const u5 = await listen<{ name?: string }>("voice://tool", (e) => {
          const name = toolEventName(e.payload);
          if (name) {
            appendLine(
              "system",
              tt("voice.toolRan", { name }),
              true,
            );
          }
          if (name === "create_agent_session" || name === "prompt_agent") {
            window.dispatchEvent(
              new CustomEvent("grok-app:voice-session-changed"),
            );
          }
          // Refresh delegated chips after host tool completes.
          void voiceState()
            .then(setState)
            .catch(() => {});
        });
        unsubs.push(u5);

        const u6 = await listen("voice://tool_result", () => {
          void voiceState()
            .then(setState)
            .catch(() => {});
        });
        unsubs.push(u6);
      } catch (e) {
        setError(String(e));
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
      setError(String(e));
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
  const phase = deriveVoiceDelegatePhase({
    connecting: busy,
    uiError: error,
    state,
    awaitingResponse,
  });
  const statusLabel = tt(phaseMessageKey(phase));

  const handleSendTranscript = async () => {
    if (!showSend || !onSendTranscriptAsPrompt || !transcriptPrompt.trim()) {
      return;
    }
    setSendingPrompt(true);
    try {
      await onSendTranscriptAsPrompt(transcriptPrompt);
    } catch (e) {
      setError(String(e));
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
            >
              <span
                className={cn(
                  "voice-overlay__phase-dot",
                  `is-${phase}`,
                )}
                aria-hidden
              />
              {statusLabel}
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
