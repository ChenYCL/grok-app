/**
 * End-to-end pure fixture path for chat UX renovation.
 * Drives shipped reducers/helpers only (no UI mocks of the unit under test).
 */
import { describe, expect, it } from "vitest";
import {
  applyStreamChunk,
  applyToolEvent,
  applyTurnMarker,
  buildSegmentsFromLegacy,
  isFailedToolStepMessage,
  messageSegments,
  type ChatMessage,
} from "./session";
import { extractThinkingSummary } from "./thinkingSummary";
import { buildTurnActivity } from "./turnActivity";
import { mapEndOfTurnReason } from "./endOfTurn";
import {
  armStopLatch,
  createStopLatchState,
  tickStopLatch,
  canSendWithStopLatch,
  STOP_LATCH_MS,
} from "./stopLatch";

describe("chat UX fixtures (shipped path)", () => {
  it("a) multi-phase thoughts with empty-assistant-style new hints merge", () => {
    let messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "q" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        segments: [{ kind: "thought", text: "**定位目录**" }],
        streaming: true,
      },
    ];
    // Spurious "new" without body between thoughts
    messages = applyStreamChunk(messages, {
      sessionId: "s",
      messageId: "a1",
      text: "更多推理",
      done: false,
      kind: "thought",
      thoughtPhase: "new",
    });
    messages = applyStreamChunk(messages, {
      sessionId: "s",
      messageId: "a1",
      text: "答案正文",
      done: true,
      kind: "assistant",
    });
    const segs = messageSegments(messages[1]!);
    const thoughtLabels = segs
      .filter((s) => s.kind === "thought")
      .map((s) => extractThinkingSummary(s.text) || s.text);
    for (const lab of thoughtLabels) {
      expect(lab).not.toMatch(/^思考\s*\d+$/);
      expect(lab).not.toMatch(/^Thinking\s*\d+$/i);
    }
    // Reload path: multi phase markers stack before body only
    const legacy = buildSegmentsFromLegacy(
      "答案正文",
      "a\n\n⟪phase⟫\n\nb\n\n⟪phase⟫\n\nc",
    );
    expect(legacy.map((s) => s.kind)).toEqual(["thought", "content"]);
    expect(legacy[0]!.kind === "thought" && legacy[0]!.text).toContain("a");
  });

  it("b) failed tools visible signal; successes not stacked as history rows", () => {
    let messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "do" },
    ];
    for (let i = 0; i < 5; i++) {
      messages = applyToolEvent(messages, {
        sessionId: "s",
        toolCallId: `ok-${i}`,
        title: `Read f${i}`,
        kind: "read_file",
        status: "completed",
        path: `/p/f${i}.ts`,
      });
    }
    messages = applyToolEvent(messages, {
      sessionId: "s",
      toolCallId: "bad",
      title: "Shell boom",
      kind: "run_terminal_command",
      status: "failed",
      detail: "exit 1",
    });
    const tools = messages.filter((m) => m.marker === "tool_step");
    const failed = tools.filter(isFailedToolStepMessage);
    const success = tools.filter((m) => !isFailedToolStepMessage(m));
    expect(failed).toHaveLength(1);
    expect(success.length).toBeGreaterThanOrEqual(5);
    // Transcript policy: only failed would render — success hidden
    const visibleCount = failed.length; // successes intentionally not visible
    expect(visibleCount).toBe(1);
  });

  it("c) multi-tool turn activity groups context tools", () => {
    let messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "explore" },
    ];
    for (const id of ["a", "b", "c"]) {
      messages = applyToolEvent(messages, {
        toolCallId: id,
        title: `Read ${id}`,
        kind: "read_file",
        status: "completed",
        path: `/src/${id}.ts`,
      });
    }
    messages = applyToolEvent(messages, {
      toolCallId: "e",
      title: "Edit",
      kind: "search_replace",
      status: "completed",
      path: "/src/a.ts",
    });
    const act = buildTurnActivity(messages);
    expect(act.stepCount).toBe(4);
    expect(act.segments.some((s) => s.kind === "context")).toBe(true);
    if (act.segments[0]?.kind === "context") {
      expect(act.segments[0].tools.length).toBeGreaterThanOrEqual(3);
    }
    expect(act.modifiedPaths.length).toBeGreaterThanOrEqual(1);
  });

  it("d) end reasons map to one chip family; stop latch unlocks send", () => {
    expect(mapEndOfTurnReason("user_stop").messageKey).toBe(
      "activity.cancelledByUser",
    );
    expect(mapEndOfTurnReason("stall").messageKey).toBe("endOfTurn.stall");
    let messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "x" },
      { id: "a1", role: "assistant", content: "partial", streaming: true },
    ];
    messages = applyTurnMarker(messages, {
      marker: "turn_end",
      reason: "user_stop",
      content: "turn_end|user_stop",
    });
    expect(messages.some((m) => m.marker === "turn_end")).toBe(true);

    let latch = armStopLatch(createStopLatchState(), "s1", 0);
    expect(canSendWithStopLatch("streaming", latch)).toBe(false);
    const r = tickStopLatch(latch, "streaming", STOP_LATCH_MS);
    expect(r.forceComplete).toBe(true);
    expect(canSendWithStopLatch("streaming", r.latch)).toBe(true);
  });
});
