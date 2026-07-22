/**
 * Catalogs aligned with Grok Build CLI (`grok models`, reasoning effort, permission).
 * Update when `grok models` or Build docs change; keep llm-wiki/i18n notes in sync.
 */

export interface ModelOption {
  id: string;
  /** Display name (language-neutral product name) */
  label: string;
  /** True if CLI lists as default */
  isDefault?: boolean;
}

export interface EffortOption {
  id: "high" | "medium" | "low";
}

export interface SessionModeOption {
  id: "agent" | "plan" | "ask";
}

/**
 * Permission policies (composer + settings), aligned with Grok Build modes:
 * | Build mode           | App id            |
 * | default              | ask               |
 * | acceptEdits          | accept_edits      |
 * | (session grant UX)   | allow_for_session |
 * | dontAsk              | dont_ask          |
 * | bypassPermissions    | always_approve    |
 */
export type PermissionPolicyId =
  | "ask"
  | "accept_edits"
  | "allow_for_session"
  | "dont_ask"
  | "always_approve";

/**
 * Live `grok models` (2026-07) reports only grok-4.5 as available for this install.
 * `grok-build` remains listed as the classic agent alias from Build docs — still selectable
 * for profiles that expose it; Host may fall back if CLI rejects.
 */
export const GROK_BUILD_MODELS: ModelOption[] = [
  { id: "grok-4.5", label: "Grok 4.5", isDefault: true },
  { id: "grok-build", label: "Grok Build" },
];

export const DEFAULT_MODEL_ID =
  GROK_BUILD_MODELS.find((m) => m.isDefault)?.id ?? "grok-4.5";

/** Reasoning effort flags: `--reasoning-effort` / `--effort` on grok agent. */
export const GROK_BUILD_EFFORTS: EffortOption[] = [
  { id: "high" },
  { id: "medium" },
  { id: "low" },
];

export const DEFAULT_EFFORT: EffortOption["id"] = "high";

/** Product session modes (desktop shell). */
export const SESSION_MODES: SessionModeOption[] = [
  { id: "agent" },
  { id: "plan" },
  { id: "ask" },
];

/**
 * Permission policies (composer + settings).
 * `always_approve` = YOLO / unrestricted (CLI `--always-approve`, config yolo).
 */
export const PERMISSION_POLICIES: {
  id: PermissionPolicyId;
  dangerous?: boolean;
}[] = [
  { id: "ask" },
  { id: "accept_edits" },
  { id: "allow_for_session" },
  { id: "dont_ask" },
  { id: "always_approve", dangerous: true },
];

export function isValidModelId(id: string): boolean {
  return GROK_BUILD_MODELS.some((m) => m.id === id);
}

export function isValidEffort(id: string): id is EffortOption["id"] {
  return GROK_BUILD_EFFORTS.some((e) => e.id === id);
}

export function isValidPolicy(id: string): id is PermissionPolicyId {
  return PERMISSION_POLICIES.some((p) => p.id === id);
}
