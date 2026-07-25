import { describe, expect, it } from "vitest";
import {
  classifyToolKind,
  isContextToolKind,
  summarizeToolDisplay,
  toolDetailTail,
} from "./toolDisplay";

describe("toolDisplay", () => {
  it("classifies bash / read / edit / search", () => {
    expect(classifyToolKind("run_terminal_command")).toBe("bash");
    expect(classifyToolKind("read_file")).toBe("read");
    expect(classifyToolKind("search_replace")).toBe("edit");
    expect(classifyToolKind("grep")).toBe("search");
    expect(isContextToolKind("read_file")).toBe(true);
    expect(isContextToolKind("search_replace")).toBe(false);
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
