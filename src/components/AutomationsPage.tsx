/**
 * Scheduled automations workbench — Codex-style “已安排”.
 * List + filter + AI create entry + manual form panel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as api from "@/lib/api";
import {
  computeNextRunAt,
  formatNextRunRelative,
  formatScheduleSummary,
  type Automation,
} from "@/lib/automations";
import { automationsRunnerBanner } from "@/lib/automationsRunnerPolicy";
import {
  automationsHonestyMatrix,
  automationsOneShotHelperSurface,
  deriveAutomationsRunnerSurface,
  launchAgentSoftFail,
  type LaunchAgentSoftFail,
} from "@/lib/automationsHeadlessHonesty";
import {
  AUTOMATION_RUN_HISTORY_CHANGE_EVENT,
  clearAutomationRunHistory,
  loadAutomationRunHistory,
  type AutomationRunOutcomeFilter,
  type AutomationRunRecord,
} from "@/lib/automationRunHistory";
import {
  buildAutomationsInbox,
  clearInboxSeenIds,
  countInboxByOutcome,
  filterInbox,
  loadInboxSeenIds,
  markAllInboxRead,
  markInboxItemRead,
  planOpenInboxItem,
  planRetryAutomation,
  resolveInboxEmptyState,
  type AutomationsInboxItem,
} from "@/lib/automationsInbox";
import { formatRelativeTime } from "@/lib/accountUi";
import { Select } from "@/components/Select";
import { GlassModal } from "@/components/GlassModal";
import {
  IconAutomations,
  IconClose,
  IconMore,
  IconPlus,
  IconScheduled,
  IconSearch,
} from "@/components/icons";
import { Tip } from "@/components/ui/tooltip";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL_ID,
  GROK_BUILD_EFFORTS,
  GROK_BUILD_MODELS,
  type ModelOption,
} from "@/lib/grokCatalog";
import { automationsBackgroundStatus } from "@/lib/automationsBackgroundStatus";

export type AutomationsFilter = "all" | "enabled" | "paused";

export interface AutomationsProjectOption {
  id: string;
  name: string;
}

export interface AutomationsPageProps {
  t: (key: string, vars?: Record<string, string | number>) => string;
  projects: AutomationsProjectOption[];
  defaultModelId?: string;
  defaultEffort?: string;
  /** Live selectable models; falls back to catalog. */
  models?: ModelOption[];
  onAiCreate: () => void;
  onRunNow?: (auto: Automation) => void;
  /**
   * Open a session linked from an Inbox row (when sessionId was observed).
   * Soft — App resolves live session; may toast if missing.
   */
  onOpenSession?: (sessionId: string, projectId?: string | null) => void;
  /** Focus a project when Inbox row has project but no session. */
  onOpenProject?: (projectId: string) => void;
  /** Locale for relative timestamps in Inbox (default: en). */
  locale?: string;
  /** AppSettings.launchAtLogin — honest background status banner. */
  openAtLogin?: boolean;
  /** Deep-link to Settings → general/app → Launch at login. */
  onOpenLaunchAtLogin?: () => void;
  /** AppSettings.closeToTray */
  closeToTray?: boolean;
  /** AppSettings.keepTrayForSchedules — hide to tray when schedules are on. */
  keepTrayForSchedules?: boolean;
  onKeepTrayForSchedules?: (v: boolean) => void;
  /** Deep-link to Settings → general/app → Keep tray for schedules. */
  onOpenKeepTraySetting?: () => void;
}

type FormState = {
  title: string;
  prompt: string;
  projectId: string; // "" = none
  modelId: string;
  effort: string;
  frequency: string;
  time: string;
  notify: string;
  enabled: boolean;
};

const emptyForm = (modelId: string, effort: string): FormState => ({
  title: "",
  prompt: "",
  projectId: "",
  modelId,
  effort,
  frequency: "daily",
  time: "09:00",
  notify: "all",
  enabled: true,
});

