/**
 * TodoGate (CLI 0.2.117+) — pure normalize + spawn helpers.
 *
 * Runtime turn-end gate: when the model tries to end a turn with pending /
 * in_progress todos, the CLI can nudge before falling through to the user.
 *
 * - CLI flag: top-level `grok --todo-gate …` (session-scoped; overrides remote
 *   `todo_gate_enabled` and the built-in default `false`).
 * - Config keys (agent-home independent mode): `todo_gate_enabled`,
 *   `todo_gate_max_fires_per_prompt` (1–20).
 */

/** Min fires per prompt when the gate is used. */
export const MIN_TODO_GATE_MAX_FIRES = 1;
/** Max fires per prompt (product clamp). */
export const MAX_TODO_GATE_MAX_FIRES = 20;
/** Default max fires when unset / invalid (CLI-aligned middle ground). */
export const DEFAULT_TODO_GATE_MAX_FIRES = 3;

/**
 * Normalize the enable toggle.
 * null / undefined → false (CLI built-in default).
 */
export function normalizeTodoGateEnabled(
  raw: boolean | null | undefined,
): boolean {
  return raw === true;
}

/**
 * Normalize max fires per prompt.
 * null / undefined / "" / non-finite / ≤0 → default (3).
 * Otherwise clamp to 1–20.
 */
export function normalizeTodoGateMaxFires(
  raw: number | string | null | undefined,
): number {
  if (raw === null || raw === undefined) return DEFAULT_TODO_GATE_MAX_FIRES;
  const n =
    typeof raw === "string"
      ? (() => {
          const t = raw.trim();
          if (!t) return NaN;
          return Number(t);
        })()
      : raw;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TODO_GATE_MAX_FIRES;
  const rounded = Math.round(n);
  if (rounded <= 0) return DEFAULT_TODO_GATE_MAX_FIRES;
  return Math.min(
    MAX_TODO_GATE_MAX_FIRES,
    Math.max(MIN_TODO_GATE_MAX_FIRES, rounded),
  );
}

/**
 * Top-level CLI args when enabled:
 * `["--todo-gate"]`. Empty when disabled (CLI default off).
 */
export function todoGateSpawnArgs(
  enabled: boolean | null | undefined,
): string[] {
  return normalizeTodoGateEnabled(enabled) ? ["--todo-gate"] : [];
}

/** True when two max-fires values normalize equal (soft-respawn flip check). */
export function todoGateMaxFiresEqual(
  a: number | string | null | undefined,
  b: number | string | null | undefined,
): boolean {
  return normalizeTodoGateMaxFires(a) === normalizeTodoGateMaxFires(b);
}
