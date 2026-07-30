import { describe, expect, it } from "vitest";
import {
  GROK_APP_SHARE_FOOTER,
  buildShareCardModel,
  exportableToShareMessages,
  sessionExportImageFilename,
  shareCardToHtml,
} from "./sessionExportImage";

describe("sessionExportImageFilename", () => {
  it("builds safe png names", () => {
    expect(sessionExportImageFilename("Fix Doctor Reset!", "abcdef12-xxxx")).toBe(
      "grok-fix-doctor-reset-abcdef12.png",
    );
    expect(sessionExportImageFilename("", null)).toBe("grok-session.png");
  });
});

describe("buildShareCardModel", () => {
  it("drops tools, caps messages, keeps branding footer", () => {
    const model = buildShareCardModel({
      title: "Demo",
      projectName: "app",
      sessionId: "sid-1",
      messages: [
        { role: "user", content: "hi" },
        { role: "tool", content: "tool_step|bash|ok" },
        { role: "assistant", content: "hello", thought: "secret" },
      ],
      includeThoughts: false,
    });
    expect(model.messages).toHaveLength(2);
    expect(model.messages[0]?.role).toBe("user");
    expect(model.messages[1]?.thought).toBeUndefined();
    expect(model.footerText).toBe(GROK_APP_SHARE_FOOTER);
    expect(model.logoDataUrl).toBeNull();
  });

  it("includes thoughts when requested and truncates long bodies", () => {
    const long = "x".repeat(5000);
    const model = buildShareCardModel({
      title: "Long",
      messages: [{ role: "assistant", content: long, thought: "think" }],
      includeThoughts: true,
      maxBodyChars: 100,
    });
    expect(model.messages[0]?.content.length).toBeLessThanOrEqual(100);
    expect(model.messages[0]?.thought).toBe("think");
  });

  it("omits oldest messages when over maxMessages", () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `m${i}`,
    }));
    const model = buildShareCardModel({
      title: "T",
      messages,
      maxMessages: 2,
    });
    expect(model.messages).toHaveLength(2);
    expect(model.truncatedCount).toBe(3);
    expect(model.messages[0]?.content).toBe("m3");
  });
});

describe("shareCardToHtml", () => {
  it("escapes content and always shows Grok App footer", () => {
    const model = buildShareCardModel({
      title: '<script>alert(1)</script>',
      messages: [{ role: "user", content: "a <b>b</b>" }],
      logoDataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    });
    const html = shareCardToHtml(model);
    expect(html).toContain("Generated with Grok App");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain('class="sc-logo"');
    expect(html).toContain("a &lt;b&gt;b&lt;/b&gt;");
  });

  it("uses mark fallback without logo", () => {
    const model = buildShareCardModel({
      title: "No logo",
      messages: [{ role: "assistant", content: "ok" }],
    });
    const html = shareCardToHtml(model);
    expect(html).toContain("sc-logo--mark");
  });
});

describe("exportableToShareMessages", () => {
  it("maps fields", () => {
    const out = exportableToShareMessages([
      { role: "user", content: "x", thought: "t", createdAt: "1" },
    ]);
    expect(out).toEqual([
      { role: "user", content: "x", thought: "t", createdAt: "1" },
    ]);
  });
});
