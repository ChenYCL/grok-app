import { describe, expect, it } from "vitest";
import {
  classifyToolKind,
  isContextToolKind,
  summarizeToolDisplay,
  toolDetailTail,
} from "./toolDisplay";

describe("toolDisplay", () => {
  it("classifies bash / read / edit / search / browse", () => {
    expect(classifyToolKind("run_terminal_command")).toBe("bash");
    expect(classifyToolKind("read_file")).toBe("read");
    expect(classifyToolKind("search_replace")).toBe("edit");
    expect(classifyToolKind("grep")).toBe("search");
    expect(classifyToolKind("web_search")).toBe("search");
    expect(classifyToolKind("web_fetch")).toBe("browse");
    expect(classifyToolKind("open_page")).toBe("browse");
    // Host journal titles with empty kind
    expect(classifyToolKind("", "Web search:")).toBe("search");
    expect(classifyToolKind("", "X search:")).toBe("search");
    // Call-id recovery when kind+title lost (session 3971c6e8…)
    expect(
      classifyToolKind(
        "",
        "tool",
        "ws_b31d81a4-4de4-90db-b8d4-8d6165b7ea31_call-xxx-0",
      ),
    ).toBe("search");
    expect(isContextToolKind("read_file")).toBe(true);
    expect(isContextToolKind("web_fetch")).toBe(true);
    expect(isContextToolKind("search_replace")).toBe(false);
    // Host vision must not collapse into "Ran 1 search"
    expect(classifyToolKind("vision", "识别图片内容", "host-vision-abc")).toBe(
      "read",
    );
    expect(
      classifyToolKind("", "识别图片内容", "host-vision-xyz"),
    ).toBe("read");
  });

  it("summarizes path basename", () => {
    const d = summarizeToolDisplay({
      kind: "read_file",
      path: "/Users/me/proj/src/lib/session.ts",
    });
    expect(d.summary).toBe("session.ts");
    expect(d.isContext).toBe(true);
  });

  it("toolDetailTail keeps last N lines", () => {
    const detail = Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n");
    const tail = toolDetailTail(detail, 3);
    expect(tail).toBe("line9\nline10\nline11");
  });
});
