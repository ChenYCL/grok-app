import { describe, expect, it } from "vitest";
import {
  applyStreamChunk,
  canSend,
  canStop,
  canType,
  errorCopy,
  type ChatMessage,
  type StreamPayload,
} from "./session";

describe("session projection", () => {
  it("input matrix Ready / Streaming / Stop (type anytime except stream)", () => {
    expect(canType("ready")).toBe(true);
    expect(canType("idle")).toBe(true);
    expect(canSend("ready")).toBe(true);
    expect(canSend("idle")).toBe(true);
    expect(canStop("ready")).toBe(false);
    expect(canStop("streaming")).toBe(true);
    expect(canType("streaming")).toBe(false);
    expect(canSend("streaming")).toBe(false);
  });

  it("applyStreamChunk grows assistant text once per chunk", () => {
    let messages: ChatMessage[] = [];
    const chunks: StreamPayload[] = [
      { sessionId: "s", messageId: "m1", text: "Hel", done: false, kind: "assistant" },
      { sessionId: "s", messageId: "m1", text: "lo", done: false, kind: "assistant" },
      { sessionId: "s", messageId: "m1", text: "", done: true, kind: "assistant" },
    ];
    for (const c of chunks) messages = applyStreamChunk(messages, c);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("Hello");
    expect(messages[0]!.streaming).toBe(false);
  });

  it("does not double-append when same sequence applied once", () => {
    let messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "hi" },
    ];
    messages = applyStreamChunk(messages, {
      sessionId: "s",
      messageId: "a1",
      text: "直接",
      done: false,
      kind: "assistant",
    });
    messages = applyStreamChunk(messages, {
      sessionId: "s",
      messageId: "a1",
      text: "干活",
      done: true,
      kind: "assistant",
    });
    expect(messages.find((m) => m.role === "assistant")!.content).toBe("直接干活");
  });

  it("errorCopy distinguishes four codes", () => {
    expect(errorCopy("CLI_NOT_FOUND")).toMatch(/CLI/i);
    expect(errorCopy("AUTH_FAILED")).toMatch(/鉴权|Auth/i);
    expect(errorCopy("NETWORK_PROVIDER")).toMatch(/网络|Network/i);
    expect(errorCopy("AGENT_CRASHED")).toMatch(/崩溃|crash|进程/i);
    expect(errorCopy("NETWORK_PROVIDER")).toMatch(/超时|timeout|网络|network/i);
  });
});
