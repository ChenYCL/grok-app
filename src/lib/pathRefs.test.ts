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

describe("resolveFileToken bare media", () => {
  it("does not invent sibling media under a unique pathMap parent", () => {
    // After reload, only image_gen attachment remains under agent images/.
    // Inventing images/shenzhen-weather-card.png caused broken ImageUi cards.
    const pathMap = {
      "/Users/me/agent-home/sessions/abc/images/1.jpg":
        "/Users/me/agent-home/sessions/abc/images/1.jpg",
      "1.jpg": "/Users/me/agent-home/sessions/abc/images/1.jpg",
      "images/1.jpg": "/Users/me/agent-home/sessions/abc/images/1.jpg",
    };
    expect(
      resolveFileToken("shenzhen-weather-card.png", { pathMap }),
    ).toBeNull();
    expect(resolveFileToken("1.jpg", { pathMap })).toBe(
      "/Users/me/agent-home/sessions/abc/images/1.jpg",
    );
  });

  it("still invents sibling non-media files under a unique parent", () => {
    const pathMap = {
      "/Users/me/proj/docs/a.md": "/Users/me/proj/docs/a.md",
      "a.md": "/Users/me/proj/docs/a.md",
    };
    expect(resolveFileToken("b.md", { pathMap })).toBe(
      "/Users/me/proj/docs/b.md",
    );
  });
});
