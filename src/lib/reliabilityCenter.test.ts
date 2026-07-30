import { describe, expect, it } from "vitest";
import {
  assembleReliabilityCenter,
  buildReliabilityCenter,
  buildStallTimelineSnapshot,
  collectLiveStallSignals,
  collectReliabilityBusySessions,
  mergeErrorEntries,
  mergeStallSignals,
  prependReliabilityRing,
  reliabilityErrorFromDeck,
  reliabilityStallFromEvent,
  serializeStallTimelineSnapshot,
  STALL_TIMELINE_FIELD_MAX,
  type ReliabilityErrorEntry,
  type ReliabilityStallSignal,
} from "./reliabilityCenter";
import { emptyLiveSnapshot, type SessionLiveMap } from "./sessionLiveStore";

describe("prependReliabilityRing", () => {
  it("prepends newest and caps length", () => {
    const a = { id: "a", n: 1 };
    const b = { id: "b", n: 2 };
    const c = { id: "c", n: 3 };
    expect(prependReliabilityRing([], a, 2)).toEqual([a]);
    expect(prependReliabilityRing([a], b, 2)).toEqual([b, a]);
    expect(prependReliabilityRing([b, a], c, 2)).toEqual([c, b]);
  });

  it("replaces same id instead of duplicating", () => {
    const a1 = { id: "a", n: 1 };
    const a2 = { id: "a", n: 2 };
    expect(prependReliabilityRing([a1], a2, 4)).toEqual([a2]);
  });

  it("returns empty when max is 0", () => {
    expect(prependReliabilityRing([{ id: "a" }], { id: "b" }, 0)).toEqual([]);
  });
});

describe("collectReliabilityBusySessions", () => {
  it("lists busy sessions with titles", () => {
    const liveMap: SessionLiveMap = {
      a: {
        ...emptyLiveSnapshot("a", 10),
        state: "streaming",
        liveToolTitle: "bash",
      },
      b: {
        ...emptyLiveSnapshot("b", 20),
        state: "awaiting_permission",
        awaitingPermission: true,
      },
      c: { ...emptyLiveSnapshot("c", 5), state: "ready" },
    };
    const rows = collectReliabilityBusySessions({
      liveMap,
      sessions: [
        { id: "a", title: "Fix CI" },
        { id: "b", title: "Review PR" },
      ],
      currentSessionId: "a",
      untitledLabel: "Untitled",
    });
    expect(rows.map((r) => r.sessionId)).toEqual(["a", "b"]);
    expect(rows[0]!.title).toBe("Fix CI");
    expect(rows[0]!.liveToolTitle).toBe("bash");
    expect(rows[0]!.isCurrent).toBe(true);
    expect(rows[1]!.status).toBe("awaiting_permission");
  });

  it("honors max cap", () => {
    const liveMap: SessionLiveMap = {
      a: { ...emptyLiveSnapshot("a", 3), state: "streaming" },
      b: { ...emptyLiveSnapshot("b", 2), state: "streaming" },
      c: { ...emptyLiveSnapshot("c", 1), state: "connecting" },
    };
    const rows = collectReliabilityBusySessions({
      liveMap,
      sessions: [],
      max: 2,
    });
    expect(rows).toHaveLength(2);
  });
});

describe("collectLiveStallSignals", () => {
  it("includes active soft stall and terminal stall reasons", () => {
    const liveMap: SessionLiveMap = {
      s1: {
        ...emptyLiveSnapshot("s1", 100),
        state: "ready",
        terminalReason: "stall",
      },
      s2: {
        ...emptyLiveSnapshot("s2", 50),
        state: "ready",
        terminalReason: "user_stop",
      },
    };
    const signals = collectLiveStallSignals({
      liveMap,
      sessions: [{ id: "s1", title: "Long run" }],
      activeStreamStall: {
        sessionId: "view",
        stallSeconds: 120,
        tier: "working_tools",
      },
      untitledLabel: "Untitled",
      nowMs: 1000,
    });
    expect(signals.some((s) => s.kind === "active" && s.stallSeconds === 120)).toBe(
      true,
    );
    expect(
      signals.some(
        (s) => s.kind === "terminal" && s.sessionId === "s1" && s.title === "Long run",
      ),
    ).toBe(true);
    expect(signals.some((s) => s.sessionId === "s2")).toBe(false);
  });

  it("returns empty when nothing stalled", () => {
    const liveMap: SessionLiveMap = {
      s1: { ...emptyLiveSnapshot("s1", 1), state: "ready", terminalReason: null },
    };
    expect(
      collectLiveStallSignals({
        liveMap,
        sessions: [],
        activeStreamStall: null,
      }),
    ).toEqual([]);
  });
});

