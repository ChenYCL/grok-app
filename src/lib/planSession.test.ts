import { describe, expect, it } from "vitest";
import {
  closedSessionPlan,
  emptySessionPlan,
  mergePlanFromEvent,
  shouldReopenClosedPlan,
} from "./planSession";

describe("planSession hard dismiss", () => {
  it("empty plan is not visible", () => {
    const p = emptySessionPlan("t");
    expect(p.visible).toBe(false);
    expect(p.userClosed).toBe(false);
    expect(p.entries).toEqual([]);
    expect(p.closedRpcId).toBeNull();
  });

  it("closed plan stays suppressed for same-cycle updates", () => {
    const closed = closedSessionPlan("t", "tool-1");
    expect(
      shouldReopenClosedPlan(
        closed,
        { toolCallId: "tool-1", entries: [{ content: "step", status: "pending" }] },
        "agent",
      ),
    ).toBe(false);

    const next = mergePlanFromEvent(
      closed,
      { toolCallId: "tool-1", entries: [{ content: "step", status: "in_progress" }] },
      "ready",
      "agent",
    );
    expect(next.userClosed).toBe(true);
    expect(next.visible).toBe(false);
    expect(next.entries).toEqual([]);
  });

  it("stays suppressed while composer is still plan mode (same cycle)", () => {
    // Hard-dismiss while still in plan mode used to reopen on every residual
    // session://plan update because composerMode === "plan".
    const closed = closedSessionPlan("t", "tool-1", 7);
    expect(
      shouldReopenClosedPlan(
        closed,
        {
          toolCallId: "tool-1",
          entries: [{ content: "a", status: "in_progress" }],
        },
        "plan",
      ),
    ).toBe(false);

    const next = mergePlanFromEvent(
      closed,
      {
        toolCallId: "tool-1",
        entries: [{ content: "a", status: "completed" }],
        body: "# leftover",
      },
      "ready",
      "plan",
    );
    expect(next.userClosed).toBe(true);
    expect(next.visible).toBe(false);
    expect(next.body).toBe("");
    expect(next.entries).toEqual([]);
  });

  it("does not reopen the abandoned exit_plan_mode rpcId", () => {
    const closed = closedSessionPlan("t", "tool-1", 42);
    expect(
      shouldReopenClosedPlan(
        closed,
        { rpcId: 42, body: "# Plan\n..." },
        "plan",
      ),
    ).toBe(false);

    const next = mergePlanFromEvent(
      closed,
      { rpcId: 42, body: "# Plan\n..." },
      "ready",
      "plan",
    );
    expect(next.userClosed).toBe(true);
    expect(next.visible).toBe(false);
  });

  it("reopens on new toolCallId (new plan tool)", () => {
    const closed = closedSessionPlan("t", "tool-1");
    const next = mergePlanFromEvent(
      closed,
      {
        toolCallId: "tool-2",
        entries: [{ content: "new", status: "pending" }],
      },
      "ready",
      "agent",
    );
    expect(next.userClosed).toBe(false);
    expect(next.visible).toBe(true);
    expect(next.toolCallId).toBe("tool-2");
  });

  it("reopens on a new exit_plan_mode rpcId", () => {
    const closed = closedSessionPlan("t", "tool-1", 7);
    const next = mergePlanFromEvent(
      closed,
      { rpcId: 42, body: "# Plan\n..." },
      "ready",
      "agent",
    );
    expect(next.userClosed).toBe(false);
    expect(next.visible).toBe(true);
    expect(next.rpcId).toBe(42);
  });

  it("reopens new tool while still in plan mode", () => {
    const closed = closedSessionPlan("t", "tool-1", 7);
    const next = mergePlanFromEvent(
      closed,
      {
        toolCallId: "tool-2",
        entries: [{ content: "fresh", status: "pending" }],
      },
      "ready",
      "plan",
    );
    expect(next.userClosed).toBe(false);
    expect(next.visible).toBe(true);
    expect(next.toolCallId).toBe("tool-2");
  });
});
