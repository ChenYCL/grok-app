import { describe, expect, it } from "vitest";
import {
  bucketFromCheckFields,
  classifyPrHubReason,
  formatChecksSummaryLine,
  normalizeMergeable,
  overallFromCounts,
  parseGhPrCheckObject,
  parseGhPrChecksJson,
  parseGhPrListJson,
  parseGhPrObject,
  parseGhPrViewJson,
  summarizeBuckets,
  summarizeChecks,
  summarizeStatusCheckRollup,
} from "./gitPrHub";

const SAMPLE_LIST = JSON.stringify([
  {
    number: 359,
    title: "feat(settings): CLI partial messages",
    url: "https://github.com/RongleCat/grok-app/pull/359",
    author: { login: "sonnemusk", name: "sonnemusk", is_bot: false },
    baseRefName: "main",
    headRefName: "feat/partial-stream",
    isDraft: false,
    mergeable: "UNKNOWN",
    state: "OPEN",
    createdAt: "2026-07-31T02:21:34Z",
    updatedAt: "2026-07-31T02:53:59Z",
    statusCheckRollup: [
      {
        __typename: "CheckRun",
        name: "frontend",
        status: "COMPLETED",
        conclusion: "SUCCESS",
      },
      {
        __typename: "CheckRun",
        name: "Rust macOS",
        status: "COMPLETED",
        conclusion: "SUCCESS",
      },
      {
        __typename: "CheckRun",
        name: "Rust Windows",
        status: "IN_PROGRESS",
        conclusion: null,
      },
    ],
  },
  {
    number: 1,
    title: "Draft example",
    url: "https://github.com/example/repo/pull/1",
    author: { login: "alice" },
    isDraft: true,
    mergeable: "CONFLICTING",
    state: "OPEN",
    headRefName: "fix/x",
    baseRefName: "main",
    statusCheckRollup: [
      { conclusion: "FAILURE", status: "COMPLETED", name: "ci" },
    ],
  },
]);

const SAMPLE_CHECKS = JSON.stringify([
  {
    bucket: "pass",
    link: "https://github.com/RongleCat/grok-app/actions/1",
    name: "frontend",
    state: "SUCCESS",
    workflow: "ci",
    description: "",
  },
  {
    bucket: "fail",
    name: "Rust Windows",
    state: "FAILURE",
    workflow: "ci",
  },
  {
    bucket: "pending",
    name: "Rust Linux",
    state: "PENDING",
  },
]);

describe("bucketFromCheckFields", () => {
  it("prefers explicit bucket", () => {
    expect(bucketFromCheckFields({ bucket: "pass", state: "FAILURE" })).toBe(
      "pass",
    );
  });

  it("maps conclusions", () => {
    expect(bucketFromCheckFields({ conclusion: "SUCCESS" })).toBe("pass");
    expect(bucketFromCheckFields({ conclusion: "FAILURE" })).toBe("fail");
    expect(bucketFromCheckFields({ conclusion: "CANCELLED" })).toBe("cancel");
    expect(bucketFromCheckFields({ conclusion: "SKIPPED" })).toBe("skipping");
    expect(bucketFromCheckFields({ conclusion: "TIMED_OUT" })).toBe("fail");
  });

  it("maps in-progress status to pending", () => {
    expect(
      bucketFromCheckFields({ status: "IN_PROGRESS", conclusion: null }),
    ).toBe("pending");
  });
});

describe("summarizeStatusCheckRollup", () => {
  it("counts success + pending", () => {
    const list = parseGhPrListJson(SAMPLE_LIST);
    expect(list).toHaveLength(2);
    const s = list[0]!.checks!;
    expect(s.pass).toBe(2);
    expect(s.pending).toBe(1);
    expect(s.total).toBe(3);
    expect(s.overall).toBe("pending");
  });

  it("empty rollup is none", () => {
    expect(summarizeStatusCheckRollup([])).toEqual({
      pass: 0,
      fail: 0,
      pending: 0,
      skipping: 0,
      cancel: 0,
      total: 0,
      overall: "none",
    });
    expect(summarizeStatusCheckRollup(null)).toMatchObject({ overall: "none" });
  });

  it("fail wins over pass", () => {
    const s = summarizeStatusCheckRollup([
      { conclusion: "SUCCESS", status: "COMPLETED" },
      { conclusion: "FAILURE", status: "COMPLETED" },
    ]);
    expect(s.overall).toBe("fail");
    expect(s.fail).toBe(1);
    expect(s.pass).toBe(1);
  });
});

