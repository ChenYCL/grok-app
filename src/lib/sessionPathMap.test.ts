import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/session";
import {
  buildSessionFilePathMap,
  buildUniquePathMap,
  collectAbsolutePathsFromMessage,
  mergePathMaps,
  suffixKeysForAbsolute,
} from "./sessionPathMap";

const ARTICLE =
  "/Users/ronglecat/Documents/document/文章输出/进行中/2026-07-24-用Grok开发一款桌面应用/04-正文/正文.md";
const OTHER =
  "/Users/ronglecat/Documents/document/文章输出/进行中/2026-06-22-codex画布标注指哪打哪/04-正文/正文.md";
const PROJECT = "/Users/ronglecat/Documents/document/文章输出";

function toolMsg(path: string, title?: string): ChatMessage {
  return {
    id: path,
    role: "tool",
    marker: "tool_step",
    toolPath: path,
    content: `tool_step|completed|read|Read \`${title || path}\`\n${path}`,
  };
}

describe("sessionPathMap", () => {
  it("suffixKeysForAbsolute includes basename and 04-正文/正文.md", () => {
    const keys = suffixKeysForAbsolute(ARTICLE, PROJECT);
    expect(keys).toContain("正文.md");
    expect(keys).toContain("04-正文/正文.md");
    expect(keys).toContain(
      "进行中/2026-07-24-用Grok开发一款桌面应用/04-正文/正文.md",
    );
    expect(keys).toContain(ARTICLE);
  });

  it("maps short token only when unique among session abs paths", () => {
    const unique = buildUniquePathMap([ARTICLE], PROJECT);
    expect(unique["正文.md"]).toBe(ARTICLE);
    expect(unique["04-正文/正文.md"]).toBe(ARTICLE);

    const ambig = buildUniquePathMap([ARTICLE, OTHER], PROJECT);
    expect(ambig["正文.md"]).toBeUndefined();
    expect(ambig["04-正文/正文.md"]).toBeUndefined();
    // Longer unique tails still map
    expect(
      ambig["进行中/2026-07-24-用Grok开发一款桌面应用/04-正文/正文.md"],
    ).toBe(ARTICLE);
    expect(ambig[ARTICLE]).toBe(ARTICLE);
  });

  it("collects tool_step absolute paths", () => {
    const m = toolMsg(ARTICLE);
    expect(collectAbsolutePathsFromMessage(m)).toContain(ARTICLE);
  });

  it("buildSessionFilePathMap resolves 04-正文/正文.md from tools", () => {
    const messages: ChatMessage[] = [
      {
        id: "a",
        role: "assistant",
        content: "源文件：`04-正文/正文.md`",
      },
      toolMsg(ARTICLE),
    ];
    const map = buildSessionFilePathMap(messages, PROJECT);
    expect(map["04-正文/正文.md"]).toBe(ARTICLE);
    expect(map["正文.md"]).toBe(ARTICLE);
  });

  it("mergePathMaps prefers later maps", () => {
    const m = mergePathMaps(
      { "a.md": "/tmp/a.md" },
      { "a.md": "/tmp/b.md", "b.md": "/tmp/b.md" },
    );
    expect(m["a.md"]).toBe("/tmp/b.md");
    expect(m["b.md"]).toBe("/tmp/b.md");
  });
});
