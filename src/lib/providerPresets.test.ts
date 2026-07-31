import { describe, expect, it } from "vitest";
import {
  AMUX_MODELS,
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

  it("ships Amux with grok-4.5 display name Grok 4.5 and Grok efforts", () => {
    const amux = findProviderPreset("amux");
    expect(amux).toBeDefined();
    expect(amux!.baseUrl).toBe("https://api.amux.ai/v1");
    expect(amux!.apiBackend).toBe("responses");
    expect(AMUX_MODELS).toEqual([{ id: "grok-4.5", name: "Grok 4.5" }]);
    expect(amux!.models).toEqual(AMUX_MODELS);
    expect(amux!.efforts.map((e) => e.id)).toEqual(["low", "medium", "high"]);
  });

  it("defaults blank custom channels to Grok low/medium/high (ladder order)", () => {
    expect(defaultCustomChannelEfforts().map((e) => e.id)).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });
});
