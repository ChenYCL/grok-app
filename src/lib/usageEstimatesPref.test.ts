import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHOW_USAGE_ESTIMATES,
  USAGE_ESTIMATES_STORAGE_KEY,
  loadShowUsageEstimatesPref,
  parseShowUsageEstimatesPref,
  saveShowUsageEstimatesPref,
  type UsageEstimatesStorage,
} from "./usageEstimatesPref";

function memoryStorage(
  initial: Record<string, string> = {},
): UsageEstimatesStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem(key) {
      return key in data ? data[key]! : null;
    },
    setItem(key, value) {
      data[key] = value;
    },
  };
}

describe("usageEstimatesPref", () => {
  it("defaults to on (with UI disclaimer)", () => {
    expect(DEFAULT_SHOW_USAGE_ESTIMATES).toBe(true);
    expect(parseShowUsageEstimatesPref(null)).toBe(true);
    expect(parseShowUsageEstimatesPref("")).toBe(true);
    expect(parseShowUsageEstimatesPref("maybe")).toBe(true);
    expect(loadShowUsageEstimatesPref(memoryStorage())).toBe(true);
  });

  it("parses true/false variants", () => {
    expect(parseShowUsageEstimatesPref("1")).toBe(true);
    expect(parseShowUsageEstimatesPref("true")).toBe(true);
    expect(parseShowUsageEstimatesPref(true)).toBe(true);
    expect(parseShowUsageEstimatesPref("0")).toBe(false);
    expect(parseShowUsageEstimatesPref("false")).toBe(false);
    expect(parseShowUsageEstimatesPref(false)).toBe(false);
  });

  it("round-trips preference", () => {
    const s = memoryStorage();
    saveShowUsageEstimatesPref(false, s);
    expect(s.data[USAGE_ESTIMATES_STORAGE_KEY]).toBe("0");
    expect(loadShowUsageEstimatesPref(s)).toBe(false);
    saveShowUsageEstimatesPref(true, s);
    expect(s.data[USAGE_ESTIMATES_STORAGE_KEY]).toBe("1");
    expect(loadShowUsageEstimatesPref(s)).toBe(true);
  });
});
