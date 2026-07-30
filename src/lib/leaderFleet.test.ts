import { describe, expect, it } from "vitest";
import {
  formatLeaderRowSummary,
  formatLeaderUptimeMs,
  hasLeaderFleet,
  leaderInfoDetailRows,
  leaderRowKey,
} from "./leaderFleet";

describe("leaderFleet", () => {
  it("leaderRowKey prefers pid then socket", () => {
    expect(leaderRowKey({ pid: 12 }, 0)).toBe("pid-12");
    expect(leaderRowKey({ socketPath: "/tmp/a.sock" }, 1)).toBe("sock-/tmp/a.sock");
    expect(leaderRowKey({}, 3)).toBe("idx-3");
  });

  it("formatLeaderRowSummary joins known fields", () => {
    expect(
      formatLeaderRowSummary({
        pid: 7601,
        classification: "Reachable",
        version: "0.2.1",
        socketPath: "/Users/x/.grok/leader.sock",
      }),
    ).toBe("PID 7601 · Reachable · v0.2.1 · /Users/x/.grok/leader.sock");
    expect(formatLeaderRowSummary({})).toBe("—");
  });

  it("formatLeaderUptimeMs formats buckets", () => {
    expect(formatLeaderUptimeMs(null)).toBeNull();
    expect(formatLeaderUptimeMs(-1)).toBeNull();
    expect(formatLeaderUptimeMs(4500)).toBe("4s");
    expect(formatLeaderUptimeMs(125_000)).toBe("2m 5s");
    expect(formatLeaderUptimeMs(3_600_000)).toBe("1h");
    expect(formatLeaderUptimeMs(3_660_000)).toBe("1h 1m");
  });

  it("leaderInfoDetailRows maps structured fields", () => {
    const rows = leaderInfoDetailRows({
      pid: 42,
      socketPath: "/tmp/l.sock",
      version: "0.3.1",
      protocolVersion: "1",
      classification: "Reachable",
      uptimeMs: 12_000,
      activeToolCalls: 2,
    });
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(byKey.pid).toBe("42");
    expect(byKey.socketPath).toBe("/tmp/l.sock");
    expect(byKey.version).toBe("0.3.1");
    expect(byKey.protocolVersion).toBe("1");
    expect(byKey.uptime).toBe("12s");
    expect(byKey.activeToolCalls).toBe("2");
  });

  it("leaderInfoDetailRows falls back to raw JSON", () => {
    const rows = leaderInfoDetailRows({ raw: { foo: "bar" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("raw");
    expect(rows[0].value).toContain("foo");
  });

  it("hasLeaderFleet", () => {
    expect(hasLeaderFleet(null)).toBe(false);
    expect(hasLeaderFleet([])).toBe(false);
    expect(hasLeaderFleet([{ pid: 1 }])).toBe(true);
  });
});