describe("parseGhPrListJson", () => {
  it("parses array rows with author + mergeable", () => {
    const list = parseGhPrListJson(SAMPLE_LIST);
    expect(list[0]!.number).toBe(359);
    expect(list[0]!.author).toBe("sonnemusk");
    expect(list[0]!.headRefName).toBe("feat/partial-stream");
    expect(list[0]!.isDraft).toBe(false);
    expect(list[1]!.isDraft).toBe(true);
    expect(normalizeMergeable(list[1]!.mergeable)).toBe("conflicting");
    expect(list[1]!.checks!.overall).toBe("fail");
  });

  it("parses wrapped pullRequests key", () => {
    const list = parseGhPrListJson(
      JSON.stringify({
        pullRequests: [{ number: 7, title: "x", url: "https://x", author: "a" }],
      }),
    );
    expect(list).toHaveLength(1);
    expect(list[0]!.number).toBe(7);
  });

  it("returns empty for blank / invalid", () => {
    expect(parseGhPrListJson("")).toEqual([]);
    expect(parseGhPrListJson("not json")).toEqual([]);
    expect(parseGhPrListJson("[]")).toEqual([]);
  });

  it("tolerates leading log noise", () => {
    const list = parseGhPrListJson(
      "debug: loading\n" +
        JSON.stringify([{ number: 3, title: "t", url: "u", author: "a" }]),
    );
    expect(list).toHaveLength(1);
    expect(list[0]!.number).toBe(3);
  });
});

describe("parseGhPrViewJson", () => {
  it("parses single object + body", () => {
    const pr = parseGhPrViewJson(
      JSON.stringify({
        number: 344,
        title: "feat: ask timeout",
        url: "https://github.com/RongleCat/grok-app/pull/344",
        author: { login: "sonnemusk" },
        isDraft: false,
        mergeable: "MERGEABLE",
        state: "OPEN",
        body: "## Summary\nHello",
        statusCheckRollup: [],
      }),
    );
    expect(pr?.number).toBe(344);
    expect(pr?.body).toContain("Summary");
    expect(normalizeMergeable(pr?.mergeable)).toBe("mergeable");
    expect(pr?.checks?.overall).toBe("none");
  });

  it("returns null for invalid", () => {
    expect(parseGhPrViewJson("")).toBeNull();
    expect(parseGhPrViewJson("{}")).toBeNull();
  });
});

describe("parseGhPrChecksJson", () => {
  it("parses checks with buckets", () => {
    const checks = parseGhPrChecksJson(SAMPLE_CHECKS);
    expect(checks).toHaveLength(3);
    expect(checks[0]!.name).toBe("frontend");
    expect(checks[0]!.bucket).toBe("pass");
    expect(checks[1]!.bucket).toBe("fail");
    expect(checks[2]!.bucket).toBe("pending");
    const s = summarizeChecks(checks);
    expect(s.pass).toBe(1);
    expect(s.fail).toBe(1);
    expect(s.pending).toBe(1);
    expect(s.overall).toBe("fail");
  });

  it("infers bucket from state when missing", () => {
    const c = parseGhPrCheckObject({ name: "x", state: "SUCCESS" });
    expect(c?.bucket).toBe("pass");
  });

  it("returns empty for blank", () => {
    expect(parseGhPrChecksJson("")).toEqual([]);
    expect(parseGhPrChecksJson("[]")).toEqual([]);
  });
});

describe("formatChecksSummaryLine", () => {
  it("joins non-zero buckets", () => {
    expect(
      formatChecksSummaryLine({
        pass: 3,
        fail: 1,
        pending: 0,
        skipping: 0,
        cancel: 0,
        total: 4,
        overall: "fail",
      }),
    ).toBe("3 pass · 1 fail");
  });

  it("empty for no checks", () => {
    expect(formatChecksSummaryLine(null)).toBe("");
    expect(
      formatChecksSummaryLine({
        pass: 0,
        fail: 0,
        pending: 0,
        skipping: 0,
        cancel: 0,
        total: 0,
        overall: "none",
      }),
    ).toBe("");
  });
});

describe("overallFromCounts / summarizeBuckets", () => {
  it("all pass", () => {
    expect(summarizeBuckets(["pass", "pass"]).overall).toBe("pass");
  });

  it("pending without fail", () => {
    expect(overallFromCounts({ pass: 1, fail: 0, pending: 2, cancel: 0, total: 3 })).toBe(
      "pending",
    );
  });
});

describe("normalizeMergeable", () => {
  it("maps gh enum", () => {
    expect(normalizeMergeable("MERGEABLE")).toBe("mergeable");
    expect(normalizeMergeable("CONFLICTING")).toBe("conflicting");
    expect(normalizeMergeable("UNKNOWN")).toBe("unknown");
    expect(normalizeMergeable(null)).toBeNull();
  });
});

describe("classifyPrHubReason", () => {
  it("classifies soft-fail reasons", () => {
    expect(classifyPrHubReason("gh not available")).toBe("no_gh");
    expect(classifyPrHubReason("git not available")).toBe("no_git");
    expect(classifyPrHubReason("not a git repository")).toBe("not_repo");
    expect(classifyPrHubReason("empty path")).toBe("empty_path");
    expect(classifyPrHubReason(null)).toBeNull();
  });
});

describe("parseGhPrObject edge cases", () => {
  it("skips missing number", () => {
    expect(parseGhPrObject({ title: "x" })).toBeNull();
  });

  it("accepts string author", () => {
    const pr = parseGhPrObject({
      number: 9,
      title: "t",
      url: "u",
      author: "bob",
    });
    expect(pr?.author).toBe("bob");
  });
});
