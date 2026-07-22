import { describe, expect, it } from "vitest";
import {
  buildAgentPrompt,
  isImagePath,
  mergeAttachments,
  parseAttachmentsFromContent,
  pathBasename,
  type Attachment,
} from "./attachments";

const file: Attachment = {
  path: "/tmp/a.txt",
  name: "a.txt",
  isDir: false,
};
const dir: Attachment = {
  path: "/tmp/proj",
  name: "proj",
  isDir: true,
};

describe("attachments", () => {
  it("dedupes by path", () => {
    const out = mergeAttachments([file], [{ ...file, name: "renamed" }, dir]);
    expect(out).toHaveLength(2);
    expect(out.find((a) => a.path === file.path)?.name).toBe("renamed");
  });

  it("builds agent prompt with @paths", () => {
    expect(buildAgentPrompt("hi", [file, dir])).toBe(
      "hi\n\n@/tmp/a.txt\n@/tmp/proj",
    );
    expect(buildAgentPrompt("", [file])).toBe("@/tmp/a.txt");
  });

  it("parses @paths back out of content", () => {
    const raw = "hello\n\n@/Users/me/pic.png\n@/Users/me/docs";
    const { text, attachments } = parseAttachmentsFromContent(raw);
    expect(text).toBe("hello");
    expect(attachments).toHaveLength(2);
    expect(attachments[0]!.path).toBe("/Users/me/pic.png");
    expect(attachments[0]!.name).toBe("pic.png");
  });

  it("detects image extensions", () => {
    expect(isImagePath("/a/b.PNG")).toBe(true);
    expect(isImagePath("/a/b.docx")).toBe(false);
  });

  it("basename works", () => {
    expect(pathBasename("/foo/bar/baz.txt")).toBe("baz.txt");
  });
});
