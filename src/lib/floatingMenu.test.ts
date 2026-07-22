import { describe, expect, it, beforeAll } from "vitest";
import { computeFloatingPos, floatingStyle } from "./floatingMenu";

beforeAll(() => {
  Object.defineProperty(globalThis, "innerWidth", {
    value: 1024,
    configurable: true,
  });
  Object.defineProperty(globalThis, "innerHeight", {
    value: 768,
    configurable: true,
  });
});

function rect(
  partial: Partial<DOMRect> & {
    top: number;
    left: number;
    width: number;
    height: number;
  },
): DOMRect {
  const bottom = partial.top + partial.height;
  const right = partial.left + partial.width;
  return {
    x: partial.left,
    y: partial.top,
    top: partial.top,
    left: partial.left,
    width: partial.width,
    height: partial.height,
    bottom,
    right,
    toJSON: () => ({}),
  };
}

describe("computeFloatingPos", () => {
  it("prefers above when more space above", () => {
    const r = rect({ top: 600, left: 40, width: 120, height: 32 });
    const pos = computeFloatingPos(r, {
      placement: "auto",
      estHeight: 200,
      width: 200,
    });
    expect(pos.placeAbove).toBe(true);
    expect(pos.top).toBeLessThan(r.top + 1);
  });

  it("honors placement down", () => {
    const r = rect({ top: 100, left: 40, width: 80, height: 28 });
    const pos = computeFloatingPos(r, { placement: "down", width: 160 });
    expect(pos.placeAbove).toBe(false);
    expect(pos.top).toBeGreaterThan(r.bottom);
  });

  it("clamps left within viewport", () => {
    const r = rect({ top: 100, left: 9000, width: 80, height: 28 });
    const pos = computeFloatingPos(r, { width: 200, placement: "down" });
    expect(pos.left + pos.width).toBeLessThanOrEqual(1024);
  });

  it("matchTriggerWidth expands panel", () => {
    const r = rect({ top: 100, left: 20, width: 280, height: 32 });
    const pos = computeFloatingPos(r, {
      width: 100,
      matchTriggerWidth: true,
      placement: "down",
    });
    expect(pos.width).toBeGreaterThanOrEqual(280);
  });
});

describe("floatingStyle", () => {
  it("uses translateY for above placement", () => {
    const s = floatingStyle({
      left: 10,
      top: 100,
      width: 200,
      placeAbove: true,
      maxHeight: 200,
    });
    expect(s?.transform).toBe("translateY(-100%)");
    expect(s?.position).toBe("fixed");
  });
});