describe("mergeStallSignals / mergeErrorEntries", () => {
  it("merges live first then recent with cap", () => {
    const live: ReliabilityStallSignal[] = [
      reliabilityStallFromEvent({
        kind: "active",
        sessionId: "a",
        stallSeconds: 90,
        at: 200,
      }),
    ];
    const recent: ReliabilityStallSignal[] = [
      reliabilityStallFromEvent({
        kind: "hard_end",
        sessionId: "b",
        stallSeconds: 300,
        at: 100,
      }),
      reliabilityStallFromEvent({
        kind: "hard_end",
        sessionId: "c",
        stallSeconds: 200,
        at: 50,
      }),
    ];
    const merged = mergeStallSignals(live, recent, 2);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.kind).toBe("active");
    expect(merged[1]!.kind).toBe("hard_end");
  });

  it("soft-dedupes error entries by code+problem", () => {
    const cur: ReliabilityErrorEntry[] = [
      reliabilityErrorFromDeck({
        code: "CLI_NOT_FOUND",
        problem: "CLI missing",
        at: 10,
      }),
    ];
    const recent: ReliabilityErrorEntry[] = [
      reliabilityErrorFromDeck({
        code: "CLI_NOT_FOUND",
        problem: "CLI missing",
        at: 5,
      }),
      reliabilityErrorFromDeck({
        code: "AUTH_FAILED",
        problem: "Auth failed",
        at: 1,
      }),
    ];
    const merged = mergeErrorEntries(cur, recent, 8);
    expect(merged.map((e) => e.code)).toEqual(["CLI_NOT_FOUND", "AUTH_FAILED"]);
  });
});

describe("assembleReliabilityCenter", () => {
  it("flags empty when no signals", () => {
    const view = assembleReliabilityCenter({});
    expect(view.empty).toBe(true);
    expect(view.hasBusy).toBe(false);
    expect(view.hasStalls).toBe(false);
    expect(view.hasErrors).toBe(false);
    expect(view.busy.count).toBe(0);
    expect(view.stalls.count).toBe(0);
    expect(view.errors.count).toBe(0);
  });

  it("aggregates counts from inputs", () => {
    const view = assembleReliabilityCenter({
      busySessions: [
        {
          sessionId: "a",
          title: "A",
          status: "streaming",
          liveToolTitle: null,
          isCurrent: true,
          updatedAt: 1,
        },
      ],
      stallSignals: [
        reliabilityStallFromEvent({ kind: "hard_end", sessionId: "a", at: 2 }),
      ],
      errorEntries: [
        reliabilityErrorFromDeck({ problem: "Boom", code: "AGENT_CRASHED", at: 3 }),
      ],
    });
    expect(view.empty).toBe(false);
    expect(view.hasBusy).toBe(true);
    expect(view.hasStalls).toBe(true);
    expect(view.hasErrors).toBe(true);
    expect(view.busy.count).toBe(1);
    expect(view.stalls.count).toBe(1);
    expect(view.errors.count).toBe(1);
  });
});

