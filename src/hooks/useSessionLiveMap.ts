/**
 * React bindings for sessionLiveMapStore.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  sessionLiveMapStore,
  type LiveMapBusyMeta,
} from "@/lib/sessionLiveMapStore";
import {
  busySessionIds,
  type SessionLiveMap,
  type SessionLiveSnapshot,
} from "@/lib/sessionLiveStore";

/** Full live map — use in panels that need every session row. */
export function useLiveMap(): SessionLiveMap {
  return useSyncExternalStore(
    sessionLiveMapStore.subscribeMap,
    sessionLiveMapStore.getMapSnapshot,
    sessionLiveMapStore.getMapSnapshot,
  );
}

/** Busy membership only — sidebar chrome / tray badge. */
export function useLiveMapBusyMeta(): LiveMapBusyMeta {
  return useSyncExternalStore(
    sessionLiveMapStore.subscribeBusy,
    sessionLiveMapStore.getBusySnapshot,
    sessionLiveMapStore.getBusySnapshot,
  );
}

export function useLiveMapBusyIds(): Set<string> {
  const meta = useLiveMapBusyMeta();
  return useMemo(() => {
    if (!meta.busyKey) return new Set<string>();
    return new Set(meta.busyKey.split("\0").filter(Boolean));
  }, [meta.busyKey]);
}

export function useLiveSessionSnapshot(
  sessionId: string | null | undefined,
): SessionLiveSnapshot | null {
  const map = useLiveMap();
  if (!sessionId) return null;
  return map[sessionId] ?? null;
}

export function useLiveMapActions() {
  const setLiveMap = useCallback(
    (next: SessionLiveMap | ((prev: SessionLiveMap) => SessionLiveMap)) => {
      sessionLiveMapStore.setLiveMap(next);
    },
    [],
  );
  return { setLiveMap };
}

/** Stable busy id set from a one-shot map read (event handlers). */
export function peekBusySessionIds(): Set<string> {
  return busySessionIds(sessionLiveMapStore.getMap());
}
