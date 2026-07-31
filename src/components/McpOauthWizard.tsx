/**
 * MCP OAuth recovery wizard (GlassModal steps).
 *
 * intro → auth URL / TUI instructions → “I’ve authorized” → doctor refresh
 * → success / classified soft-fail.
 *
 * No window.confirm. No headless CLI oauth — honest TUI fallback copy.
 * Secrets never logged; URLs sanitized via mcpOauth helpers.
 */

import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { Locale, MessageKey } from "@/i18n";
import { createT } from "@/i18n";
import { GlassModal } from "@/components/GlassModal";
import {
  IconDoctor,
  IconExternalLink,
  IconRefresh,
} from "@/components/icons";
import * as api from "@/lib/api";
import {
  redactMcpOauthText,
  type McpOauthAction,
} from "@/lib/mcpOauth";
import {
  createMcpOauthWizardState,
  emptyMcpOauthWizardState,
  evaluateMcpOauthDoctorRefresh,
  mcpOauthWizardCanConfirmAuthorized,
  mcpOauthWizardHasOpenableUrl,
  mcpOauthWizardSoftFailLabelKey,
  mcpOauthWizardStepIndex,
  mcpOauthWizardStepLabelKey,
  mcpOauthWizardTitleKey,
  MCP_OAUTH_WIZARD_PROGRESS_TOTAL,
  reduceMcpOauthWizard,
  sanitizeMcpOauthWizardLog,
  type McpOauthWizardState,
} from "@/lib/mcpOauthWizard";
import type { McpDoctorReportLike } from "@/lib/mcpStatus";

export type McpOauthWizardDoctorRefreshResult = {
  report?: McpDoctorReportLike | null;
  error?: string | null;
};

export type McpOauthWizardProps = {
  open: boolean;
  locale: Locale;
  /** Classified OAuth action; required when open. */
  action: McpOauthAction | null;
  /** Optional redacted reason from doctor status / finding. */
  statusReason?: string | null;
  onClose: () => void;
  /**
   * Soft-fail open browser URL (defaults to host `openExternalUrl`).
   * Callers only receive sanitized http(s).
   */
  onOpenExternalUrl?: (url: string) => void | Promise<void>;
  /**
   * Re-run doctor after the user confirms authorization.
   * Should update parent doctor state and return the latest report.
   */
  onRefreshDoctor?: (
    serverName: string | null,
  ) => Promise<McpOauthWizardDoctorRefreshResult>;
};

function softFailBadgeClass(
  soft: McpOauthWizardState["softFail"],
  step: McpOauthWizardState["step"],
): string {
  if (step === "success" || soft === "none") return "ext-badge--ok";
  if (soft === "doctor_failed") return "ext-badge--fail";
  // Soft guidance / still needs auth — warn, not hard crash.
  return "ext-badge--warn";
}

