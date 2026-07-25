import { describe, expect, it } from "vitest";
import {
  buildWorktreeSiblingPath,
  findWorktreeAt,
  mainWorktreePath,
  normalizeWorktreePath,
  parseWorktreePorcelain,
  pathsEqual,
  sanitizeWorktreeName,
  siblingWorktrees,
  worktreeLabel,
} from "./gitWorktree";

const SAMPLE = `worktree /Users/me/repo
HEAD abcdef0123456789
branch refs/heads/main

worktree /Users/me/repo-feat
HEAD fedcba9876543210
branch refs/heads/feat/x

worktree /Users/me/repo-detached
HEAD 1111222233334444
detached
`;

describe("parseWorktreePorcelain", () => {
  it("parses main + linked worktrees", () => {
    const list = parseWorktreePorcelain(SAMPLE);
    expect(list).toHaveLength(3);
    expect(list[0].path).toBe("/Users/me/repo");
    expect(list[0].branch).toBe("main");
    expect(list[0].isMain).toBe(true);
    expect(list[0].detached).toBe(false);

    expect(list[1].path).toBe("/Users/me/repo-feat");
    expect(list[1].branch).toBe("feat/x");
    expect(list[1].isMain).toBe(false);

    expect(list[2].detached).toBe(true);
    expect(list[2].branch).toBeNull();
  });

  it("returns empty for blank input", () => {
    expect(parseWorktreePorcelain("")).toEqual([]);
    expect(parseWorktreePorcelain("\n\n")).toEqual([]);
  });
});

describe("path helpers", () => {
  it("normalizes and compares paths", () => {
    expect(normalizeWorktreePath("/a/b/")).toBe("/a/b");
    expect(pathsEqual("/a/b", "/a/b/")).toBe(true);
    expect(pathsEqual("/a/b", "/a/c")).toBe(false);
  });

  it("labels prefer branch names", () => {
    const list = parseWorktreePorcelain(SAMPLE);
    expect(worktreeLabel(list[0])).toBe("main");
    expect(worktreeLabel(list[1])).toBe("feat/x");
    expect(worktreeLabel(list[2])).toContain("repo-detached");
  });

  it("siblings exclude current path", () => {
    const list = parseWorktreePorcelain(SAMPLE);
    const sib = siblingWorktrees(list, "/Users/me/repo");
    expect(sib.map((w) => w.path)).toEqual([
      "/Users/me/repo-feat",
      "/Users/me/repo-detached",
    ]);
    expect(findWorktreeAt(list, "/Users/me/repo-feat")?.branch).toBe("feat/x");
  });
});

describe("worktree path builder", () => {
  it("sanitizes names", () => {
    expect(sanitizeWorktreeName("  feat-x  ")).toBe("feat-x");
    expect(sanitizeWorktreeName("v1.2_rc")).toBe("v1.2_rc");
    expect(() => sanitizeWorktreeName("")).toThrow(/required/);
    expect(() => sanitizeWorktreeName("a/b")).toThrow(/separator/);
    expect(() => sanitizeWorktreeName("-lead")).toThrow(/start/);
    expect(() => sanitizeWorktreeName("has space")).toThrow();
  });

  it("builds sibling path next to main worktree", () => {
    expect(buildWorktreeSiblingPath("/Users/me/repo", "feat")).toBe(
      "/Users/me/repo-feat",
    );
    expect(buildWorktreeSiblingPath("/Users/me/repo/", "hot-fix")).toBe(
      "/Users/me/repo-hot-fix",
    );
    expect(mainWorktreePath(parseWorktreePorcelain(SAMPLE))).toBe(
      "/Users/me/repo",
    );
    // Path preview uses main even when active cwd is a linked worktree.
    const main = mainWorktreePath(parseWorktreePorcelain(SAMPLE))!;
    expect(buildWorktreeSiblingPath(main, "new")).toBe("/Users/me/repo-new");
  });
});
