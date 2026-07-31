/**
 * Pure helpers for Privacy center (Grok Build 0.2.117 config.toml keys).
 * Host enforces path-scope + write gate; this validates UI drafts + patches.
 *
 * Allowlist:
 * - [features] telemetry
 * - [telemetry] trace_upload / mixpanel_enabled
 * - [harness] disable_codebase_upload / disable_workspace_teleport
 *
 * Missing keys stay null — never invent CLI defaults as “off”.
 * Coding-data / training opt-in is CLI `/privacy` only (not config.toml).
 */

export type PrivacyTri = boolean | null;

export type PrivacyValues = {
  /** [features] telemetry — null when unset in config. */
  telemetry: PrivacyTri;
  /** [telemetry] trace_upload */
  traceUpload: PrivacyTri;
  /** [telemetry] mixpanel_enabled */
  mixpanelEnabled: PrivacyTri;
  /** [harness] disable_codebase_upload */
  disableCodebaseUpload: PrivacyTri;
  /** [harness] disable_workspace_teleport */
  disableWorkspaceTeleport: PrivacyTri;
};

export type PrivacyPatch = {
  telemetry?: boolean | null;
  traceUpload?: boolean | null;
  mixpanelEnabled?: boolean | null;
  disableCodebaseUpload?: boolean | null;
  disableWorkspaceTeleport?: boolean | null;
};

export type PrivacySnapshotLike = {
  telemetry?: boolean | null;
  traceUpload?: boolean | null;
  mixpanelEnabled?: boolean | null;
  disableCodebaseUpload?: boolean | null;
  disableWorkspaceTeleport?: boolean | null;
  writable?: boolean;
  mode?: string;
  fileExists?: boolean;
  path?: string;
  cliPrivacyCommand?: string;
};

/** CLI slash command for coding-data / retention / training (not a config key). */
export const CLI_PRIVACY_COMMAND = "/privacy";

/** Keys this App can write (independent agent-home only). */
export const PRIVACY_WRITABLE_KEYS = [
  "telemetry",
  "traceUpload",
  "mixpanelEnabled",
  "disableCodebaseUpload",
  "disableWorkspaceTeleport",
] as const;

export type PrivacyWritableKey = (typeof PRIVACY_WRITABLE_KEYS)[number];

function tri(v: boolean | null | undefined): PrivacyTri {
  if (v === true) return true;
  if (v === false) return false;
  return null;
}

/** Map host snapshot → UI draft (null = unset / missing). */
export function valuesFromPrivacySnapshot(
  snap: PrivacySnapshotLike | null | undefined,
): PrivacyValues {
  return {
    telemetry: tri(snap?.telemetry),
    traceUpload: tri(snap?.traceUpload),
    mixpanelEnabled: tri(snap?.mixpanelEnabled),
    disableCodebaseUpload: tri(snap?.disableCodebaseUpload),
    disableWorkspaceTeleport: tri(snap?.disableWorkspaceTeleport),
  };
}

/** Build a host patch from draft vs baseline (only changed fields with concrete bools). */
export function buildPrivacyPatch(
  draft: PrivacyValues,
  baseline: PrivacyValues,
): PrivacyPatch {
  const patch: PrivacyPatch = {};
  if (draft.telemetry !== baseline.telemetry && draft.telemetry !== null) {
    patch.telemetry = draft.telemetry;
  }
  if (draft.traceUpload !== baseline.traceUpload && draft.traceUpload !== null) {
    patch.traceUpload = draft.traceUpload;
  }
  if (
    draft.mixpanelEnabled !== baseline.mixpanelEnabled &&
    draft.mixpanelEnabled !== null
  ) {
    patch.mixpanelEnabled = draft.mixpanelEnabled;
  }
  if (
    draft.disableCodebaseUpload !== baseline.disableCodebaseUpload &&
    draft.disableCodebaseUpload !== null
  ) {
    patch.disableCodebaseUpload = draft.disableCodebaseUpload;
  }
  if (
    draft.disableWorkspaceTeleport !== baseline.disableWorkspaceTeleport &&
    draft.disableWorkspaceTeleport !== null
  ) {
    patch.disableWorkspaceTeleport = draft.disableWorkspaceTeleport;
  }
  return patch;
}

export function hasPrivacyChanges(patch: PrivacyPatch): boolean {
  return (
    patch.telemetry != null ||
    patch.traceUpload != null ||
    patch.mixpanelEnabled != null ||
    patch.disableCodebaseUpload != null ||
    patch.disableWorkspaceTeleport != null
  );
}

/**
 * Toggle a tri-state bool for UI:
 * - null → true (first write enables / sets the “on” side of the label)
 * - true → false
 * - false → true
 *
 * For `disable_*` keys the “on” side of the label is “disabled = true”.
 */
export function togglePrivacyTri(current: PrivacyTri): boolean {
  if (current === null) return true;
  return !current;
}

/** Honest status label id for a tri-state value. */
export function privacyKeyPresence(
  value: PrivacyTri,
): "set_on" | "set_off" | "unset" {
  if (value === true) return "set_on";
  if (value === false) return "set_off";
  return "unset";
}

/**
 * Effective toggle checked state for UI.
 * Unset keys render as unchecked with an explicit “unset” badge (not claimed off).
 */
export function privacyToggleChecked(value: PrivacyTri): boolean {
  return value === true;
}

/** Whether writes are allowed for this snapshot (independent mode only). */
export function isPrivacyWritable(
  snap: PrivacySnapshotLike | null | undefined,
): boolean {
  return !!snap?.writable;
}
