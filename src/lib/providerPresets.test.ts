import { describe, expect, it } from "vitest";
import {
  DEEPSEEK_EFFORTS,
  DEEPSEEK_MODELS,
  PROVIDER_PRESETS,
  defaultCustomChannelEfforts,
  findProviderPreset,
} from "./providerPresets";

describe("providerPresets", () => {
  it("ships DeepSeek with both models and low/high/xhigh/max efforts", () => {
    const ds = findProviderPreset("deepseek");
    expect(ds).toBeDefined();
    expect(ds!.models.map((m) => m.id)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
    expect(DEEPSEEK_MODELS).toHaveLength(2);
    expect(DEEPSEEK_EFFORTS.map((e) => e.id)).toEqual([
      "low",
      "high",
      "xhigh",
      "max",
    ]);
    expect(DEEPSEEK_EFFORTS.find((e) => e.isDefault)?.id).toBe("high");
    expect(PROVIDER_PRESETS.some((p) => p.id === "deepseek")).toBe(true);
  });

  it("defaults blank custom channels to Grok low/medium/high (ladder order)", () => {
    expect(defaultCustomChannelEfforts().map((e) => e.id)).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });
});
