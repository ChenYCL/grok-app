import { describe, expect, it } from "vitest";
import {
  applyHunks,
  applySelectedHunks,
  applyUnifiedPatch,
  canAcceptWithContent,
  canRejectWithBefore,
  canRestoreAfter,
  needsUntrackedWipeConfirm,
  parseUnifiedDiff,
  planFileAccept,
  planFileReject,
  planFileRestore,
  preferGitCheckoutReject,
  rejectSelectedHunks,
  reverseHunks,
  splitPatchLines,
} from "./diffAccept";

const SAMPLE_DIFF = `--- a/hello.txt
+++ b/hello.txt
@@ -1,3 +1,3 @@
 line1
-line2
+line2-edited
 line3
`;

describe("splitPatchLines", () => {
  it("drops trailing empty from final newline", () => {
    expect(splitPatchLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitPatchLines("")).toEqual([]);
  });
});

describe("parseUnifiedDiff", () => {
  it("parses path and hunk body", () => {
    const p = parseUnifiedDiff(SAMPLE_DIFF);
    expect(p.filePath).toBe("hello.txt");
    expect(p.hunks).toHaveLength(1);
    expect(p.hunks[0]!.oldStart).toBe(1);
    expect(p.hunks[0]!.oldCount).toBe(3);
    expect(p.hunks[0]!.newStart).toBe(1);
    expect(p.hunks[0]!.newCount).toBe(3);
    expect(p.hunks[0]!.lines.some((l) => l.startsWith("-line2"))).toBe(true);
    expect(p.hunks[0]!.lines.some((l) => l.startsWith("+line2-edited"))).toBe(
      true,
    );
  });

  it("returns empty hunks for garbage", () => {
    expect(parseUnifiedDiff("not a diff").hunks).toEqual([]);
  });
});

describe("applyUnifiedPatch / applyHunks", () => {
  it("applies a simple substitution", () => {
    const original = "line1\nline2\nline3\n";
    const r = applyUnifiedPatch(original, SAMPLE_DIFF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content).toBe("line1\nline2-edited\nline3\n");
    }
  });

  it("fails on context mismatch", () => {
    const original = "line1\nOTHER\nline3\n";
    const r = applyUnifiedPatch(original, SAMPLE_DIFF);
    expect(r.ok).toBe(false);
  });

  it("applies pure addition hunk", () => {
    const diff = `--- a/f
+++ b/f
@@ -0,0 +1,2 @@
+alpha
+beta
`;
    const r = applyUnifiedPatch("", diff);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe("alpha\nbeta\n");
  });

  it("applies pure deletion hunk", () => {
    const diff = `--- a/f
+++ b/f
@@ -1,2 +0,0 @@
-alpha
-beta
`;
    const r = applyUnifiedPatch("alpha\nbeta\n", diff);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe("");
  });
});

describe("reverseHunks / rejectSelectedHunks", () => {
  it("reverses an applied patch", () => {
    const original = "line1\nline2\nline3\n";
    const applied = applyUnifiedPatch(original, SAMPLE_DIFF);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const hunks = parseUnifiedDiff(SAMPLE_DIFF).hunks;
    const back = reverseHunks(applied.content, hunks);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.content).toBe(original);
  });

  it("rejectSelectedHunks undoes only chosen indices", () => {
    const original = "a\nb\nc\nd\n";
    const diff = `--- a/f
+++ b/f
@@ -1,2 +1,2 @@
-a
+A
 b
@@ -3,2 +3,2 @@
-c
+C
 d
`;
    const hunks = parseUnifiedDiff(diff).hunks;
    expect(hunks).toHaveLength(2);
    const all = applyHunks(original, hunks);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    // Reject only first hunk → A→a, keep C
    const partial = rejectSelectedHunks(all.content, hunks, [0]);
    expect(partial.ok).toBe(true);
    if (partial.ok) expect(partial.content).toBe("a\nb\nC\nd\n");
  });
});

describe("applySelectedHunks", () => {
  it("applies only selected indices", () => {
    const original = "a\nb\nc\nd\n";
    const diff = `--- a/f
+++ b/f
@@ -1,2 +1,2 @@
-a
+A
 b
@@ -3,2 +3,2 @@
-c
+C
 d
`;
    const hunks = parseUnifiedDiff(diff).hunks;
    const r = applySelectedHunks(original, hunks, [1]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe("a\nb\nC\nd\n");
  });
});

describe("safety / plans", () => {
  it("needsUntrackedWipeConfirm", () => {
    expect(needsUntrackedWipeConfirm("untracked")).toBe(true);
    expect(needsUntrackedWipeConfirm("added")).toBe(true);
    expect(needsUntrackedWipeConfirm("modified")).toBe(false);
    expect(needsUntrackedWipeConfirm(null)).toBe(false);
  });

  it("preferGitCheckoutReject", () => {
    expect(preferGitCheckoutReject(true, "modified")).toBe(true);
    expect(preferGitCheckoutReject(false, "modified")).toBe(false);
    expect(preferGitCheckoutReject(true, "ignored")).toBe(false);
  });

  it("content guards", () => {
    expect(canAcceptWithContent("x")).toBe(true);
    expect(canAcceptWithContent(null)).toBe(false);
    expect(canRejectWithBefore("")).toBe(true);
    expect(canRestoreAfter(undefined)).toBe(false);
  });

  it("planFileReject prefers git when available", () => {
    const p = planFileReject({
      hasGitRepo: true,
      kind: "modified",
      before: "old",
    });
    expect(p).toEqual({ mode: "git", confirmUntracked: false });
  });

  it("planFileReject requires confirm for untracked", () => {
    const p = planFileReject({
      hasGitRepo: true,
      kind: "untracked",
    });
    expect(p).toEqual({ mode: "git", confirmUntracked: true });
  });

  it("planFileReject falls back to before write without git", () => {
    const p = planFileReject({
      hasGitRepo: false,
      kind: "modified",
      before: "old\n",
    });
    expect(p).toEqual({ mode: "write_before", content: "old\n" });
  });

  it("planFileReject delete untracked without git", () => {
    const p = planFileReject({
      hasGitRepo: false,
      kind: "untracked",
      fileExists: true,
    });
    expect(p).toEqual({ mode: "delete", confirmUntracked: true });
  });

  it("planFileReject unavailable when no git and no before", () => {
    const p = planFileReject({ hasGitRepo: false, kind: "modified" });
    expect(p.mode).toBe("unavailable");
  });

  it("planFileAccept / restore", () => {
    expect(planFileAccept({ after: "new" })).toEqual({
      mode: "write_after",
      content: "new",
    });
    expect(planFileAccept({ alreadyApplied: true })).toEqual({
      mode: "keep_current",
    });
    expect(planFileAccept({})).toEqual({ mode: "keep_current" });
    expect(planFileRestore({ after: "x" }).mode).toBe("write_after");
    expect(planFileRestore({}).mode).toBe("unavailable");
  });
});
