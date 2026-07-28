/**
 * Live Voice overlay — full-duplex session UI + delegated agent chips.
 */
import { useCallback, useEffect, useRef, useState } from "react";
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
import type { Locale, MessageKey } from "@/i18n";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

type TranscriptLine = {
  id: string;
  role: string;
  text: string;
  final?: boolean;
};

export type VoiceOverlayProps = {
  locale: Locale;
  open: boolean;
  projectPath?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  voiceId?: string | null;
  keepAgentsOnEnd?: boolean;
  onClose: () => void;
  onOpenSession?: (sessionId: string) => void;
};

export function VoiceOverlay({
  locale,
  open,
  projectPath,
  projectId,
  projectName,
  voiceId,
  keepAgentsOnEnd = true,
  onClose,
  onOpenSession,
}: VoiceOverlayProps) {
  const tt = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) => t(locale, key, vars),
    [locale],
  );
  const [state, setState] = useState<VoiceSessionState | null>(null);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stopCapture = useRef<(() => void) | null>(null);
  const started = useRef(false);

  const appendLine = useCallback((role: string, text: string, final?: boolean) => {
    setLines((prev) => {
      if (!final && prev.length && prev[prev.length - 1]?.role === role && !prev[prev.length - 1]?.final) {
        const next = [...prev];
        const last = next[next.length - 1]!;
        next[next.length - 1] = { ...last, text: last.text + text };
        return next;
      }
      return [
        ...prev,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          role,
          text,
          final,
        },
      ];
    });
  }, []);

  useEffect(() => {
    if (!open) {
      started.current = false;
      stopCapture.current?.();
      stopCapture.current = null;
      return;
    }
    if (started.current) return;
    started.current = true;
    setBusy(true);
    setError(null);
    setLines([]);

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
        });
        unsubs.push(u1);

        const u2 = await listen<{ role?: string; text?: string; final?: boolean }>(
          "voice://transcript",
          (e) => {
            const role = e.payload.role ?? "assistant";
            const text = e.payload.text ?? "";
            if (text) appendLine(role, text, e.payload.final);
          },
        );
        unsubs.push(u2);

        const u3 = await listen<{ delta?: string }>("voice://audio", (e) => {
          if (e.payload.delta) {
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
          if (e.payload.name) {
            appendLine(
              "system",
              tt("voice.toolRan", { name: e.payload.name }),
              true,
            );
          }
          if (
            e.payload.name === "create_agent_session" ||
            e.payload.name === "prompt_agent"
          ) {
            window.dispatchEvent(
              new CustomEvent("grok-app:voice-session-changed"),
            );
          }
        });
        unsubs.push(u5);
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

  if (!open) return null;

  const statusLabel = busy
    ? tt("voice.connecting")
    : state?.speaking
      ? tt("voice.speaking")
      : state?.listening
        ? tt("voice.listening")
        : tt("voice.live");

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
            <div className="voice-overlay__status">{statusLabel}</div>
          </div>
          <button type="button" className="voice-overlay__end" onClick={handleEnd}>
            {tt("voice.end")}
          </button>
        </header>

        {error ? <div className="voice-overlay__error">{error}</div> : null}

        <div className="voice-overlay__wave" aria-hidden>
          <span className={cn("voice-overlay__bar", state?.listening && "is-on")} />
          <span className={cn("voice-overlay__bar", state?.speaking && "is-on")} />
          <span className={cn("voice-overlay__bar", state?.listening && "is-on")} />
          <span className={cn("voice-overlay__bar", state?.speaking && "is-on")} />
          <span className={cn("voice-overlay__bar", state?.listening && "is-on")} />
        </div>

        <div className="voice-overlay__transcript">
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

        <section className="voice-overlay__delegated">
          <div className="voice-overlay__delegated-title">{tt("voice.delegated")}</div>
          {(state?.delegatedSessionIds?.length ?? 0) === 0 ? (
            <div className="voice-overlay__muted">{tt("voice.noDelegated")}</div>
          ) : (
            <ul className="voice-overlay__chips">
              {(state?.delegatedSessionIds ?? []).map((id) => (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => onOpenSession?.(id)}
                  >
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
