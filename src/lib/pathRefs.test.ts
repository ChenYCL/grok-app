import { describe, expect, it } from "vitest";
import {
  classifyPathRef,
  looksLikeFilePath,
  normalizePathToken,
  resolveFileToken,
} from "./pathRefs";

describe("normalizePathToken", () => {
  it("preserves absolute unix paths (video history reload)", () => {
    const abs = "/Users/me/proj/out/moon-taste-story.mp4";
    expect(normalizePathToken(abs)).toBe(abs);
    expect(looksLikeFilePath(abs)).toBe(true);
    expect(classifyPathRef(abs)).toBe("video");
    expect(resolveFileToken(abs)).toBe(abs);
  });

  it("still strips leading ellipsis on relative tokens", () => {
    expect(normalizePathToken(".../foo/bar.mp4")).toBe("foo/bar.mp4");
    expect(normalizePathToken("…/videos/1.mp4")).toBe("videos/1.mp4");
  });
});
