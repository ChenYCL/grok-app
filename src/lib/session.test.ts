import { describe, expect, it } from "vitest";
import {
  applyContextCompact,
  applyGeneratedImage,
  applyStreamChunk,
  applyToolEvent,
  applyTurnError,
  canSend,
  canStop,
  canType,
  clearPriorTurnStreaming,
  errorCopy,
  formatTurnErrorBody,
  splitThoughtPhases,
  isSessionBusy,
  parseCompactContent,
  parseToolStepContent,
  pickLatestTurnTool,
  pickRunningTurnTool,
  toolStepDisplayTitle,
  preferSessionMessages,
  presentErrorBanner,
  stripAnsi,
  truncateBeforeLastUser,
  type ChatMessage,
  type StreamPayload,
} from "./session";

describe("session projection", () => {
  it("input matrix Ready / Streaming / Stop (draft ok while stream; send blocked)", () => {
    expect(canType("ready")).toBe(true);
    expect(canType("idle")).toBe(true);
    // Draft allowed while streaming so the box is never "stuck" on pauses.
    expect(canType("streaming")).toBe(true);
    expect(canType("awaiting_permission")).toBe(false);
    expect(canSend("ready")).toBe(true);
    expect(canSend("idle")).toBe(true);
    expect(canStop("ready")).toBe(false);
    expect(canStop("streaming")).toBe(true);
    expect(canSend("streaming")).toBe(false);
  });

  it("isSessionBusy covers connect / stream / permission", () => {
    expect(isSessionBusy("idle")).toBe(false);
    expect(isSessionBusy("ready")).toBe(false);
    expect(isSessionBusy("disconnected")).toBe(false);
    expect(isSessionBusy("connecting")).toBe(true);
    expect(isSessionBusy("streaming")).toBe(true);
    expect(isSessionBusy("awaiting_permission")).toBe(true);
  });

  it("truncateBeforeLastUser drops last user turn and everything after", () => {
    const msgs: ChatMessage[] = [
      { id: "u1", role: "user", content: "first" },
      { id: "a1", role: "assistant", content: "ok" },
      { id: "u2", role: "user", content: "second" },
      { id: "a2", role: "assistant", content: "fail", isError: true },
    ];
    expect(truncateBeforeLastUser(msgs)).toEqual([
      { id: "u1", role: "user", content: "first" },
      { id: "a1", role: "assistant", content: "ok" },
    ]);
    expect(
      truncateBeforeLastUser([{ id: "u1", role: "user", content: "only" }]),
    ).toEqual([]);
    expect(truncateBeforeLastUser([])).toEqual([]);
  });

  it("preferSessionMessages keeps optimistic / streaming cache over disk", () => {
    const stored: ChatMessage[] = [
      { id: "u1", role: "user", content: "old" },
    ];
    const cached: ChatMessage[] = [
      { id: "u1", role: "user", content: "hello" },
      { id: "a1", role: "assistant", content: "partial", streaming: true },
    ];
    expect(preferSessionMessages(cached, stored)).toEqual(cached);
    expect(preferSessionMessages(undefined, stored)).toEqual(stored);
    expect(preferSessionMessages([], stored)).toEqual(stored);
    // Equal length, disk has more text → prefer disk
    const doneCache: ChatMessage[] = [
      { id: "u1", role: "user", content: "hi" },
      { id: "a1", role: "assistant", content: "ok" },
    ];
    const doneStore: ChatMessage[] = [
      { id: "u1", role: "user", content: "hi" },
      { id: "a1", role: "assistant", content: "ok full" },
    ];
    expect(preferSessionMessages(doneCache, doneStore)).toEqual(doneStore);
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

  it("splitThoughtPhases separates multi-phase markers", () => {
    expect(splitThoughtPhases("a\n\n⟪phase⟫\n\nb")).toEqual(["a", "b"]);
    expect(splitThoughtPhases("only")).toEqual(["only"]);
  });

  it("thought phases stay separate on new phase hint", () => {
    let messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "hi" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        thought: "first",
        thoughtPhases: ["first"],
        segments: [{ kind: "thought", text: "first" }],
        streaming: true,
      },
    ];
    messages = applyStreamChunk(messages, {
      sessionId: "s",
      messageId: "a1",
      text: "second",
      done: false,
      kind: "thought",
      thoughtPhase: "new",
    });
    expect(messages[1]!.thoughtPhases).toEqual(["first", "second"]);
    expect(messages[1]!.segments).toEqual([
      { kind: "thought", text: "first" },
      { kind: "thought", text: "second" },
    ]);
  });

  it("interleaves thought and content in stream order", () => {
    let messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "hi" },
      { id: "a1", role: "assistant", content: "", streaming: true },
    ];
    messages = applyStreamChunk(messages, {
      sessionId: "s",
      messageId: "a1",
      text: "think1",
      done: false,
      kind: "thought",
      thoughtPhase: "open",
    });
    messages = applyStreamChunk(messages, {
      sessionId: "s",
      messageId: "a1",
      text: "hello ",
      done: false,
      kind: "assistant",
    });
    messages = applyStreamChunk(messages, {
      sessionId: "s",
      messageId: "a1",
      text: "think2",
      done: false,
      kind: "thought",
      thoughtPhase: "new",
    });
    messages = applyStreamChunk(messages, {
      sessionId: "s",
      messageId: "a1",
      text: "world",
      done: false,
      kind: "assistant",
    });
    const a = messages[1]!;
    expect(a.segments).toEqual([
      { kind: "thought", text: "think1" },
      { kind: "content", text: "hello " },
      { kind: "thought", text: "think2" },
      { kind: "content", text: "world" },
    ]);
    expect(a.content).toBe("hello world");
    expect(a.thoughtPhases).toEqual(["think1", "think2"]);
  });

  it("stream chunks never append onto prior-turn assistants", () => {
    let messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "first" },
      {
        id: "a1",
        role: "assistant",
        content: "old answer",
        streaming: true, // stuck flag from missed done
      },
      { id: "u2", role: "user", content: "second" },
      { id: "a-pending-1", role: "assistant", content: "", streaming: true },
    ];
    messages = applyStreamChunk(messages, {
      sessionId: "s",
      messageId: "a2",
      text: "new answer",
      done: false,
      kind: "assistant",
    });
    expect(messages.find((m) => m.id === "a1")!.content).toBe("old answer");
    const current = messages.find(
      (m) => m.id === "a2" || m.id === "a-pending-1",
    )!;
    expect(current.content).toBe("new answer");
    expect(current.id).toBe("a2"); // adopted host id
  });

  it("clearPriorTurnStreaming only clears assistants before last user", () => {
    const msgs: ChatMessage[] = [
      { id: "a0", role: "assistant", content: "x", streaming: true },
      { id: "u1", role: "user", content: "hi" },
      { id: "a1", role: "assistant", content: "", streaming: true },
    ];
    const next = clearPriorTurnStreaming(msgs);
    expect(next[0]!.streaming).toBe(false);
    expect(next[2]!.streaming).toBe(true);
  });

  it("errorCopy distinguishes seven codes", () => {
    expect(errorCopy("CLI_NOT_FOUND")).toMatch(/CLI/i);
    expect(errorCopy("AUTH_FAILED")).toMatch(/鉴权|Auth/i);
    expect(errorCopy("NETWORK_PROVIDER")).toMatch(/网络|Network|模型/i);
    expect(errorCopy("AGENT_CRASHED")).toMatch(/崩溃|crash|进程/i);
    expect(errorCopy("QUOTA_EXCEEDED")).toMatch(/额度|Quota/i);
    expect(errorCopy("CONNECT_FAILED")).toMatch(/连接|connect/i);
    expect(errorCopy("PROCESS_LIMIT")).toMatch(/上限|limit|进程|process/i);
  });

  it("formatTurnErrorBody maps connect / quota phrases", () => {
    expect(
      formatTurnErrorBody(
        {
          content:
            "Could not connect the agent for this session; edit aborted.",
        },
        "en",
      ),
    ).toMatch(/connect/i);
    expect(
      formatTurnErrorBody({ content: "rate limit exceeded (429)" }, "en"),
    ).toMatch(/quota|rate/i);
  });

  it("presentErrorBanner shows friendly copy without MCP dumps", () => {
    const raw =
      'rpc timeout on session/prompt (id=4) after 600s; stderr: ...\nERROR worker quit with fatal: Connection refused';
    const fromAgent = presentErrorBanner(
      { code: "NETWORK_PROVIDER", message: raw },
      null,
      "zh",
    );
    expect(fromAgent?.summary).toMatch(/超时|中止/);
    expect(fromAgent?.summary).not.toMatch(/Connection refused/);
    expect(fromAgent?.summary).not.toMatch(/stderr/i);
    expect(fromAgent?.detail).toBeNull();
    expect(fromAgent?.reconnectHint).toBe(true);

    const fromLocal = presentErrorBanner(
      null,
      `NETWORK_PROVIDER: ${raw}`,
      "zh",
    );
    expect(fromLocal?.code).toBe("NETWORK_PROVIDER");
    expect(fromLocal?.summary).toMatch(/超时|中止/);
    expect(fromLocal?.detail).toBeNull();

    const short = presentErrorBanner(null, "请先选择项目", "zh");
    expect(short?.summary).toBe("请先选择项目");
    expect(short?.detail).toBeNull();
  });

  it("formatTurnErrorBody maps turn_timeout tag", () => {
    const body = formatTurnErrorBody(
      {
        code: "NETWORK_PROVIDER",
        message: "turn_timeout",
        content: "**NETWORK_PROVIDER**\n\nturn_timeout",
      },
      "zh",
    );
    expect(body).toMatch(/超时/);
    expect(body).not.toMatch(/NETWORK_PROVIDER|rpc timeout|stderr/i);
  });

  it("stripAnsi removes SGR sequences", () => {
    expect(stripAnsi("\u001b[31mERROR\u001b[0m boom")).toBe("ERROR boom");
  });

  it("applyTurnError replaces optimistic thinking with friendly error", () => {
    let messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "hi" },
      { id: "a-pending", role: "assistant", content: "", streaming: true },
    ];
    messages = applyTurnError(
      messages,
      {
        messageId: "host-mid",
        code: "NETWORK_PROVIDER",
        message:
          'rpc timeout on session/prompt (id=6) after 600s; stderr: Connection refused',
        content:
          '**NETWORK_PROVIDER**\n\nrpc timeout on session/prompt (id=6) after 600s; stderr: Connection refused',
      },
      "zh",
    );
    expect(messages).toHaveLength(2);
    const err = messages[1]!;
    expect(err.role).toBe("assistant");
    expect(err.isError).toBe(true);
    expect(err.streaming).toBe(false);
    expect(err.content).toMatch(/超时/);
    expect(err.content).not.toMatch(/Connection refused|stderr|rpc timeout/i);
  });

  it("applyGeneratedImage attaches to streaming assistant and dedupes", () => {
    let messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "画猫" },
      { id: "a-pending", role: "assistant", content: "", streaming: true },
    ];
    messages = applyGeneratedImage(messages, {
      path: "/tmp/images/1.jpg",
      name: "1.jpg",
    });
    expect(messages[1]!.attachments).toEqual([
      { path: "/tmp/images/1.jpg", name: "1.jpg", isDir: false },
    ]);
    // second time same path → no dup
    messages = applyGeneratedImage(messages, {
      path: "/tmp/images/1.jpg",
      name: "1.jpg",
    });
    expect(messages[1]!.attachments).toHaveLength(1);
    messages = applyGeneratedImage(messages, {
      path: "/tmp/images/2.png",
    });
    expect(messages[1]!.attachments).toHaveLength(2);
    expect(messages[1]!.attachments![1]!.name).toBe("2.png");
  });
});

