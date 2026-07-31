import { describe, expect, it } from "vitest";
import {
  WORKFLOWS_ENABLED_CONFIG_KEY,
  collectWorkflowDefs,
  formatDiscoveredWorkflowNames,
  grokHomeFromUserHome,
  isWorkflowDefinitionFileName,
  normalizeWorkflowsEnabled,
  resolveWorkflowDirs,
  workflowMetaLine,
  workflowNameFromFileName,
  workflowNamesFromFileList,
  workflowsEnabledEqual,
} from "./workflows";

describe("normalizeWorkflowsEnabled", () => {
  it("defaults off", () => {
    expect(normalizeWorkflowsEnabled(undefined)).toBe(false);
    expect(normalizeWorkflowsEnabled(null)).toBe(false);
    expect(normalizeWorkflowsEnabled(false)).toBe(false);
    expect(normalizeWorkflowsEnabled(true)).toBe(true);
  });

  it("equality after normalize", () => {
    expect(workflowsEnabledEqual(null, false)).toBe(true);
    expect(workflowsEnabledEqual(true, true)).toBe(true);
    expect(workflowsEnabledEqual(true, false)).toBe(false);
  });
});

describe("file name filters", () => {
  it("accepts .rhai only", () => {
    expect(isWorkflowDefinitionFileName("review-changes.rhai")).toBe(true);
    expect(isWorkflowDefinitionFileName("Foo.RHAI")).toBe(true);
    expect(isWorkflowDefinitionFileName("notes.md")).toBe(false);
    expect(isWorkflowDefinitionFileName(".hidden.rhai")).toBe(false);
    expect(isWorkflowDefinitionFileName("README.rhai")).toBe(false);
    expect(isWorkflowDefinitionFileName("")).toBe(false);
    expect(isWorkflowDefinitionFileName(null)).toBe(false);
  });

  it("stems names", () => {
    expect(workflowNameFromFileName("review-changes.rhai")).toBe(
      "review-changes",
    );
    expect(workflowNameFromFileName("path/to/find-flaky.rhai")).toBe(
      "find-flaky",
    );
  });

  it("lists unique sorted names", () => {
    expect(
      workflowNamesFromFileList([
        "b.rhai",
        "a.rhai",
        "a.rhai",
        "skip.md",
        ".x.rhai",
      ]),
    ).toEqual(["a", "b"]);
  });
});

describe("paths", () => {
  it("resolves user + project dirs", () => {
    const d = resolveWorkflowDirs("/Users/me", "/repo/app");
    expect(d.user).toBe("/Users/me/.grok/workflows");
    expect(d.project).toBe("/repo/app/.grok/workflows");
    expect(d.skillDoc).toContain("create-workflow");
    expect(d.skillDoc.endsWith("SKILL.md")).toBe(true);
  });

  it("handles missing project", () => {
    expect(resolveWorkflowDirs("/home/u").project).toBeNull();
    expect(grokHomeFromUserHome("/home/u")).toBe("/home/u/.grok");
  });
});

describe("collectWorkflowDefs", () => {
  it("prefers project over user on name clash", () => {
    const rows = collectWorkflowDefs({
      projectFiles: ["review.rhai"],
      userFiles: ["review.rhai", "other.rhai"],
      projectDir: "/p/.grok/workflows",
      userDir: "/h/.grok/workflows",
    });
    expect(rows.map((r) => r.name)).toEqual(["review", "other"]);
    expect(rows[0].scope).toBe("project");
    expect(rows[0].path).toContain("/p/");
    expect(rows[1].scope).toBe("user");
  });
});

describe("display helpers", () => {
  it("meta line and summary", () => {
    expect(
      workflowMetaLine({ name: "review", scope: "project" }),
    ).toContain("project");
    expect(formatDiscoveredWorkflowNames([])).toBeNull();
    expect(
      formatDiscoveredWorkflowNames([{ name: "a" }, { name: "b" }]),
    ).toBe("a, b");
    const many = Array.from({ length: 14 }, (_, i) => ({ name: `w${i}` }));
    const s = formatDiscoveredWorkflowNames(many, 3);
    expect(s).toContain("+11");
  });

  it("exports config key constant", () => {
    expect(WORKFLOWS_ENABLED_CONFIG_KEY).toBe("workflows_enabled");
  });
});
