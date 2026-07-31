import { describe, expect, it } from "vitest";
import {
  estimateDurationSecFromTimestamps,
  formatWorkDuration,
} from "./formatWorkDuration";

describe("formatWorkDuration", () => {
  it("formats seconds under a minute", () => {
    expect(formatWorkDuration(0)).toBe("0s");
    expect(formatWorkDuration(1)).toBe("1s");
    expect(formatWorkDuration(38)).toBe("38s");
    expect(formatWorkDuration(59)).toBe("59s");
  });

  it("formats minutes + seconds like Grok web", () => {
    expect(formatWorkDuration(60)).toBe("1m");
    expect(formatWorkDuration(62)).toBe("1m 2s");
    expect(formatWorkDuration(125)).toBe("2m 5s");
  });

  it("formats hours", () => {
    expect(formatWorkDuration(3600)).toBe("1h");
    expect(formatWorkDuration(3661)).toBe("1h 1m 1s");
    expect(formatWorkDuration(3720)).toBe("1h 2m");
  });
});

describe("estimateDurationSecFromTimestamps", () => {
  it("returns span between earliest and latest", () => {
    expect(
      estimateDurationSecFromTimestamps([
        "2026-07-26T01:10:00Z",
        "2026-07-26T01:10:38Z",
      ]),
    ).toBe(38);
  });

  it("returns null without enough points", () => {
    expect(estimateDurationSecFromTimestamps([])).toBeNull();
    expect(
      estimateDurationSecFromTimestamps(["2026-07-26T01:10:00Z"]),
    ).toBeNull();
  });
});