describe("context compact markers", () => {
  it("parseCompactContent reads host journal format", () => {
    const meta = parseCompactContent(
      "context_compact|auto|tokens:120000->40000\nkept auth design",
    );
    expect(meta?.trigger).toBe("auto");
    expect(meta?.tokensBefore).toBe(120000);
    expect(meta?.tokensAfter).toBe(40000);
    expect(meta?.summaryPreview).toBe("kept auth design");
  });

  it("applyContextCompact appends marker row", () => {
    const next = applyContextCompact([], {
      messageId: "c1",
      trigger: "auto",
      tokensBefore: 1000,
      tokensAfter: 400,
    });
    expect(next).toHaveLength(1);
    expect(next[0]?.marker).toBe("context_compact");
    expect(next[0]?.compactMeta?.tokensBefore).toBe(1000);
  });
});

describe("tool activity", () => {
  it("applyToolEvent upserts by toolCallId", () => {
    let m = applyToolEvent([], {
      toolCallId: "t1",
      title: "read_file",
      kind: "read",
      status: "in_progress",
      path: "/tmp/a.ts",
    });
    expect(m).toHaveLength(1);
    expect(m[0]?.streaming).toBe(true);
    m = applyToolEvent(m, {
      toolCallId: "t1",
      title: "Read /tmp/a.ts",
      kind: "read",
      status: "completed",
      path: "/tmp/a.ts",
    });
    expect(m).toHaveLength(1);
    expect(m[0]?.streaming).toBe(false);
    expect(m[0]?.content).toContain("Read");
  });

  it("parseToolStepContent", () => {
    const p = parseToolStepContent(
      "tool_step|completed|read|Read foo\n/tmp/foo",
    );
    expect(p?.status).toBe("completed");
    expect(p?.title).toBe("Read foo");
  });

  it("pickLatestTurnTool prefers running tool in current turn", () => {
    let m = applyToolEvent(
      [
        {
          id: "u1",
          role: "user",
          content: "hi",
          createdAt: new Date().toISOString(),
        },
      ],
      {
        toolCallId: "t1",
        title: "Read a",
        kind: "read",
        status: "completed",
      },
    );
    m = applyToolEvent(m, {
      toolCallId: "t2",
      title: "Search b",
      kind: "search",
      status: "in_progress",
    });
    const latest = pickLatestTurnTool(m);
    expect(latest?.toolCallId).toBe("t2");
    expect(latest?.streaming).toBe(true);
  });

  it("pickRunningTurnTool only returns in-flight tool (hide when done)", () => {
    let m = applyToolEvent(
      [
        {
          id: "u1",
          role: "user",
          content: "hi",
          createdAt: new Date().toISOString(),
        },
      ],
      {
        toolCallId: "t1",
        title: "Listing files in private persona folder",
        kind: "list",
        status: "in_progress",
      },
    );
    expect(pickRunningTurnTool(m)?.content).toContain("Listing files");
    m = applyToolEvent(m, {
      toolCallId: "t1",
      title: "Listing files in private persona folder",
      kind: "list",
      status: "completed",
    });
    expect(pickRunningTurnTool(m)).toBeNull();
  });

  it("toolStepDisplayTitle prefers plain content title", () => {
    expect(
      toolStepDisplayTitle({
        id: "tool-1",
        role: "tool",
        content: "Listing files in private persona folder",
        marker: "tool_step",
      }),
    ).toBe("Listing files in private persona folder");
    expect(
      toolStepDisplayTitle({
        id: "tool-2",
        role: "tool",
        content: "tool_step|completed|read|Read foo",
        marker: "tool_step",
      }),
    ).toBe("Read foo");
  });

  it("never surfaces bare tool placeholder; prefers detail/path", () => {
    expect(
      toolStepDisplayTitle({
        id: "tool-3",
        role: "tool",
        content: "tool",
        toolDetail: "ls -la /tmp",
        marker: "tool_step",
      }),
    ).toBe("ls -la /tmp");
    expect(
      toolStepDisplayTitle({
        id: "tool-4",
        role: "tool",
        content: "tool",
        marker: "tool_step",
      }),
    ).toBe("");
    let m = applyToolEvent([], {
      toolCallId: "t-gen",
      title: "tool",
      kind: "tool",
      status: "in_progress",
    });
    expect(pickRunningTurnTool(m)).toBeNull();
    m = applyToolEvent(m, {
      toolCallId: "t-gen",
      title: "tool",
      kind: "bash",
      status: "in_progress",
      detail: "npm test",
    });
    expect(pickRunningTurnTool(m)?.content).toBe("npm test");
    // Don't downgrade a good title on a vague update
    m = applyToolEvent(m, {
      toolCallId: "t-gen",
      title: "tool",
      kind: "bash",
      status: "in_progress",
    });
    expect(m[0]?.content).toBe("npm test");
  });
});
