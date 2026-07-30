/**
 * Settings → Extensions → Hooks: list and open hook folders + recent activity
 * + Try/override dry-run (validates sample stdin JSON; does not execute hooks).
 * Settings → Extensions → Hooks: list / open folders, real try-run, recent activity.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "@/lib/api";
import { createT, type Locale } from "@/i18n";
import { GlassModal } from "@/components/GlassModal";
import {
  IconExternalLink,
  IconFolder,
  IconHooks,
  IconPlus,
  IconRefresh,
} from "@/components/icons";
import { isCliMissingError } from "@/lib/extensionsUi";
import {
  clearHookActivities,
  formatHookActivityTime,
  listHookActivities,
  pushHookActivity,
  redactHookDetail,
  subscribeHookActivities,
  type HookActivityOutcome,
  type HookActivityRecord,
} from "@/lib/hooksDebug";
import {
  filterHookActivitiesByOutcome,
  formatHookOverridePreview,
  hookOverrideValidationMessage,
  recordHookDryRun,
  validateHookOverrideJson,
  type HookActivityOutcomeFilter,
} from "@/lib/hookOverride";
import {
  clampHooksTryTimeout,
  formatHooksTryRunOutput,
  formatHooksTryRunSummary,
  HOOKS_TRY_DEFAULT_TIMEOUT_SECS,
  hooksTryRunActivityOutcome,
  hooksTryStdinErrorCode,
  isHookScriptTryable,
  validateHooksTryStdin,
} from "@/lib/hooksTryRun";
import {
  formatHookMtime,
  formatHookSize,
  hookMetaLine,
  hookRowKey,
  hookTypeLabel,
  sortHooksByScopeName,
  type HookLike,
} from "@/lib/hooksUi";

const KNOWN_HOOK_TYPES = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionDenied",
  "Stop",
  "StopFailure",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
] as const;

const SAMPLE_STDIN = `{
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "echo dry-run" }
}`;

const OUTCOME_FILTERS: HookActivityOutcomeFilter[] = [
  "all",
  "ok",
  "fail",
  "skip",
];

const DRY_RUN_OUTCOMES: Array<"ok" | "fail" | "skip"> = ["ok", "fail", "skip"];

const SAMPLE_STDIN = `{
  "hookEventName": "PreToolUse",
  "sessionId": "try-run",
  "cwd": "/tmp",
  "toolName": "run_terminal_command",
  "toolInput": { "command": "echo hi" }
}`;

function outcomeBadgeClass(outcome: HookActivityOutcome): string {
  if (outcome === "ok") return "ext-badge ext-badge--ok";
  if (outcome === "fail") return "ext-badge ext-badge--fail";
  return "ext-badge ext-badge--muted";
}

function outcomeLabel(
  outcome: HookActivityOutcome,
  tr: ReturnType<typeof createT>,
): string {
  if (outcome === "ok") return tr("ext.hooks.activity.ok");
  if (outcome === "fail") return tr("ext.hooks.activity.fail");
  if (outcome === "skip") return tr("ext.hooks.activity.skip");
  return tr("ext.hooks.activity.info");
}

function filterChipLabel(
  id: HookActivityOutcomeFilter,
  tr: ReturnType<typeof createT>,
): string {
  if (id === "all") return tr("ext.hooks.activity.filterAll");
  if (id === "ok") return tr("ext.hooks.activity.ok");
  if (id === "fail") return tr("ext.hooks.activity.fail");
  return tr("ext.hooks.activity.skip");
}

export function ExtensionsHooksPanel({
  locale,
  projectPath = null,
  cliFound = true,
}: {
  locale: Locale;
  projectPath?: string | null;
  cliFound?: boolean;
}) {
  const tr = useMemo(() => createT(locale), [locale]);
  const [hooks, setHooks] = useState<HookLike[]>([]);
  const [userDir, setUserDir] = useState("");
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [docsPath, setDocsPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [activity, setActivity] = useState<HookActivityRecord[]>(() => [
    ...listHookActivities(),
  ]);
  const [outcomeFilter, setOutcomeFilter] =
    useState<HookActivityOutcomeFilter>("all");
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);

  // Try / override
  const [tryOpen, setTryOpen] = useState(false);
  const [tryHookName, setTryHookName] = useState("");
  const [tryType, setTryType] = useState<string>("PreToolUse");
  const [tryJson, setTryJson] = useState(SAMPLE_STDIN);
  const [tryOutcome, setTryOutcome] = useState<"ok" | "fail" | "skip">("ok");
  const [tryMsg, setTryMsg] = useState<{
    kind: "ok" | "err" | "info";
    text: string;
  } | null>(null);


  // Real try-run panel
  const [tryOpen, setTryOpen] = useState(true);
  const [tryPath, setTryPath] = useState("");
  const [tryJson, setTryJson] = useState(SAMPLE_STDIN);
  const [tryTimeout, setTryTimeout] = useState(String(HOOKS_TRY_DEFAULT_TIMEOUT_SECS));
  const [tryRunning, setTryRunning] = useState(false);
  const [tryResult, setTryResult] = useState<api.HooksTryRunResult | null>(null);
  const [tryMsg, setTryMsg] = useState<{
    kind: "ok" | "err" | "info";
    text: string;
  } | null>(null);

  const cliMissing = !cliFound;

  useEffect(() => {
    setActivity([...listHookActivities()]);
    return subscribeHookActivities((recs) => setActivity([...recs]));
  }, []);

  const filteredActivity = useMemo(
    () => filterHookActivitiesByOutcome(activity, outcomeFilter),
    [activity, outcomeFilter],
  );

  const load = useCallback(async () => {
    if (!api.isTauri()) {
      setHooks([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.hooksList(projectPath);
      setHooks(
        sortHooksByScopeName(
          (res.hooks ?? []).map((h) => ({
            name: h.name,
            path: h.path,
            scope: h.scope,
            kind: h.kind,
            ext: h.ext,
            size: h.size ?? 0,
            mtimeMs: h.mtimeMs ?? 0,
          })),
        ),
      );
      setUserDir(res.userDir || "");
      setProjectDir(res.projectDir ?? null);
      setDocsPath(res.docsPath ?? null);
    } catch (e) {
      setHooks([]);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDir = async (scope: "user" | "project", create: boolean) => {
    if (scope === "project" && !projectPath?.trim()) return;
    setBusy(`${scope}:${create ? "c" : "o"}`);
    try {
      await api.hooksOpenDir({ scope, projectPath, create });
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const scopeLabel = (scope: string) =>
    scope === "project" ? tr("ext.hooks.scope.project") : tr("ext.hooks.scope.user");

  const validationLabels = useMemo(
    () => ({
      empty: tr("ext.hooks.try.errEmpty"),
      tooLarge: tr("ext.hooks.try.errTooLarge"),
      invalidJson: tr("ext.hooks.try.errInvalidJson"),
      notObject: tr("ext.hooks.try.errNotObject"),
      ok: tr("ext.hooks.try.validOk"),
    }),
    [tr],
  );

  const onValidate = () => {
    const result = validateHookOverrideJson(tryJson);
    const text = hookOverrideValidationMessage(result, validationLabels);
    if (result.ok) {
      const preview = formatHookOverridePreview(result.parsed);
      setTryMsg({
        kind: "ok",
        text: preview ? `${text} · ${preview}` : text,
      });
    } else {
      setTryMsg({ kind: "err", text });
    }
  };

  const onRecordDryRun = () => {
    const result = validateHookOverrideJson(tryJson);
    if (!result.ok) {
      setTryMsg({
        kind: "err",
        text: hookOverrideValidationMessage(result, validationLabels),
      });
      return;
    }
    const preview = formatHookOverridePreview(result.parsed);
    recordHookDryRun({
      hookName: tryHookName.trim() || undefined,
      type: tryType.trim() || "Hook",
      outcome: tryOutcome,
      detail: preview,
    });
    setTryMsg({
      kind: "info",
      text: tr("ext.hooks.try.recorded"),
    });
  };

  const confirmClearActivity = () => {
    clearHookActivities();
    setClearConfirmOpen(false);
    setOutcomeFilter("all");
  };

  const scriptHooks = useMemo(
    () => hooks.filter((h) => isHookScriptTryable(h)),
    [hooks],
  );

  const selectTryPath = (path: string) => {
    setTryPath(path);
    setTryResult(null);
    setTryMsg(null);
    setTryOpen(true);
  };

  const onTryRun = async () => {
    const path = tryPath.trim();
    if (!path) {
      setTryMsg({ kind: "err", text: tr("ext.hooks.try.errNoPath") });
      return;
    }
    if (!api.isTauri()) {
      setTryMsg({ kind: "err", text: tr("ext.hooks.try.errHostOnly") });
      return;
    }
    const stdinCheck = validateHooksTryStdin(tryJson);
    if (!stdinCheck.ok) {
      const code = hooksTryStdinErrorCode(stdinCheck);
      if (code === "too_large") {
        setTryMsg({ kind: "err", text: tr("ext.hooks.try.errTooLarge") });
      } else {
        const detail = stdinCheck.error.replace(/^invalid_json:/, "") || "…";
        setTryMsg({
          kind: "err",
          text: tr("ext.hooks.try.errInvalidJson", { detail }),
        });
      }
      return;
    }
    const timeoutSecs = clampHooksTryTimeout(
      tryTimeout.trim() ? Number(tryTimeout) : HOOKS_TRY_DEFAULT_TIMEOUT_SECS,
    );
    setTryRunning(true);
    setTryMsg(null);
    setTryResult(null);
    setBusy(`try:${path}`);
    try {
      const res = await api.hooksTryRun({
        path,
        projectPath,
        stdinJson: stdinCheck.body,
        timeoutSecs,
      });
      setTryResult(res);
      const summary = formatHooksTryRunSummary(res, {
        refused: tr("ext.hooks.try.summaryRefused"),
        timedOut: tr("ext.hooks.try.summaryTimedOut"),
        ok: tr("ext.hooks.try.summaryOk"),
        fail: tr("ext.hooks.try.summaryFail", {
          code:
            res.exitCode == null || res.exitCode === undefined
              ? "?"
              : String(res.exitCode),
        }),
      });
      setTryMsg({
        kind: res.ok ? "ok" : res.refused ? "err" : "err",
        text: summary,
      });
      // Honest activity row (source=try); never mark ok unless host ok.
      const baseName = path.split(/[/\\]/).pop() || path;
      pushHookActivity({
        id: `try-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        type: "TryRun",
        outcome: hooksTryRunActivityOutcome(res),
        atMs: Date.now(),
        detail: redactHookDetail(
          [
            summary,
            res.path ? res.path : baseName,
            res.stdout?.trim() ? res.stdout.trim().slice(0, 80) : null,
          ]
            .filter(Boolean)
            .join(" · "),
        ),
        source: "try",
        hookName: baseName,
      });
    } catch (e) {
      setTryResult(null);
      setTryMsg({ kind: "err", text: String(e) });
    } finally {
      setTryRunning(false);
      setBusy(null);
    }
  };

  return (
    <>
      <h2 className="settings-page__h2" id="settings-anchor-ext-hooks">
        <IconHooks size={15} />
        {tr("ext.hooks.title")}
        {!loading ? <span className="ext-count">{hooks.length}</span> : null}
        <button
          type="button"
          className="btn btn--ghost ext-bulk-btn"
          disabled={loading || !!busy}
          onClick={() => void load()}
        >
          <IconRefresh size={13} />
          <span>{tr("ext.market.update")}</span>
        </button>
      </h2>
      <div className="settings-card ext-card">
        <p className="ext-section-note">{tr("ext.hooks.desc")}</p>
        {!projectPath?.trim() ? (
          <p className="ext-field-hint">{tr("ext.hooks.emptyProject")}</p>
        ) : null}
        <div className="ext-toolbar">
          <div className="ext-toolbar__actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={!!busy || cliMissing}
              onClick={() => void openDir("user", false)}
            >
              <IconFolder size={13} />
              <span>{tr("ext.hooks.openUser")}</span>
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={!!busy || cliMissing}
              onClick={() => void openDir("user", true)}
            >
              <IconPlus size={13} />
              <span>{tr("ext.hooks.createUser")}</span>
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={!!busy || cliMissing || !projectPath?.trim()}
              onClick={() => void openDir("project", false)}
            >
              <IconFolder size={13} />
              <span>{tr("ext.hooks.openProject")}</span>
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={!!busy || cliMissing || !projectPath?.trim()}
              onClick={() => void openDir("project", true)}
            >
              <IconPlus size={13} />
              <span>{tr("ext.hooks.createProject")}</span>
            </button>
          </div>
          {userDir ? (
            <p className="ext-toolbar__hint" title={userDir}>
              {userDir}
              {projectDir ? ` · ${projectDir}` : ""}
            </p>
          ) : null}
        </div>
        {error ? (
          <div
            className={
              "ext-alert" +
              (isCliMissingError(error) ? " ext-alert--error" : " ext-alert--warn")
            }
            role="alert"
          >
            <div className="ext-alert__title">{tr("ext.hooks.error")}</div>
            <p className="ext-alert__body">{error}</p>
          </div>
        ) : null}
        {loading ? (
          <p className="ext-field-hint">{tr("ext.hooks.loading")}</p>
        ) : hooks.length === 0 ? (
          <p className="ext-field-hint">{tr("ext.hooks.empty")}</p>
        ) : (
          <ul className="ext-list">
            {hooks.map((h) => (
              <li key={hookRowKey(h)} className="ext-item">
                <div className="ext-item__head">
                  <span className="ext-item__name">{h.name}</span>
                  <span
                    className={
                      "ext-badge" +
                      (h.scope === "project"
                        ? " ext-badge--project"
                        : " ext-badge--user")
                    }
                  >
                    {scopeLabel(h.scope)}
                  </span>
                  <span className="ext-badge ext-badge--muted">
                    {hookTypeLabel(h)}
                  </span>
                </div>
                <div className="ext-item__meta">
                  {hookMetaLine(h, { locale, scopeLabel })}
                  {" · "}
                  {formatHookSize(h.size)}
                  {h.mtimeMs ? ` · ${formatHookMtime(h.mtimeMs, locale)}` : ""}
                </div>
                <div className="ext-item__actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={!!busy}
                    onClick={() =>
                      void api.hooksReveal(h.path).catch((e) => setError(String(e)))
                    }
                  >
                    <IconExternalLink size={13} />
                    <span>{tr("ext.hooks.reveal")}</span>
                  </button>
                  {isHookScriptTryable(h) ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={!!busy || tryRunning}
                      onClick={() => selectTryPath(h.path)}
                    >
                      <span>{tr("ext.hooks.try.action")}</span>
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {docsPath ? (
          <p className="ext-section-note">
            {tr("ext.hooks.docs")}: <code>{docsPath}</code>
          </p>
        ) : null}
      </div>

      {/* Real try-run */}
      <div className="settings-card ext-card ext-hooks-try">
        <button
          type="button"
          className="ext-hooks-try__toggle"
          aria-expanded={tryOpen}
          onClick={() => setTryOpen((v) => !v)}
        >
          <span className="ext-hooks-try__chevron" aria-hidden>
            {tryOpen ? "▾" : "▸"}
          </span>
          <span className="ext-hooks-try__toggle-title">
            {tr("ext.hooks.try.title")}
          </span>
        </button>
        {tryOpen ? (
          <div className="ext-hooks-try__body">
            <p className="ext-section-note">{tr("ext.hooks.try.desc")}</p>
            <label className="ext-hooks-try__field ext-hooks-try__field--block">
              <span className="ext-hooks-try__label">
                {tr("ext.hooks.try.scriptPath")}
              </span>
              <input
                type="text"
                className="settings-input"
                list="ext-hooks-try-paths"
                value={tryPath}
                onChange={(e) => {
                  setTryPath(e.target.value);
                  setTryMsg(null);
                  setTryResult(null);
                }}
                placeholder={tr("ext.hooks.try.scriptPathPlaceholder")}
                autoComplete="off"
                spellCheck={false}
              />
              <datalist id="ext-hooks-try-paths">
                {scriptHooks.map((h) => (
                  <option key={hookRowKey(h)} value={h.path}>
                    {h.name}
                  </option>
                ))}
              </datalist>
            </label>
            <label className="ext-hooks-try__field ext-hooks-try__field--block">
              <span className="ext-hooks-try__label">
                {tr("ext.hooks.try.stdin")}
              </span>
              <textarea
                className="settings-input ext-hooks-try__textarea"
                value={tryJson}
                onChange={(e) => {
                  setTryJson(e.target.value);
                  setTryMsg(null);
                }}
                rows={8}
                spellCheck={false}
                autoComplete="off"
                aria-label={tr("ext.hooks.try.stdin")}
              />
            </label>
            <div className="ext-hooks-try__row">
              <label className="ext-hooks-try__field">
                <span className="ext-hooks-try__label">
                  {tr("ext.hooks.try.timeout")}
                </span>
                <input
                  type="number"
                  className="settings-input"
                  min={1}
                  max={60}
                  step={1}
                  value={tryTimeout}
                  onChange={(e) => setTryTimeout(e.target.value)}
                  aria-label={tr("ext.hooks.try.timeout")}
                />
              </label>
            </div>
            <div className="ext-hooks-try__actions">
              <button
                type="button"
                className="btn btn--solid btn--sm"
                disabled={tryRunning || !!busy || !tryPath.trim()}
                onClick={() => void onTryRun()}
              >
                {tryRunning
                  ? tr("ext.hooks.try.running")
                  : tr("ext.hooks.try.run")}
              </button>
            </div>
            {tryMsg ? (
              <p
                className={
                  "ext-field-hint ext-hooks-try__msg" +
                  (tryMsg.kind === "ok"
                    ? " ext-hooks-try__msg--ok"
                    : tryMsg.kind === "err"
                      ? " ext-hooks-try__msg--err"
                      : "")
                }
                role="status"
              >
                {tryMsg.text}
              </p>
            ) : null}
            {tryResult ? (
              <div className="ext-hooks-try__result" role="region" aria-live="polite">
                <div className="ext-hooks-try__result-meta">
                  <span
                    className={
                      "ext-badge " +
                      (tryResult.ok
                        ? "ext-badge--ok"
                        : tryResult.refused
                          ? "ext-badge--muted"
                          : "ext-badge--fail")
                    }
                  >
                    {tryResult.ok
                      ? tr("ext.hooks.activity.ok")
                      : tryResult.refused
                        ? tr("ext.hooks.try.badgeRefused")
                        : tryResult.timedOut
                          ? tr("ext.hooks.try.badgeTimeout")
                          : tr("ext.hooks.activity.fail")}
                  </span>
                  {tryResult.exitCode != null ? (
                    <span className="ext-badge ext-badge--muted">
                      {tr("ext.hooks.try.exitCode", {
                        code: String(tryResult.exitCode),
                      })}
                    </span>
                  ) : null}
                  {typeof tryResult.durationMs === "number" ? (
                    <span className="ext-badge ext-badge--muted">
                      {tryResult.durationMs}ms
                    </span>
                  ) : null}
                  {tryResult.scope ? (
                    <span className="ext-badge ext-badge--muted">
                      {scopeLabel(tryResult.scope)}
                    </span>
                  ) : null}
                </div>
                {tryResult.path ? (
                  <p className="ext-hooks-try__result-path" title={tryResult.path}>
                    <code>{tryResult.path}</code>
                  </p>
                ) : null}
                {formatHooksTryRunOutput(tryResult) ? (
                  <pre className="ext-hooks-try__output">
                    {formatHooksTryRunOutput(tryResult)}
                  </pre>
                ) : (
                  <p className="ext-field-hint">{tr("ext.hooks.try.noOutput")}</p>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Try / override dry-run */}
      <div className="settings-card ext-card ext-hooks-try">
        <button
          type="button"
          className="ext-hooks-try__toggle"
          aria-expanded={tryOpen}
          onClick={() => setTryOpen((v) => !v)}
        >
          <span className="ext-hooks-try__chevron" aria-hidden>
            {tryOpen ? "▾" : "▸"}
          </span>
          <span className="ext-hooks-try__toggle-title">
            {tr("ext.hooks.try.title")}
          </span>
        </button>
        {tryOpen ? (
          <div className="ext-hooks-try__body">
            <p className="ext-section-note">{tr("ext.hooks.try.desc")}</p>
            <div className="ext-hooks-try__row">
              <label className="ext-hooks-try__field">
                <span className="ext-hooks-try__label">
                  {tr("ext.hooks.try.hookName")}
                </span>
                <input
                  type="text"
                  className="settings-input"
                  list="ext-hooks-try-names"
                  value={tryHookName}
                  onChange={(e) => setTryHookName(e.target.value)}
                  placeholder={tr("ext.hooks.try.hookNamePlaceholder")}
                  autoComplete="off"
                  spellCheck={false}
                />
                <datalist id="ext-hooks-try-names">
                  {hooks.map((h) => (
                    <option key={hookRowKey(h)} value={h.name} />
                  ))}
                </datalist>
              </label>
              <label className="ext-hooks-try__field">
                <span className="ext-hooks-try__label">
                  {tr("ext.hooks.try.eventType")}
                </span>
                <input
                  type="text"
                  className="settings-input"
                  list="ext-hooks-try-types"
                  value={tryType}
                  onChange={(e) => setTryType(e.target.value)}
                  placeholder="PreToolUse"
                  autoComplete="off"
                  spellCheck={false}
                />
                <datalist id="ext-hooks-try-types">
                  {KNOWN_HOOK_TYPES.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </label>
            </div>
            <label className="ext-hooks-try__field ext-hooks-try__field--block">
              <span className="ext-hooks-try__label">
                {tr("ext.hooks.try.stdin")}
              </span>
              <textarea
                className="settings-input ext-hooks-try__textarea"
                value={tryJson}
                onChange={(e) => {
                  setTryJson(e.target.value);
                  setTryMsg(null);
                }}
                rows={8}
                spellCheck={false}
                autoComplete="off"
                aria-label={tr("ext.hooks.try.stdin")}
              />
            </label>
            <div className="ext-hooks-try__row ext-hooks-try__row--outcome">
              <span className="ext-hooks-try__label">
                {tr("ext.hooks.try.outcome")}
              </span>
              <div
                className="settings-seg"
                role="tablist"
                aria-label={tr("ext.hooks.try.outcome")}
              >
                {DRY_RUN_OUTCOMES.map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={tryOutcome === id}
                    className={
                      "settings-seg__btn" + (tryOutcome === id ? " is-on" : "")
                    }
                    onClick={() => setTryOutcome(id)}
                  >
                    {outcomeLabel(id, tr)}
                  </button>
                ))}
              </div>
            </div>
            <div className="ext-hooks-try__actions">
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={onValidate}
              >
                {tr("ext.hooks.try.validate")}
              </button>
              <button
                type="button"
                className="btn btn--solid btn--sm"
                onClick={onRecordDryRun}
              >
                {tr("ext.hooks.try.record")}
              </button>
            </div>
            {tryMsg ? (
              <p
                className={
                  "ext-field-hint ext-hooks-try__msg" +
                  (tryMsg.kind === "ok"
                    ? " ext-hooks-try__msg--ok"
                    : tryMsg.kind === "err"
                      ? " ext-hooks-try__msg--err"
                      : "")
                }
                role="status"
              >
                {tryMsg.text}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="settings-card ext-card ext-hooks-activity">
        <div className="ext-hooks-activity__head">
          <h3 className="settings-page__h2 ext-hooks-activity__title">
            {tr("ext.hooks.activity.title")}
          </h3>
          {activity.length > 0 ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setClearConfirmOpen(true)}
            >
              {tr("ext.hooks.activity.clear")}
            </button>
          ) : null}
        </div>
        <p className="ext-section-note">{tr("ext.hooks.activity.desc")}</p>
        {activity.length > 0 ? (
          <div
            className="settings-seg ext-hooks-activity__chips"
            role="tablist"
            aria-label={tr("ext.hooks.activity.filterLabel")}
          >
            {OUTCOME_FILTERS.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={outcomeFilter === id}
                className={
                  "settings-seg__btn" +
                  (outcomeFilter === id ? " is-on" : "")
                }
                onClick={() => setOutcomeFilter(id)}
              >
                {filterChipLabel(id, tr)}
              </button>
            ))}
          </div>
        ) : null}
        {activity.length === 0 ? (
          <p className="ext-field-hint">{tr("ext.hooks.activity.empty")}</p>
        ) : filteredActivity.length === 0 ? (
          <p className="ext-field-hint">
            {tr("ext.hooks.activity.emptyFilter")}
          </p>
        ) : (
          <ul className="ext-list ext-hooks-activity__list">
            {filteredActivity.map((row) => (
              <li key={row.id} className="ext-item ext-hooks-activity__item">
                <div className="ext-item__head">
                  <span className="ext-item__name">{row.type}</span>
                  <span className={outcomeBadgeClass(row.outcome)}>
                    {outcomeLabel(row.outcome, tr)}
                  </span>
                  {row.source === "debug" ? (
                    <span className="ext-badge ext-badge--muted">
                      {tr("ext.hooks.activity.sourceDebug")}
                    </span>
                  ) : null}
                  <span className="ext-badge ext-badge--muted">
                    {formatHookActivityTime(row.atMs, locale)}
                  </span>
                  {row.source === "try" ? (
                    <span className="ext-badge ext-badge--muted">
                      {tr("ext.hooks.try.badgeTry")}
                    </span>
                  ) : null}
                </div>
                {row.detail ? (
                  <div
                    className="ext-item__meta ext-hooks-activity__detail"
                    title={row.detail}
                  >
                    {row.detail}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <GlassModal
        open={clearConfirmOpen}
        onClose={() => setClearConfirmOpen(false)}
        title={tr("ext.hooks.activity.clearConfirmTitle")}
        size="sm"
        closeLabel={tr("common.close")}
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setClearConfirmOpen(false)}
            >
              {tr("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--solid"
              onClick={confirmClearActivity}
            >
              {tr("ext.hooks.activity.clearConfirmOk")}
            </button>
          </>
        }
      >
        <p>{tr("ext.hooks.activity.clearConfirmMessage")}</p>
      </GlassModal>
    </>
  );
}
