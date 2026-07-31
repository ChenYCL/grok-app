/**
 * Pure helpers for managed configuration setup (`grok setup` / `grok setup --json`).
 * Redacts secret-like fields so Settings never shows full keys.
 */

import { redact } from "./redact";

/** Known failure modes from the CLI / host wrapper. */
export type ManagedSetupErrorKind =
  | "missing_auth"
  | "rejected"
  | "signature_rejected"
  | "cli_missing"
  | "timeout"
  | "parse"
  | "other";

/** Sanitized preview of managed config (safe to show in UI). */
export type ManagedSetupSummary = {
  /** Top-level keys present after redaction (stable sort). */
  topLevelKeys: string[];
  /** Safe scalar facts (string/number/boolean only, already redacted). */
  facts: Array<{ key: string; value: string }>;
  /** Nested section counts (e.g. models → 3). */
  sectionCounts: Array<{ key: string; count: number }>;
  /** Pretty JSON with secrets redacted. */
  redactedJson: string;
  /** Optional short note (e.g. deployment id fingerprint). */
  note?: string | null;
};

export type ManagedSetupResult = {
  ok: boolean;
  /** Install stdout message, or preview note. */
  message?: string | null;
  summary?: ManagedSetupSummary | null;
  error?: string | null;
  errorKind?: ManagedSetupErrorKind | null;
};

/**
 * Local disk / inspect snapshot from host `managed_setup_status` (soft-fail).
 * Paths are shown; signature *contents* are never loaded.
 */
export type ManagedLocalStatus = {
  /** Host always returns an envelope; false only on unexpected invoke failures. */
  ok: boolean;
  cliFound: boolean;
  /** Active GROK_HOME probed for user managed files. */
  grokHome?: string | null;
  managedConfigPresent: boolean;
  requirementsPresent: boolean;
  /** `managed_config.sig.json` exists (content not read). */
  configSignaturePresent: boolean;
  /** `managed_identity.sig.json` exists (content not read). */
  identitySignaturePresent: boolean;
  /** System `/etc/grok/managed_config.toml` (Unix) when probeable. */
  systemManagedConfigPresent: boolean;
  /** From `grok inspect` when available; null = not probed / soft-fail. */
  managedSettingsActive?: boolean | null;
  managedSettingsExists?: boolean | null;
  managedSettingsPath?: string | null;
  /** Soft-fail reason (CLI missing for inspect, etc.). */
  reason?: string | null;
};

/**
 * Honest signature / managed-policy status for the UI.
 * Never claims cryptographic verification unless the CLI/inspect said so.
 */
export type ManagedSignatureStatus =
  | "none"
  | "artifacts"
  | "sig_files"
  | "active"
  | "rejected"
  | "unknown";

/** Guided setup step ids (order is stable). */
export type ManagedSetupStepId =
  | "cli"
  | "auth"
  | "preview"
  | "install"
  | "verify";

export type ManagedSetupStepState = "done" | "current" | "todo" | "blocked" | "soft";

export type ManagedSetupStep = {
  id: ManagedSetupStepId;
  state: ManagedSetupStepState;
};

/** Safe meta extracted from a redacted preview payload (no secrets). */
export type ManagedPreviewMeta = {
  deploymentId: string | null;
  teamId: string | null;
  failClosed: boolean | null;
  /** True when a signatures / managed_identity_signatures key was present (value redacted). */
  hasSignatureBlock: boolean;
  /** True when requirements section present. */
  hasRequirements: boolean;
};

const SENSITIVE_KEY_RE =
  /^(api[_-]?key|token|secret|password|passwd|authorization|auth|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|bearer|deployment[_-]?key|xai[_-]?api[_-]?key)$/i;

const SENSITIVE_CONTAINER_KEYS = new Set([
  "env",
  "environment",
  "headers",
  "authorization",
  "secrets",
  "credentials",
  "signatures",
  "managed_identity_signatures",
  "managedidentitysignatures",
]);

/** Max scalar facts / nested keys to list in the summary panel. */
const MAX_FACTS = 24;
const MAX_SECTION_COUNTS = 16;
/** Cap pretty-print size so huge payloads do not freeze the UI. */
const MAX_JSON_CHARS = 48_000;

