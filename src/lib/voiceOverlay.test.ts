import { describe, expect, it } from "vitest";
import {
  canSendTranscriptAsPrompt,
  deriveVoiceDelegatePhase,
  formatTranscriptAsPrompt,
  hasDelegatedSessions,
  isConversationalRole,
  mergeTranscriptLine,
  nextAwaitingResponse,
  toolEventName,
  transcriptEmptyKind,
  type VoiceTranscriptLine,
} from "./voiceOverlay";

describe("deriveVoiceDelegatePhase", () => {
  it("prefers connecting and ended over host flags", () => {
    expect(
      deriveVoiceDelegatePhase({
        connecting: true,
        state: { active: true, listening: true },
      }),
    ).toBe("connecting");
    expect(
      deriveVoiceDelegatePhase({
        ended: true,
        state: { active: true, speaking: true },
      }),
    ).toBe("ended");
  });

  it("surfaces error from ui or host", () => {
    expect(
      deriveVoiceDelegatePhase({
        uiError: "mic denied",
        state: { active: true, listening: true },
      }),
    ).toBe("error");
    expect(
      deriveVoiceDelegatePhase({
        state: { active: true, error: "ws down", listening: true },
      }),
    ).toBe("error");
  });

  it("is idle when host not active", () => {
    expect(deriveVoiceDelegatePhase({ state: null })).toBe("idle");
    expect(deriveVoiceDelegatePhase({ state: { active: false } })).toBe(
      "idle",
    );
  });

  it("honors explicit host phase", () => {
    expect(
      deriveVoiceDelegatePhase({
        state: { active: true, phase: "Thinking", speaking: true },
      }),
    ).toBe("thinking");
    expect(
      deriveVoiceDelegatePhase({
        state: { active: true, phase: "SPEAKING" },
      }),
    ).toBe("speaking");
  });

  it("orders speaking > thinking > listening", () => {
    expect(
      deriveVoiceDelegatePhase({
        state: {
          active: true,
          speaking: true,
          thinking: true,
          listening: true,
        },
      }),
    ).toBe("speaking");
    expect(
      deriveVoiceDelegatePhase({
        state: { active: true, thinking: true, listening: true },
      }),
    ).toBe("thinking");
    expect(
      deriveVoiceDelegatePhase({
        toolBusy: true,
        state: { active: true, listening: true },
      }),
    ).toBe("thinking");
    expect(
      deriveVoiceDelegatePhase({
        awaitingResponse: true,
        state: { active: true, listening: true },
      }),
    ).toBe("thinking");
    expect(
      deriveVoiceDelegatePhase({
        state: { active: true, listening: true },
      }),
    ).toBe("listening");
  });

  it("treats active with no listen/speak flags as thinking", () => {
    expect(
      deriveVoiceDelegatePhase({
        state: { active: true, listening: false, speaking: false },
      }),
    ).toBe("thinking");
  });
});

describe("mergeTranscriptLine", () => {
  it("appends partial same-role deltas", () => {
    let lines: VoiceTranscriptLine[] = [];
    lines = mergeTranscriptLine(lines, "assistant", "Hel", false, () => "1");
    lines = mergeTranscriptLine(lines, "assistant", "lo", false, () => "2");
    expect(lines).toEqual([
      { id: "1", role: "assistant", text: "Hello", final: false },
    ]);
  });

  it("starts a new line on final or role change", () => {
    let lines: VoiceTranscriptLine[] = [];
    lines = mergeTranscriptLine(lines, "user", "Hi", true, () => "a");
    lines = mergeTranscriptLine(lines, "assistant", "Hey", false, () => "b");
    expect(lines.map((l) => l.id)).toEqual(["a", "b"]);
  });

  it("ignores empty text", () => {
    expect(mergeTranscriptLine([], "user", "", true)).toEqual([]);
  });
});

describe("formatTranscriptAsPrompt / canSend", () => {
  const sample: VoiceTranscriptLine[] = [
    { id: "1", role: "system", text: "Voice ready", final: true },
    { id: "2", role: "user", text: "  Fix the tests  ", final: true },
    { id: "3", role: "assistant", text: "On it.", final: true },
  ];

  it("formats only conversational host text", () => {
    expect(formatTranscriptAsPrompt(sample)).toBe(
      "User: Fix the tests\n\nAssistant: On it.",
    );
  });

  it("returns empty when no conversational content (no fake STT)", () => {
    expect(
      formatTranscriptAsPrompt([
        { id: "1", role: "system", text: "connected", final: true },
      ]),
    ).toBe("");
    expect(formatTranscriptAsPrompt([])).toBe("");
  });

  it("gates send on support + session + non-empty text", () => {
    const text = formatTranscriptAsPrompt(sample);
    expect(
      canSendTranscriptAsPrompt({
        supportsSend: true,
        hasActiveSession: true,
        transcriptText: text,
      }),
    ).toBe(true);
    expect(
      canSendTranscriptAsPrompt({
        supportsSend: false,
        hasActiveSession: true,
        transcriptText: text,
      }),
    ).toBe(false);
    expect(
      canSendTranscriptAsPrompt({
        supportsSend: true,
        hasActiveSession: false,
        transcriptText: text,
      }),
    ).toBe(false);
    expect(
      canSendTranscriptAsPrompt({
        supportsSend: true,
        hasActiveSession: true,
        transcriptText: "",
      }),
    ).toBe(false);
  });
});

describe("transcriptEmptyKind / delegated / tools", () => {
  it("classifies empty states honestly", () => {
    expect(transcriptEmptyKind([])).toBe("none");
    expect(
      transcriptEmptyKind([
        { id: "1", role: "system", text: "ready", final: true },
      ]),
    ).toBe("system_only");
    expect(
      transcriptEmptyKind([
        { id: "1", role: "user", text: "hi", final: true },
      ]),
    ).toBe("has_content");
  });

  it("detects delegated session ids", () => {
    expect(hasDelegatedSessions(null)).toBe(false);
    expect(hasDelegatedSessions({ delegatedSessionIds: [] })).toBe(false);
    expect(
      hasDelegatedSessions({ delegatedSessionIds: ["abc"] }),
    ).toBe(true);
  });

  it("normalizes tool event names", () => {
    expect(toolEventName({ name: "  prompt_agent " })).toBe("prompt_agent");
    expect(toolEventName({ name: "" })).toBeNull();
    expect(toolEventName(null)).toBeNull();
  });

  it("tracks awaiting response from host transcript roles", () => {
    expect(
      nextAwaitingResponse({ prev: false, role: "user", final: true }),
    ).toBe(true);
    expect(
      nextAwaitingResponse({ prev: true, role: "assistant", final: false }),
    ).toBe(false);
    expect(
      nextAwaitingResponse({ prev: true, role: "user", final: true, speaking: true }),
    ).toBe(false);
    expect(
      nextAwaitingResponse({ prev: true, role: "system", final: true }),
    ).toBe(true);
  });

  it("recognizes conversational roles", () => {
    expect(isConversationalRole("User")).toBe(true);
    expect(isConversationalRole("system")).toBe(false);
  });
});
