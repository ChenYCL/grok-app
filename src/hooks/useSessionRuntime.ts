/**
 * Session runtime: messages / liveMap / stop latch / viewing session coordination.
 * Owns projection state so AppWorkbench stays a shell over Host event wiring + send.
 * api.sessionSend contract remains in AppWorkbench (send path).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  canStopWithStopLatch,
  createStopLatchState,
  type StopLatchState,
} from "@/lib/stopLatch";
import {
  IDLE_SNAPSHOT,
  isSessionLiveStreaming,
  type ChatMessage,
  type SessionSnapshot,
} from "@/lib/session";
import {
  busySessionIds,
  settleStoppedSessionInLiveMap,
  settleStoppedSessionSnapshot,
  type SessionLiveMap,
} from "@/lib/sessionLiveStore";
import {
  reconcileUiBusyGate,
} from "@/lib/sessionPhase";
import {
  type ViewFocus,
} from "@/lib/viewFocus";
import { canLiveParticipate } from "@/lib/multiWindow";

export type { SessionLiveMap };

export function useSessionRuntime(opts?: {
  isSecondaryWindow?: boolean;
}) {
  const isSecondaryWindow = opts?.isSecondaryWindow ?? false;

  const [session, setSession] = useState<SessionSnapshot>(IDLE_SNAPSHOT);
  /** Host live agent (may differ from the session currently viewed in the UI). */
  const [liveHost, setLiveHost] = useState<SessionSnapshot>(IDLE_SNAPSHOT);
  const liveHostRef = useRef<SessionSnapshot>(IDLE_SNAPSHOT);

  /** Multi-session live projection (busy / permission badges). */
  const [liveMap, setLiveMap] = useState<SessionLiveMap>({});
  /** Latest live map for callbacks that must not close over a stale render. */
  const liveMapRef = useRef(liveMap);
  liveMapRef.current = liveMap;

  /** Stop interrupt honesty latch (force unlock after budget). */
  const [stopLatch, setStopLatch] = useState<StopLatchState>(() =>
    createStopLatchState(),
  );
  const stopLatchRef = useRef<StopLatchState>(createStopLatchState());
  stopLatchRef.current = stopLatch;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  /** Per-session message cache so switching away mid-turn does not drop the UI. */
  const messagesBySessionRef = useRef<Map<string, ChatMessage[]>>(new Map());
  const viewingSessionIdRef = useRef<string | null>(null);
  /**
   * Bumped on every user navigation (open chat / new chat). Async work captures
   * {@link currentViewFocus} before its first await and must re-check before
   * touching view state.
   */
  const viewEpochRef = useRef(0);

  const currentViewFocus = useCallback(
    (): ViewFocus => ({
      sessionId: viewingSessionIdRef.current,
      epoch: viewEpochRef.current,
    }),
    [],
  );
  const bumpViewEpoch = useCallback(() => {
    viewEpochRef.current += 1;
  }, []);

  useEffect(() => {
    liveHostRef.current = liveHost;
  }, [liveHost]);

  // Mirror viewed-session messages into the cache on every change.
  useEffect(() => {
    messagesRef.current = messages;
    const id = session.sessionId;
    if (!id) return;
    messagesBySessionRef.current.set(id, messages);
  }, [messages, session.sessionId]);

  /** Apply a message reducer to the viewed session or only to the cache. */
  const patchSessionMessages = useCallback(
    (
      targetSessionId: string | undefined | null,
      reduce: (prev: ChatMessage[]) => ChatMessage[],
    ) => {
      if (!targetSessionId) return;
      if (viewingSessionIdRef.current === targetSessionId) {
        setMessages((prev) => {
          const next = reduce(prev);
          messagesBySessionRef.current.set(targetSessionId, next);
          return next;
        });
      } else {
        const prev = messagesBySessionRef.current.get(targetSessionId) ?? [];
        messagesBySessionRef.current.set(targetSessionId, reduce(prev));
      }
    },
    [],
  );

  /**
   * Multi-session busy ids (stream / permission) for sidebar spinner.
   * Uses liveMap projection + liveHost fallback. Excludes connecting.
   */
  const busyIds = useMemo(() => {
    const set = busySessionIds(liveMap);
    if (liveHost.sessionId && isSessionLiveStreaming(liveHost.state)) {
      set.add(liveHost.sessionId);
    }
    return set;
  }, [liveMap, liveHost.sessionId, liveHost.state]);

  const settleStoppedSessionUi = useCallback((sessionId: string) => {
    setLiveMap((prev) => {
      const next = settleStoppedSessionInLiveMap(prev, sessionId);
      liveMapRef.current = next;
      return next;
    });
    setLiveHost((prev) => {
      const next = settleStoppedSessionSnapshot(prev, sessionId);
      liveHostRef.current = next;
      return next;
    });
    setSession((prev) => settleStoppedSessionSnapshot(prev, sessionId));
  }, []);

  const stopGate = useMemo(
    () =>
      reconcileUiBusyGate({
        hostState: session.state,
        stopLatch,
      }),
    [session.state, stopLatch],
  );

  // Session-keyed pool: secondary shares Host — send/stop allowed (session-targeted).
  const effectiveCanSend =
    stopGate.sendable && canLiveParticipate(isSecondaryWindow);
  const effectiveCanStop =
    canLiveParticipate(isSecondaryWindow) &&
    canStopWithStopLatch(session.state, stopLatch);

  const clearStopLatch = useCallback(() => {
    const idle = createStopLatchState();
    setStopLatch(idle);
    stopLatchRef.current = idle;
  }, []);

  return {
    session,
    setSession,
    liveHost,
    setLiveHost,
    liveHostRef,
    liveMap,
    setLiveMap,
    liveMapRef,
    stopLatch,
    setStopLatch,
    stopLatchRef,
    clearStopLatch,
    messages,
    setMessages,
    messagesRef,
    messagesBySessionRef,
    viewingSessionIdRef,
    viewEpochRef,
    currentViewFocus,
    bumpViewEpoch,
    patchSessionMessages,
    busyIds,
    settleStoppedSessionUi,
    stopGate,
    effectiveCanSend,
    effectiveCanStop,
  };
}