describe("buildReliabilityCenter", () => {
  it("full pipeline: busy + live stall + rings + honest empty parts", () => {
    const liveMap: SessionLiveMap = {
      a: {
        ...emptyLiveSnapshot("a", 30),
        state: "streaming",
        liveToolTitle: "npm test",
      },
      b: {
        ...emptyLiveSnapshot("b", 20),
        state: "ready",
        terminalReason: "stall",
      },
    };
    const view = buildReliabilityCenter({
      liveMap,
      sessions: [
        { id: "a", title: "CI fix" },
        { id: "b", title: "Stalled chat" },
      ],
      currentSessionId: "a",
      activeStreamStall: null,
      recentStalls: [
        reliabilityStallFromEvent({
          kind: "hard_end",
          sessionId: "b",
          stallSeconds: 600,
          title: "Stalled chat",
          at: 5,
        }),
      ],
      recentErrors: [],
      currentErrors: [],
      nowMs: 1000,
    });
    expect(view.hasBusy).toBe(true);
    expect(view.busy.sessions[0]!.title).toBe("CI fix");
    expect(view.hasStalls).toBe(true);
    expect(view.stalls.signals.some((s) => s.kind === "terminal")).toBe(true);
    expect(view.stalls.signals.some((s) => s.kind === "hard_end")).toBe(true);
    expect(view.hasErrors).toBe(false);
    expect(view.empty).toBe(false);
  });

  it("empty when idle map and no rings", () => {
    const view = buildReliabilityCenter({
      liveMap: {
        x: { ...emptyLiveSnapshot("x", 1), state: "ready" },
      },
      sessions: [{ id: "x", title: "Idle" }],
    });
    expect(view.empty).toBe(true);
  });
});

describe("buildStallTimelineSnapshot", () => {
  it("builds a redacted support-bundle snapshot from stall signals", () => {
    const signals: ReliabilityStallSignal[] = [
      reliabilityStallFromEvent({
        kind: "hard_end",
        sessionId: "s1",
        title: "Long run",
        stallSeconds: 120,
        tier: "hard",
        reason: "stall",
        at: 1000,
      }),
      {
        id: "active:s2:45",
        sessionId: "s2",
        title: "Soft quiet",
        kind: "active",
        stallSeconds: 45,
        tier: "soft",
        reason: "stall",
        at: 2000,
      },
    ];
    const snap = buildStallTimelineSnapshot(signals, {
      generatedAt: "2026-07-30T12:00:00.000Z",
    });
    expect(snap.kind).toBe("stall_timeline");
    expect(snap.source).toBe("reliability_center");
    expect(snap.generatedAt).toBe("2026-07-30T12:00:00.000Z");
    expect(snap.count).toBe(2);
    expect(snap.signals).toHaveLength(2);
    expect(snap.signals[0]).toMatchObject({
      sessionId: "s1",
      title: "Long run",
      kind: "hard_end",
      stallSeconds: 120,
      tier: "hard",
      reason: "stall",
      at: 1000,
    });
    // Only known keys — no accidental secret-bearing fields.
    for (const row of snap.signals) {
      expect(Object.keys(row).sort()).toEqual(
        [
          "at",
          "id",
          "kind",
          "reason",
          "sessionId",
          "stallSeconds",
          "tier",
          "title",
        ].sort(),
      );
    }
    const json = serializeStallTimelineSnapshot(snap);
    expect(json).toContain('"kind": "stall_timeline"');
    expect(json).not.toContain("sk-");
  });

  it("caps title length and drops invalid kinds / duplicate ids", () => {
    const long = "t".repeat(STALL_TIMELINE_FIELD_MAX + 40);
    const signals = [
      reliabilityStallFromEvent({
        kind: "terminal",
        sessionId: "a",
        title: long,
        at: 1,
      }),
      reliabilityStallFromEvent({
        kind: "terminal",
        sessionId: "a",
        title: "dup-id-will-lose",
        at: 1,
      }),
      {
        id: "bad",
        sessionId: null,
        title: null,
        kind: "not_a_kind" as ReliabilityStallSignal["kind"],
        stallSeconds: null,
        tier: null,
        reason: null,
        at: 2,
      },
    ];
    // Force same id on second row
    signals[1] = { ...signals[1]!, id: signals[0]!.id };
    const snap = buildStallTimelineSnapshot(signals, { max: 10 });
    expect(snap.count).toBe(1);
    expect(snap.signals[0]!.title!.length).toBe(STALL_TIMELINE_FIELD_MAX);
  });

  it("honors max and empty input", () => {
    expect(buildStallTimelineSnapshot([], { max: 5 }).count).toBe(0);
    const many = Array.from({ length: 8 }, (_, i) =>
      reliabilityStallFromEvent({
        kind: "hard_end",
        sessionId: `s${i}`,
        at: i + 1,
      }),
    );
    expect(buildStallTimelineSnapshot(many, { max: 3 }).signals).toHaveLength(
      3,
    );
  });
});
