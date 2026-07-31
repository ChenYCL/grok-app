import { describe, expect, it } from "vitest";
import {
  DEFAULT_EFFORT,
  GROK_BUILD_EFFORTS,
  effortDisplayLabel,
  effortsForModel,
  isValidEffort,
  mapEffortToTargetCatalog,
  pickDefaultEffort,
  type EffortOption,
  type ModelOption,
} from "./grokCatalog";

const modelWithEfforts: ModelOption = {
  id: "grok-4.5",
  label: "Grok 4.5",
  reasoningEfforts: [
    {
      id: "high",
      value: "high",
      label: "High Effort",
      description: "Deep",
      isDefault: true,
    },
    {
      id: "medium",
      value: "medium",
      label: "Medium Effort",
      isDefault: false,
    },
    {
      id: "low",
      value: "low",
      label: "Low Effort",
      isDefault: false,
    },
  ],
};

const modelCustomOnly: ModelOption = {
  id: "custom-model",
  label: "Custom",
  reasoningEfforts: [
    { id: "max", value: "max", label: "Max", isDefault: true },
    { id: "min", value: "min", label: "Min" },
  ],
};

describe("effortsForModel", () => {
  it("returns static fallback when model has no efforts", () => {
    expect(effortsForModel({ id: "x", label: "X" })).toEqual(
      GROK_BUILD_EFFORTS,
    );
    expect(effortsForModel(null)).toEqual(GROK_BUILD_EFFORTS);
    expect(effortsForModel(undefined)).toEqual(GROK_BUILD_EFFORTS);
  });

  it("returns model efforts when non-empty", () => {
    const list = effortsForModel(modelWithEfforts);
    expect(list).toHaveLength(3);
    expect(list[0].id).toBe("high");
    expect(list[0].label).toBe("High Effort");
  });

  it("prefers explicit catalogEfforts arg over model", () => {
    const override = [{ id: "only" }];
    expect(effortsForModel(modelWithEfforts, override)).toEqual(override);
  });
});

describe("isValidEffort", () => {
  it("accepts static low/medium/high without model", () => {
    expect(isValidEffort("low")).toBe(true);
    expect(isValidEffort("medium")).toBe(true);
    expect(isValidEffort("high")).toBe(true);
    expect(isValidEffort("max")).toBe(false);
    expect(isValidEffort("")).toBe(false);
  });

  it("accepts efforts for the selected model when known", () => {
    expect(isValidEffort("high", modelWithEfforts)).toBe(true);
    expect(isValidEffort("max", modelCustomOnly)).toBe(true);
    expect(isValidEffort("min", modelCustomOnly)).toBe(true);
    expect(isValidEffort("medium", modelCustomOnly)).toBe(false);
  });

  it("accepts an efforts array directly", () => {
    expect(isValidEffort("max", modelCustomOnly.reasoningEfforts)).toBe(true);
    expect(isValidEffort("high", modelCustomOnly.reasoningEfforts)).toBe(
      false,
    );
  });
});

describe("pickDefaultEffort", () => {
  it("uses model default flag when present", () => {
    expect(pickDefaultEffort(modelWithEfforts)).toBe("high");
    expect(pickDefaultEffort(modelCustomOnly)).toBe("max");
  });

  it("falls back to medium static default", () => {
    expect(pickDefaultEffort(null)).toBe(DEFAULT_EFFORT);
    expect(pickDefaultEffort({ id: "x", label: "X" })).toBe("medium");
  });
});

describe("mapEffortToTargetCatalog", () => {
  const deepseek: EffortOption[] = [
    { id: "low" },
    { id: "high" },
    { id: "xhigh" },
    { id: "max" },
  ];

  it("maps DeepSeek 4-tier onto Grok 3-tier (semantic high≠high)", () => {
    expect(
      mapEffortToTargetCatalog("low", GROK_BUILD_EFFORTS, deepseek),
    ).toBe("low");
    expect(
      mapEffortToTargetCatalog("high", GROK_BUILD_EFFORTS, deepseek),
    ).toBe("medium");
    expect(
      mapEffortToTargetCatalog("xhigh", GROK_BUILD_EFFORTS, deepseek),
    ).toBe("high");
    expect(
      mapEffortToTargetCatalog("max", GROK_BUILD_EFFORTS, deepseek),
    ).toBe("high");
  });

  it("maps Grok 3-tier onto DeepSeek 4-tier", () => {
    expect(mapEffortToTargetCatalog("low", deepseek, GROK_BUILD_EFFORTS)).toBe(
      "low",
    );
    expect(
      mapEffortToTargetCatalog("medium", deepseek, GROK_BUILD_EFFORTS),
    ).toBe("high");
    expect(
      mapEffortToTargetCatalog("high", deepseek, GROK_BUILD_EFFORTS),
    ).toBe("max");
  });

  it("keeps the id when same-kind catalog already contains it", () => {
    expect(
      mapEffortToTargetCatalog("medium", GROK_BUILD_EFFORTS, GROK_BUILD_EFFORTS),
    ).toBe("medium");
    expect(mapEffortToTargetCatalog("xhigh", deepseek, deepseek)).toBe(
      "xhigh",
    );
  });

  it("still maps xhigh/max onto Grok without source catalog", () => {
    expect(mapEffortToTargetCatalog("xhigh", GROK_BUILD_EFFORTS)).toBe("high");
    expect(mapEffortToTargetCatalog("max", GROK_BUILD_EFFORTS)).toBe("high");
  });
});

describe("effortDisplayLabel", () => {
  it("prefers i18n for known ids over English catalog labels", () => {
    expect(
      effortDisplayLabel(
        { id: "high", label: "High Effort" },
        { high: "高" },
      ),
    ).toBe("高");
    expect(
      effortDisplayLabel(
        { id: "medium", label: "Medium Effort" },
        { medium: "中" },
      ),
    ).toBe("中");
    expect(
      effortDisplayLabel(
        { id: "low", label: "Low Effort" },
        { high: "High", medium: "Medium", low: "Low" },
      ),
    ).toBe("Low");
  });

  it("uses i18n for known ids without catalog label", () => {
    expect(
      effortDisplayLabel("high", {
        high: "High",
        medium: "Medium",
        low: "Low",
      }),
    ).toBe("High");
    expect(effortDisplayLabel({ id: "medium" }, { medium: "中" })).toBe(
      "中",
    );
  });

  it("localizes DeepSeek-style xhigh/max over stored English names", () => {
    expect(
      effortDisplayLabel(
        { id: "xhigh", label: "xhigh" },
        { xhigh: "极高", max: "最高" },
      ),
    ).toBe("极高");
    expect(
      effortDisplayLabel(
        { id: "max", label: "Max" },
        { xhigh: "极高", max: "最高" },
      ),
    ).toBe("最高");
  });

  it("strips shared Effort suffix on non-standard catalog labels", () => {
    expect(
      effortDisplayLabel({ id: "custom-tier", label: "Max Effort" }),
    ).toBe("Max");
  });

  it("falls back to raw id", () => {
    expect(effortDisplayLabel("custom-tier")).toBe("custom-tier");
  });
});
