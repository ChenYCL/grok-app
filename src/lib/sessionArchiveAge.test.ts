import { describe, expect, it } from "vitest";
import {
  ARCHIVE_AGE_DAY_OPTIONS,
  daysToMs,
  filterSessionsOlderThanDays,
  isSessionOlderThanDays,
} from "./sessionArchiveAge";

const NOW = new Date("2026-07-30T12:00:00.000Z").getTime();

function isoDaysAgo(days: number): string {
  return new Date(NOW - daysToMs(days)).toISOString();
}

describe("ARCHIVE_AGE_DAY_OPTIONS", () => {
  it("offers 7 / 30 / 90 day thresholds", () => {
    expect([...ARCHIVE_AGE_DAY_OPTIONS]).toEqual([7, 30, 90]);
  });
});

describe("daysToMs", () => {
  it("converts whole days to milliseconds", () => {
    expect(daysToMs(1)).toBe(86_400_000);
    expect(daysToMs(7)).toBe(7 * 86_400_000);
  });
});

describe("isSessionOlderThanDays", () => {
  it("is true when updatedAt is strictly older than the threshold", () => {
    expect(isSessionOlderThanDays(isoDaysAgo(8), 7, NOW)).toBe(true);
    expect(isSessionOlderThanDays(isoDaysAgo(7), 7, NOW)).toBe(false);
    expect(isSessionOlderThanDays(isoDaysAgo(6), 7, NOW)).toBe(false);
  });

  it("rejects invalid, empty, or non-positive inputs", () => {
    expect(isSessionOlderThanDays("", 7, NOW)).toBe(false);
    expect(isSessionOlderThanDays(null, 7, NOW)).toBe(false);
    expect(isSessionOlderThanDays("not-a-date", 7, NOW)).toBe(false);
    expect(isSessionOlderThanDays(isoDaysAgo(30), 0, NOW)).toBe(false);
    expect(isSessionOlderThanDays(isoDaysAgo(30), -1, NOW)).toBe(false);
  });
});

describe("filterSessionsOlderThanDays", () => {
  const rows = [
    { id: "fresh", updatedAt: isoDaysAgo(1), archived: false, pinned: false },
    { id: "old7", updatedAt: isoDaysAgo(8), archived: false, pinned: false },
    { id: "old30", updatedAt: isoDaysAgo(31), archived: false, pinned: false },
    { id: "old90", updatedAt: isoDaysAgo(100), archived: false, pinned: false },
    {
      id: "pinned-old",
      updatedAt: isoDaysAgo(100),
      archived: false,
      pinned: true,
    },
    {
      id: "archived-old",
      updatedAt: isoDaysAgo(100),
      archived: true,
      pinned: false,
    },
    {
      id: "bad-date",
      updatedAt: "nope",
      archived: false,
      pinned: false,
    },
  ];

  it("keeps only non-archived, non-pinned sessions older than N days", () => {
    expect(filterSessionsOlderThanDays(rows, 7, NOW).map((s) => s.id)).toEqual([
      "old7",
      "old30",
      "old90",
    ]);
    expect(filterSessionsOlderThanDays(rows, 30, NOW).map((s) => s.id)).toEqual(
      ["old30", "old90"],
    );
    expect(filterSessionsOlderThanDays(rows, 90, NOW).map((s) => s.id)).toEqual(
      ["old90"],
    );
  });

  it("skips pinned and already-archived rows", () => {
    const hits = filterSessionsOlderThanDays(rows, 7, NOW);
    expect(hits.some((s) => s.id === "pinned-old")).toBe(false);
    expect(hits.some((s) => s.id === "archived-old")).toBe(false);
  });

  it("returns empty for non-positive days or empty input", () => {
    expect(filterSessionsOlderThanDays(rows, 0, NOW)).toEqual([]);
    expect(filterSessionsOlderThanDays([], 7, NOW)).toEqual([]);
  });

  it("preserves input order", () => {
    const shuffled = [rows[3], rows[1], rows[2]];
    expect(
      filterSessionsOlderThanDays(shuffled, 7, NOW).map((s) => s.id),
    ).toEqual(["old90", "old7", "old30"]);
  });
});
