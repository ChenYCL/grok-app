/**
 * Session runtime: messages / liveMap / stop latch / viewing session coordination.
 * Owns projection state so AppWorkbench stays a shell over Host event wiring + send.
 *
 * Stream hot path uses external stores so token growth does not force every
 * workbench subscriber to reconcile (Intel Retina multi-turn).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  canStopWithStopLatch,
  createStopLatchState,
  type StopLatchState,
} from "@/lib/stopLatch";
import {
  isSessionLiveStreaming,
  type ChatMessage,
} from "@/lib/session";
import {
  settleStoppedSessionInLiveMap,
  settleStoppedSessionSnapshot,
  type SessionLiveMap,
} from "@/lib/sessionLiveStore";
import { reconcileUiBusyGate } from "@/lib/sessionPhase";
import { type ViewFocus } from "@/lib/viewFocus";
import { canLiveParticipate } from "@/lib/multiWindow";
import { sessionTranscriptStore } from "@/lib/sessionTranscriptStore";
import {
  useTranscriptActions,
  useTranscriptMeta,
} from "@/hooks/useSessionTranscript";
import {
  useLiveMap,
  useLiveMapActions,
  useLiveMapBusyIds,
} from "@/hooks/useSessionLiveMap";
import {
  useFocusedSession,
  useLiveHost,
  useSessionShellActions,
} from "@/hooks/useSessionShell";
import { useSessionRuntimeRefs } from "@/hooks/useSessionRuntimeRefs";

export type { SessionLiveMap };

export function useSessionRuntime(opts?: {
  isSecondaryWindow?: boolean;
}) {
  const isSecondaryWindow = opts?.isSecondaryWindow ?? false;

  const session = useFocusedSession();
  const liveHost = useLiveHost();
  const { setSession, setLiveHost } = useSessionShellActions();

  const liveMap = useLiveMap();
  const { setLiveMap } = useLiveMapActions();
  const busyIdsFromStore = useLiveMapBusyIds();
  const { liveMapRef, liveHostRef } = useSessionRuntimeRefs({
    liveMap,
    liveHost,
  });

  /** Stop interrupt honesty latch (force unlock after budget). */
  const [stopLatch, setStopLatch] = useState<StopLatchState>(() =>
    createStopLatchState(),
  );
  const stopLatchRef = useRef<StopLatchState>(createStopLatchState());
  stopLatchRef.current = stopLatch;

  const transcriptMeta = useTranscriptMeta();
  const { setMessages, patchSessionMessages: patchStore } =
    useTranscriptActions();
  /**
   * Structural shell mirror — token growth does not update this array.
   * ConversationThreadLive subscribes to full content separately.
   */
  const [messages, setShellMessages] = useState<ChatMessage[]>(() =>
    sessionTranscriptStore.getMessages(),
  );
  useEffect(() => {
    setShellMessages(sessionTranscriptStore.getMessages());
  }, [transcriptMeta.structuralRev]);

  const messagesRef = useRef<ChatMessage[]>(messages);
  useEffect(() => {
    return sessionTranscriptStore.subscribeContent(() => {
      messagesRef.current = sessionTranscriptStore.getMessages();
    });
  }, []);
  messagesRef.current = sessionTranscriptStore.getMessages();

  const messagesBySessionRef = useRef(sessionTranscriptStore.getBySessionMap());
  const viewingSessionIdRef = useRef<string | null>(null);
  const viewEpochRef = useRef(0);

  useEffect(() => {
    sessionTranscriptStore.setViewingSessionId(session.sessionId);
    sessionTranscriptStore.setViewingIdResolver(
      () => viewingSessionIdRef.current,
    );
    return () => sessionTranscriptStore.setViewingIdResolver(null);
  }, [session.sessionId]);

  // Keep viewing id aligned when React session id updates (when not opening).
  useEffect(() => {
    if (viewingSessionIdRef.current == null && session.sessionId) {
      viewingSessionIdRef.current = session.sessionId;
    }
  }, [session.sessionId]);

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

  const patchSessionMessages = useCallback(
    (
      targetSessionId: string | undefined | null,
      reduce: (prev: ChatMessage[]) => ChatMessage[],
    ) => {
      patchStore(targetSessionId, reduce);
    },
    [patchStore],
  );

  const busyIds = useMemo(() => {
    const set = new Set(busyIdsFromStore);
    if (
      liveHost.sessionId &&
      isSessionLiveStreaming(liveHost.state) &&
      !set.has(liveHost.sessionId)
    ) {
      set.add(liveHost.sessionId);
    }
    return set;
  }, [busyIdsFromStore, liveHost.sessionId, liveHost.state]);

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
  }, [setLiveMap, setLiveHost, setSession, liveMapRef, liveHostRef]);

  const stopGate = useMemo(
    () =>
      reconcileUiBusyGate({
        hostState: session.state,
        stopLatch,
      }),
    [session.state, stopLatch],
  );

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
    /** Structural transcript meta for shell empty/streaming gates. */
    transcriptMeta,
  };
}
