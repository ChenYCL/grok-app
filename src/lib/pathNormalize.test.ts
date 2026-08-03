import { describe, expect, it } from "vitest";
import {
  displayPathLabel,
  isLocalMediaOpenable,
  isRealLocalAbsolutePath,
  isSiteRootAbsolutePath,
  normalizeLocalPathToken,
  unescapeShellPath,
} from "./pathNormalize";

describe("unescapeShellPath", () => {
  it("restores spaces and parens from shell escapes", () => {
    expect(
      unescapeShellPath(
        "/Users/me/Downloads/6A5ED46119BDACC7C24DC3B6FF3CF051\\ \\(1\\).png",
      ),
    ).toBe("/Users/me/Downloads/6A5ED46119BDACC7C24DC3B6FF3CF051 (1).png");
  });

  it("normalizes Windows separators without eating drive letters", () => {
    expect(unescapeShellPath("C:\\Users\\me\\a.png")).toBe("C:/Users/me/a.png");
  });
});

describe("isRealLocalAbsolutePath / isSiteRootAbsolutePath", () => {
  it("accepts macOS user paths and home", () => {
    expect(isRealLocalAbsolutePath("/Users/me/pic.png")).toBe(true);
    expect(isRealLocalAbsolutePath("~/docs/a.md")).toBe(true);
    expect(
      isRealLocalAbsolutePath(
        "/Users/me/Library/Application Support/com.grokapp.grok-app/a.png",
      ),
    ).toBe(true);
  });

  it("rejects CMS site-root media paths", () => {
    expect(isSiteRootAbsolutePath("/images/partner-brands/manycore.png")).toBe(
      true,
    );
    expect(isRealLocalAbsolutePath("/images/partner-brands/manycore.png")).toBe(
      false,
    );
    expect(isSiteRootAbsolutePath("/static/logo.svg")).toBe(true);
  });

  it("accepts agent-home / custom abs roots that are not site CMS", () => {
    expect(isRealLocalAbsolutePath("/sess/images/1.jpg")).toBe(true);
    expect(isRealLocalAbsolutePath("/a.png")).toBe(true);
  });

  it("does not treat site roots as openable local media", () => {
    expect(isLocalMediaOpenable("/images/x.png")).toBe(false);
    expect(
      isLocalMediaOpenable("/Users/me/Downloads/微信图片_1.png"),
    ).toBe(true);
  });
});

describe("normalizeLocalPathToken", () => {
  it("shell-unescapes then keeps a real absolute", () => {
    const raw =
      "/Users/ronglecat/Downloads/6A5ED46119BDACC7C24DC3B6FF3CF051\\ \\(1\\).png";
    expect(normalizeLocalPathToken(raw)).toBe(
      "/Users/ronglecat/Downloads/6A5ED46119BDACC7C24DC3B6FF3CF051 (1).png",
    );
    expect(isRealLocalAbsolutePath(normalizeLocalPathToken(raw))).toBe(true);
  });
});

describe("displayPathLabel", () => {
  it("shows basename for long absolute paths", () => {
    expect(displayPathLabel("/Users/me/proj/apps/web/public/logo.png")).toBe(
      "logo.png",
    );
  });

  it("keeps short relative paths for code citations", () => {
    expect(displayPathLabel("apps/web/foo.ts")).toBe("apps/web/foo.ts");
  });
});