export function McpOauthWizard({
  open,
  locale,
  action,
  statusReason,
  onClose,
  onOpenExternalUrl,
  onRefreshDoctor,
}: McpOauthWizardProps) {
  const tr = useMemo(() => createT(locale), [locale]);
  const [state, dispatch] = useReducer(
    reduceMcpOauthWizard,
    undefined,
    emptyMcpOauthWizardState,
  );
  const [busy, setBusy] = useState(false);

  // Seed when opened / target changes; reset when closed.
  useEffect(() => {
    if (!open || !action) {
      if (!open) {
        dispatch({ type: "reset" });
        setBusy(false);
      }
      return;
    }
    const next = createMcpOauthWizardState({
      action,
      reason: statusReason ?? null,
    });
    dispatch({
      type: "init",
      input: {
        action,
        reason: statusReason ?? null,
      },
    });
    setBusy(false);
    // Safe snapshot only — no secrets / raw tokens.
    try {
      console.info(
        "[mcp-oauth-wizard] open",
        sanitizeMcpOauthWizardLog(next),
      );
    } catch {
      /* ignore log failures */
    }
  }, [
    open,
    action?.server,
    action?.kind,
    action?.preferredUrl,
    action?.isRetry,
    statusReason,
  ]);

  const openExternal = useCallback(
    async (url: string) => {
      if (onOpenExternalUrl) {
        await onOpenExternalUrl(url);
        return;
      }
      if (!api.isTauri()) {
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      await api.openExternalUrl(url);
    },
    [onOpenExternalUrl],
  );

  const handleOpenUrl = useCallback(async () => {
    const url = state.authUrl;
    if (!url) return;
    setBusy(true);
    try {
      await openExternal(url);
      dispatch({ type: "open_url_ok" });
    } catch (e) {
      dispatch({
        type: "open_url_error",
        error: redactMcpOauthText(String(e)).slice(0, 240),
      });
    } finally {
      setBusy(false);
    }
  }, [openExternal, state.authUrl]);

  const runDoctorRefresh = useCallback(async () => {
    const server = state.server;
    dispatch({ type: "doctor_start" });
    setBusy(true);
    try {
      let result: McpOauthWizardDoctorRefreshResult;
      if (onRefreshDoctor) {
        result = await onRefreshDoctor(server);
      } else if (api.isTauri()) {
        try {
          const report = await api.mcpDoctor(server);
          result = { report, error: null };
        } catch (e) {
          result = {
            report: null,
            error: redactMcpOauthText(String(e)).slice(0, 240),
          };
        }
      } else {
        result = {
          report: null,
          error: tr("ext.needTauri"),
        };
      }

      const evaluated = evaluateMcpOauthDoctorRefresh({
        report: result.report,
        serverName: server,
        doctorError: result.error,
      });
      dispatch({
        type: "doctor_result",
        stillNeedsAuth: evaluated.stillNeedsAuth,
        reason: evaluated.reason,
        doctorError:
          evaluated.softFail === "doctor_failed"
            ? evaluated.reason ?? result.error
            : null,
      });
      try {
        console.info(
          "[mcp-oauth-wizard] doctor_result",
          sanitizeMcpOauthWizardLog({
            ...state,
            step: evaluated.ok ? "success" : "fail",
            softFail: evaluated.softFail,
            softFailNonBlocking:
              evaluated.softFail !== "none" &&
              evaluated.softFail !== "doctor_failed",
            reason: evaluated.reason,
            errorMessage: evaluated.reason,
            refreshAttempts: state.refreshAttempts + 1,
          }),
        );
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(false);
    }
  }, [onRefreshDoctor, state, tr]);

  const handleIAuthorized = useCallback(() => {
    if (!mcpOauthWizardCanConfirmAuthorized(state)) return;
    void runDoctorRefresh();
  }, [runDoctorRefresh, state]);

  const handleClose = useCallback(() => {
    if (busy && state.step === "refreshing") return;
    dispatch({ type: "reset" });
    onClose();
  }, [busy, onClose, state.step]);

  const serverName =
    state.server || tr("mcpModal.oauth.unknownServer");
  const stepIdx = mcpOauthWizardStepIndex(state.step);
  const progressLabel = tr("mcpOauth.wizard.progress", {
    n: Math.min(stepIdx + 1, MCP_OAUTH_WIZARD_PROGRESS_TOTAL),
    total: MCP_OAUTH_WIZARD_PROGRESS_TOTAL,
  });
  const hasUrl = mcpOauthWizardHasOpenableUrl(state);
  const showSoftChip =
    state.softFail !== "none" ||
    state.step === "success" ||
    state.step === "fail";

  const footer = (
    <>
      {state.step === "intro" ? (
        <>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={handleClose}
          >
            {tr("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn--solid"
            onClick={() => dispatch({ type: "continue" })}
          >
            {tr("mcpOauth.wizard.next")}
          </button>
        </>
      ) : null}

      {state.step === "auth" ? (
        <>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => dispatch({ type: "back" })}
          >
            {tr("mcpOauth.wizard.back")}
          </button>
          {hasUrl ? (
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => void handleOpenUrl()}
            >
              <IconExternalLink size={14} />
              <span>
                {busy
                  ? tr("mcpOauth.wizard.openingUrl")
                  : tr("mcpModal.oauth.openUrl")}
              </span>
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--solid"
            disabled={busy}
            onClick={() => dispatch({ type: "continue" })}
          >
            {tr("mcpOauth.wizard.next")}
          </button>
        </>
      ) : null}

      {state.step === "waiting" ? (
        <>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => dispatch({ type: "back" })}
          >
            {tr("mcpOauth.wizard.back")}
          </button>
          {hasUrl ? (
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => void handleOpenUrl()}
            >
              <IconExternalLink size={14} />
              <span>{tr("mcpModal.oauth.openUrl")}</span>
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--solid"
            disabled={busy}
            onClick={handleIAuthorized}
          >
            <IconDoctor size={14} />
            <span>{tr("mcpOauth.wizard.iAuthorized")}</span>
          </button>
        </>
      ) : null}

      {state.step === "refreshing" ? (
        <button type="button" className="btn btn--solid" disabled>
          <IconRefresh size={14} />
          <span>{tr("mcpOauth.wizard.refreshing")}</span>
        </button>
      ) : null}

      {state.step === "success" ? (
        <button
          type="button"
          className="btn btn--solid"
          onClick={handleClose}
        >
          {tr("common.close")}
        </button>
      ) : null}

      {state.step === "fail" ? (
        <>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => dispatch({ type: "retry_auth" })}
          >
            {tr("mcpOauth.wizard.retryAuth")}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => {
              dispatch({ type: "retry_refresh" });
            }}
          >
            {tr("mcpOauth.wizard.retryRefresh")}
          </button>
          <button
            type="button"
            className="btn btn--solid"
            disabled={busy}
            onClick={() => void runDoctorRefresh()}
          >
            <IconDoctor size={14} />
            <span>{tr("mcpOauth.wizard.iAuthorized")}</span>
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={handleClose}
          >
            {tr("common.close")}
          </button>
        </>
      ) : null}
    </>
  );

  return (
    <GlassModal
      open={open && !!action}
      onClose={handleClose}
      title={tr(mcpOauthWizardTitleKey(state) as MessageKey, {
        name: serverName,
      })}
      size="md"
      closeLabel={tr("common.close")}
      wrapBody
      className="mcp-oauth-wizard"
      bodyClassName="mcp-oauth-wizard__body"
      closeOnOverlay={!busy || state.step !== "refreshing"}
      showClose={!busy || state.step !== "refreshing"}
      footer={footer}
    >
      <div className="mcp-oauth-wizard__progress" role="status">
        <span className="mcp-oauth-wizard__progress-label">
          {progressLabel}
        </span>
        <span className="mcp-oauth-wizard__progress-step">
          {tr(mcpOauthWizardStepLabelKey(state.step) as MessageKey)}
        </span>
        <div
          className="mcp-oauth-wizard__dots"
          aria-hidden
        >
          {Array.from({ length: MCP_OAUTH_WIZARD_PROGRESS_TOTAL }, (_, i) => (
            <span
              key={i}
              className={
                "mcp-oauth-wizard__dot" +
                (i <= stepIdx ? " is-active" : "") +
                (i === stepIdx ? " is-current" : "") +
                (state.step === "success" && i === stepIdx
                  ? " is-ok"
                  : "") +
                (state.step === "fail" && i === stepIdx ? " is-fail" : "")
              }
            />
          ))}
        </div>
      </div>

      {showSoftChip && state.softFail !== "none" ? (
        <p className="mcp-oauth-wizard__chip-row">
          <span
            className={
              "ext-badge " + softFailBadgeClass(state.softFail, state.step)
            }
          >
            {tr(mcpOauthWizardSoftFailLabelKey(state.softFail) as MessageKey)}
          </span>
          {state.softFailNonBlocking ? (
            <span className="mcp-oauth-wizard__soft-hint">
              {tr("mcpOauth.wizard.softHint")}
            </span>
          ) : null}
        </p>
      ) : null}

      {state.step === "intro" ? (
        <div className="mcp-oauth-wizard__panel">
          <p className="app-dialog__msg">
            {state.isRetry
              ? tr("mcpModal.oauth.retryLead")
              : tr("mcpModal.oauth.authorizeLead")}
          </p>
          <dl className="mcp-oauth-wizard__meta">
            <div>
              <dt>{tr("mcpOauth.wizard.serverLabel")}</dt>
              <dd title={serverName}>{serverName}</dd>
            </div>
            {state.reason ? (
              <div>
                <dt>{tr("mcpOauth.wizard.reasonLabel")}</dt>
                <dd>{state.reason}</dd>
              </div>
            ) : null}
          </dl>
          <p className="ext-field-hint">{tr("mcpModal.oauth.noCliHelper")}</p>
        </div>
      ) : null}

      {state.step === "auth" ? (
        <div className="mcp-oauth-wizard__panel">
          <p className="app-dialog__msg">
            {hasUrl
              ? tr("mcpOauth.wizard.authLeadUrl")
              : tr("mcpOauth.wizard.authLeadTui")}
          </p>
          {hasUrl && state.authUrl ? (
            <p
              className="mcp-modal__oauth-url"
              title={state.authUrl}
            >
              <span className="mcp-modal__oauth-url-label">
                {tr("mcpModal.oauth.urlLabel")}
              </span>{" "}
              <code className="mcp-modal__oauth-url-value">
                {state.authUrl}
              </code>
            </p>
          ) : null}
          {state.errorMessage ? (
            <p className="modal-status modal-status--error">
              {state.errorMessage}
            </p>
          ) : null}
          {state.urlOpened ? (
            <p className="modal-status" role="status">
              {tr("mcpOauth.wizard.urlOpened")}
            </p>
          ) : null}
          <ol className="ext-mcp-auth-steps">
            <li>{tr("mcpModal.oauth.stepTui")}</li>
            <li>{tr("mcpModal.oauth.stepBrowser")}</li>
            {!hasUrl ? (
              <li>{tr("ext.mcp.auth.stepReauth")}</li>
            ) : null}
          </ol>
          <p className="ext-field-hint">{tr("mcpModal.oauth.noCliHelper")}</p>
        </div>
      ) : null}

      {state.step === "waiting" ? (
        <div className="mcp-oauth-wizard__panel">
          <p className="app-dialog__msg">
            {tr("mcpOauth.wizard.waitingLead")}
          </p>
          <ol className="ext-mcp-auth-steps">
            <li>{tr("mcpModal.oauth.stepDoctor")}</li>
            <li>{tr("ext.mcp.auth.stepDoctor")}</li>
          </ol>
          <p className="ext-field-hint">
            {tr("mcpOauth.wizard.waitingHint")}
          </p>
        </div>
      ) : null}

      {state.step === "refreshing" ? (
        <div className="mcp-oauth-wizard__panel">
          <p className="modal-status" role="status">
            {tr("mcpOauth.wizard.refreshingDetail", { name: serverName })}
          </p>
        </div>
      ) : null}

      {state.step === "success" ? (
        <div className="mcp-oauth-wizard__panel">
          <p className="app-dialog__msg mcp-oauth-wizard__success">
            {tr("mcpOauth.wizard.successLead", { name: serverName })}
          </p>
          {state.reason ? (
            <p className="ext-mcp-status-reason">{state.reason}</p>
          ) : null}
        </div>
      ) : null}

      {state.step === "fail" ? (
        <div className="mcp-oauth-wizard__panel">
          <p className="app-dialog__msg">
            {state.softFail === "doctor_failed"
              ? tr("mcpOauth.wizard.failDoctor")
              : tr("mcpOauth.wizard.failStillAuth", { name: serverName })}
          </p>
          {state.errorMessage || state.reason ? (
            <p className="ext-mcp-status-reason">
              {state.errorMessage || state.reason}
            </p>
          ) : null}
          <ol className="ext-mcp-auth-steps">
            <li>{tr("mcpModal.oauth.stepTui")}</li>
            <li>{tr("ext.mcp.auth.stepReadd")}</li>
            <li>{tr("mcpModal.oauth.stepDoctor")}</li>
          </ol>
          <p className="ext-field-hint">{tr("mcpModal.oauth.noCliHelper")}</p>
        </div>
      ) : null}
    </GlassModal>
  );
}
