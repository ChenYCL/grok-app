import { describe, expect, it } from "vitest";
import {
  GROK_ACTIVITY_STEP_ROW_PX,
  GROK_ACTIVITY_VIRTUAL_VISIBLE_ROWS,
  GROK_ACTIVITY_VIRTUALIZE_THRESHOLD,
  applyActivityStepExpand,
  grokActivityVirtualMaxHeightPx,
  shouldVirtualizeActivityWithExpand,
  shouldVirtualizeGrokActivitySteps,
} from "./grokActivityVirtualize";
import { toolExpandBody } from "./toolDisplay";

describe("grokActivityVirtualize", () => {
  it("keeps short lists non-virtual (≤ threshold)", () => {
    expect(shouldVirtualizeGrokActivitySteps(0)).toBe(false);
    expect(shouldVirtualizeGrokActivitySteps(1)).toBe(false);
    expect(
      shouldVirtualizeGrokActivitySteps(GROK_ACTIVITY_VIRTUALIZE_THRESHOLD),
    ).toBe(false);
  });

  it("virtualizes when count exceeds threshold", () => {
    expect(
      shouldVirtualizeGrokActivitySteps(GROK_ACTIVITY_VIRTUALIZE_THRESHOLD + 1),
    ).toBe(true);
    expect(shouldVirtualizeGrokActivitySteps(100)).toBe(true);
  });

  it("maxHeight is min(visibleRows, count) × row height", () => {
    expect(grokActivityVirtualMaxHeightPx(0)).toBe(0);
    expect(grokActivityVirtualMaxHeightPx(5)).toBe(5 * GROK_ACTIVITY_STEP_ROW_PX);
    expect(grokActivityVirtualMaxHeightPx(15)).toBe(
      GROK_ACTIVITY_VIRTUAL_VISIBLE_ROWS * GROK_ACTIVITY_STEP_ROW_PX,
    );
    expect(grokActivityVirtualMaxHeightPx(100)).toBe(
      GROK_ACTIVITY_VIRTUAL_VISIBLE_ROWS * GROK_ACTIVITY_STEP_ROW_PX,
    );
  });

  it("row height constant matches virtual CSS contract (30px)", () => {
    expect(GROK_ACTIVITY_STEP_ROW_PX).toBe(30);
    expect(GROK_ACTIVITY_VIRTUALIZE_THRESHOLD).toBe(14);
    expect(GROK_ACTIVITY_VIRTUAL_VISIBLE_ROWS).toBe(12);
  });

  it("expand leaves VirtualList and keys survive leave-VL remount (no unmount clear)", () => {
    const stepCount = GROK_ACTIVITY_VIRTUALIZE_THRESHOLD + 5; // >14 → would virtualize
    expect(shouldVirtualizeActivityWithExpand(stepCount, 0)).toBe(true);

    // User expands a tool step that has detail body (shipped expand helper).
    const body = toolExpandBody(
      {
        toolCallId: "bash-1",
        toolKind: "run_terminal_command",
        detail: "line1\nline2\nline3",
      },
      false,
    );
    expect(body.hasBody).toBe(true);

    let expanded = new Set<string>();
    // Simulate click open — parent reducer only (no unmount side-effect).
    expanded = applyActivityStepExpand(expanded, "bash-1", true);
    expect(expanded.has("bash-1")).toBe(true);
    expect(shouldVirtualizeActivityWithExpand(stepCount, expanded.size)).toBe(
      false,
    );

    // VirtualList → full map remount: old row would have run cleanup
    // onExpandChange(key,false) in the buggy version. Parent-owned set must
    // ignore that — only applyActivityStepExpand(open=false) on real toggle.
    const afterRemountNoise = applyActivityStepExpand(
      expanded,
      "bash-1",
      true,
    ); // remount default must not force false
    expect(afterRemountNoise.has("bash-1")).toBe(true);
    expect(
      shouldVirtualizeActivityWithExpand(stepCount, afterRemountNoise.size),
    ).toBe(false);

    // Explicit user collapse re-enters VirtualList.
    expanded = applyActivityStepExpand(afterRemountNoise, "bash-1", false);
    expect(expanded.has("bash-1")).toBe(false);
    expect(shouldVirtualizeActivityWithExpand(stepCount, expanded.size)).toBe(
      true,
    );
  });
});
