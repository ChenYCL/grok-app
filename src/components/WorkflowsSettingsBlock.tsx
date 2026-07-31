/**
 * Settings → Runtime → Tools: workflows discovery + soft-fail headless run.
 * No visual workflow editor; run uses CLI workflow tool via short agent.
 */

import { useCallback, useEffect, useState } from "react";
import * as api from "@/lib/api";
import { createT, type Locale, type MessageKey } from "@/i18n";
import {
  formatDiscoveredWorkflowNames,
  formatWorkflowRunStatusLine,
  isValidWorkflowName,
  isWorkflowRunOk,
  prepareWorkflowRunLogForDisplay,
  workflowRunReasonKey,
  type WorkflowDefLike,
  type WorkflowRunMode,
  type WorkflowRunResultLike,
  type WorkflowScope,
} from "@/lib/workflows";

const RUN_REASON_KEYS: Record<string, MessageKey> = {
  ok: "settings.workflows.run.reason.ok",
  invalid_name: "settings.workflows.run.reason.invalid_name",
  cli_missing: "settings.workflows.run.reason.cli_missing",
  timeout: "settings.workflows.run.reason.timeout",
  spawn_failed: "settings.workflows.run.reason.spawn_failed",
  empty: "settings.workflows.run.reason.empty",
  nonzero_exit: "settings.workflows.run.reason.nonzero_exit",
  soft_fail: "settings.workflows.run.reason.soft_fail",
};

export type WorkflowsDiscoveryBlockProps = {
  locale: Locale;
  projectPath?: string | null;
  showToast?: (msg: string, ms?: number) => void;
};

function asScope(raw: string): WorkflowScope {
  if (raw === "project" || raw === "agent_home") return raw;
  return "user";
}

type RunState = {
  name: string;
  mode: WorkflowRunMode;
  busy: boolean;
  result: WorkflowRunResultLike | null;
  error: string | null;
};

