/**
 * Session runtime: messages / liveMap / stop latch / viewing session coordination.
 * Extracted boundary for WP-B3; AppWorkbench continues to own Host event wiring
 * during migration and may call into this hook for shared projection state.
 */
import { useCallback, useRef, useState } from "react";

export type SessionLiveEntry = {
  busy?: boolean;
  permission?: boolean;
  [key: string]: unknown;
};

export function useSessionRuntime() {
  const [messages, setMessages] = useState<unknown[]>([]);
  const [liveMap, setLiveMap] = useState<Record<string, SessionLiveEntry>>({});
  const liveMapRef = useRef(liveMap);
  liveMapRef.current = liveMap;
  const [viewingSessionId, setViewingSessionId] = useState<string | null>(null);
  const [stopLatch, setStopLatch] = useState(false);

  const patchLive = useCallback((sessionId: string, patch: SessionLiveEntry) => {
    setLiveMap((prev) => ({
      ...prev,
      [sessionId]: { ...prev[sessionId], ...patch },
    }));
  }, []);

  const clearStopLatch = useCallback(() => setStopLatch(false), []);
  const armStopLatch = useCallback(() => setStopLatch(true), []);

  return {
    messages,
    setMessages,
    liveMap,
    setLiveMap,
    liveMapRef,
    viewingSessionId,
    setViewingSessionId,
    stopLatch,
    setStopLatch,
    clearStopLatch,
    armStopLatch,
    patchLive,
  };
}
