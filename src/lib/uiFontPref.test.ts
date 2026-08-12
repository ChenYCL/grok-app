import { describe, expect, it } from "vitest";
import {
  applyUiFontFamily,
  loadUiFontFamily,
  saveUiFontFamily,
} from "./uiFontPref";

function mem() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
    removeItem: (k: string) => {
      m.delete(k);
    },
  };
}

describe("uiFontPref", () => {
  it("persists and applies --font-sans", () => {
    const s = mem();
    saveUiFontFamily("PingFang SC", s);
    expect(loadUiFontFamily(s)).toBe("PingFang SC");
    const props = new Map<string, string>();
    applyUiFontFamily("PingFang SC", {
      style: {
        setProperty: (n, v) => {
          props.set(n, v);
        },
        removeProperty: (n) => {
          props.delete(n);
        },
      },
    });
    expect(props.get("--font-sans")).toContain("PingFang SC");
    applyUiFontFamily("", {
      style: {
        setProperty: (n, v) => {
          props.set(n, v);
        },
        removeProperty: (n) => {
          props.delete(n);
        },
      },
    });
    expect(props.has("--font-sans")).toBe(false);
  });
});
