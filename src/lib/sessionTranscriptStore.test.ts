import { describe, expect, it, beforeEach, vi } from "vitest";
import { sessionTranscriptStore } from "./sessionTranscriptStore";
import type { ChatMessage } from "./session";
import { resolveTranscriptContentNotifyMs } from "./streamRenderPolicy";

const msg = (
  partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role">,
): ChatMessage => ({
  content: "",
  ...partial,
});

describe("sessionTranscriptStore", () => {
  beforeEach(() => {
    sessionTranscriptStore.resetForTests();
  });

  it("notifies content on stream growth but keeps structuralRev stable", () => {
    sessionTranscriptStore.setViewingSessionId("s1");
    sessionTranscriptStore.setMessages([
      msg({ id: "u1", role: "user", content: "hi" }),
      msg({ id: "a1", role: "assistant", content: "he", streaming: true }),
    ]);
    const rev1 = sessionTranscriptStore.getMetaSnapshot().structuralRev;
    let contentTicks = 0;
    let metaTicks = 0;
    const unsubC = sessionTranscriptStore.subscribeContent(() => {
      contentTicks += 1;
    });
    const unsubM = sessionTranscriptStore.subscribeMeta(() => {
      metaTicks += 1;
    });

    sessionTranscriptStore.setMessages((prev) =>
      prev.map((m) =>
        m.id === "a1" ? { ...m, content: m.content + "llo" } : m,
      ),
    );

    expect(sessionTranscriptStore.getMessages()[1]!.content).toBe("hello");
    expect(contentTicks).toBe(1);
    expect(metaTicks).toBe(0);
    expect(sessionTranscriptStore.getMetaSnapshot().structuralRev).toBe(rev1);

    unsubC();
    unsubM();
  });

  it("bumps structuralRev when streaming ends", () => {
    sessionTranscriptStore.setViewingSessionId("s1");
    sessionTranscriptStore.setMessages([
      msg({ id: "a1", role: "assistant", content: "x", streaming: true }),
    ]);
    const rev1 = sessionTranscriptStore.getMetaSnapshot().structuralRev;
    let metaTicks = 0;
    const unsubM = sessionTranscriptStore.subscribeMeta(() => {
      metaTicks += 1;
    });

    sessionTranscriptStore.setMessages((prev) =>
      prev.map((m) => (m.id === "a1" ? { ...m, streaming: false } : m)),
    );

    expect(metaTicks).toBe(1);
    expect(sessionTranscriptStore.getMetaSnapshot().structuralRev).toBe(
      rev1 + 1,
    );
    expect(sessionTranscriptStore.getMetaSnapshot().hasStreamingAssistant).toBe(
      false,
    );
    unsubM();
  });

  it("patchSession only updates cache for background sessions", () => {
    sessionTranscriptStore.setViewingSessionId("s1");
    sessionTranscriptStore.setMessages([
      msg({ id: "u1", role: "user", content: "viewing" }),
    ]);
    sessionTranscriptStore.cacheSession("s2", [
      msg({ id: "u2", role: "user", content: "bg" }),
    ]);

    let contentTicks = 0;
    const unsubC = sessionTranscriptStore.subscribeContent(() => {
      contentTicks += 1;
    });

    sessionTranscriptStore.patchSession("s2", (prev) => [
      ...prev,
      msg({ id: "a2", role: "assistant", content: "done" }),
    ]);

    expect(contentTicks).toBe(0);
    expect(sessionTranscriptStore.getCached("s2")).toHaveLength(2);
    expect(sessionTranscriptStore.getMessages()).toHaveLength(1);
    unsubC();
  });

  it("throttles content notifies for rapid stream growth (trailing flush)", () => {
    vi.useFakeTimers();
    sessionTranscriptStore.setViewingSessionId("s1");
    sessionTranscriptStore.setMessages([
      msg({ id: "a1", role: "assistant", content: "a", streaming: true }),
    ]);
    let contentTicks = 0;
    const unsubC = sessionTranscriptStore.subscribeContent(() => {
      contentTicks += 1;
    });

    // Leading edge
    sessionTranscriptStore.setMessages((prev) =>
      prev.map((m) =>
        m.id === "a1" ? { ...m, content: m.content + "b" } : m,
      ),
    );
    expect(contentTicks).toBe(1);

    // Inside throttle window — no extra tick yet
    sessionTranscriptStore.setMessages((prev) =>
      prev.map((m) =>
        m.id === "a1" ? { ...m, content: m.content + "c" } : m,
      ),
    );
    expect(contentTicks).toBe(1);
    expect(sessionTranscriptStore.getMessages()[0]!.content).toBe("abc");

    vi.advanceTimersByTime(resolveTranscriptContentNotifyMs());
    expect(contentTicks).toBe(2);

    unsubC();
    vi.useRealTimers();
  });
});
