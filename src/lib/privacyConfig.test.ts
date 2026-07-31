import { describe, expect, it } from "vitest";
import {
  buildPrivacyPatch,
  CLI_PRIVACY_COMMAND,
  hasPrivacyChanges,
  isPrivacyWritable,
  privacyKeyPresence,
  privacyToggleChecked,
  togglePrivacyTri,
  valuesFromPrivacySnapshot,
  type PrivacyValues,
} from "./privacyConfig";

const base: PrivacyValues = {
  telemetry: false,
  traceUpload: false,
  mixpanelEnabled: false,
  disableCodebaseUpload: true,
  disableWorkspaceTeleport: true,
};

describe("valuesFromPrivacySnapshot", () => {
  it("maps missing keys to null (soft-fail, never invents defaults)", () => {
    expect(valuesFromPrivacySnapshot({})).toEqual({
      telemetry: null,
      traceUpload: null,
      mixpanelEnabled: null,
      disableCodebaseUpload: null,
      disableWorkspaceTeleport: null,
    });
    expect(valuesFromPrivacySnapshot(null)).toEqual({
      telemetry: null,
      traceUpload: null,
      mixpanelEnabled: null,
      disableCodebaseUpload: null,
      disableWorkspaceTeleport: null,
    });
  });

  it("maps present bools", () => {
    expect(
      valuesFromPrivacySnapshot({
        telemetry: false,
        traceUpload: true,
        mixpanelEnabled: false,
        disableCodebaseUpload: true,
        disableWorkspaceTeleport: false,
      }),
    ).toEqual({
      telemetry: false,
      traceUpload: true,
      mixpanelEnabled: false,
      disableCodebaseUpload: true,
      disableWorkspaceTeleport: false,
    });
  });
});

describe("buildPrivacyPatch", () => {
  it("emits only changed concrete fields", () => {
    const draft: PrivacyValues = {
      ...base,
      telemetry: true,
      disableCodebaseUpload: false,
    };
    const patch = buildPrivacyPatch(draft, base);
    expect(patch).toEqual({
      telemetry: true,
      disableCodebaseUpload: false,
    });
    expect(hasPrivacyChanges(patch)).toBe(true);
    expect(hasPrivacyChanges(buildPrivacyPatch(base, base))).toBe(false);
  });

  it("does not emit null→null or null-only draft fields", () => {
    const baseline: PrivacyValues = {
      telemetry: null,
      traceUpload: null,
      mixpanelEnabled: null,
      disableCodebaseUpload: null,
      disableWorkspaceTeleport: null,
    };
    // Still unset — no write.
    expect(buildPrivacyPatch(baseline, baseline)).toEqual({});
    // User toggled telemetry on from unset.
    const draft = { ...baseline, telemetry: true as const };
    expect(buildPrivacyPatch(draft, baseline)).toEqual({ telemetry: true });
  });
});

describe("togglePrivacyTri / presence", () => {
  it("cycles unset → true → false → true", () => {
    expect(togglePrivacyTri(null)).toBe(true);
    expect(togglePrivacyTri(true)).toBe(false);
    expect(togglePrivacyTri(false)).toBe(true);
  });

  it("presence and checked honesty", () => {
    expect(privacyKeyPresence(null)).toBe("unset");
    expect(privacyKeyPresence(true)).toBe("set_on");
    expect(privacyKeyPresence(false)).toBe("set_off");
    expect(privacyToggleChecked(null)).toBe(false);
    expect(privacyToggleChecked(true)).toBe(true);
    expect(privacyToggleChecked(false)).toBe(false);
  });
});

describe("isPrivacyWritable", () => {
  it("requires writable flag", () => {
    expect(isPrivacyWritable(undefined)).toBe(false);
    expect(isPrivacyWritable({ writable: false })).toBe(false);
    expect(isPrivacyWritable({ writable: true })).toBe(true);
  });
});

describe("CLI_PRIVACY_COMMAND", () => {
  it("is the coding-data slash command (not a config key)", () => {
    expect(CLI_PRIVACY_COMMAND).toBe("/privacy");
  });
});
