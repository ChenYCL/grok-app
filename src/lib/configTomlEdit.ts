/**
 * Pure helpers for allowlisted agent-home config.toml section edit.
 * Host enforces path-scope + write gate; this validates UI input + patches.
 */

/** Allowed `[ui].permission_mode` values (Grok Build config.toml). */
export const UI_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "auto",
  "dontAsk",
  "always-approve",
] as const;

export type UiPermissionMode = (typeof UI_PERMISSION_MODES)[number];

export type ConfigEditValues = {
  permissionMode: UiPermissionMode | "";
  yolo: boolean;
  subagentsEnabled: boolean;
  memoryEnabled: boolean;
};

export type ConfigEditPatch = {
  permissionMode?: string | null;
  yolo?: boolean | null;
  subagentsEnabled?: boolean | null;
  memoryEnabled?: boolean | null;
};

/** Normalize a permission_mode string; returns null when unsupported. */
export function normalizePermissionMode(
  raw: string | null | undefined,
): UiPermissionMode | null {
  if (raw == null) return null;
  const t = String(raw).trim();
  if (!t) return null;
  const compact = t.toLowerCase().replace(/[_\s]/g, "-");
  switch (compact) {
    case "default":
    case "ask":
      return "default";
    case "acceptedits":
    case "accept-edits":
      return "acceptEdits";
    case "auto":
      return "auto";
    case "dontask":
    case "dont-ask":
      return "dontAsk";
    case "always-approve":
    case "alwaysapprove":
    case "bypasspermissions":
    case "yolo":
      return "always-approve";
    default:
      return null;
  }
}

export function isUiPermissionMode(v: string): v is UiPermissionMode {
  return (UI_PERMISSION_MODES as readonly string[]).includes(v);
}

/** Build a host patch from draft vs baseline (only changed fields). */
export function buildConfigEditPatch(
  draft: ConfigEditValues,
  baseline: ConfigEditValues,
): ConfigEditPatch {
  const patch: ConfigEditPatch = {};
  const draftMode = draft.permissionMode || null;
  const baseMode = baseline.permissionMode || null;
  if (draftMode !== baseMode && draftMode) {
    patch.permissionMode = draftMode;
  }
  if (draft.yolo !== baseline.yolo) {
    patch.yolo = draft.yolo;
  }
  if (draft.subagentsEnabled !== baseline.subagentsEnabled) {
    patch.subagentsEnabled = draft.subagentsEnabled;
  }
  if (draft.memoryEnabled !== baseline.memoryEnabled) {
    patch.memoryEnabled = draft.memoryEnabled;
  }
  return patch;
}

export function hasConfigEditChanges(patch: ConfigEditPatch): boolean {
  return (
    patch.permissionMode != null ||
    patch.yolo != null ||
    patch.subagentsEnabled != null ||
    patch.memoryEnabled != null
  );
}

/** Snapshot defaults when keys are missing on disk. */
export function valuesFromSnapshot(snap: {
  permissionMode?: string | null;
  yolo?: boolean | null;
  subagentsEnabled?: boolean | null;
  memoryEnabled?: boolean | null;
}): ConfigEditValues {
  const mode = normalizePermissionMode(snap.permissionMode ?? null);
  return {
    permissionMode: mode ?? "",
    yolo: snap.yolo ?? false,
    subagentsEnabled: snap.subagentsEnabled ?? true,
    memoryEnabled: snap.memoryEnabled ?? false,
  };
}
