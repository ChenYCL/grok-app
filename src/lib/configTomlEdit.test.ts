import { describe, expect, it } from "vitest";
import {
  buildConfigEditPatch,
  hasConfigEditChanges,
  normalizePermissionMode,
  valuesFromSnapshot,
  type ConfigEditValues,
} from "./configTomlEdit";

const base: ConfigEditValues = {
  permissionMode: "default",
  yolo: false,
  subagentsEnabled: true,
  memoryEnabled: false,
};

describe("normalizePermissionMode", () => {
  it("maps aliases", () => {
    expect(normalizePermissionMode("default")).toBe("default");
    expect(normalizePermissionMode("accept_edits")).toBe("acceptEdits");
    expect(normalizePermissionMode("dontAsk")).toBe("dontAsk");
    expect(normalizePermissionMode("always-approve")).toBe("always-approve");
    expect(normalizePermissionMode("yolo")).toBe("always-approve");
    expect(normalizePermissionMode("nope")).toBeNull();
    expect(normalizePermissionMode("")).toBeNull();
  });
});

describe("buildConfigEditPatch", () => {
  it("emits only changed fields", () => {
    const draft: ConfigEditValues = {
      ...base,
      yolo: true,
      memoryEnabled: true,
    };
    const patch = buildConfigEditPatch(draft, base);
    expect(patch).toEqual({ yolo: true, memoryEnabled: true });
    expect(hasConfigEditChanges(patch)).toBe(true);
    expect(hasConfigEditChanges(buildConfigEditPatch(base, base))).toBe(false);
  });

  it("includes permission mode when set", () => {
    const draft: ConfigEditValues = {
      ...base,
      permissionMode: "dontAsk",
    };
    expect(buildConfigEditPatch(draft, base).permissionMode).toBe("dontAsk");
  });
});

describe("valuesFromSnapshot", () => {
  it("applies defaults for missing keys", () => {
    expect(valuesFromSnapshot({})).toEqual({
      permissionMode: "",
      yolo: false,
      subagentsEnabled: true,
      memoryEnabled: false,
    });
    expect(
      valuesFromSnapshot({
        permissionMode: "acceptEdits",
        yolo: true,
        subagentsEnabled: false,
        memoryEnabled: true,
      }),
    ).toEqual({
      permissionMode: "acceptEdits",
      yolo: true,
      subagentsEnabled: false,
      memoryEnabled: true,
    });
  });
});
