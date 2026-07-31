/**
 * Settings → Runtime → Privacy: honest Grok Build 0.2.117 privacy keys.
 * Independent agent-home: allowlisted read/write. Shared mode: read-only probe.
 * Coding-data / training is CLI `/privacy` only — never a fake App toggle.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "@/lib/api";
import type { PrivacyConfigSnapshot } from "@/lib/api";
import { createT, type Locale, type MessageKey } from "@/i18n";
import {
  buildPrivacyPatch,
  CLI_PRIVACY_COMMAND,
  hasPrivacyChanges,
  privacyKeyPresence,
  privacyToggleChecked,
  togglePrivacyTri,
  valuesFromPrivacySnapshot,
  type PrivacyTri,
  type PrivacyValues,
} from "@/lib/privacyConfig";
import { IconRefresh } from "@/components/icons";

function Toggle({
  checked,
  disabled,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className={"ui-check" + (checked ? " is-on" : "")}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        if (!disabled) onChange();
      }}
    >
      <span className="ui-check__box" aria-hidden>
        {checked ? (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M2.5 6.2L4.8 8.5L9.5 3.5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </span>
    </button>
  );
}

function PresenceBadge({
  value,
  t,
}: {
  value: PrivacyTri;
  t: (k: MessageKey, vars?: Record<string, string | number>) => string;
}) {
  const p = privacyKeyPresence(value);
  if (p === "unset") {
    return (
      <span className="ext-badge ext-badge--muted">
        {t("settings.privacy.presence.unset")}
      </span>
    );
  }
  if (p === "set_on") {
    return (
      <span className="ext-badge">{t("settings.privacy.presence.on")}</span>
    );
  }
  return (
    <span className="ext-badge ext-badge--muted">
      {t("settings.privacy.presence.off")}
    </span>
  );
}

type RowKey = keyof PrivacyValues;

function PrivacyRow({
  id,
  labelKey,
  descKey,
  configKey,
  value,
  disabled,
  onToggle,
  t,
}: {
  id: string;
  labelKey: MessageKey;
  descKey: MessageKey;
  configKey: string;
  value: PrivacyTri;
  disabled: boolean;
  onToggle: () => void;
  t: (k: MessageKey, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div className="settings-row" id={id}>
      <div className="settings-row__text">
        <div className="settings-row__label">
          {t(labelKey)}{" "}
          <PresenceBadge value={value} t={t} />
        </div>
        <div className="settings-row__desc">{t(descKey)}</div>
        <div className="settings-row__hint" title={configKey}>
          {configKey}
        </div>
      </div>
      <Toggle
        checked={privacyToggleChecked(value)}
        disabled={disabled}
        onChange={onToggle}
        ariaLabel={t(labelKey)}
      />
    </div>
  );
}

export function PrivacyCenterPanel({
  locale,
  onSaved,
  onError,
}: {
  locale: Locale;
  onSaved?: () => void;
  onError?: (message: string) => void;
}) {
  const tr = useMemo(() => createT(locale), [locale]);
  const t = useCallback(
    (k: MessageKey, vars?: Record<string, string | number>) => tr(k, vars),
    [tr],
  );

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snap, setSnap] = useState<PrivacyConfigSnapshot | null>(null);
  const [baseline, setBaseline] = useState<PrivacyValues>(
    valuesFromPrivacySnapshot({}),
  );
  const [draft, setDraft] = useState<PrivacyValues>(
    valuesFromPrivacySnapshot({}),
  );
  const [copied, setCopied] = useState(false);

  const applySnap = useCallback((s: PrivacyConfigSnapshot) => {
    setSnap(s);
    const vals = valuesFromPrivacySnapshot({
      telemetry: s.telemetry,
      traceUpload: s.traceUpload,
      mixpanelEnabled: s.mixpanelEnabled,
      disableCodebaseUpload: s.disableCodebaseUpload,
      disableWorkspaceTeleport: s.disableWorkspaceTeleport,
    });
    setBaseline(vals);
    setDraft(vals);
  }, []);

  const load = useCallback(async () => {
    if (!api.isTauri()) {
      setSnap(null);
      setError(t("settings.privacy.needTauri"));
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.privacyConfigGet();
      applySnap(res);
    } catch (e) {
      setSnap(null);
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      onError?.(msg);
    } finally {
      setLoading(false);
    }
  }, [applySnap, onError, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useMemo(
    () => buildPrivacyPatch(draft, baseline),
    [draft, baseline],
  );
  const dirty = hasPrivacyChanges(patch);
  const writable = !!snap?.writable;
  const disabled = !writable || busy || loading;

  const setKey = (key: RowKey) => {
    setDraft((d) => ({ ...d, [key]: togglePrivacyTri(d[key]) }));
  };

  const save = async () => {
    if (!dirty || !writable || !api.isTauri()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.privacyConfigSet({
        telemetry: patch.telemetry ?? null,
        traceUpload: patch.traceUpload ?? null,
        mixpanelEnabled: patch.mixpanelEnabled ?? null,
        disableCodebaseUpload: patch.disableCodebaseUpload ?? null,
        disableWorkspaceTeleport: patch.disableWorkspaceTeleport ?? null,
      });
      applySnap(res);
      onSaved?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      onError?.(msg);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const reset = () => setDraft(baseline);

  const copyPrivacyCmd = async () => {
    const cmd = snap?.cliPrivacyCommand || CLI_PRIVACY_COMMAND;
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // ignore — clipboard may be blocked
    }
  };

  return (
    <div
      className="settings-row settings-row--stack settings-privacy"
      id="settings-anchor-privacy"
    >
      <div className="settings-row__text">
        <div className="settings-row__label">{t("settings.privacy")}</div>
        <div className="settings-row__desc">{t("settings.privacyDesc")}</div>
        {snap?.path ? (
          <div className="settings-row__hint" title={snap.path}>
            {t("settings.privacy.path", { path: snap.path })}
          </div>
        ) : null}
      </div>

      {loading && !snap ? (
        <p className="ext-field-hint">{t("settings.privacy.loading")}</p>
      ) : null}

      {error ? (
        <div className="ext-alert ext-alert--error" role="alert">
          <div className="ext-alert__title">{t("settings.privacy.error")}</div>
          <p className="ext-alert__body">{error}</p>
        </div>
      ) : null}

      {snap && !writable ? (
        <div className="ext-alert ext-alert--warn" role="status">
          <p className="ext-alert__body" style={{ margin: 0 }}>
            {t("settings.privacy.sharedWarning")}
          </p>
        </div>
      ) : null}

      {snap ? (
        <>
          <div className="settings-config-edit__badges">
            <span className="ext-badge ext-badge--muted">
              {snap.mode === "shared"
                ? t("settings.privacy.mode.shared")
                : t("settings.privacy.mode.independent")}
            </span>
            {!snap.fileExists ? (
              <span className="ext-badge">
                {t("settings.privacy.missing")}
              </span>
            ) : null}
            {writable ? (
              <span className="ext-badge">
                {t("settings.privacy.writable")}
              </span>
            ) : (
              <span className="ext-badge">
                {t("settings.privacy.readOnly")}
              </span>
            )}
          </div>

          <div className="settings-config-edit__fields">
            <PrivacyRow
              id="settings-anchor-privacy-telemetry"
              labelKey="settings.privacy.telemetry"
              descKey="settings.privacy.telemetryDesc"
              configKey="[features] telemetry · GROK_TELEMETRY_ENABLED"
              value={draft.telemetry}
              disabled={disabled}
              onToggle={() => setKey("telemetry")}
              t={t}
            />
            <PrivacyRow
              id="settings-anchor-privacy-traceUpload"
              labelKey="settings.privacy.traceUpload"
              descKey="settings.privacy.traceUploadDesc"
              configKey="[telemetry] trace_upload · GROK_TELEMETRY_TRACE_UPLOAD"
              value={draft.traceUpload}
              disabled={disabled}
              onToggle={() => setKey("traceUpload")}
              t={t}
            />
            <PrivacyRow
              id="settings-anchor-privacy-mixpanel"
              labelKey="settings.privacy.mixpanel"
              descKey="settings.privacy.mixpanelDesc"
              configKey="[telemetry] mixpanel_enabled · GROK_TELEMETRY_MIXPANEL_ENABLED"
              value={draft.mixpanelEnabled}
              disabled={disabled}
              onToggle={() => setKey("mixpanelEnabled")}
              t={t}
            />
            <PrivacyRow
              id="settings-anchor-privacy-codebaseUpload"
              labelKey="settings.privacy.disableCodebaseUpload"
              descKey="settings.privacy.disableCodebaseUploadDesc"
              configKey="[harness] disable_codebase_upload"
              value={draft.disableCodebaseUpload}
              disabled={disabled}
              onToggle={() => setKey("disableCodebaseUpload")}
              t={t}
            />
            <PrivacyRow
              id="settings-anchor-privacy-workspaceTeleport"
              labelKey="settings.privacy.disableWorkspaceTeleport"
              descKey="settings.privacy.disableWorkspaceTeleportDesc"
              configKey="[harness] disable_workspace_teleport"
              value={draft.disableWorkspaceTeleport}
              disabled={disabled}
              onToggle={() => setKey("disableWorkspaceTeleport")}
              t={t}
            />
          </div>

          <div
            className="settings-row settings-row--stack"
            id="settings-anchor-privacy-codingData"
            style={{ marginTop: 12 }}
          >
            <div className="settings-row__text">
              <div className="settings-row__label">
                {t("settings.privacy.codingData")}
              </div>
              <div className="settings-row__desc">
                {t("settings.privacy.codingDataDesc")}
              </div>
              <div className="settings-row__hint">
                {t("settings.privacy.codingDataHint", {
                  cmd: snap.cliPrivacyCommand || CLI_PRIVACY_COMMAND,
                })}
              </div>
            </div>
            <div
              className="settings-row__actions"
              style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
            >
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void copyPrivacyCmd()}
              >
                {copied
                  ? t("settings.privacy.codingDataCopied")
                  : t("settings.privacy.codingDataCopy", {
                      cmd: snap.cliPrivacyCommand || CLI_PRIVACY_COMMAND,
                    })}
              </button>
            </div>
          </div>

          {snap.redactedPreview?.trim() ? (
            <div className="settings-config-edit__preview">
              <div className="settings-row__label">
                {t("settings.privacy.preview")}
              </div>
              <p className="ext-field-hint" style={{ marginTop: 4 }}>
                {t("settings.privacy.redactNote")}
              </p>
              <pre className="settings-config-edit__pre" tabIndex={0}>
                {snap.redactedPreview}
              </pre>
            </div>
          ) : (
            <p className="ext-field-hint">{t("settings.privacy.previewEmpty")}</p>
          )}

          <div
            className="settings-row__actions"
            style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}
          >
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={busy || loading}
              onClick={() => void load()}
            >
              <IconRefresh size={14} />
              <span>{t("settings.privacy.refresh")}</span>
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={!dirty || busy || loading}
              onClick={reset}
            >
              {t("settings.privacy.reset")}
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={!dirty || !writable || busy || loading}
              onClick={() => void save()}
            >
              {busy
                ? t("settings.privacy.saving")
                : t("settings.privacy.save")}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