export function isSensitiveKey(key: string): boolean {
  const k = (key ?? "").trim();
  if (!k) return false;
  if (SENSITIVE_KEY_RE.test(k)) return true;
  if (/api[_-]?key/i.test(k)) return true;
  if (/(^|[_-])(token|secret|password|passwd)($|[_-])/i.test(k)) return true;
  if (/deployment[_-]?key/i.test(k)) return true;
  // Signature blobs / fingerprints that are still secret-adjacent
  if (/(_sig|signature|fingerprint)$/i.test(k) && !/key_fingerprint/i.test(k)) {
    return /sig|signature/i.test(k);
  }
  return false;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

/**
 * Drop secrets from an arbitrary JSON-like value.
 * Sensitive keys become `"[REDACTED]"`; env/header/signature maps are fully redacted.
 */
export function redactSensitiveValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    return redact(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValue(item));
  }
  const obj = asRecord(value);
  if (!obj) return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(obj)) {
    if (isSensitiveKey(key) || SENSITIVE_CONTAINER_KEYS.has(key.toLowerCase())) {
      out[key] = "[REDACTED]";
      continue;
    }
    out[key] = redactSensitiveValue(child);
  }
  return out;
}

/** Classify CLI stderr/stdout into a stable error kind for UI copy. */
export function classifySetupError(message: string | null | undefined): ManagedSetupErrorKind {
  const m = (message ?? "").toLowerCase();
  if (!m.trim()) return "other";
  if (
    m.includes("cli not found") ||
    m.includes("grok build cli not found") ||
    m.includes("no such file")
  ) {
    return "cli_missing";
  }
  if (m.includes("timed out") || m.includes("timeout")) {
    return "timeout";
  }
  if (
    m.includes("no deployment key") ||
    m.includes("team sign-in") ||
    m.includes("team login") ||
    m.includes("sign in with a team") ||
    m.includes("export grok_deployment_key")
  ) {
    return "missing_auth";
  }
  // Signature / managed-policy verification failures (CLI managed_config path).
  if (
    m.includes("signature rejected") ||
    m.includes("signature was rejected") ||
    m.includes("did not verify") ||
    m.includes("could not be verified") ||
    m.includes("is-managed claim") ||
    m.includes("managed config signature") ||
    m.includes("server envelope rejected")
  ) {
    return "signature_rejected";
  }
  if (
    m.includes("deployment key was rejected") ||
    m.includes("key was rejected") ||
    m.includes("hasn't expired") ||
    m.includes("hasnt expired")
  ) {
    return "rejected";
  }
  if (m.includes("json") && (m.includes("parse") || m.includes("invalid"))) {
    return "parse";
  }
  return "other";
}

/**
 * Extract safe meta from a (possibly redacted) `grok setup --json` payload.
 * Never returns secret material — only ids and flags.
 */
export function extractPreviewMeta(raw: unknown): ManagedPreviewMeta {
  let root: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return {
        deploymentId: null,
        teamId: null,
        failClosed: null,
        hasSignatureBlock: false,
        hasRequirements: false,
      };
    }
    try {
      root = JSON.parse(trimmed);
    } catch {
      return {
        deploymentId: null,
        teamId: null,
        failClosed: null,
        hasSignatureBlock: false,
        hasRequirements: false,
      };
    }
  }
  const obj = asRecord(root);
  if (!obj) {
    return {
      deploymentId: null,
      teamId: null,
      failClosed: null,
      hasSignatureBlock: false,
      hasRequirements: false,
    };
  }

  const pickStr = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string" && v.trim()) {
        const s = redact(v.trim());
        if (s && s.length <= 120 && !s.includes("\n")) return s;
      }
    }
    return null;
  };

  const failClosedRaw =
    obj.failClosed ?? obj.fail_closed ?? obj["fail-closed"];
  const failClosed =
    typeof failClosedRaw === "boolean"
      ? failClosedRaw
      : failClosedRaw == null
        ? null
        : null;

  const hasSignatureBlock =
    "signatures" in obj ||
    "managed_identity_signatures" in obj ||
    "managedIdentitySignatures" in obj ||
    "managed_identity_signature" in obj;

  const hasRequirements =
    "requirements" in obj ||
    "managedConfig" in obj ||
    "managed_config" in obj;

  return {
    deploymentId: pickStr("deploymentId", "deployment_id", "deployment-id"),
    teamId: pickStr("teamId", "team_id", "team-id"),
    failClosed,
    hasSignatureBlock,
    hasRequirements,
  };
}

