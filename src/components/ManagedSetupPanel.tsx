/**
 * Settings → Runtime: managed configuration via `grok setup` / `grok setup --json`.
 * Preview shows a secret-safe summary; Install confirms then writes ~/.grok.
 */

import { useCallback, useMemo, useState } from "react";
import * as api from "@/lib/api";
import { createT, type Locale } from "@/i18n";
import {
  classifySetupError,
  summarizeSetupJson,
  type ManagedSetupErrorKind,
  type ManagedSetupSummary,
} from "@/lib/managedSetup";
import { isCliMissingError } from "@/lib/extensionsUi";
import { GlassModal } from "@/components/GlassModal";

export interface ManagedSetupPanelProps {
  locale: Locale;
  cliFound?: boolean;
  onOpenAccount?: () => void;
}

export function ManagedSetupPanel({
  locale,
  cliFound = true,
  onOpenAccount,
}: ManagedSetupPanelProps) {
  const tr = useMemo(() => createT(locale), [locale]);

  const [summary, setSummary] = useState<ManagedSetupSummary | null>(null);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<ManagedSetupErrorKind | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const applyError = useCallback((msg: string, kind?: ManagedSetupErrorKind | null) => {
    const text = (msg ?? "").trim() || tr("managedSetup.error.generic");
    setError(text);
    setErrorKind(kind ?? classifySetupError(text));
    setStatus(null);
  }, [tr]);

  const onPreview = useCallback(async () => {
    if (!api.isTauri()) {
      applyError(tr("managedSetup.needTauri"), "other");
      return;
    }
    setLoadingPreview(true);
    setError(null);
    setErrorKind(null);
    setStatus(null);
    setPreviewNote(null);
    try {
      const res = await api.setupPreview();
      if (!res.ok) {
        setSummary(null);
        applyError(
          res.error?.trim() || tr("managedSetup.error.generic"),
          res.errorKind ?? classifySetupError(res.error),
        );
        return;
      }
      if (res.payload != null) {
        setSummary(summarizeSetupJson(res.payload));
        setPreviewNote(null);
      } else if (res.message?.trim()) {
        setSummary(summarizeSetupJson(res.message));
        setPreviewNote(res.message.trim());
      } else {
        setSummary(null);
        setPreviewNote(null);
      }
      setStatus(tr("managedSetup.previewOk"));
    } catch (e) {
      setSummary(null);
      applyError(String(e));
    } finally {
      setLoadingPreview(false);
    }
  }, [applyError, tr]);

  const runInstall = useCallback(async () => {
    if (!api.isTauri()) {
      applyError(tr("managedSetup.needTauri"), "other");
      setConfirmOpen(false);
      return;
    }
    setInstalling(true);
    setError(null);
    setErrorKind(null);
    setStatus(null);
    try {
      const res = await api.setupInstall();
      if (!res.ok) {
        applyError(
          res.error?.trim() || tr("managedSetup.error.generic"),
          res.errorKind ?? classifySetupError(res.error),
        );
        return;
      }
      setStatus(
        res.message?.trim() || tr("managedSetup.installOk"),
      );
    } catch (e) {
      applyError(String(e));
    } finally {
      setInstalling(false);
      setConfirmOpen(false);
    }
  }, [applyError, tr]);

  const busy = loadingPreview || installing;
  const cliMissing =
    !cliFound ||
    errorKind === "cli_missing" ||
    isCliMissingError(error);

  const kindHint =
    errorKind === "missing_auth"
      ? tr("managedSetup.error.missingAuth")
      : errorKind === "rejected"
        ? tr("managedSetup.error.rejected")
        : errorKind === "cli_missing"
          ? tr("managedSetup.error.cliBody")
          : null;

  return (
    <div className="managed-setup" data-testid="managed-setup-panel">
      <div className="settings-row settings-row--stack" style={{ borderBottom: "none" }}>
        <div className="settings-row__text">
          <div className="settings-row__label">{tr("managedSetup.title")}</div>
          <div className="settings-row__desc">{tr("managedSetup.desc")}</div>
        </div>
        <div className="settings-row__hint">{tr("managedSetup.authHint")}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => void onPreview()}
          >
            {loadingPreview
              ? tr("managedSetup.previewing")
              : tr("managedSetup.preview")}
          </button>
          <button
            type="button"
            className="btn btn--solid"
            disabled={busy}
            onClick={() => setConfirmOpen(true)}
          >
            {installing
              ? tr("managedSetup.installing")
              : tr("managedSetup.install")}
          </button>
          {onOpenAccount && (
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={onOpenAccount}
            >
              {tr("managedSetup.openAccount")}
            </button>
          )}
        </div>
      </div>

      {status && !error && (
        <p className="settings-row__hint" role="status">
          {status}
        </p>
      )}

      {cliMissing && (
        <div className="ext-alert ext-alert--error" role="alert">
          <div className="ext-alert__title">{tr("managedSetup.error.cliTitle")}</div>
          <p className="ext-alert__body">{tr("managedSetup.error.cliBody")}</p>
        </div>
      )}

      {!cliMissing && error && (
        <div className="ext-alert ext-alert--error" role="alert">
          <div className="ext-alert__title">
            {errorKind === "missing_auth"
              ? tr("managedSetup.error.missingAuthTitle")
              : errorKind === "rejected"
                ? tr("managedSetup.error.rejectedTitle")
                : tr("managedSetup.error.title")}
          </div>
          {kindHint && <p className="ext-alert__body">{kindHint}</p>}
          <pre className="ext-alert__detail" style={{ whiteSpace: "pre-wrap" }}>
            {error}
          </pre>
          {errorKind === "missing_auth" && onOpenAccount && (
            <button
              type="button"
              className="btn btn--ghost ext-alert__cta"
              onClick={onOpenAccount}
            >
              {tr("managedSetup.openAccount")}
            </button>
          )}
        </div>
      )}

      {summary && (
        <div className="managed-setup__preview" data-testid="managed-setup-preview">
          <div className="settings-row__label" style={{ marginBottom: 6 }}>
            {tr("managedSetup.previewTitle")}
          </div>
          {summary.facts.length > 0 && (
            <ul className="managed-setup__facts">
              {summary.facts.map((f) => (
                <li key={f.key}>
                  <span className="managed-setup__fact-key">{f.key}</span>
                  <span className="managed-setup__fact-val">{f.value}</span>
                </li>
              ))}
            </ul>
          )}
          {summary.sectionCounts.length > 0 && (
            <p className="settings-row__hint">
              {tr("managedSetup.sections", {
                list: summary.sectionCounts
                  .map((s) => `${s.key} (${s.count})`)
                  .join(" · "),
              })}
            </p>
          )}
          {previewNote && !summary.topLevelKeys.length && (
            <p className="settings-row__hint">{previewNote}</p>
          )}
          <pre
            className="ext-details-pre managed-setup__json"
            data-testid="managed-setup-json"
          >
            {summary.redactedJson}
          </pre>
          <p className="settings-row__hint">{tr("managedSetup.redactNote")}</p>
        </div>
      )}

      <GlassModal
        open={confirmOpen}
        onClose={() => {
          if (!installing) setConfirmOpen(false);
        }}
        title={tr("managedSetup.confirmTitle")}
        size="sm"
        closeLabel={tr("common.close")}
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={installing}
              onClick={() => setConfirmOpen(false)}
            >
              {tr("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--solid"
              disabled={installing}
              onClick={() => void runInstall()}
            >
              {installing
                ? tr("managedSetup.installing")
                : tr("managedSetup.install")}
            </button>
          </>
        }
      >
        <p className="app-dialog__msg">{tr("managedSetup.confirmBody")}</p>
      </GlassModal>
    </div>
  );
}
