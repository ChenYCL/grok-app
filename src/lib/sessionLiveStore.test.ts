import { describe, expect, it } from "vitest";
import {
  busySessionIds,
  emptyLiveSnapshot,
  isSessionLiveBusy,
  projectHostIntoLiveMap,
  upsertLiveSnapshot,
} from "./sessionLiveStore";

describe("sessionLiveStore", () => {
  it("tracks multi-session busy", () => {
    let map = {};
    map = projectHostIntoLiveMap(map, {
      sessionId: "a",
      state: "streaming",
      streamingMessageId: "m1",
    });
    map = projectHostIntoLiveMap(map, {
      sessionId: "b",
      state: "awaiting_permission",
    });
    map = projectHostIntoLiveMap(map, {
      sessionId: "c",
      state: "ready",
    });
    const busy = busySessionIds(map);
    expect(busy.has("a")).toBe(true);
    expect(busy.has("b")).toBe(true);
    expect(busy.has("c")).toBe(false);
    expect(isSessionLiveBusy(map, "a")).toBe(true);
  });

  it("clears live tool when host leaves streaming", () => {
    let map = upsertLiveSnapshot(
      {},
      {
        sessionId: "a",
        state: "streaming",
        liveToolTitle: "Reading x",
        liveToolId: "t1",
      },
    );
    map = projectHostIntoLiveMap(map, { sessionId: "a", state: "ready" });
    expect(map.a!.liveToolTitle).toBeNull();
    expect(map.a!.state).toBe("ready");
  });

  it("empty snapshot defaults", () => {
    const s = emptyLiveSnapshot("x", 1);
    expect(s.sessionId).toBe("x");
    expect(s.state).toBe("idle");
  });
});
