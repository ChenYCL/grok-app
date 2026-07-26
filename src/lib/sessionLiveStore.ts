/**
 * Per-session live snapshot projection (multi-session busy without retyping).
 * Host remains authoritative; this is a client-side cache keyed by sessionId.
 */

import type { ChatMessage, SessionState } from "./session";
import { isSessionLiveStreaming, pickRunningTurnTool } from "./session";
import type { EndOfTurnReason } from "./endOfTurn";

export interface SessionLiveSnapshot {
  sessionId: string;
  state: SessionState;
  streamingMessageId: string | null;
  /** Running tool title if any */
  liveToolTitle: string | null;
  liveToolId: string | null;
  terminalReason: EndOfTurnReason | null;
  /** First model output seen this turn (for stall tier) */
  sawModelOutput: boolean;
  startedAt: number | null;
  updatedAt: number;
  /** Permission waiting */
  awaitingPermission: boolean;
}

export type SessionLiveMap = Record<string, SessionLiveSnapshot>;

export function emptyLiveSnapshot(
  sessionId: string,
  nowMs: number = Date.now(),
): SessionLiveSnapshot {
  return {
    sessionId,
    state: "idle",
    streamingMessageId: null,
    liveToolTitle: null,
    liveToolId: null,
    terminalReason: null,
    sawModelOutput: false,
    startedAt: null,
    updatedAt: nowMs,
    awaitingPermission: false,
  };
}

export function upsertLiveSnapshot(
  map: SessionLiveMap,
  patch: Partial<SessionLiveSnapshot> & { sessionId: string },
  nowMs: number = Date.now(),
): SessionLiveMap {
  const prev = map[patch.sessionId] ?? emptyLiveSnapshot(patch.sessionId, nowMs);
  return {
    ...map,
    [patch.sessionId]: {
      ...prev,
      ...patch,
      updatedAt: nowMs,
    },
  };
}

/** Project Host snapshot into the live map. */
export function projectHostIntoLiveMap(
  map: SessionLiveMap,
  host: {
    sessionId: string | null;
    state: SessionState;
    streamingMessageId?: string | null;
  },
  nowMs: number = Date.now(),
): SessionLiveMap {
  if (!host.sessionId) return map;
  const awaitingPermission = host.state === "awaiting_permission";
  const live = isSessionLiveStreaming(host.state);
  return upsertLiveSnapshot(
    map,
    {
      sessionId: host.sessionId,
      state: host.state,
      streamingMessageId: host.streamingMessageId ?? null,
      awaitingPermission,
      startedAt: live
        ? (map[host.sessionId]?.startedAt ?? nowMs)
        : null,
      // Clear live tool when not streaming
      ...(live
        ? {}
        : { liveToolTitle: null, liveToolId: null, sawModelOutput: false }),
    },
    nowMs,
  );
}

/**
 * State to project when (re)opening `sessionId`.
 *
 * The Host live slot wins. Otherwise a *background* turn's snapshot is used, so
 * switching back to a demoted chat re-attaches the spinner and stream pipeline
 * instead of showing a finished-looking `idle` thread while the agent is still
 * writing into it.
 */
export function resumeStateForSession(
  sessionId: string,
  live: {
    sessionId: string | null;
    state: SessionState;
    streamingMessageId?: string | null;
  },
  map: SessionLiveMap,
): { state: SessionState; streamingMessageId: string | null } {
  if (live.sessionId && live.sessionId === sessionId) {
    return {
      state: live.state,
      streamingMessageId: live.streamingMessageId ?? null,
    };
  }
  const snap = map[sessionId];
  if (snap && (isSessionLiveStreaming(snap.state) || snap.state === "connecting")) {
    return { state: snap.state, streamingMessageId: snap.streamingMessageId };
  }
  return { state: "idle", streamingMessageId: null };
}

/** Update live tool from messages for a session. */
export function projectLiveToolFromMessages(
  map: SessionLiveMap,
  sessionId: string,
  messages: ChatMessage[],
  nowMs: number = Date.now(),
): SessionLiveMap {
  const tool = pickRunningTurnTool(messages);
  return upsertLiveSnapshot(
    map,
    {
      sessionId,
      liveToolTitle: tool ? tool.content || null : null,
      liveToolId: tool?.toolCallId ?? null,
    },
    nowMs,
  );
}

export function markSawModelOutput(
  map: SessionLiveMap,
  sessionId: string,
  nowMs: number = Date.now(),
): SessionLiveMap {
  return upsertLiveSnapshot(
    map,
    { sessionId, sawModelOutput: true },
    nowMs,
  );
}

export function setTerminalReason(
  map: SessionLiveMap,
  sessionId: string,
  reason: EndOfTurnReason | null,
  nowMs: number = Date.now(),
): SessionLiveMap {
  const patch: Partial<SessionLiveSnapshot> & { sessionId: string } = {
    sessionId,
    terminalReason: reason,
    liveToolTitle: null,
    liveToolId: null,
  };
  if (reason) patch.state = "ready";
  return upsertLiveSnapshot(map, patch, nowMs);
}

/** Session ids that should show sidebar busy/permission indicator. */
export function busySessionIds(map: SessionLiveMap): Set<string> {
  const out = new Set<string>();
  for (const s of Object.values(map)) {
    if (
      s.awaitingPermission ||
      s.state === "streaming" ||
      s.state === "awaiting_permission"
    ) {
      out.add(s.sessionId);
    }
  }
  return out;
}

export function isSessionLiveBusy(
  map: SessionLiveMap,
  sessionId: string | null | undefined,
): boolean {
  if (!sessionId) return false;
  return busySessionIds(map).has(sessionId);
}

export function sessionNeedsPermission(
  map: SessionLiveMap,
  sessionId: string | null | undefined,
): boolean {
  if (!sessionId) return false;
  const s = map[sessionId];
  return !!s?.awaitingPermission || s?.state === "awaiting_permission";
}
