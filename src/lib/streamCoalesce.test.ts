import { describe, expect, it, vi } from "vitest";
import {
  mergeStreamChunks,
  StreamCoalescer,
  streamChunkNeedsImmediateFlush,
  streamCoalesceKey,
} from "./streamCoalesce";

describe("streamCoalesce", () => {
  it("keys by session + message + kind", () => {
    expect(
      streamCoalesceKey({ sessionId: "s1", messageId: "m1", kind: "assistant" }),
    ).toBe(streamCoalesceKey({ sessionId: "s1", messageId: "m1", kind: "assistant" }));
    expect(
      streamCoalesceKey({ sessionId: "s1", messageId: "m1", kind: "assistant" }),
    ).not.toBe(
      streamCoalesceKey({ sessionId: "s1", messageId: "m1", kind: "thought" }),
    );
  });

  it("merges text and ORs done", () => {
    const m = mergeStreamChunks(
      { sessionId: "s", messageId: "m", kind: "assistant", text: "hel" },
      { sessionId: "s", messageId: "m", kind: "assistant", text: "lo", done: true },
    );
    expect(m).toEqual({
      sessionId: "s",
      messageId: "m",
      kind: "assistant",
      text: "hello",
      done: true,
      thoughtPhase: undefined,
    });
  });

  it("refuses merge across keys", () => {
    expect(
      mergeStreamChunks(
        { sessionId: "a", messageId: "1", kind: "assistant", text: "x" },
        { sessionId: "b", messageId: "1", kind: "assistant", text: "y" },
      ),
    ).toBeNull();
  });

  it("immediate flush on done / new thought phase", () => {
    expect(streamChunkNeedsImmediateFlush({ done: true })).toBe(true);
    expect(streamChunkNeedsImmediateFlush({ thoughtPhase: "new" })).toBe(true);
    expect(streamChunkNeedsImmediateFlush({ text: "hi" })).toBe(false);
  });

  it("coalescer batches then flushes on timer", async () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const c = new StreamCoalescer({
      flushMs: 40,
      onFlush: (ch) => out.push(ch.text ?? ""),
    });
    c.push({ sessionId: "s", messageId: "m", kind: "assistant", text: "a" });
    c.push({ sessionId: "s", messageId: "m", kind: "assistant", text: "b" });
    expect(out).toEqual([]);
    vi.advanceTimersByTime(40);
    expect(out).toEqual(["ab"]);
    c.dispose();
    vi.useRealTimers();
  });

  it("coalescer flushes immediately on done", () => {
    const out: string[] = [];
    const c = new StreamCoalescer({
      flushMs: 1000,
      onFlush: (ch) => out.push(`${ch.text}|${ch.done ? "d" : ""}`),
    });
    c.push({ sessionId: "s", messageId: "m", kind: "assistant", text: "a" });
    c.push({
      sessionId: "s",
      messageId: "m",
      kind: "assistant",
      text: "b",
      done: true,
    });
    expect(out).toEqual(["ab|d"]);
    c.dispose();
  });
});
