import { describe, expect, it } from "vitest";
import { mapStoredMessageToChat, mapStoredMessagesToChat } from "./mapStoredMessages";

describe("mapStoredMessages", () => {
  it("keeps structured user attachments for history cards", () => {
    const msg = mapStoredMessageToChat({
      id: "u-1",
      role: "user",
      content: "see this screenshot",
      createdAt: "2026-08-01T00:00:00.000Z",
      attachments: [
        {
          path: "/Users/me/Desktop/shot.png",
          name: "shot.png",
          isDir: false,
        },
      ],
    });
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("see this screenshot");
    expect(msg.attachments).toEqual([
      {
        path: "/Users/me/Desktop/shot.png",
        name: "shot.png",
        isDir: false,
      },
    ]);
  });

  it("parses @path lines when structured attachments are missing", () => {
    const msg = mapStoredMessageToChat({
      id: "u-2",
      role: "user",
      content: "docs please\n\n@/tmp/notes.md",
      createdAt: "2026-08-01T00:00:00.000Z",
      attachments: null,
    });
    expect(msg.content).toBe("docs please");
    expect(msg.attachments?.map((a) => a.path)).toEqual(["/tmp/notes.md"]);
  });

  it("maps a batch without dropping attachments", () => {
    const out = mapStoredMessagesToChat([
      {
        id: "u-1",
        role: "user",
        content: "hi",
        createdAt: "2026-08-01T00:00:00.000Z",
        attachments: [
          { path: "/a/b.pdf", name: "b.pdf", isDir: false },
        ],
      },
      {
        id: "a-1",
        role: "assistant",
        content: "ok",
        createdAt: "2026-08-01T00:00:01.000Z",
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.attachments).toHaveLength(1);
    expect(out[1]!.attachments).toBeUndefined();
  });
});