/**
 * Derive an honest signature / managed-policy status chip.
 * Prefers CLI error / inspect active over mere file presence.
 */
export function deriveSignatureStatus(input: {
  local?: ManagedLocalStatus | null;
  previewMeta?: ManagedPreviewMeta | null;
  errorKind?: ManagedSetupErrorKind | null;
  /** True after a successful install in this session. */
  installOk?: boolean;
}): ManagedSignatureStatus {
  if (input.errorKind === "signature_rejected") return "rejected";
  const local = input.local;
  if (local?.managedSettingsActive === true) return "active";
  if (input.installOk) {
    // Install wrote files; verify chip uses local artifacts when known.
    if (
      local?.configSignaturePresent ||
      local?.identitySignaturePresent ||
      input.previewMeta?.hasSignatureBlock
    ) {
      return "sig_files";
    }
    if (local?.managedConfigPresent || local?.systemManagedConfigPresent) {
      return "artifacts";
    }
    return "artifacts";
  }
  if (
    local?.configSignaturePresent ||
    local?.identitySignaturePresent ||
    input.previewMeta?.hasSignatureBlock
  ) {
    return "sig_files";
  }
  if (
    local?.managedConfigPresent ||
    local?.systemManagedConfigPresent ||
    local?.requirementsPresent ||
    local?.managedSettingsExists === true
  ) {
    return "artifacts";
  }
  if (local == null) return "unknown";
  if (local.ok === false) return "unknown";
  return "none";
}

/**
 * Build ordered guided steps for first-run / managed setup UX.
 * Soft states never block install (enterprise path is optional).
 */
export function buildManagedSetupSteps(input: {
  cliFound: boolean;
  /** True when preview returned ok this session. */
  previewDone?: boolean;
  /** True when install returned ok this session. */
  installDone?: boolean;
  errorKind?: ManagedSetupErrorKind | null;
  local?: ManagedLocalStatus | null;
  signatureStatus?: ManagedSignatureStatus | null;
}): ManagedSetupStep[] {
  const cliFound = input.cliFound;
  const authBlocked =
    input.errorKind === "missing_auth" || input.errorKind === "rejected";
  const sigRejected = input.errorKind === "signature_rejected";
  const hasArtifacts =
    !!input.local?.managedConfigPresent ||
    !!input.local?.systemManagedConfigPresent ||
    !!input.local?.requirementsPresent ||
    input.local?.managedSettingsActive === true ||
    input.installDone === true;
  const sigStatus = input.signatureStatus ?? "unknown";
  const verified =
    sigStatus === "active" ||
    (hasArtifacts &&
      (sigStatus === "sig_files" || sigStatus === "artifacts") &&
      input.installDone === true);

  const cliState: ManagedSetupStepState = !cliFound
    ? "blocked"
    : "done";

  let authState: ManagedSetupStepState;
  if (!cliFound) authState = "todo";
  else if (authBlocked) authState = "blocked";
  else if (hasArtifacts || input.previewDone || input.installDone) authState = "done";
  else authState = "current";

  let previewState: ManagedSetupStepState;
  if (!cliFound || authBlocked) previewState = "todo";
  else if (input.previewDone) previewState = "done";
  else if (authState === "current") previewState = "todo";
  else previewState = "current";

  let installState: ManagedSetupStepState;
  if (!cliFound || authBlocked || sigRejected) {
    installState = sigRejected ? "blocked" : "todo";
  } else if (input.installDone || hasArtifacts) {
    installState = "done";
  } else if (previewState === "current" || authState === "current") {
    installState = "todo";
  } else {
    installState = "current";
  }

  let verifyState: ManagedSetupStepState;
  if (sigRejected) verifyState = "blocked";
  else if (verified) verifyState = "done";
  else if (hasArtifacts || sigStatus === "sig_files" || sigStatus === "artifacts") {
    verifyState = "soft";
  } else if (installState === "done") verifyState = "current";
  else verifyState = "todo";

  // Ensure exactly one "current" when possible (prefer earliest incomplete).
  const steps: ManagedSetupStep[] = [
    { id: "cli", state: cliState },
    { id: "auth", state: authState },
    { id: "preview", state: previewState },
    { id: "install", state: installState },
    { id: "verify", state: verifyState },
  ];

  const hasCurrent = steps.some((s) => s.state === "current");
  if (!hasCurrent) {
    const firstTodo = steps.find((s) => s.state === "todo" || s.state === "soft");
    if (firstTodo && firstTodo.state !== "blocked") {
      firstTodo.state = "current";
    }
  }

  return steps;
}

