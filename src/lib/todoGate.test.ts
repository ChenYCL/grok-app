import { describe, expect, it } from "vitest";
import {
  DEFAULT_TODO_GATE_MAX_FIRES,
  MAX_TODO_GATE_MAX_FIRES,
  MIN_TODO_GATE_MAX_FIRES,
  normalizeTodoGateEnabled,
  normalizeTodoGateMaxFires,
  todoGateMaxFiresEqual,
  todoGateSpawnArgs,
} from "./todoGate";

describe("normalizeTodoGateEnabled", () => {
  it("defaults to false", () => {
    expect(normalizeTodoGateEnabled(null)).toBe(false);
    expect(normalizeTodoGateEnabled(undefined)).toBe(false);
    expect(normalizeTodoGateEnabled(false)).toBe(false);
  });

  it("is true only for true", () => {
    expect(normalizeTodoGateEnabled(true)).toBe(true);
  });
});

describe("normalizeTodoGateMaxFires", () => {
  it("defaults for nullish / empty / zero / invalid", () => {
    expect(normalizeTodoGateMaxFires(null)).toBe(DEFAULT_TODO_GATE_MAX_FIRES);
    expect(normalizeTodoGateMaxFires(undefined)).toBe(
      DEFAULT_TODO_GATE_MAX_FIRES,
    );
    expect(normalizeTodoGateMaxFires("")).toBe(DEFAULT_TODO_GATE_MAX_FIRES);
    expect(normalizeTodoGateMaxFires("   ")).toBe(DEFAULT_TODO_GATE_MAX_FIRES);
    expect(normalizeTodoGateMaxFires(0)).toBe(DEFAULT_TODO_GATE_MAX_FIRES);
    expect(normalizeTodoGateMaxFires("0")).toBe(DEFAULT_TODO_GATE_MAX_FIRES);
    expect(normalizeTodoGateMaxFires(-2)).toBe(DEFAULT_TODO_GATE_MAX_FIRES);
    expect(normalizeTodoGateMaxFires(Number.NaN)).toBe(
      DEFAULT_TODO_GATE_MAX_FIRES,
    );
    expect(normalizeTodoGateMaxFires("nope")).toBe(DEFAULT_TODO_GATE_MAX_FIRES);
  });

  it("clamps to 1–20", () => {
    expect(normalizeTodoGateMaxFires(1)).toBe(MIN_TODO_GATE_MAX_FIRES);
    expect(normalizeTodoGateMaxFires(10)).toBe(10);
    expect(normalizeTodoGateMaxFires(20)).toBe(MAX_TODO_GATE_MAX_FIRES);
    expect(normalizeTodoGateMaxFires(99)).toBe(MAX_TODO_GATE_MAX_FIRES);
    expect(normalizeTodoGateMaxFires(1.6)).toBe(2);
    expect(normalizeTodoGateMaxFires("  7  ")).toBe(7);
  });
});

describe("todoGateSpawnArgs", () => {
  it("emits --todo-gate only when enabled", () => {
    expect(todoGateSpawnArgs(true)).toEqual(["--todo-gate"]);
    expect(todoGateSpawnArgs(false)).toEqual([]);
    expect(todoGateSpawnArgs(null)).toEqual([]);
    expect(todoGateSpawnArgs(undefined)).toEqual([]);
  });

  it("is a top-level flag (not under agent/stdio)", () => {
    const args = todoGateSpawnArgs(true);
    expect(args[0]).toBe("--todo-gate");
    expect(args).not.toContain("agent");
    expect(args).not.toContain("stdio");
  });
});

describe("todoGateMaxFiresEqual", () => {
  it("compares after normalize", () => {
    expect(todoGateMaxFiresEqual(3, "3")).toBe(true);
    expect(todoGateMaxFiresEqual(null, DEFAULT_TODO_GATE_MAX_FIRES)).toBe(true);
    expect(todoGateMaxFiresEqual(5, 6)).toBe(false);
    expect(todoGateMaxFiresEqual(99, 20)).toBe(true);
  });
});