export function WorkflowsDiscoveryBlock({
  locale,
  projectPath,
  showToast,
}: WorkflowsDiscoveryBlockProps) {
  const t = createT(locale);
  const [loading, setLoading] = useState(false);
  const [workflows, setWorkflows] = useState<WorkflowDefLike[]>([]);
  const [skillPath, setSkillPath] = useState<string | null>(null);
  const [userDir, setUserDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runState, setRunState] = useState<RunState | null>(null);

  const refresh = useCallback(async () => {
    if (!api.isTauri()) {
      setWorkflows([]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.workflowsList(projectPath);
      const rows: WorkflowDefLike[] = (res.workflows ?? []).map((w) => ({
        name: w.name,
        path: w.path,
        scope: asScope(w.scope),
      }));
      setWorkflows(rows);
      setSkillPath(res.createWorkflowSkill?.trim() || null);
      setUserDir(res.userDir?.trim() || null);
    } catch (e) {
      // Soft-fail: discovery is optional honesty, never block settings.
      setWorkflows([]);
      setError(String(e ?? "workflows_list failed"));
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const summary = formatDiscoveredWorkflowNames(workflows);
  const scopeLabels: Partial<Record<WorkflowScope, string>> = {
    project: t("settings.workflows.scope.project"),
    user: t("settings.workflows.scope.user"),
    agent_home: t("settings.workflows.scope.agentHome"),
  };

  const reasonLabel = (reason: string | null | undefined) => {
    const key = workflowRunReasonKey(reason);
    const msgKey = RUN_REASON_KEYS[key] ?? RUN_REASON_KEYS.soft_fail;
    return t(msgKey);
  };

  const openSkill = async () => {
    if (!skillPath) {
      showToast?.(t("settings.workflows.docsMissing"), 2800);
      return;
    }
    try {
      await api.pathReveal(skillPath);
    } catch {
      showToast?.(t("settings.workflows.docsMissing"), 2800);
    }
  };

  const openUserDir = async () => {
    if (!userDir) return;
    try {
      await api.pathReveal(userDir);
    } catch {
      showToast?.(t("settings.workflows.dirMissing"), 2800);
    }
  };

  const runWorkflow = async (name: string, mode: WorkflowRunMode) => {
    if (!api.isTauri()) {
      showToast?.(t("settings.workflows.run.desktopOnly"), 2800);
      return;
    }
    if (!isValidWorkflowName(name)) {
      setRunState({
        name,
        mode,
        busy: false,
        result: {
          ok: false,
          reason: "invalid_name",
          workflowName: name,
          mode,
        },
        error: null,
      });
      return;
    }
    setRunState({ name, mode, busy: true, result: null, error: null });
    try {
      const res = await api.workflowsRun({
        name,
        projectPath,
        mode,
      });
      setRunState({
        name,
        mode,
        busy: false,
        result: {
          ok: !!res.ok,
          reason: res.reason ?? (res.ok ? "ok" : "soft_fail"),
          workflowName: res.workflowName ?? name,
          mode: res.mode ?? mode,
          log: res.log ?? null,
          durationMs: res.durationMs ?? null,
          truncated: res.truncated ?? false,
          cliPath: res.cliPath ?? null,
          cliVersion: res.cliVersion ?? null,
        },
        error: null,
      });
    } catch (e) {
      // Soft-fail: never throw into Settings root.
      setRunState({
        name,
        mode,
        busy: false,
        result: {
          ok: false,
          reason: "soft_fail",
          workflowName: name,
          mode,
          log: String(e ?? "workflows_run failed"),
        },
        error: String(e ?? "workflows_run failed"),
      });
    }
  };

  const displayLog = runState?.result
    ? prepareWorkflowRunLogForDisplay(runState.result.log)
    : null;

  const statusLine = runState?.result
    ? formatWorkflowRunStatusLine(runState.result, {
        ok: t("settings.workflows.run.status.ok"),
        softFail: t("settings.workflows.run.status.softFail"),
        reason: reasonLabel(runState.result.reason),
      })
    : null;

  const anyBusy = !!runState?.busy;

  return (
    <div className="settings-workflows-discovery">
      <div className="settings-row__hint">
        {loading
          ? t("settings.workflows.scanning")
          : summary
            ? t("settings.workflows.discovered", { names: summary })
            : t("settings.workflows.noneFound")}
        {error ? ` · ${t("settings.workflows.scanSoftFail")}` : null}
      </div>
      <div className="settings-row__hint settings-workflows-run-hint">
        {t("settings.workflows.runHonesty")}
      </div>
      {workflows.length > 0 ? (
        <ul className="settings-workflows-list" aria-label={t("settings.workflows")}>
          {workflows.slice(0, 24).map((w) => {
            const runningThis =
              anyBusy && runState?.name === w.name;
            return (
              <li key={`${w.scope}:${w.path}`}>
                <div className="settings-workflows-list__row">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    title={w.path}
                    onClick={() => {
                      void api.pathReveal(w.path).catch(() => {
                        showToast?.(t("settings.workflows.dirMissing"), 2800);
                      });
                    }}
                  >
                    {w.name}
                    <span className="settings-workflows-list__scope">
                      {" "}
                      · {scopeLabels[w.scope] ?? w.scope}
                    </span>
                  </button>
                  <span className="settings-workflows-list__actions">
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={anyBusy || !isValidWorkflowName(w.name)}
                      title={t("settings.workflows.run.smokeTitle")}
                      onClick={() => void runWorkflow(w.name, "validate")}
                    >
                      {runningThis && runState?.mode === "validate"
                        ? t("settings.workflows.run.running")
                        : t("settings.workflows.run.smoke")}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={anyBusy || !isValidWorkflowName(w.name)}
                      title={t("settings.workflows.run.launchTitle")}
                      onClick={() => void runWorkflow(w.name, "launch")}
                    >
                      {runningThis && runState?.mode === "launch"
                        ? t("settings.workflows.run.running")
                        : t("settings.workflows.run.launch")}
                    </button>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {runState ? (
        <div
          className={
            "settings-workflows-run-result" +
            (runState.busy
              ? " settings-workflows-run-result--busy"
              : runState.result && isWorkflowRunOk(runState.result)
                ? " settings-workflows-run-result--ok"
                : " settings-workflows-run-result--soft")
          }
          role="status"
          aria-live="polite"
        >
          <div className="settings-workflows-run-result__title">
            {t("settings.workflows.run.resultTitle", {
              name: runState.name,
              mode:
                runState.mode === "launch"
                  ? t("settings.workflows.run.mode.launch")
                  : t("settings.workflows.run.mode.validate"),
            })}
          </div>
          {runState.busy ? (
            <div className="settings-row__hint">
              {t("settings.workflows.run.running")}
            </div>
          ) : null}
          {statusLine ? (
            <div className="settings-workflows-run-result__status">
              {statusLine}
            </div>
          ) : null}
          {runState.result && !isWorkflowRunOk(runState.result) ? (
            <div className="settings-row__hint">
              {t("settings.workflows.run.softFailDetail", {
                reason: reasonLabel(runState.result.reason),
              })}
            </div>
          ) : null}
          {displayLog?.text ? (
            <pre
              className="settings-workflows-run-result__log"
              tabIndex={0}
            >
              {displayLog.text}
              {displayLog.truncated || runState.result?.truncated
                ? `\n${t("settings.workflows.run.logTruncated")}`
                : ""}
            </pre>
          ) : !runState.busy ? (
            <div className="settings-row__hint">
              {t("settings.workflows.run.noLog")}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="settings-row__actions" style={{ gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn--ghost settings-row__action"
          onClick={() => void refresh()}
          disabled={loading || anyBusy}
        >
          {t("settings.workflows.refresh")}
        </button>
        <button
          type="button"
          className="btn btn--ghost settings-row__action"
          onClick={() => void openSkill()}
        >
          {t("settings.workflows.openDocs")}
        </button>
        {userDir ? (
          <button
            type="button"
            className="btn btn--ghost settings-row__action"
            onClick={() => void openUserDir()}
          >
            {t("settings.workflows.openUserDir")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