/** Empty local status for tests / soft-fail defaults. */
export function emptyManagedLocalStatus(
  partial?: Partial<ManagedLocalStatus>,
): ManagedLocalStatus {
  return {
    ok: true,
    cliFound: false,
    grokHome: null,
    managedConfigPresent: false,
    requirementsPresent: false,
    configSignaturePresent: false,
    identitySignaturePresent: false,
    systemManagedConfigPresent: false,
    managedSettingsActive: null,
    managedSettingsExists: null,
    managedSettingsPath: null,
    reason: null,
    ...partial,
  };
}

/** Pretty-print redacted JSON, capped for UI. */
export function formatRedactedJson(value: unknown): string {
  const safe = redactSensitiveValue(value);
  let text: string;
  try {
    text = JSON.stringify(safe, null, 2);
  } catch {
    text = String(safe);
  }
  text = redact(text);
  if (text.length > MAX_JSON_CHARS) {
    return `${text.slice(0, MAX_JSON_CHARS)}\n… [truncated]`;
  }
  return text;
}

function formatScalar(v: unknown): string | null {
  if (typeof v === "string") {
    const s = redact(v.trim());
    if (!s) return null;
    // Avoid dumping multi-line blobs into fact rows
    if (s.length > 120 || s.includes("\n")) {
      return `${s.slice(0, 80)}…`;
    }
    return s;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return null;
}

function countEntries(v: unknown): number | null {
  if (Array.isArray(v)) return v.length;
  const obj = asRecord(v);
  if (obj) return Object.keys(obj).length;
  return null;
}

/**
 * Build a secret-safe summary from raw `grok setup --json` output.
 * Accepts already-parsed JSON, or a JSON string (will parse).
 */
export function summarizeSetupJson(raw: unknown): ManagedSetupSummary {
  let root: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return {
        topLevelKeys: [],
        facts: [],
        sectionCounts: [],
        redactedJson: "{}",
        note: null,
      };
    }
    try {
      root = JSON.parse(trimmed);
    } catch {
      // Non-JSON preview (plain text) — still scrub and show
      const scrubbed = redact(trimmed);
      return {
        topLevelKeys: [],
        facts: [],
        sectionCounts: [],
        redactedJson: scrubbed.slice(0, MAX_JSON_CHARS),
        note: "non-json",
      };
    }
  }

  const redacted = redactSensitiveValue(root);
  const obj = asRecord(redacted);
  const topLevelKeys = obj
    ? Object.keys(obj).sort((a, b) => a.localeCompare(b))
    : [];

  const facts: ManagedSetupSummary["facts"] = [];
  const sectionCounts: ManagedSetupSummary["sectionCounts"] = [];

  if (obj) {
    for (const key of topLevelKeys) {
      const child = obj[key];
      const scalar = formatScalar(child);
      if (scalar != null) {
        if (facts.length < MAX_FACTS) {
          facts.push({ key, value: scalar });
        }
        continue;
      }
      const n = countEntries(child);
      if (n != null && sectionCounts.length < MAX_SECTION_COUNTS) {
        sectionCounts.push({ key, count: n });
      }
    }
  } else if (Array.isArray(redacted)) {
    sectionCounts.push({ key: "items", count: redacted.length });
  }

  return {
    topLevelKeys,
    facts,
    sectionCounts,
    redactedJson: formatRedactedJson(root),
    note: null,
  };
}

/** Empty result helper for tests / UI defaults. */
export function emptySetupResult(
  partial?: Partial<ManagedSetupResult>,
): ManagedSetupResult {
  return {
    ok: false,
    message: null,
    summary: null,
    error: null,
    errorKind: null,
    ...partial,
  };
}
