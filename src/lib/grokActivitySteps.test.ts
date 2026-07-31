import { describe, expect, it } from "vitest";
import type { MessageToolSegment } from "./session";
import {
  buildGrokActivitySteps,
  extractBrowseUrl,
  type GrokPhaseItem,
} from "./grokActivitySteps";

function tool(
  id: string,
  kind: string,
  title: string,
  extra: Partial<MessageToolSegment> = {},
): MessageToolSegment {
  return {
    kind: "tool",
    toolCallId: id,
    title,
    toolKind: kind,
    status: "completed",
    streaming: false,
    ...extra,
  };
}

describe("grokActivitySteps", () => {
  it("interleaves thoughts and tools in stream order", () => {
    const items: GrokPhaseItem[] = [
      { kind: "thought", text: "**调研** 流程" },
      { kind: "tool", tool: tool("s1", "web_search", "Search A") },
      { kind: "tool", tool: tool("s2", "web_search", "Search B") },
      { kind: "thought", text: "Verifying China-specific registration" },
      {
        kind: "tool",
        tool: tool("b1", "web_fetch", "Fetch", {
          path: "https://developer.apple.com/cn/programs/enroll/",
        }),
      },
    ];
    const steps = buildGrokActivitySteps(items);
    // Queries present → individual “Searched web for” rows (≤3)
    expect(steps.map((s) => s.type)).toEqual([
      "thought",
      "web-search",
      "web-search",
      "thought",
      "browse",
    ]);
    expect(steps[1]).toMatchObject({ type: "web-search", query: "Search A" });
    expect(steps[4]).toMatchObject({
      type: "browse",
      url: "developer.apple.com/cn/programs/enroll/",
    });
  });

  it("collapses consecutive searches without queries into Ran N", () => {
    const items: GrokPhaseItem[] = [
      { kind: "tool", tool: tool("a", "web_search", "Web search:") },
      { kind: "tool", tool: tool("b", "web_search", "Web search:") },
      { kind: "tool", tool: tool("c", "web_search", "Web search:") },
      { kind: "tool", tool: tool("d", "web_search", "Web search:") },
    ];
    const steps = buildGrokActivitySteps(items);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ type: "search-group", count: 4 });
  });

  it("emits Searched web for when each search has a query", () => {
    const items: GrokPhaseItem[] = [
      {
        kind: "tool",
        tool: tool("a", "web_search", "Web search: 个人苹果开发者账号"),
      },
      {
        kind: "tool",
        tool: tool("b", "web_search", "Web search: Apple Developer Program"),
      },
    ];
    const steps = buildGrokActivitySteps(items);
    expect(steps.map((s) => s.type)).toEqual(["web-search", "web-search"]);
    expect(steps[0]).toMatchObject({
      type: "web-search",
      query: "个人苹果开发者账号",
    });
  });

  it("uses hollow-circle tool rows for non-search tools", () => {
    const items: GrokPhaseItem[] = [
      {
        kind: "tool",
        tool: tool("t1", "run_terminal_command", "Draft intro", {
          detail: "echo hello",
        }),
      },
    ];
    const steps = buildGrokActivitySteps(items);
    expect(steps[0]!.type).toBe("tool");
  });

  it("extractBrowseUrl keeps directory trailing slash like Grok web", () => {
    expect(
      extractBrowseUrl(
        tool("b", "web_fetch", "x", {
          path: "https://developer.apple.com/cn/help/account/",
        }),
      ),
    ).toBe("developer.apple.com/cn/help/account/");
  });
});
