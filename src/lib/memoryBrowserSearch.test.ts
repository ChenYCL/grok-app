import { describe, expect, it } from "vitest";
import {
  clampMemorySearchLimit,
  memoryEntryNameMatches,
  mergeMemoryBrowserRows,
  MEMORY_SEARCH_DEFAULT_LIMIT,
  MEMORY_SEARCH_MAX_LIMIT,
  shouldRunMemoryContentSearch,
  type MemoryListEntryLike,
  type MemorySearchHitLike,
} from "./memoryBrowserSearch";

const entry = (
  partial: Partial<MemoryListEntryLike> & Pick<MemoryListEntryLike, "path" | "name">,
): MemoryListEntryLike => ({
  relativePath: partial.relativePath ?? partial.name,
  kind: partial.kind ?? "workspace",
  size: partial.size ?? 10,
  mtimeMs: partial.mtimeMs ?? 0,
  preview: partial.preview ?? "",
  matched: partial.matched ?? true,
  workspaceSlug: partial.workspaceSlug,
  path: partial.path,
  name: partial.name,
});

describe("clampMemorySearchLimit", () => {
  it("defaults and clamps", () => {
    expect(clampMemorySearchLimit(undefined)).toBe(MEMORY_SEARCH_DEFAULT_LIMIT);
    expect(clampMemorySearchLimit(null)).toBe(MEMORY_SEARCH_DEFAULT_LIMIT);
    expect(clampMemorySearchLimit(0)).toBe(1);
    expect(clampMemorySearchLimit(-3)).toBe(1);
    expect(clampMemorySearchLimit(12)).toBe(12);
    expect(clampMemorySearchLimit(999)).toBe(MEMORY_SEARCH_MAX_LIMIT);
  });
});

describe("shouldRunMemoryContentSearch", () => {
  it("requires non-empty trimmed query", () => {
    expect(shouldRunMemoryContentSearch("")).toBe(false);
    expect(shouldRunMemoryContentSearch("   ")).toBe(false);
    expect(shouldRunMemoryContentSearch(null)).toBe(false);
    expect(shouldRunMemoryContentSearch("api")).toBe(true);
  });
});

describe("memoryEntryNameMatches", () => {
  it("matches name relative path preview kind", () => {
    const e = entry({
      path: "/m/a.md",
      name: "MEMORY.md",
      relativePath: "proj/MEMORY.md",
      preview: "hello widgets",
      kind: "workspace",
    });
    expect(memoryEntryNameMatches(e, "memory")).toBe(true);
    expect(memoryEntryNameMatches(e, "WIDGETS")).toBe(true);
    expect(memoryEntryNameMatches(e, "proj/")).toBe(true);
    expect(memoryEntryNameMatches(e, "zzz")).toBe(false);
    expect(memoryEntryNameMatches(e, "")).toBe(true);
  });
});

describe("mergeMemoryBrowserRows", () => {
  const list: MemoryListEntryLike[] = [
    entry({
      path: "/m/MEMORY.md",
      name: "MEMORY.md",
      relativePath: "MEMORY.md",
      kind: "global",
      preview: "prefs",
    }),
    entry({
      path: "/m/ws/MEMORY.md",
      name: "MEMORY.md",
      relativePath: "ws/MEMORY.md",
      kind: "workspace",
      preview: "short",
      workspaceSlug: "ws",
    }),
    entry({
      path: "/m/ws/sessions/log.md",
      name: "log.md",
      relativePath: "ws/sessions/log.md",
      kind: "session",
      preview: "session log",
      workspaceSlug: "ws",
    }),
  ];

  it("returns all list rows when query empty", () => {
    const rows = mergeMemoryBrowserRows(list, [], "");
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => !r.snippet)).toBe(true);
  });

  it("prefers content hits and attaches snippets", () => {
    const hits: MemorySearchHitLike[] = [
      {
        path: "/m/ws/MEMORY.md",
        name: "MEMORY.md",
        relativePath: "ws/MEMORY.md",
        kind: "workspace",
        workspaceSlug: "ws",
        size: 100,
        mtimeMs: 1,
        snippet: "…deep unique-body-fact here…",
        contentMatch: true,
        matched: true,
      },
      {
        path: "/m/MEMORY.md",
        name: "MEMORY.md",
        relativePath: "MEMORY.md",
        kind: "global",
        size: 10,
        mtimeMs: 1,
        snippet: "",
        contentMatch: false,
        matched: true,
      },
    ];
    const rows = mergeMemoryBrowserRows(list, hits, "unique-body-fact");
    expect(rows[0]?.path).toBe("/m/ws/MEMORY.md");
    expect(rows[0]?.contentMatch).toBe(true);
    expect(rows[0]?.snippet).toContain("unique-body-fact");
    expect(rows.some((r) => r.path === "/m/MEMORY.md")).toBe(true);
  });

  it("includes client name matches not yet in hits", () => {
    const rows = mergeMemoryBrowserRows(list, [], "sessions");
    expect(rows.some((r) => r.relativePath.includes("sessions"))).toBe(true);
  });

  it("can surface host-only hits missing from list", () => {
    const hits: MemorySearchHitLike[] = [
      {
        path: "/m/extra.md",
        name: "extra.md",
        relativePath: "extra.md",
        kind: "other",
        size: 1,
        mtimeMs: 0,
        snippet: "hit body",
        contentMatch: true,
        matched: true,
      },
    ];
    const rows = mergeMemoryBrowserRows(list, hits, "hit");
    expect(rows.some((r) => r.path === "/m/extra.md" && r.fromSearch)).toBe(true);
  });
});
