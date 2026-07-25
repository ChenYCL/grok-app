/**
 * Pure Host ↔ UI phase reconcile (CodePilot stream-phase-reconcile style).
 * Does not invent streaming without a live reader — only corrects stuck busy.
 */

import type { SessionState } from "./session";
import { canSend, isSessionLiveStreaming } from "./session";
import type { StopLatchState } from "./stopLatch";
import { canSendWithStopLatch } from "./stopLatch";

export type UiBusyGate = {
  /** Composer may send */
  sendable: boolean;
  /** Show quiet thinking placeholder */
  quietThinking: boolean;
  /** UI should clear streaming flags / force idle projection */
  forceIdle: boolean;
  /** Session is in a live turn for sidebar badge */
  liveBusy: boolean;
};

/**
 * Reconcile host session state with optional stop latch.
 */
export function reconcileUiBusyGate(input: {
  hostState: SessionState;
  stopLatch?: StopLatchState;
  /** True when messages still have streaming assistant */
  hasStreamingAssistant?: boolean;
  /** True when a tool is still marked running in current turn */
  hasRunningTool?: boolean;
}): UiBusyGate {
  const host = input.hostState;
  const latch = input.stopLatch ?? {
    phase: "idle" as const,
    sessionId: null,
    startedAt: null,
  };
  const forceIdle = latch.phase === "force_idle";
  const sendable = canSendWithStopLatch(host, latch);
  const liveBusy =
    !forceIdle &&
    (isSessionLiveStreaming(host) ||
      !!input.hasStreamingAssistant ||
      !!input.hasRunningTool);
  const quietThinking =
    liveBusy && !input.hasStreamingAssistant && !input.hasRunningTool;

  return {
    sendable,
    quietThinking,
    forceIdle,
    liveBusy,
  };
}

/**
 * When opening a session, if UI cache says streaming but host snapshot is ready/idle,
 * prefer host (clear stuck busy).
 */
export function reconcileSessionState(
  hostState: SessionState,
  uiCached?: SessionState | null,
): SessionState {
  if (!uiCached) return hostState;
  // Host terminal + UI still streaming → host wins
  if (
    (hostState === "ready" ||
      hostState === "idle" ||
      hostState === "disconnected") &&
    isSessionLiveStreaming(uiCached)
  ) {
    return hostState;
  }
  // Host streaming, UI idle → host wins
  if (isSessionLiveStreaming(hostState) && canSend(uiCached)) {
    return hostState;
  }
  return hostState;
}

/** Dual-tier stall copy keys (pre first token vs mid-stream silence). */
export type StallTier = "pre_first_token" | "post_first_token";

export function stallTierFromProgress(input: {
  sawModelOutput: boolean;
}): StallTier {
  return input.sawModelOutput ? "post_first_token" : "pre_first_token";
}

export function stallMessageKey(tier: StallTier):
  | "endOfTurn.stallPreToken"
  | "endOfTurn.stall" {
  return tier === "pre_first_token"
    ? "endOfTurn.stallPreToken"
    : "endOfTurn.stall";
}
