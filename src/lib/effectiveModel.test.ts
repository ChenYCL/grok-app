import { describe, expect, it } from "vitest";
import { effectiveComposerModel } from "./effectiveModel";

describe("effectiveComposerModel", () => {
  it("keeps the official catalog selection on the official route", () => {
    expect(effectiveComposerModel("grok-4.5", null)).toBe("grok-4.5");
    expect(effectiveComposerModel("grok-3", undefined)).toBe("grok-3");
  });

  it("prefers the active custom provider request model", () => {
    expect(effectiveComposerModel("grok-4.5", "deepseek-v4-flash")).toBe(
      "deepseek-v4-flash",
    );
  });

  it("falls back to the composer selection when provider model is blank", () => {
    expect(effectiveComposerModel("grok-4.5", "")).toBe("grok-4.5");
    expect(effectiveComposerModel("grok-4.5", "   ")).toBe("grok-4.5");
  });

  it("keeps the composer selection when no provider is active", () => {
    expect(effectiveComposerModel("grok-4.5", "")).toBe("grok-4.5");
  });
});
