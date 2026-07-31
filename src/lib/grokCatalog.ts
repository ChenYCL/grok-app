/**
 * Catalogs aligned with Grok Build CLI (`grok models`, reasoning effort, permission).
 * Live selectable models come from `models_list_available` (CLI cache + custom providers).
 * Update docs/llm-wiki/catalog.md when defaults change.
 */

export interface EffortOption {
  /** Effort id passed to `--reasoning-effort` (e.g. low / medium / high). */
  id: string;
  /** CLI value when distinct from id; usually equals id. */
  value?: string;
  /** Display label from catalog when present. */
  label?: string;
  description?: string;
  isDefault?: boolean;
}

export interface ModelOption {
  id: string;
  /** Display name (language-neutral product name) */
  label: string;
  /** True if CLI lists as default */
  isDefault?: boolean;
  /** Catalog source; official list is one group in the composer model menu. */
  source?: string;
  /** Per-model reasoning efforts from CLI cache; empty/undefined → static fallback. */
  reasoningEfforts?: EffortOption[];
}

export interface SessionModeOption {
  id: "agent" | "plan" | "ask";
}

/**
 * Permission policies (composer + settings), aligned with Grok Build modes:
 * | Build / CLI `--permission-mode` | App id            |
 * | default                         | ask               |
 * | acceptEdits                     | accept_edits      |
 * | (session grant UX → default)    | allow_for_session |
 * | auto                            | auto              |
 * | dontAsk                         | dont_ask          |
 * | bypassPermissions               | always_approve    |
 * | plan                            | (product mode `plan`, not a policy) |
 *
 * Pure map helpers: `src/lib/permissionModeMap.ts`.
 */
export type PermissionPolicyId =
  | "ask"
  | "accept_edits"
  | "allow_for_session"
  | "auto"
  | "dont_ask"
  | "always_approve";

/** Where composer model / permission choices are remembered. */
export type ComposerPrefsScope = "global" | "project" | "session";

export const COMPOSER_PREFS_SCOPES: ComposerPrefsScope[] = [
  "global",
  "project",
  "session",
];

/**
 * Fallback catalog when Host has not returned live models yet.
 * Official OAuth currently exposes grok-4.5 only (2026-07 probe).
 * `grok-build` is NOT listed — CLI rejects it as unknown model id.
 */
export const GROK_BUILD_MODELS: ModelOption[] = [
  { id: "grok-4.5", label: "Grok 4.5", isDefault: true, source: "official" },
];

export const DEFAULT_MODEL_ID =
  GROK_BUILD_MODELS.find((m) => m.isDefault)?.id ?? "grok-4.5";

/** Static fallback when the selected model has no `reasoning_efforts` in cache. */
export const GROK_BUILD_EFFORTS: EffortOption[] = [
  { id: "medium" },
  { id: "low" },
  { id: "high" },
];

/**
 * Default reasoning depth. `medium` balances speed vs quality for agentic use;
 * users can lower (faster) or raise (deeper) via the composer chip.
 * When a model lists a default effort, prefer `pickDefaultEffort(model)`.
 */
export const DEFAULT_EFFORT = "medium";

/** Product session modes (desktop shell). */
export const SESSION_MODES: SessionModeOption[] = [
  { id: "agent" },
  { id: "plan" },
  { id: "ask" },
];

/**
 * Permission policies (composer + settings).
 * `always_approve` = YOLO / unrestricted (CLI `--always-approve` + `bypassPermissions`).
 * `auto` = CLI auto mode (fewer prompts with safety checks).
 * Product **plan** is a session mode, not a row here — see `permissionModeMap`.
 */
export const PERMISSION_POLICIES: {
  id: PermissionPolicyId;
  dangerous?: boolean;
}[] = [
  { id: "ask" },
  { id: "accept_edits" },
  { id: "allow_for_session" },
  { id: "auto" },
  { id: "dont_ask" },
  { id: "always_approve", dangerous: true },
];

export function isValidModelId(
  id: string,
  catalog: ModelOption[] = GROK_BUILD_MODELS,
): boolean {
  return catalog.some((m) => m.id === id);
}

/**
 * Efforts list for a model: live catalog when non-empty, else static fallback.
 */
export function effortsForModel(
  model?: ModelOption | null,
  catalogEfforts?: EffortOption[] | null,
): EffortOption[] {
  const fromArg =
    catalogEfforts && catalogEfforts.length > 0 ? catalogEfforts : null;
  const fromModel =
    model?.reasoningEfforts && model.reasoningEfforts.length > 0
      ? model.reasoningEfforts
      : null;
  return fromArg ?? fromModel ?? GROK_BUILD_EFFORTS;
}

/**
 * Validate an effort id against the selected model's efforts when known;
 * otherwise against the static GROK_BUILD_EFFORTS fallback.
 */
export function isValidEffort(
  id: string,
  modelOrEfforts?: ModelOption | EffortOption[] | null,
): boolean {
  if (!id) return false;
  if (Array.isArray(modelOrEfforts)) {
    return effortsForModel(null, modelOrEfforts).some((e) => e.id === id);
  }
  return effortsForModel(modelOrEfforts).some((e) => e.id === id);
}

/** Default effort for a model (catalog default flag, else first, else medium). */
export function pickDefaultEffort(
  model?: ModelOption | null,
  catalogEfforts?: EffortOption[] | null,
): string {
  const list = effortsForModel(model, catalogEfforts);
  return (
    list.find((e) => e.isDefault)?.id ?? list[0]?.id ?? DEFAULT_EFFORT
  );
}

/**
 * Strip a shared CLI suffix so "High Effort" / "Medium Effort" collapse to
 * "High" / "Medium" (identical trailing " Effort" is noise in compact UI).
 */
export function stripCommonEffortSuffix(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return trimmed;
  const stripped = trimmed.replace(/\s+Effort$/i, "").trim();
  return stripped || trimmed;
}

/**
 * Display label for an effort.
 * - Standard ids (`high` / `medium` / `low`): prefer i18n so locale controls
 *   高/中/低 vs High/Medium/Low (catalog labels are English-only).
 * - Other catalog labels: strip a shared " Effort" suffix, then raw id.
 */
export function effortDisplayLabel(
  effort: EffortOption | string,
  i18nLabels?: {
    high?: string;
    medium?: string;
    low?: string;
  },
): string {
  const id = typeof effort === "string" ? effort : effort.id;
  if (id === "high" && i18nLabels?.high) return i18nLabels.high;
  if (id === "medium" && i18nLabels?.medium) return i18nLabels.medium;
  if (id === "low" && i18nLabels?.low) return i18nLabels.low;

  if (typeof effort !== "string") {
    const raw = effort.label?.trim();
    if (raw) return stripCommonEffortSuffix(raw);
    return effortDisplayLabel(effort.id, i18nLabels);
  }
  return effort;
}

export function isValidPolicy(id: string): id is PermissionPolicyId {
  return PERMISSION_POLICIES.some((p) => p.id === id);
}

export function isValidPrefsScope(id: string): id is ComposerPrefsScope {
  return COMPOSER_PREFS_SCOPES.includes(id as ComposerPrefsScope);
}

export function pickDefaultModelId(catalog: ModelOption[]): string {
  return (
    catalog.find((m) => m.isDefault)?.id ??
    catalog[0]?.id ??
    DEFAULT_MODEL_ID
  );
}

/** Find a model in catalog by id. */
export function findModel(
  id: string,
  catalog: ModelOption[] = GROK_BUILD_MODELS,
): ModelOption | undefined {
  return catalog.find((m) => m.id === id);
}
