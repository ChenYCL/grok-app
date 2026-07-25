/**
 * Structural guard: Remote IM UI must not use native checkbox/radio/select.
 * Project chrome only: Select, ui-check, ext-switch, settings-seg.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

const FILES = [
  "RemoteImChannelPanel.tsx",
  "RemoteImLayout.tsx",
  "RemoteImOverview.tsx",
  "remoteIm/RimControls.tsx",
];

describe("Remote IM UI chrome guard", () => {
  for (const rel of FILES) {
    it(`${rel} avoids native checkbox/radio/select`, () => {
      const src = readFileSync(join(ROOT, rel), "utf8");
      expect(src).not.toMatch(/type=["']checkbox["']/);
      expect(src).not.toMatch(/type=["']radio["']/);
      expect(src).not.toMatch(/<select[\s>]/);
      // Must not use our earlier ad-hoc rim-switch/rim-radio labels for native
      expect(src).not.toMatch(/rim-switch/);
      expect(src).not.toMatch(/rim-radio/);
    });
  }

  it("RimControls reuses project Select + ui-check + ext-switch", () => {
    const src = readFileSync(join(ROOT, "remoteIm/RimControls.tsx"), "utf8");
    expect(src).toContain('from "@/components/Select"');
    expect(src).toContain("ext-switch");
    expect(src).toContain("ui-check");
    expect(src).toContain("settings-seg");
  });

  it("ChannelPanel uses settings-card / settings-row / settings-input", () => {
    const src = readFileSync(join(ROOT, "RemoteImChannelPanel.tsx"), "utf8");
    expect(src).toContain("settings-card");
    expect(src).toContain("settings-row");
    expect(src).toContain("settings-input");
    expect(src).toContain("RimSelect");
    expect(src).toContain("RimCheck");
    expect(src).toContain("RimSwitch");
    expect(src).toContain("RimSeg");
    expect(src).toContain("showsPublicUrlCallout");
  });
});
