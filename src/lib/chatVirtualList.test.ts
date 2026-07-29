import { describe, expect, it } from "vitest";
import {
  CHAT_VIRTUALIZE_THRESHOLD,
  computeChatVirtualWindow,
  cumulativeOffsets,
  estimateChatRowHeight,
  scrollTopAfterHeightChange,
  shouldCommitRowHeight,
} from "./chatVirtualList";

const fixed = (h: number) => () => h;

describe("computeChatVirtualWindow", () => {
  it("empty list", () => {
    expect(
      computeChatVirtualWindow({
        count: 0,
        getHeight: fixed(100),
        scrollTop: 0,
        viewportHeight: 400,
      }),
    ).toEqual({
      start: 0,
      end: 0,
      paddingTop: 0,
      paddingBottom: 0,
      totalHeight: 0,
    });
  });

  it("pinToBottom always ends at count", () => {
    const w = computeChatVirtualWindow({
      count: 50,
      getHeight: fixed(100),
      scrollTop: 0,
      viewportHeight: 400,
      pinToBottom: true,
      overscanPx: 200,
    });
    expect(w.end).toBe(50);
    expect(w.totalHeight).toBe(5000);
    // Window covers the tail
    expect(w.start).toBeLessThan(50);
    expect(w.paddingBottom).toBe(0);
  });

  it("history browse windows mid-list", () => {
    const w = computeChatVirtualWindow({
      count: 40,
      getHeight: fixed(100),
      scrollTop: 1000,
      viewportHeight: 400,
      pinToBottom: false,
      overscanPx: 100,
    });
    expect(w.start).toBeGreaterThan(0);
    expect(w.end).toBeLessThan(40);
    expect(w.paddingTop + (w.end - w.start) * 100 + w.paddingBottom).toBe(
      w.totalHeight,
    );
  });

  it("forceIndices expands the window", () => {
    const w = computeChatVirtualWindow({
      count: 40,
      getHeight: fixed(100),
      scrollTop: 3000,
      viewportHeight: 400,
      pinToBottom: false,
      overscanPx: 0,
      forceIndices: [2],
    });
    expect(w.start).toBeLessThanOrEqual(2);
    expect(w.end).toBeGreaterThan(2);
  });

  it("threshold constant is high enough to skip short chats", () => {
    expect(CHAT_VIRTUALIZE_THRESHOLD).toBeGreaterThanOrEqual(40);
  });
});

describe("estimateChatRowHeight", () => {
  it("grows with long assistant bodies (org-chart style answers)", () => {
    const short = estimateChatRowHeight({ contentLength: 80, role: "assistant" });
    const long = estimateChatRowHeight({ contentLength: 7300, role: "assistant" });
    expect(long).toBeGreaterThan(short);
    expect(long).toBeGreaterThan(1500);
  });

  it("user bubbles stay relatively compact", () => {
    const h = estimateChatRowHeight({ contentLength: 40, role: "user" });
    expect(h).toBeLessThan(200);
  });

  it("collapsed / empty tool rows estimate 0 (no blank pin tail)", () => {
    expect(estimateChatRowHeight({ role: "tool", collapsed: true })).toBe(0);
    expect(estimateChatRowHeight({ role: "tool", contentLength: 0 })).toBe(0);
    expect(
      estimateChatRowHeight({ role: "tool", contentLength: 20 }),
    ).toBeLessThan(50);
  });
});

describe("shouldCommitRowHeight", () => {
  it("accepts first measure and real growth", () => {
    expect(shouldCommitRowHeight(undefined, 400)).toBe(true);
    expect(shouldCommitRowHeight(120, 3000)).toBe(true);
  });

  it("commits zero height for inlined tool spacers (not phantom scroll)", () => {
    expect(shouldCommitRowHeight(undefined, 0)).toBe(true);
    expect(shouldCommitRowHeight(40, 0)).toBe(true);
    expect(shouldCommitRowHeight(0, 0)).toBe(false);
  });

  it("pin window still reaches early rows when trailing heights are 0", () => {
    // user + assistant + 64 zero-height tools (cc6d8b01-style journal)
    const heights = [80, 2000, ...Array(64).fill(0)];
    const w = computeChatVirtualWindow({
      count: heights.length,
      getHeight: (i) => heights[i] ?? 0,
      scrollTop: 0,
      viewportHeight: 600,
      pinToBottom: true,
      overscanPx: 1600,
    });
    expect(w.end).toBe(heights.length);
    // Must include the assistant at index 1 (not only trailing zeros).
    expect(w.start).toBeLessThanOrEqual(1);
    expect(w.totalHeight).toBe(2080);
  });

  it("pin window with inflated tool estimates misses early content (regression)", () => {
    // Pre-fix: 64 tools estimated at 40px each — pin only sees the tail.
    const heights = [80, 2000, ...Array(64).fill(40)];
    const w = computeChatVirtualWindow({
      count: heights.length,
      getHeight: (i) => heights[i] ?? 0,
      scrollTop: 0,
      viewportHeight: 600,
      pinToBottom: true,
      overscanPx: 400,
    });
    expect(w.start).toBeGreaterThan(1);
  });

  it("ignores tiny flicker and small shrink thrash", () => {
    expect(shouldCommitRowHeight(400, 401)).toBe(false);
    expect(shouldCommitRowHeight(400, 390)).toBe(false);
  });

  it("commits zero height so collapsed spacers correct estimates", () => {
    expect(shouldCommitRowHeight(undefined, 0)).toBe(true);
    expect(shouldCommitRowHeight(120, 0)).toBe(true);
    expect(shouldCommitRowHeight(0, 0)).toBe(false);
  });
});

describe("scrollTopAfterHeightChange", () => {
  it("does not adjust when pinned", () => {
    expect(
      scrollTopAfterHeightChange({
        scrollTop: 500,
        rowOffset: 100,
        prevHeight: 80,
        delta: 40,
        pinToBottom: true,
      }),
    ).toBe(500);
  });

  it("shifts when entire row was above viewport and grows", () => {
    expect(
      scrollTopAfterHeightChange({
        scrollTop: 500,
        rowOffset: 100,
        prevHeight: 80,
        delta: 40,
        pinToBottom: false,
      }),
    ).toBe(540);
  });

  it("does not shift tall straddling media row growth (near-bottom bounce)", () => {
    // Assistant starts at 100, height 800; user reading lower half at scrollTop 500.
    // Images load (+200) at bottom of the same row — must not yank down.
    expect(
      scrollTopAfterHeightChange({
        scrollTop: 500,
        rowOffset: 100,
        prevHeight: 800,
        delta: 200,
        pinToBottom: false,
      }),
    ).toBe(500);
  });

  it("ignores rows at or below viewport top", () => {
    expect(
      scrollTopAfterHeightChange({
        scrollTop: 500,
        rowOffset: 500,
        prevHeight: 120,
        delta: 40,
        pinToBottom: false,
      }),
    ).toBe(500);
  });
});

describe("cumulativeOffsets", () => {
  it("builds prefix sums", () => {
    expect(cumulativeOffsets(3, (i) => (i + 1) * 10)).toEqual([0, 10, 30, 60]);
  });
});
