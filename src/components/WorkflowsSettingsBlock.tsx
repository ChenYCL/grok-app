/**
 * Settings → Runtime → Tools: workflows discovery + docs honesty.
 * Read-only soft-fail list; no in-app runner.
 */

import { useCallback, useEffect, useState } from "react";
import * as api from "@/lib/api";
import { createT, type Locale } from "@/i18n";
import {
  formatDiscoveredWorkflowNames,
  type WorkflowDefLike,
  type WorkflowScope,
} from "@/lib/workflows";

export type WorkflowsDiscoveryBlockProps = {
  locale: Locale;
  projectPath?: string | null;
  showToast?: (msg: string, ms?: number) => void;
};

function asScope(raw: string): WorkflowScope {
  if (raw === "project" || raw === "agent_home") return raw;
  return "user";
}

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
      {workflows.length > 0 ? (
        <ul className="settings-workflows-list" aria-label={t("settings.workflows")}>
          {workflows.slice(0, 24).map((w) => (
            <li key={`${w.scope}:${w.path}`}>
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
            </li>
          ))}
        </ul>
      ) : null}
      <div className="settings-row__actions" style={{ gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn--ghost settings-row__action"
          onClick={() => void refresh()}
          disabled={loading}
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