export function AutomationsPage({
  t,
  projects,
  defaultModelId = DEFAULT_MODEL_ID,
  defaultEffort = DEFAULT_EFFORT,
  models,
  onAiCreate,
  onRunNow,
  onOpenSession,
  onOpenProject,
  locale = "en",
  openAtLogin = false,
  onOpenLaunchAtLogin,
  closeToTray = true,
  keepTrayForSchedules = true,
  onKeepTrayForSchedules,
  onOpenKeepTraySetting,
}: AutomationsPageProps) {
  const [list, setList] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<AutomationsFilter>("all");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() =>
    emptyForm(defaultModelId, defaultEffort),
  );
  const [createMenu, setCreateMenu] = useState(false);
  const [rowMenuId, setRowMenuId] = useState<string | null>(null);
  /** Pending delete — never use window.confirm in Tauri WebView. */
  const [deleteTarget, setDeleteTarget] = useState<Automation | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [runnerStatus, setRunnerStatus] =
    useState<api.AutomationRunnerStatusDto | null>(null);
  const [launchAgent, setLaunchAgent] =
    useState<api.SchedulesLaunchAgentStatusDto | null>(null);
  const [launchAgentBusy, setLaunchAgentBusy] = useState(false);
  /** Soft-fail modal when LaunchAgent install/remove/reveal fails (no fake daemon). */
  const [launchAgentFail, setLaunchAgentFail] =
    useState<LaunchAgentSoftFail | null>(null);
  /** Observed schedule run history (local ring; process-bound honesty). */
  const [runHistory, setRunHistory] = useState<AutomationRunRecord[]>(() =>
    loadAutomationRunHistory(),
  );
  /** Inbox filters (outcome chips + search) over the same observed ring. */
  const [inboxOutcome, setInboxOutcome] =
    useState<AutomationRunOutcomeFilter>("all");
  const [inboxQuery, setInboxQuery] = useState("");
  const [inboxSeen, setInboxSeen] = useState<Set<string>>(() =>
    loadInboxSeenIds(),
  );
  const [clearHistoryOpen, setClearHistoryOpen] = useState(false);
  const createBtnRef = useRef<HTMLButtonElement>(null);
  const createMenuRef = useRef<HTMLDivElement>(null);
  const deleteConfirmBtnRef = useRef<HTMLButtonElement>(null);
  const [, setTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const rows = await api.automationsList();
      setList(
        rows.map((r) => ({
          ...r,
          weekdays: r.weekdays ?? [],
        })),
      );
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshRunner = useCallback(async () => {
    try {
      const [st, la] = await Promise.all([
        api.automationRunnerStatus(),
        api.schedulesLaunchAgentStatus(),
      ]);
      setRunnerStatus(st);
      setLaunchAgent(la);
    } catch {
      // Browser / missing host — keep prior snapshot.
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshRunner();
  }, [refresh, refreshRunner]);

  // Refresh runner status occasionally while page is open.
  useEffect(() => {
    const id = window.setInterval(() => void refreshRunner(), 45_000);
    return () => window.clearInterval(id);
  }, [refreshRunner]);

  // Live ring buffer updates from host fires + Run now (App records).
  useEffect(() => {
    const onChange = (ev: Event) => {
      const detail = (ev as CustomEvent<AutomationRunRecord[]>).detail;
      if (Array.isArray(detail)) {
        setRunHistory(detail);
      } else {
        setRunHistory(loadAutomationRunHistory());
      }
    };
    window.addEventListener(AUTOMATION_RUN_HISTORY_CHANGE_EVENT, onChange);
    // Soft reload on mount in case another surface wrote while we were away.
    setRunHistory(loadAutomationRunHistory());
    return () =>
      window.removeEventListener(AUTOMATION_RUN_HISTORY_CHANGE_EVENT, onChange);
  }, []);

  const enabledCount = useMemo(
    () => list.filter((a) => a.enabled).length,
    [list],
  );

  const inboxItems = useMemo(
    () =>
      buildAutomationsInbox(runHistory, {
        seenIds: inboxSeen,
        tasks: list.map((a) => ({
          id: a.id,
          projectId: a.projectId,
          title: a.title,
        })),
      }),
    [runHistory, inboxSeen, list],
  );

  const filteredInbox = useMemo(
    () =>
      filterInbox(inboxItems, {
        outcome: inboxOutcome,
        query: inboxQuery,
      }),
    [inboxItems, inboxOutcome, inboxQuery],
  );

  const inboxCounts = useMemo(
    () => countInboxByOutcome(inboxItems),
    [inboxItems],
  );

  const inboxEmpty = useMemo(
    () =>
      resolveInboxEmptyState({
        totalCount: inboxItems.length,
        filteredCount: filteredInbox.length,
        outcomeFilter: inboxOutcome,
        query: inboxQuery,
      }),
    [inboxItems.length, filteredInbox.length, inboxOutcome, inboxQuery],
  );

  const unreadCount = useMemo(
    () => inboxItems.filter((i) => i.unread).length,
    [inboxItems],
  );

  const confirmClearHistory = () => {
    setRunHistory(clearAutomationRunHistory());
    setInboxSeen(clearInboxSeenIds());
    setClearHistoryOpen(false);
  };

  const onMarkInboxRead = useCallback((item: AutomationsInboxItem) => {
    setInboxSeen(markInboxItemRead(item.id));
  }, []);

  const onMarkAllInboxRead = useCallback(() => {
    setInboxSeen(markAllInboxRead(inboxItems.map((i) => i.id)));
  }, [inboxItems]);

  const onOpenInboxItem = useCallback(
    (item: AutomationsInboxItem) => {
      const plan = planOpenInboxItem(item);
      if (plan.kind === "session") {
        onOpenSession?.(plan.sessionId, plan.projectId ?? item.projectId);
        onMarkInboxRead(item);
        return;
      }
      if (plan.kind === "project") {
        onOpenProject?.(plan.projectId);
        onMarkInboxRead(item);
      }
    },
    [onOpenSession, onOpenProject, onMarkInboxRead],
  );

  const onRetryInboxItem = useCallback(
    (item: AutomationsInboxItem) => {
      const plan = planRetryAutomation(item);
      if (!plan.canRetry || !onRunNow) return;
      const auto = list.find((a) => a.id === plan.taskId);
      if (!auto) return;
      onMarkInboxRead(item);
      onRunNow(auto);
    },
    [list, onRunNow, onMarkInboxRead],
  );

  const banner = useMemo(
    () =>
      automationsRunnerBanner({
        enabledCount,
        keepTrayForSchedules,
        closeToTray,
        launchAgentSupported: !!launchAgent?.supported,
        launchAgentEnabled: !!launchAgent?.enabled,
        runnerKnown: api.isTauri(),
      }),
    [
      enabledCount,
      keepTrayForSchedules,
      closeToTray,
      launchAgent?.supported,
      launchAgent?.enabled,
    ],
  );

  /** Host runner status surface: last tick + honest pause reason. */
  const runnerSurface = useMemo(
    () =>
      deriveAutomationsRunnerSurface({
        runnerKnown: api.isTauri(),
        running: !!runnerStatus?.running,
        lastTickAt: runnerStatus?.lastTickAt ?? null,
        tickIntervalSecs: runnerStatus?.tickIntervalSecs ?? 30,
        enabledCount,
        closeToTray,
        keepTrayForSchedules,
        launchAgentEnabled: !!launchAgent?.enabled,
      }),
    [
      runnerStatus?.running,
      runnerStatus?.lastTickAt,
      runnerStatus?.tickIntervalSecs,
      enabledCount,
      closeToTray,
      keepTrayForSchedules,
      launchAgent?.enabled,
    ],
  );

  const honestyRows = useMemo(
    () =>
      automationsHonestyMatrix({
        // Always show LaunchAgent row on macOS status; on other platforms hide
        // unless we already know support (desktop macOS = true from host).
        launchAgentSupported:
          launchAgent == null ? true : !!launchAgent.supported,
        // One-shot helper is always available on desktop hosts (flag + script).
        includeOneShot: true,
      }),
    [launchAgent],
  );

  const oneShotSurface = useMemo(() => automationsOneShotHelperSurface(), []);

  const onToggleLaunchAgent = async (next: boolean) => {
    setLaunchAgentBusy(true);
    try {
      const st = await api.schedulesLaunchAgentSetEnabled(next);
      setLaunchAgent(st);
    } catch (e) {
      // Soft-fail: do not flip toggle; GlassModal explains limits.
      setLaunchAgentFail(launchAgentSoftFail(e, next ? "enable" : "disable"));
      try {
        const st = await api.schedulesLaunchAgentStatus();
        setLaunchAgent(st);
      } catch {
        /* keep prior */
      }
    } finally {
      setLaunchAgentBusy(false);
    }
  };

  const onRevealLaunchAgent = async () => {
    try {
      await api.schedulesLaunchAgentRevealHelper();
    } catch (e) {
      setLaunchAgentFail(launchAgentSoftFail(e, "reveal"));
    }
  };

  // Refresh relative "next run" labels once a minute.
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!createMenu) return;
    const onDoc = (e: MouseEvent) => {
      const el = e.target as Node;
      if (
        createMenuRef.current?.contains(el) ||
        createBtnRef.current?.contains(el)
      ) {
        return;
      }
      setCreateMenu(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [createMenu]);

  useEffect(() => {
    if (!rowMenuId) return;
    // Close on outside mousedown, but ignore presses inside the open menu
    // (otherwise menu unmounts before click fires → items do nothing).
    const onDoc = (e: MouseEvent) => {
      const el = e.target as Element | null;
      if (el?.closest?.(`[data-auto-row-menu="${rowMenuId}"]`)) return;
      // Keep open when pressing the same row's ⋯ trigger (toggle handled there).
      if (el?.closest?.(`[data-auto-row-trigger="${rowMenuId}"]`)) return;
      setRowMenuId(null);
    };
    const timer = window.setTimeout(
      () => document.addEventListener("mousedown", onDoc),
      0,
    );
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [rowMenuId]);

  const filtered = useMemo(() => {
    let rows = list;
    if (filter === "enabled") rows = rows.filter((a) => a.enabled);
    if (filter === "paused") rows = rows.filter((a) => !a.enabled);
    const q = query.trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (a) =>
          a.title.toLowerCase().includes(q) ||
          a.prompt.toLowerCase().includes(q),
      );
    }
    return rows;
  }, [list, filter, query]);

  /** Honest quit / background status — no fake detached daemon. */
  const bgStatus = useMemo(
    () =>
      automationsBackgroundStatus({
        openAtLogin,
        enabledCount,
        // Desktop host owns automation_runner; browser dev falls back to unknown.
        runnerKnown: api.isTauri(),
      }),
    [openAtLogin, enabledCount],
  );

  const openCreateManual = () => {
    setCreateMenu(false);
    setEditingId(null);
    setForm(emptyForm(defaultModelId, defaultEffort));
    setPanelOpen(true);
  };

  const openEdit = (auto: Automation) => {
    setRowMenuId(null);
    setEditingId(auto.id);
    setForm({
      title: auto.title,
      prompt: auto.prompt,
      projectId: auto.projectId ?? "",
      modelId: auto.modelId || defaultModelId,
      effort: auto.effort || defaultEffort,
      frequency: auto.frequency || "daily",
      time: auto.time || "09:00",
      notify: auto.notify || "all",
      enabled: auto.enabled,
    });
    setPanelOpen(true);
  };

  const closePanel = () => {
    setPanelOpen(false);
    setEditingId(null);
  };

  const saveForm = async () => {
    const title = form.title.trim();
    const prompt = form.prompt.trim();
    if (!title) {
      setError(t("automations.errTitle"));
      return;
    }
    if (!prompt) {
      setError(t("automations.errPrompt"));
      return;
    }
    const nextRunAt = computeNextRunAt({
      frequency: form.frequency,
      time: form.time,
      weekdays: [],
      enabled: form.enabled,
    });
    const input: api.AutomationInputDto = {
      title,
      prompt,
      enabled: form.enabled,
      projectId: form.projectId || null,
      modelId: form.modelId || null,
      effort: form.effort || null,
      frequency: form.frequency,
      time: form.time,
      weekdays: [],
      notify: form.notify,
      nextRunAt,
    };
    try {
      if (editingId) {
        await api.automationUpdate(editingId, input);
      } else {
        await api.automationCreate(input);
      }
      closePanel();
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const toggleEnabled = async (auto: Automation) => {
    setRowMenuId(null);
    try {
      const next = await api.automationSetEnabled(auto.id, !auto.enabled);
      if (next.enabled && !next.nextRunAt) {
        const nr = computeNextRunAt(next as Automation);
        if (nr) {
          await api.automationUpdate(auto.id, {
            title: next.title,
            prompt: next.prompt,
            enabled: true,
            projectId: next.projectId,
            modelId: next.modelId,
            effort: next.effort,
            frequency: next.frequency,
            time: next.time,
            weekdays: next.weekdays,
            notify: next.notify,
            nextRunAt: nr,
          });
        }
      }
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const requestRemove = (auto: Automation) => {
    setRowMenuId(null);
    setDeleteTarget(auto);
  };

  const confirmRemove = async () => {
    const auto = deleteTarget;
    if (!auto || deleting) return;
    setDeleting(true);
    try {
      await api.automationDelete(auto.id);
      setDeleteTarget(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setDeleting(false);
    }
  };

  useEffect(() => {
    if (!deleteTarget) return;
    const t = window.setTimeout(() => deleteConfirmBtnRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [deleteTarget]);

  const scheduleLabels = {
    daily: t("automations.freq.daily"),
    weekly: t("automations.freq.weekly"),
    weekdays: t("automations.freq.weekdays"),
    once: t("automations.freq.once"),
    at: t("automations.at"),
  };

  const relativeLabels = {
    overdue: t("automations.next.overdue"),
    inHours: t("automations.next.inHours"),
    inDays: t("automations.next.inDays"),
    inMinutes: t("automations.next.inMinutes"),
    unknown: t("automations.next.unknown"),
  };

  const projectOptions = useMemo(
    () => [
      { value: "", label: t("automations.projectNone") },
      ...projects.map((p) => ({ value: p.id, label: p.name })),
    ],
    [projects, t],
  );

  const modelOptions = (models?.length ? models : GROK_BUILD_MODELS).map((m) => ({
    value: m.id,
    label: m.label,
  }));

  const effortOptions = GROK_BUILD_EFFORTS.map((e) => ({
    value: e.id,
    label: t(`effort.${e.id}` as "effort.high"),
  }));

  const freqOptions = [
    { value: "daily", label: t("automations.freq.daily") },
    { value: "weekdays", label: t("automations.freq.weekdays") },
    { value: "weekly", label: t("automations.freq.weekly") },
    { value: "once", label: t("automations.freq.once") },
  ];

  const timeOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 30]) {
        const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
        opts.push({ value, label: value });
      }
    }
    // Ensure current form time is present even if not on 30-min grid.
    if (form.time && !opts.some((o) => o.value === form.time)) {
      opts.unshift({ value: form.time, label: form.time });
    }
    return opts;
  }, [form.time]);

  const notifyOptions = [
    { value: "all", label: t("automations.notify.all") },
    { value: "failures", label: t("automations.notify.failures") },
    { value: "none", label: t("automations.notify.none") },
  ];

  return (
    <div className="auto-page">
      <div className="auto-page__head">
        <div className="auto-page__titles">
          <h1 className="auto-page__title">{t("automations.title")}</h1>
          <p className="auto-page__subtitle">{t("automations.subtitle")}</p>
          {bgStatus.severity === "none" ? (
            <p className="auto-page__subtitle auto-page__subtitle--hint">
              {t("automations.trayHint")}
            </p>
          ) : null}
        </div>
        <div className="auto-page__create-wrap">
          <button
            ref={createBtnRef}
            type="button"
            className="auto-page__create"
            onClick={() => setCreateMenu((v) => !v)}
          >
            {t("automations.create")}
            <span className="auto-page__create-caret" aria-hidden>
              ▾
            </span>
          </button>
          {createMenu && (
            <div
              ref={createMenuRef}
              className="menu-panel auto-page__create-menu"
              role="menu"
            >
              <button
                type="button"
                className="auto-page__create-item"
                role="menuitem"
                onClick={() => {
                  setCreateMenu(false);
                  onAiCreate();
                }}
              >
                <IconAutomations size={16} />
                <span>
                  <strong>{t("automations.createAi")}</strong>
                  <em>{t("automations.createAiHint")}</em>
                </span>
              </button>
              <button
                type="button"
                className="auto-page__create-item"
                role="menuitem"
                onClick={openCreateManual}
              >
                <IconPlus size={16} />
                <span>
                  <strong>{t("automations.createManual")}</strong>
                  <em>{t("automations.createManualHint")}</em>
                </span>
              </button>
            </div>
          )}
        </div>
      </div>

      {bgStatus.severity !== "none" && bgStatus.messageKey ? (
        <div
          className={
            "auto-page__bg-banner" +
            (bgStatus.severity === "warn"
              ? " auto-page__bg-banner--warn"
              : " auto-page__bg-banner--info")
          }
          role="status"
        >
          <p className="auto-page__bg-banner-text">
            {t(bgStatus.messageKey, { n: bgStatus.enabledCount })}
          </p>
          {bgStatus.showOpenAtLoginLink && onOpenLaunchAtLogin ? (
            <button
              type="button"
              className="auto-page__bg-banner-link"
              onClick={onOpenLaunchAtLogin}
            >
              {t("automations.bg.openAtLoginLink")}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="auto-page__bg-panel" role="region" aria-label={t("automations.runner.section")}>
        {banner.messageKey ? (
          <div
            className={
              "auto-page__bg-banner" +
              (banner.severity === "warn"
                ? " auto-page__bg-banner--warn"
                : " auto-page__bg-banner--info")
            }
            role="status"
          >
            <p className="auto-page__bg-banner-text">
              {t(banner.messageKey, { n: enabledCount })}
            </p>
            {onOpenKeepTraySetting ? (
              <button
                type="button"
                className="auto-page__bg-banner-link"
                onClick={onOpenKeepTraySetting}
              >
                {t("automations.runner.openSettings")}
              </button>
            ) : null}
          </div>
        ) : null}

        {/* AUTO-HEADLESS-LITE: tray vs quit vs LaunchAgent product truth */}
        <div
          className="auto-page__honesty"
          role="group"
          aria-label={t("automations.honesty.legend")}
        >
          <div className="auto-page__honesty-title">
            {t("automations.honesty.legend")}
          </div>
          <ul className="auto-page__honesty-list">
            {honestyRows.map((row) => (
              <li key={row.id} className="auto-page__honesty-item">
                <strong className="auto-page__honesty-item-title">
                  {t(row.titleKey)}
                </strong>
                <span className="auto-page__honesty-item-body">
                  {t(row.bodyKey)}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="auto-page__bg-rows">
          <div className="auto-page__bg-row">
            <div className="auto-page__bg-row-text">
              <div className="auto-page__bg-row-label">
                {t("automations.runner.statusLabel")}
              </div>
              <div className="auto-page__bg-row-desc">
                {runnerSurface.phase === "running"
                  ? t("automations.runner.statusRunning", {
                      secs: runnerSurface.tickIntervalSecs,
                    })
                  : runnerSurface.phase === "unknown"
                    ? t("automations.runner.statusIdle")
                    : t("automations.runner.statusIdle")}
                {runnerSurface.lastTickAt
                  ? ` · ${t("automations.runner.lastTick", {
                      time: new Date(
                        runnerSurface.lastTickAt,
                      ).toLocaleTimeString(),
                    })}`
                  : ""}
              </div>
              {runnerSurface.severity !== "none" ||
              runnerSurface.pausedReason === "no_enabled" ? (
                <div
                  className={
                    "auto-page__runner-reason" +
                    (runnerSurface.severity === "warn"
                      ? " auto-page__runner-reason--warn"
                      : runnerSurface.severity === "info"
                        ? " auto-page__runner-reason--info"
                        : "")
                  }
                  role="status"
                >
                  {t(runnerSurface.pausedReasonKey)}
                </div>
              ) : null}
            </div>
          </div>

          {banner.showKeepTrayToggle && onKeepTrayForSchedules ? (
            <div className="auto-page__bg-row">
              <div className="auto-page__bg-row-text">
                <div className="auto-page__bg-row-label">
                  {t("settings.keepTrayForSchedules")}
                </div>
                <div className="auto-page__bg-row-desc">
                  {t("settings.keepTrayForSchedulesDesc")}
                </div>
              </div>
              <label className="auto-page__switch">
                <input
                  type="checkbox"
                  checked={!!keepTrayForSchedules}
                  onChange={() =>
                    onKeepTrayForSchedules(!keepTrayForSchedules)
                  }
                  aria-label={t("settings.keepTrayForSchedules")}
                />
                <span className="auto-page__switch-ui" aria-hidden />
              </label>
            </div>
          ) : null}

          {banner.showLaunchAgent && launchAgent?.supported ? (
            <div className="auto-page__bg-row">
              <div className="auto-page__bg-row-text">
                <div className="auto-page__bg-row-label">
                  {t("automations.launchAgent.title")}
                </div>
                <div className="auto-page__bg-row-desc">
                  {t("automations.launchAgent.desc")}
                </div>
                <div className="auto-page__bg-row-actions">
                  <button
                    type="button"
                    className="auto-page__bg-banner-link"
                    onClick={() => void onRevealLaunchAgent()}
                  >
                    {t("automations.launchAgent.reveal")}
                  </button>
                </div>
              </div>
              <label className="auto-page__switch">
                <input
                  type="checkbox"
                  checked={!!launchAgent.enabled}
                  disabled={launchAgentBusy}
                  onChange={() =>
                    void onToggleLaunchAgent(!launchAgent.enabled)
                  }
                  aria-label={t("automations.launchAgent.title")}
                />
                <span className="auto-page__switch-ui" aria-hidden />
              </label>
            </div>
          ) : null}

          {/* AUTO-HEADLESS A2: one-shot helper vs tray residency (not KeepAlive daemon) */}
          <div className="auto-page__bg-row">
            <div className="auto-page__bg-row-text">
              <div className="auto-page__bg-row-label">
                {t(oneShotSurface.titleKey)}
              </div>
              <div className="auto-page__bg-row-desc">
                {t(oneShotSurface.bodyKey, {
                  flag: oneShotSurface.flagHint,
                  script: oneShotSurface.scriptName,
                })}
              </div>
              <div className="auto-page__bg-row-desc auto-page__bg-row-desc--muted">
                {t(oneShotSurface.honestyKey)}
              </div>
              <div className="auto-page__bg-row-actions">
                <button
                  type="button"
                  className="auto-page__bg-banner-link"
                  onClick={() => void onRevealLaunchAgent()}
                >
                  {t("automations.oneshot.reveal")}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Inbox: observed fires only — empty is soft-fail, never invents offline runs */}
      <div
        className="auto-page__history auto-page__inbox"
        role="region"
        aria-label={t("automations.inbox.section")}
      >
        <div className="auto-page__history-head">
          <div className="auto-page__history-titles">
            <div className="auto-page__history-title">
              {t("automations.inbox.section")}
              {unreadCount > 0 ? (
                <span className="auto-page__inbox-unread" aria-label={t("automations.inbox.unreadCount", { n: unreadCount })}>
                  {unreadCount}
                </span>
              ) : null}
            </div>
            <p className="auto-page__history-desc">
              {t("automations.inbox.desc")}
            </p>
          </div>
          <div className="auto-page__inbox-head-actions">
            {unreadCount > 0 ? (
              <button
                type="button"
                className="auto-page__bg-banner-link"
                onClick={onMarkAllInboxRead}
              >
                {t("automations.inbox.markAllRead")}
              </button>
            ) : null}
            {runHistory.length > 0 ? (
              <button
                type="button"
                className="auto-page__bg-banner-link"
                onClick={() => setClearHistoryOpen(true)}
              >
                {t("automations.inbox.clear")}
              </button>
            ) : null}
          </div>
        </div>

        <div
          className="auto-page__inbox-banner"
          role="note"
        >
          {t("automations.inbox.processBound")}
        </div>

        <div className="auto-page__inbox-toolbar">
          <div className="auto-page__search auto-page__inbox-search">
            <IconSearch size={14} />
            <input
              type="search"
              value={inboxQuery}
              onChange={(e) => setInboxQuery(e.target.value)}
              placeholder={t("automations.inbox.search")}
              aria-label={t("automations.inbox.search")}
            />
          </div>
          <div
            className="auto-page__history-filters"
            role="tablist"
            aria-label={t("automations.inbox.filterAria")}
          >
            {(
              [
                ["all", "automations.history.filter.all"],
                ["ok", "automations.history.filter.ok"],
                ["error", "automations.history.filter.error"],
                ["skipped", "automations.history.filter.skipped"],
              ] as const
            ).map(([id, key]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={inboxOutcome === id}
                className={
                  "auto-page__filter" +
                  (inboxOutcome === id ? " is-active" : "")
                }
                onClick={() => setInboxOutcome(id)}
              >
                {t(key)}
                <span className="auto-page__history-count" aria-hidden>
                  {inboxCounts[id]}
                </span>
              </button>
            ))}
          </div>
        </div>

        {inboxEmpty ? (
          <div className="auto-page__history-empty" role="status">
            {inboxEmpty === "filter"
              ? t("automations.inbox.emptyFiltered")
              : inboxEmpty === "process_bound_hint"
                ? t("automations.inbox.emptyProcessBound")
                : t("automations.inbox.empty")}
          </div>
        ) : (
          <ul className="auto-page__history-list auto-page__inbox-list">
            {filteredInbox.map((row) => {
              const when = formatRelativeTime(row.at, locale);
              const outcomeKey =
                row.outcome === "ok"
                  ? "automations.history.outcome.ok"
                  : row.outcome === "error"
                    ? "automations.history.outcome.error"
                    : "automations.history.outcome.skipped";
              const sourceKey =
                row.source === "host"
                  ? "automations.history.source.host"
                  : row.source === "run_now"
                    ? "automations.history.source.runNow"
                    : "automations.history.source.unknown";
              const openPlan = planOpenInboxItem(row);
              const retryPlan = planRetryAutomation(row);
              return (
                <li
                  key={row.id}
                  className={
                    "auto-page__history-row auto-page__inbox-row" +
                    (row.outcome === "error"
                      ? " auto-page__history-row--error"
                      : row.outcome === "skipped"
                        ? " auto-page__history-row--skipped"
                        : "") +
                    (row.unread ? " auto-page__inbox-row--unread" : "")
                  }
                >
                  <span
                    className={
                      "auto-page__history-outcome" +
                      ` auto-page__history-outcome--${row.outcome}`
                    }
                  >
                    {t(outcomeKey)}
                  </span>
                  <div className="auto-page__history-main">
                    <span className="auto-page__history-name">
                      {row.unread ? (
                        <span
                          className="auto-page__inbox-dot"
                          aria-hidden
                        />
                      ) : null}
                      {row.title}
                    </span>
                    <span className="auto-page__history-meta">
                      <time dateTime={row.at} title={row.at}>
                        {when}
                      </time>
                      {" · "}
                      {t(sourceKey)}
                    </span>
                    {row.outcome === "error" && row.error ? (
                      <span
                        className="auto-page__history-error"
                        title={row.error}
                      >
                        {row.error}
                      </span>
                    ) : null}
                    <div className="auto-page__inbox-actions">
                      {openPlan.kind !== "none" &&
                      (onOpenSession || onOpenProject) ? (
                        <button
                          type="button"
                          className="auto-page__inbox-action"
                          onClick={() => onOpenInboxItem(row)}
                        >
                          {openPlan.kind === "session"
                            ? t("automations.inbox.openSession")
                            : t("automations.inbox.openProject")}
                        </button>
                      ) : null}
                      {retryPlan.canRetry && onRunNow ? (
                        <button
                          type="button"
                          className="auto-page__inbox-action"
                          onClick={() => onRetryInboxItem(row)}
                        >
                          {t("automations.inbox.runNow")}
                        </button>
                      ) : null}
                      {row.unread ? (
                        <button
                          type="button"
                          className="auto-page__inbox-action"
                          onClick={() => onMarkInboxRead(row)}
                        >
                          {t("automations.inbox.markRead")}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="auto-page__toolbar">
        <div className="auto-page__search">
          <IconSearch size={15} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("automations.search")}
            aria-label={t("automations.search")}
          />
        </div>
        <div className="auto-page__filters" role="tablist">
          {(
            [
              ["all", "automations.filter.all"],
              ["enabled", "automations.filter.enabled"],
              ["paused", "automations.filter.paused"],
            ] as const
          ).map(([id, key]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={filter === id}
              className={
                "auto-page__filter" + (filter === id ? " is-active" : "")
              }
              onClick={() => setFilter(id)}
            >
              {t(key)}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="auto-page__error" role="alert">
          {error}
          <button type="button" onClick={() => setError(null)}>
            <IconClose size={14} />
          </button>
        </div>
      )}

      <div className="auto-page__body">
        {loading ? (
          <div className="auto-page__empty">{t("automations.loading")}</div>
        ) : filtered.length === 0 ? (
          <div className="auto-page__empty">
            <IconScheduled size={28} />
            <strong>{t("automations.emptyTitle")}</strong>
            <span>{t("automations.emptyHint")}</span>
            <div className="auto-page__empty-actions">
              <button
                type="button"
                className="btn btn--solid"
                onClick={onAiCreate}
              >
                {t("automations.createAi")}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={openCreateManual}
              >
                {t("automations.createManual")}
              </button>
            </div>
          </div>
        ) : (
          <ul className="auto-list">
            {filtered.map((auto) => {
              const next =
                auto.nextRunAt ||
                (auto.enabled ? computeNextRunAt(auto) : null);
              const projectName = auto.projectId
                ? projects.find((p) => p.id === auto.projectId)?.name
                : null;
              return (
                <li
                  key={auto.id}
                  className={
                    "auto-row" +
                    (!auto.enabled ? " auto-row--paused" : "") +
                    (rowMenuId === auto.id ? " auto-row--menu-open" : "")
                  }
                >
                  <span
                    className={
                      "auto-row__dot" +
                      (auto.enabled ? " is-on" : " is-off")
                    }
                    aria-hidden
                  />
                  <button
                    type="button"
                    className="auto-row__main"
                    onClick={() => openEdit(auto)}
                  >
                    <span className="auto-row__title">{auto.title}</span>
                    <span className="auto-row__meta">
                      {formatScheduleSummary(auto, scheduleLabels)}
                      {" · "}
                      {auto.enabled
                        ? formatNextRunRelative(next, new Date(), relativeLabels)
                        : t("automations.filter.paused")}
                      {projectName ? ` · ${projectName}` : ""}
                    </span>
                  </button>
                  <div className="auto-row__actions">
                    <Tip label={t("automations.menu")}>
                      <button
                        type="button"
                        className="tree-icon-btn"
                        data-auto-row-trigger={auto.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          setRowMenuId((id) =>
                            id === auto.id ? null : auto.id,
                          );
                        }}
                      >
                        <IconMore size={15} />
                      </button>
                    </Tip>
                    {rowMenuId === auto.id && (
                      <div
                        className="menu-panel auto-row__menu"
                        role="menu"
                        data-auto-row-menu={auto.id}
                        onMouseDown={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => openEdit(auto)}
                        >
                          {t("automations.edit")}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setRowMenuId(null);
                            void toggleEnabled(auto);
                          }}
                        >
                          {auto.enabled
                            ? t("automations.pause")
                            : t("automations.resume")}
                        </button>
                        {onRunNow && (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setRowMenuId(null);
                              onRunNow(auto);
                            }}
                          >
                            {t("automations.runNow")}
                          </button>
                        )}
                        <button
                          type="button"
                          role="menuitem"
                          className="is-danger"
                          onClick={() => requestRemove(auto)}
                        >
                          {t("automations.delete")}
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <GlassModal
        open={!!launchAgentFail}
        onClose={() => setLaunchAgentFail(null)}
        title={
          launchAgentFail
            ? t(launchAgentFail.titleKey)
            : t("automations.launchAgent.failTitle")
        }
        size="sm"
        closeLabel={t("common.close")}
        footer={
          <button
            type="button"
            className="btn btn--solid"
            onClick={() => setLaunchAgentFail(null)}
          >
            {t("common.close")}
          </button>
        }
      >
        {launchAgentFail ? (
          <>
            <p className="app-dialog__msg">{t(launchAgentFail.bodyKey)}</p>
            <p className="app-dialog__msg app-dialog__msg--muted">
              {t(launchAgentFail.honestyKey)}
            </p>
            {launchAgentFail.detail ? (
              <pre className="auto-page__fail-detail" tabIndex={0}>
                {launchAgentFail.detail}
              </pre>
            ) : null}
          </>
        ) : null}
      </GlassModal>

      <GlassModal
        open={clearHistoryOpen}
        onClose={() => setClearHistoryOpen(false)}
        title={t("automations.inbox.clearTitle")}
        size="sm"
        closeLabel={t("common.close")}
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setClearHistoryOpen(false)}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={confirmClearHistory}
            >
              {t("automations.inbox.clearConfirm")}
            </button>
          </>
        }
      >
        <p className="app-dialog__msg">{t("automations.inbox.clearBody")}</p>
        <p className="app-dialog__msg app-dialog__msg--muted">
          {t("automations.inbox.processBound")}
        </p>
      </GlassModal>

      {deleteTarget &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="overlay app-dialog-overlay"
            role="presentation"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget && !deleting) {
                setDeleteTarget(null);
              }
            }}
          >
            <div
              className="modal app-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="auto-delete-title"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <header className="modal-head">
                <h2 id="auto-delete-title" className="modal-title">
                  {t("automations.delete")}
                </h2>
                <button
                  type="button"
                  className="icon-btn modal-close"
                  disabled={deleting}
                  onClick={() => setDeleteTarget(null)}
                  aria-label={t("common.close")}
                >
                  <IconClose size={16} />
                </button>
              </header>
              <form
                className="app-dialog__form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void confirmRemove();
                }}
              >
                <p className="app-dialog__msg">
                  {t("automations.deleteConfirm", {
                    title: deleteTarget.title,
                  })}
                </p>
                <div className="app-dialog__actions modal-actions">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={deleting}
                    onClick={() => setDeleteTarget(null)}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    ref={deleteConfirmBtnRef}
                    type="submit"
                    className="btn btn--danger"
                    disabled={deleting}
                  >
                    {t("automations.delete")}
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )}

      {panelOpen && (
        <aside className="auto-panel" aria-label={t("automations.formTitle")}>
          <div className="auto-panel__head">
            <h2>
              {editingId
                ? t("automations.editTitle")
                : t("automations.formTitle")}
            </h2>
            <Tip label={t("common.close")}>
              <button
                type="button"
                className="chrome-btn"
                onClick={closePanel}
              >
                <IconClose size={16} />
              </button>
            </Tip>
          </div>
          <div className="auto-panel__body">
            <label className="auto-field">
              <span>{t("automations.field.title")}</span>
              <input
                type="text"
                value={form.title}
                onChange={(e) =>
                  setForm((f) => ({ ...f, title: e.target.value }))
                }
                placeholder={t("automations.field.titlePh")}
              />
            </label>
            <label className="auto-field">
              <span>{t("automations.field.prompt")}</span>
              <textarea
                rows={5}
                value={form.prompt}
                onChange={(e) =>
                  setForm((f) => ({ ...f, prompt: e.target.value }))
                }
                placeholder={t("automations.field.promptPh")}
              />
            </label>

            <div className="auto-panel__section">
              <div className="auto-panel__section-label">
                {t("automations.section.details")}
              </div>
              <div className="auto-field auto-field--row">
                <span>{t("automations.field.project")}</span>
                <Select
                  value={form.projectId}
                  options={projectOptions}
                  onChange={(v) => setForm((f) => ({ ...f, projectId: v }))}
                  aria-label={t("automations.field.project")}
                />
              </div>
              <div className="auto-field auto-field--row">
                <span>{t("automations.field.model")}</span>
                <Select
                  value={form.modelId}
                  options={modelOptions}
                  onChange={(v) => setForm((f) => ({ ...f, modelId: v }))}
                  aria-label={t("automations.field.model")}
                />
              </div>
              <div className="auto-field auto-field--row">
                <span>{t("automations.field.effort")}</span>
                <Select
                  value={form.effort}
                  options={effortOptions}
                  onChange={(v) => setForm((f) => ({ ...f, effort: v }))}
                  aria-label={t("automations.field.effort")}
                />
              </div>
            </div>

            <div className="auto-panel__section">
              <div className="auto-panel__section-label">
                {t("automations.section.schedule")}
              </div>
              <div className="auto-field auto-field--row">
                <span>{t("automations.field.frequency")}</span>
                <Select
                  value={form.frequency}
                  options={freqOptions}
                  onChange={(v) => setForm((f) => ({ ...f, frequency: v }))}
                  aria-label={t("automations.field.frequency")}
                />
              </div>
              <div className="auto-field auto-field--row">
                <span>{t("automations.field.time")}</span>
                <Select
                  value={form.time}
                  options={timeOptions}
                  onChange={(v) => setForm((f) => ({ ...f, time: v }))}
                  aria-label={t("automations.field.time")}
                />
              </div>
              <div className="auto-field auto-field--row">
                <span>{t("automations.field.notify")}</span>
                <Select
                  value={form.notify}
                  options={notifyOptions}
                  onChange={(v) => setForm((f) => ({ ...f, notify: v }))}
                  aria-label={t("automations.field.notify")}
                />
              </div>
            </div>
          </div>
          <div className="auto-panel__foot">
            <button type="button" className="btn btn--ghost" onClick={closePanel}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--solid"
              onClick={() => void saveForm()}
            >
              {editingId ? t("automations.save") : t("automations.create")}
            </button>
          </div>
        </aside>
      )}
    </div>
  );
}
