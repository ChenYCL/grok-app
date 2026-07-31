import { describe, expect, it } from "vitest";
import {
  canOfferContinueCwd,
  cwdPathsMatch,
  normalizeCwdPath,
  pickLatestCliSessionForCwd,
} from "./continueCwd";

describe("normalizeCwdPath", () => {
  it("trims, unifies slashes, drops trailing separator, lowercases", () => {
    expect(normalizeCwdPath("/Users/Me/Proj/")).toBe(
      normalizeCwdPath("/users/me/proj"),
    );
    expect(normalizeCwdPath("  /a/b  ")).toBe("/a/b");
    expect(normalizeCwdPath(String.raw`C:\Work\App`)).toBe("c:/work/app");
  });

  it("treats empty / whitespace as empty", () => {
    expect(normalizeCwdPath("")).toBe("");
    expect(normalizeCwdPath("   ")).toBe("");
    expect(normalizeCwdPath(null)).toBe("");
    expect(normalizeCwdPath(undefined)).toBe("");
  });
});

describe("cwdPathsMatch", () => {
  it("ignores trailing slash and case", () => {
    expect(cwdPathsMatch("/Users/me/Code", "/Users/me/Code/")).toBe(true);
    expect(cwdPathsMatch(String.raw`C:\Work\App`, "c:/work/app")).toBe(true);
  });

  it("rejects different paths and empty", () => {
    expect(cwdPathsMatch("/a/b", "/a/c")).toBe(false);
    expect(cwdPathsMatch("", "/a")).toBe(false);
    expect(cwdPathsMatch(null, "/a")).toBe(false);
  });
});

describe("pickLatestCliSessionForCwd", () => {
  const rows = [
    {
      agentSessionId: "old",
      cwd: "/Users/me/proj",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      agentSessionId: "other",
      cwd: "/Users/me/other",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    {
      agentSessionId: "new",
      cwd: "/Users/me/proj/",
      updatedAt: "2025-06-01T12:00:00Z",
    },
  ];

  it("picks the newest matching cwd (trailing slash ok)", () => {
    const best = pickLatestCliSessionForCwd(rows, "/Users/me/proj");
    expect(best?.agentSessionId).toBe("new");
  });

  it("soft-fails when none match or path empty", () => {
    expect(pickLatestCliSessionForCwd(rows, "/missing")).toBeNull();
    expect(pickLatestCliSessionForCwd(rows, "")).toBeNull();
    expect(pickLatestCliSessionForCwd(rows, null)).toBeNull();
    expect(pickLatestCliSessionForCwd([], "/Users/me/proj")).toBeNull();
  });

  it("skips rows without cwd", () => {
    const mixed = [
      { agentSessionId: "nocwd", cwd: null, updatedAt: "2026-01-01T00:00:00Z" },
      {
        agentSessionId: "hit",
        cwd: "/p",
        updatedAt: "2025-01-01T00:00:00Z",
      },
    ];
    expect(pickLatestCliSessionForCwd(mixed, "/p")?.agentSessionId).toBe(
      "hit",
    );
  });
});

describe("canOfferContinueCwd", () => {
  it("requires a non-empty path", () => {
    expect(canOfferContinueCwd("/Users/me/proj")).toBe(true);
    expect(canOfferContinueCwd("  ")).toBe(false);
    expect(canOfferContinueCwd(null)).toBe(false);
    expect(canOfferContinueCwd(undefined)).toBe(false);
  });
});
