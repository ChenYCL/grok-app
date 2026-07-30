import { describe, expect, it } from "vitest";
import {
  filterSessionSearch,
  matchMessageContent,
  mergeSessionSearchHits,
  parseSessionSearchRankMode,
  scoreSessionSearchHit,
  tokenizeSearchText,
  tokenOverlapScore,
} from "./sessionSearch";

const projects = [
  { id: "p1", name: "grok-app", path: "/Users/me/Code/oss/grok-app" },
  { id: "p2", name: "notes", path: "/Users/me/notes" },
];

const sessions = [
  { id: "s1", title: "Fix doctor reset", projectId: "p1" },
  { id: "s2", title: "Weekly plan", projectId: "p2" },
  { id: "s3", title: "Untitled", projectId: null },
  { id: "s4", title: "Old archived", projectId: "p1", archived: true },
];

describe("filterSessionSearch", () => {
  it("returns recent items when query is empty", () => {
    const hits = filterSessionSearch("", sessions, projects);
    expect(hits.matchedSessions.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(hits.matchedProjects.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("matches session title case-insensitively", () => {
    const hits = filterSessionSearch("doctor", sessions, projects);
    expect(hits.matchedSessions.map((s) => s.id)).toEqual(["s1"]);
  });

  it("matches project name and pulls related sessions", () => {
    const hits = filterSessionSearch("grok-app", sessions, projects);
    expect(hits.matchedProjects.map((p) => p.id)).toEqual(["p1"]);
    expect(hits.matchedSessions.map((s) => s.id)).toContain("s1");
  });

  it("matches project path segments", () => {
    const hits = filterSessionSearch("Code/oss", sessions, projects);
    expect(hits.matchedProjects[0]?.id).toBe("p1");
  });

  it("skips archived sessions by default", () => {
    const hits = filterSessionSearch("archived", sessions, projects);
    expect(hits.matchedSessions).toHaveLength(0);
  });

  it("can include archived when asked", () => {
    const hits = filterSessionSearch("archived", sessions, projects, {
      includeArchived: true,
    });
    expect(hits.matchedSessions.map((s) => s.id)).toEqual(["s4"]);
  });
});

describe("matchMessageContent", () => {
  const messages = [
    { role: "user", content: "Please fix the Doctor reset button" },
    { role: "assistant", content: "Sure, I will patch doctor later." },
    { role: "system", content: "doctor should be ignored" },
    { role: "user", content: "unrelated" },
  ];

  it("returns null for empty query", () => {
    expect(matchMessageContent("", messages)).toBeNull();
    expect(matchMessageContent("  ", messages)).toBeNull();
  });

  it("matches case-insensitively and skips non user/assistant", () => {
    const hit = matchMessageContent("doctor", messages);
    expect(hit).not.toBeNull();
    expect(hit!.matchCount).toBe(2);
    expect(hit!.snippet.toLowerCase()).toContain("doctor");
  });

  it("returns null when nothing matches", () => {
    expect(matchMessageContent("zzzz", messages)).toBeNull();
  });
});

describe("mergeSessionSearchHits", () => {
  it("keeps title hits first and attaches content snippets", () => {
    const title = [{ id: "s1", title: "Fix doctor reset", projectId: "p1" }];
    const content = [
      {
        id: "s1",
        title: "Fix doctor reset",
        projectId: "p1",
        snippet: "…fix the Doctor…",
        matchCount: 2,
      },
      {
        id: "s9",
        title: "Other chat",
        projectId: null,
        snippet: "body mentions doctor",
        matchCount: 1,
      },
    ];
    const merged = mergeSessionSearchHits("doctor", title, content);
    expect(merged.map((h) => h.id)).toEqual(["s1", "s9"]);
    expect(merged[0].titleMatch).toBe(true);
    expect(merged[0].contentMatch).toBe(true);
    expect(merged[0].snippet).toContain("Doctor");
    expect(merged[1].titleMatch).toBe(false);
    expect(merged[1].matchCount).toBe(1);
  });

  it("empty query does not append content-only rows", () => {
    const title = [{ id: "s1", title: "A", projectId: null }];
    const content = [
      {
        id: "s9",
        title: "B",
        snippet: "x",
        matchCount: 3,
      },
    ];
    const merged = mergeSessionSearchHits("", title, content);
    expect(merged.map((h) => h.id)).toEqual(["s1"]);
  });
});

describe("tokenizeSearchText / tokenOverlapScore", () => {
  it("tokenizes latin and drops short noise", () => {
    expect(tokenizeSearchText("Fix doctor reset!")).toEqual([
      "fix",
      "doctor",
      "reset",
    ]);
    expect(tokenizeSearchText("a to of")).toEqual([]);
  });

  it("keeps CJK characters as tokens", () => {
    expect(tokenizeSearchText("修复医生重置")).toEqual([
      "修",
      "复",
      "医",
      "生",
      "重",
      "置",
    ]);
  });

  it("scores token recall over the query", () => {
    expect(tokenOverlapScore(["doctor", "button"], "Fix doctor reset")).toBe(
      0.5,
    );
    expect(
      tokenOverlapScore(["doctor", "button"], "Doctor reset button"),
    ).toBe(1);
    expect(tokenOverlapScore([], "anything")).toBe(0);
  });
});

describe("parseSessionSearchRankMode", () => {
  it("accepts hybrid aliases and defaults to keyword", () => {
    expect(parseSessionSearchRankMode("hybrid")).toBe("hybrid");
    expect(parseSessionSearchRankMode("semantic")).toBe("hybrid");
    expect(parseSessionSearchRankMode("keyword")).toBe("keyword");
    expect(parseSessionSearchRankMode("nope")).toBe("keyword");
    expect(parseSessionSearchRankMode(null)).toBe("keyword");
  });
});

describe("hybrid rank mode", () => {
  const hybridSessions = [
    { id: "s1", title: "Fix doctor reset", projectId: "p1" },
    { id: "s2", title: "Weekly plan", projectId: "p2" },
    { id: "s5", title: "Doctor dashboard UI", projectId: "p1" },
    { id: "s6", title: "Button styles", projectId: "p2" },
  ];

  it("keyword mode requires full substring", () => {
    const hits = filterSessionSearch(
      "doctor button",
      hybridSessions,
      projects,
      { rankMode: "keyword" },
    );
    expect(hits.matchedSessions.map((s) => s.id)).toEqual([]);
  });

  it("hybrid expands to token matches and ranks phrase hits first", () => {
    const hits = filterSessionSearch(
      "doctor button",
      hybridSessions,
      projects,
      { rankMode: "hybrid" },
    );
    const ids = hits.matchedSessions.map((s) => s.id);
    // doctor token → s1, s5; button token → s6
    expect(ids).toContain("s1");
    expect(ids).toContain("s5");
    expect(ids).toContain("s6");
    expect(ids).not.toContain("s2");
  });

  it("scoreSessionSearchHit prefers full phrase + more token overlap", () => {
    const q = "doctor reset";
    const phrase = scoreSessionSearchHit(q, {
      title: "Fix doctor reset",
      titleMatch: true,
    });
    const partial = scoreSessionSearchHit(q, {
      title: "Doctor dashboard UI",
      titleMatch: true,
    });
    const weak = scoreSessionSearchHit(q, {
      title: "Unrelated chat",
      snippet: "mentions doctor once",
      contentMatch: true,
      matchCount: 1,
    });
    expect(phrase).toBeGreaterThan(partial);
    expect(partial).toBeGreaterThan(0);
    expect(phrase).toBeGreaterThan(weak);
  });

  it("merge hybrid re-ranks content-only above weak title hits", () => {
    const title = [
      { id: "s6", title: "Button styles", projectId: "p2" },
      { id: "s1", title: "Fix doctor reset", projectId: "p1" },
    ];
    const content = [
      {
        id: "s9",
        title: "Other",
        snippet: "Please fix the doctor reset button now",
        matchCount: 3,
      },
    ];
    const keyword = mergeSessionSearchHits("doctor reset", title, content, {
      rankMode: "keyword",
    });
    // Keyword keeps title-first order.
    expect(keyword.map((h) => h.id)).toEqual(["s6", "s1", "s9"]);

    const hybrid = mergeSessionSearchHits("doctor reset", title, content, {
      rankMode: "hybrid",
    });
    // s1 has full phrase in title → top; s9 strong snippet; s6 only "button" unrelated.
    expect(hybrid[0].id).toBe("s1");
    expect(hybrid.map((h) => h.id)).toContain("s9");
    expect(hybrid.every((h) => typeof h.score === "number")).toBe(true);
  });
});
