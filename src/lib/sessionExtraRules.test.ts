import { describe, expect, it } from "vitest";
import {
  SESSION_EXTRA_RULES_MAX_CHARS,
  extraRulesSpawnArgs,
  hasExtraRules,
  sanitizeExtraRules,
} from "./sessionExtraRules";

describe("sanitizeExtraRules", () => {
  it("returns empty for nullish / whitespace", () => {
    expect(sanitizeExtraRules(null)).toBe("");
    expect(sanitizeExtraRules(undefined)).toBe("");
    expect(sanitizeExtraRules("")).toBe("");
    expect(sanitizeExtraRules("   \n\t  ")).toBe("");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeExtraRules("  prefer tests  ")).toBe("prefer tests");
    expect(sanitizeExtraRules("\nline a\nline b\n")).toBe("line a\nline b");
  });

  it("clamps to max length after trim", () => {
    const long = "x".repeat(100);
    expect(sanitizeExtraRules(long, 10)).toBe("x".repeat(10));
    expect(sanitizeExtraRules("  " + "y".repeat(50) + "  ", 5)).toBe(
      "y".repeat(5),
    );
  });

  it("uses the default 32 KiB soft cap", () => {
    const ok = "a".repeat(SESSION_EXTRA_RULES_MAX_CHARS);
    expect(sanitizeExtraRules(ok).length).toBe(SESSION_EXTRA_RULES_MAX_CHARS);
    const over = "b".repeat(SESSION_EXTRA_RULES_MAX_CHARS + 20);
    expect(sanitizeExtraRules(over).length).toBe(SESSION_EXTRA_RULES_MAX_CHARS);
  });
});

describe("extraRulesSpawnArgs", () => {
  it("builds top-level --rules pair", () => {
    expect(extraRulesSpawnArgs("Always write tests")).toEqual([
      "--rules",
      "Always write tests",
    ]);
  });

  it("omits the flag when empty after sanitize", () => {
    expect(extraRulesSpawnArgs("")).toEqual([]);
    expect(extraRulesSpawnArgs(null)).toEqual([]);
    expect(extraRulesSpawnArgs("   ")).toEqual([]);
  });

  it("does not place rules under agent/stdio flags", () => {
    const args = extraRulesSpawnArgs("be concise");
    expect(args[0]).toBe("--rules");
    expect(args).not.toContain("agent");
    expect(args).not.toContain("stdio");
  });
});

describe("hasExtraRules", () => {
  it("is true only for non-empty sanitized text", () => {
    expect(hasExtraRules("hi")).toBe(true);
    expect(hasExtraRules("  ")).toBe(false);
    expect(hasExtraRules(null)).toBe(false);
  });
});
