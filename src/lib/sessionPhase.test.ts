import { describe, expect, it } from "vitest";
import {
  reconcileSessionState,
  reconcileUiBusyGate,
  stallMessageKey,
  stallTierFromProgress,
} from "./sessionPhase";
import { armStopLatch, createStopLatchState, tickStopLatch, STOP_LATCH_MS } from "./stopLatch";

describe("sessionPhase", () => {
  it("reconcileUiBusyGate force idle unlocks send", () => {
    let latch = armStopLatch(createStopLatchState(), "s", 0);
    latch = tickStopLatch(latch, "streaming", STOP_LATCH_MS).latch;
    const gate = reconcileUiBusyGate({
      hostState: "streaming",
      stopLatch: latch,
    });
    expect(gate.sendable).toBe(true);
    expect(gate.forceIdle).toBe(true);
  });

  it("host ready wins over stuck ui streaming", () => {
    expect(reconcileSessionState("ready", "streaming")).toBe("ready");
    expect(reconcileSessionState("streaming", "ready")).toBe("streaming");
  });

  it("stall tier keys differ pre/post first token", () => {
    expect(stallTierFromProgress({ sawModelOutput: false })).toBe(
      "pre_first_token",
    );
    expect(stallMessageKey("pre_first_token")).toBe("endOfTurn.stallPreToken");
    expect(stallMessageKey("post_first_token")).toBe("endOfTurn.stall");
  });
});
