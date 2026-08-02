import { describe, expect, it } from "vitest";
import {
  CHAT_VIRTUALIZE_THRESHOLD_PERF,
  resolveStreamFlushMs,
  resolveStreamOverscanScale,
  resolveTranscriptContentNotifyMs,
  shouldUsePlainStreamBody,
  STREAM_COALESCE_FLUSH_MS,
  STREAM_PLAIN_TEXT_CHAR_THRESHOLD,
  TRANSCRIPT_CONTENT_NOTIFY_MS,
} from "./streamRenderPolicy";

describe("streamRenderPolicy", () => {
  it("virtualize threshold is early enough for multi-turn agent chats", () => {
    expect(CHAT_VIRTUALIZE_THRESHOLD_PERF).toBeLessThanOrEqual(24);
    expect(CHAT_VIRTUALIZE_THRESHOLD_PERF).toBeGreaterThanOrEqual(12);
  });

  it("plain body only while streaming and past char threshold", () => {
    expect(shouldUsePlainStreamBody(100, true)).toBe(false);
    expect(
      shouldUsePlainStreamBody(STREAM_PLAIN_TEXT_CHAR_THRESHOLD, true),
    ).toBe(true);
    expect(
      shouldUsePlainStreamBody(STREAM_PLAIN_TEXT_CHAR_THRESHOLD + 1, false),
    ).toBe(false);
  });

  it("flush ms scales with hardware concurrency", () => {
    expect(resolveStreamFlushMs(4)).toBeGreaterThanOrEqual(STREAM_COALESCE_FLUSH_MS);
    expect(resolveStreamFlushMs(12)).toBe(STREAM_COALESCE_FLUSH_MS);
    expect(resolveStreamFlushMs(16)).toBeLessThan(STREAM_COALESCE_FLUSH_MS);
  });

  it("overscan scale shrinks only while streaming", () => {
    expect(resolveStreamOverscanScale(false, 12)).toBe(1);
    expect(resolveStreamOverscanScale(true, 12)).toBeLessThan(1);
    expect(resolveStreamOverscanScale(true, 16)).toBeLessThan(1);
    expect(resolveStreamOverscanScale(true, 12)).toBeLessThan(
      resolveStreamOverscanScale(true, 16),
    );
  });

  it("content notify ms scales with hardware concurrency", () => {
    expect(resolveTranscriptContentNotifyMs(4)).toBeGreaterThanOrEqual(
      TRANSCRIPT_CONTENT_NOTIFY_MS,
    );
    expect(resolveTranscriptContentNotifyMs(12)).toBe(
      TRANSCRIPT_CONTENT_NOTIFY_MS,
    );
    expect(resolveTranscriptContentNotifyMs(16)).toBeLessThan(
      TRANSCRIPT_CONTENT_NOTIFY_MS,
    );
  });
});
