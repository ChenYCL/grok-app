/**
 * Cross-session Agent Dashboard — status of active/recent App sessions.
 * Distinct from AgentTasksPanel (per-turn tools for the focused chat).
 */

import { useEffect, useMemo, useState } from "react";
import type { Locale, MessageKey } from "@/i18n";
import { createT } from "@/i18n";
import { GlassModal } from "@/components/GlassModal";
import { xEvidenceStats, type XEvidenceStats } from "@/lib/api";
import {
  AGENT_DASHBOARD_STATUS_FILTERS,
  countBusyDashboardRows,
  countDashboardRowsByStatus,
  filterAgentDashboardRows,
  filterStoppableAmongSelection,
  stoppableDashboardRows,
  stoppableSelectedSessionIds,
  type AgentDashboardRow,
  type AgentDashboardStatus,
  type AgentDashboardStatusFilter,
} from "@/lib/agentDashboard";
import { formatRelativeTime } from "@/lib/accountUi";
import { pruneSelectedIds, toggleIdInSet } from "@/lib/sessionSelect";

type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

function statusLabel(status: AgentDashboardStatus, t: TFn): string {
  switch (status) {
    case "busy":
      return t("dashboard.status.busy");
    case "permission":
      return t("dashboard.status.permission");
    case "connecting":
      return t("dashboard.status.connecting");
    case "error":
      return t("dashboard.status.error");
    default:
      return t("dashboard.status.idle");
  }
}

function statusFilterLabel(
  filter: AgentDashboardStatusFilter,
  t: TFn,
): string {
  if (filter === "all") return t("dashboard.filter.all");
  return statusLabel(filter, t);
}

function statusDotClass(status: AgentDashboardStatus): string {
  switch (status) {
    case "busy":
    case "connecting":
      return "agent-dash__dot--busy";
    case "permission":
      return "agent-dash__dot--perm";
    case "error":
      return "agent-dash__dot--error";
    default:
      return "agent-dash__dot--idle";
  }
}

function statusBadgeClass(status: AgentDashboardStatus): string {
  switch (status) {
    case "busy":
      return "agent-dash__status-badge--busy";
    case "permission":
      return "agent-dash__status-badge--perm";
    case "connecting":
      return "agent-dash__status-badge--connecting";
    case "error":
      return "agent-dash__status-badge--error";
    default:
      return "agent-dash__status-badge--idle";
  }
}

function DashboardRow({
  row,
  t,
  locale,
  selected,
  onToggleSelect,
  onSelect,
}: {
  row: AgentDashboardRow;
  t: TFn;
  locale: Locale;
  selected: boolean;
  onToggleSelect: (sessionId: string) => void;
  onSelect?: (sessionId: string) => void;
}) {
  const metaParts: string[] = [];
  if (row.projectName) metaParts.push(row.projectName);
  else if (row.projectPath) metaParts.push(row.projectPath);
  if (row.modelId) metaParts.push(row.modelId);
  if (row.effort) metaParts.push(row.effort);

  const activity =
    row.lastActivityAt > 0
      ? formatRelativeTime(new Date(row.lastActivityAt).toISOString(), locale)
      : null;

  const cwd = row.projectPath || null;
  const toolTitle = row.liveToolTitle?.trim() || null;

  return (
    <li
      className={
        "agent-dash__row" +
        (row.isCurrent ? " is-current" : "") +
        (row.stoppable ? " is-busy" : "") +
        (selected ? " is-selected" : "") +
        (row.status === "permission" ? " is-permission" : "")
      }
    >
      <div className="agent-dash__row-inner">
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          className={
            "agent-dash__check" + (selected ? " is-on" : "")
          }
          aria-label={
            selected
              ? t("dashboard.deselectRow", { title: row.title })
              : t("dashboard.selectRow", { title: row.title })
          }
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect(row.sessionId);
          }}
        >
          <span className="agent-dash__check-box" aria-hidden>
            {selected ? "✓" : ""}
          </span>
        </button>
        <button
          type="button"
          className="agent-dash__row-main"
          onClick={() => onSelect?.(row.sessionId)}
          title={t("dashboard.openSession")}
        >
          <span
            className={`agent-dash__dot ${statusDotClass(row.status)}`}
            aria-hidden
          />
          <span className="agent-dash__body">
            <span className="agent-dash__title-line">
              <span className="agent-dash__title" title={row.title}>
                {row.title}
              </span>
              {row.isCurrent ? (
                <span className="agent-dash__current">
                  {t("dashboard.current")}
                </span>
              ) : null}
              <span
                className={
                  "agent-dash__status-badge " + statusBadgeClass(row.status)
                }
              >
                {statusLabel(row.status, t)}
              </span>
            </span>
            {toolTitle ? (
              <span className="agent-dash__tool is-live" title={toolTitle}>
                <span className="agent-dash__tool-label">
                  {t("dashboard.toolLabel")}
                </span>
                <span className="agent-dash__tool-name">{toolTitle}</span>
              </span>
            ) : null}
            {metaParts.length > 0 ? (
              <span className="agent-dash__meta" title={metaParts.join(" · ")}>
                {metaParts.join(" · ")}
              </span>
            ) : null}
            {cwd ? (
              <span className="agent-dash__cwd" title={cwd}>
                {cwd}
              </span>
            ) : null}
            {activity ? (
              <span className="agent-dash__activity">
                {t("dashboard.lastActivity", { time: activity })}
              </span>
            ) : null}
          </span>
        </button>
      </div>
    </li>
  );
}

export type AgentDashboardModalProps = {
  open: boolean;
  locale: Locale;
  rows: AgentDashboardRow[];
  onClose: () => void;
  onSelectSession?: (sessionId: string) => void;
  /**
   * Reuse App stop-all (confirm lives in App).
   * Stops **all** busy sessions globally — not only the currently filtered list.
   */
  onStopAllBusy?: () => void;
  /**
   * Stop the given session ids (already filtered to stoppable).
   * Confirm / toast lives in App.
   */
  onStopSessions?: (sessionIds: string[]) => void;
  /** Open multi-project batch agents dispatch. */
  onOpenBatchAgents?: () => void;
};

export function AgentDashboardModal({
  open,
  locale,
  rows,
  onClose,
  onSelectSession,
  onStopAllBusy,
  onStopSessions,
  onOpenBatchAgents,
}: AgentDashboardModalProps) {
  const tr = useMemo(() => createT(locale), [locale]);
  const [query, setQuery] = useState("");
  const [projectQuery, setProjectQuery] = useState("");
  const [statusFilter, setStatusFilter] =
    useState<AgentDashboardStatusFilter>("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  // X Evidence Rail counters (today's new evidence / this week's quote packs).
  // Absent backend (mock mode) or empty store → hide the block silently.
  const [evidence, setEvidence] = useState<XEvidenceStats | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    xEvidenceStats()
      .then((s) => {
        if (!cancelled) setEvidence(s);
      })
      .catch(() => {
        if (!cancelled) setEvidence(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);
  const filtered = useMemo(
    () =>
      filterAgentDashboardRows(rows, {
        query,
        projectQuery,
        status: statusFilter,
      }),
    [rows, query, projectQuery, statusFilter],
  );
  const statusCounts = useMemo(() => countDashboardRowsByStatus(rows), [rows]);
  const busyCount = useMemo(() => countBusyDashboardRows(rows), [rows]);
  // Stop-all targets every stoppable row in the dashboard, not only the filter.
  const stoppable = useMemo(() => stoppableDashboardRows(rows), [rows]);
  const showStopAll = !!onStopAllBusy && stoppable.length > 0;

  const filteredIds = useMemo(
    () => new Set(filtered.map((r) => r.sessionId)),
    [filtered],
  );

  // Drop selections that left the catalog (session ended / archived idle).
  useEffect(() => {
    const live = new Set(rows.map((r) => r.sessionId));
    setSelectedIds((prev) => pruneSelectedIds(prev, live));
  }, [rows]);

  // Clear multi-select when the modal closes so the next open is fresh.
  useEffect(() => {
    if (!open) setSelectedIds(new Set());
  }, [open]);

  const selectedStoppable = useMemo(
    () => filterStoppableAmongSelection(rows, selectedIds),
    [rows, selectedIds],
  );
  const selectedStoppableCount = selectedStoppable.length;
  const showStopSelected =
    !!onStopSessions && selectedStoppableCount > 0;

  const visibleSelectedCount = useMemo(() => {
    let n = 0;
    for (const id of selectedIds) {
      if (filteredIds.has(id)) n += 1;
    }
    return n;
  }, [selectedIds, filteredIds]);

  const allVisibleSelected =
    filtered.length > 0 && visibleSelectedCount === filtered.length;
  const someVisibleSelected =
    visibleSelectedCount > 0 && !allVisibleSelected;

  const hasActiveFilters =
    statusFilter !== "all" ||
    query.trim().length > 0 ||
    projectQuery.trim().length > 0;
  const isEmptyCatalog = rows.length === 0;
  const isEmptyFilter = !isEmptyCatalog && filtered.length === 0;

  const toggleRow = (sessionId: string) => {
    setSelectedIds((prev) => toggleIdInSet(prev, sessionId));
  };

  const toggleSelectAllVisible = () => {
    setSelectedIds((prev) => {
      if (allVisibleSelected) {
        // Deselect only currently visible rows.
        const next = new Set(prev);
        for (const id of filteredIds) next.delete(id);
        return next;
      }
      const next = new Set(prev);
      for (const id of filteredIds) next.add(id);
      return next;
    });
  };

  const handleStopSelected = () => {
    if (!onStopSessions) return;
    const ids = stoppableSelectedSessionIds(rows, selectedIds);
    if (!ids.length) return;
    onStopSessions(ids);
    // Clear selection after dispatch so the footer doesn't stale-count.
    setSelectedIds(new Set());
  };

  return (
    <GlassModal
      open={open}
      onClose={onClose}
      title={tr("dashboard.title")}
      titleId="agent-dashboard-title"
      closeLabel={tr("common.close")}
      size="lg"
      className="agent-dash-modal"
      wrapBody
      bodyClassName="agent-dash-modal__body"
      footer={
        <div className="agent-dash-modal__footer">
          <div className="agent-dash-modal__footer-actions">
            {onOpenBatchAgents ? (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={onOpenBatchAgents}
                title={tr("dashboard.batchAgentsTitle")}
              >
                {tr("dashboard.batchAgents")}
              </button>
            ) : null}
            {showStopSelected ? (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={handleStopSelected}
                title={tr("dashboard.stopSelectedTitle", {
                  n: selectedStoppableCount,
                })}
              >
                {tr("dashboard.stopSelected", { n: selectedStoppableCount })}
              </button>
            ) : null}
            {showStopAll ? (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={onStopAllBusy}
                title={tr("dashboard.stopAllTitle")}
              >
                {tr("dashboard.stopAll")}
              </button>
            ) : null}
          </div>
          <button type="button" className="btn btn--solid" onClick={onClose}>
            {tr("common.close")}
          </button>
        </div>
      }
    >
      <p className="agent-dash__hint">{tr("dashboard.hint")}</p>
      {evidence && evidence.total > 0 ? (
        <div
          className="agent-dash__evidence"
          title={tr("dashboard.evidence.hint")}
        >
          <span className="agent-dash__evidence-title">
            {tr("dashboard.evidence.title")}
          </span>
          <span className="agent-dash__evidence-stat">
            {tr("dashboard.evidence.todayNew", { n: evidence.todayNew })}
          </span>
          <span className="agent-dash__evidence-stat">
            {tr("dashboard.evidence.weekPacks", { n: evidence.weekPacks })}
          </span>
          <span className="agent-dash__evidence-stat agent-dash__evidence-stat--dim">
            {tr("dashboard.evidence.total", { n: evidence.total })}
          </span>
        </div>
      ) : null}
      <div
        className="agent-dash__chips"
        role="tablist"
        aria-label={tr("dashboard.filter.statusLabel")}
      >
        {AGENT_DASHBOARD_STATUS_FILTERS.map((id) => {
          const n = statusCounts[id];
          // Hide zero-count status chips except "all" and the active selection.
          if (id !== "all" && n === 0 && statusFilter !== id) return null;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={statusFilter === id}
              className={
                "agent-dash__chip" + (statusFilter === id ? " is-active" : "")
              }
              onClick={() => setStatusFilter(id)}
            >
              <span>{statusFilterLabel(id, (k, vars) => tr(k, vars))}</span>
              <span className="agent-dash__chip-count">{n}</span>
            </button>
          );
        })}
      </div>
      <div className="agent-dash__toolbar">
        <input
          type="search"
          className="settings-input agent-dash__search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tr("dashboard.searchPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          aria-label={tr("dashboard.searchPlaceholder")}
        />
        <input
          type="search"
          className="settings-input agent-dash__search agent-dash__search--project"
          value={projectQuery}
          onChange={(e) => setProjectQuery(e.target.value)}
          placeholder={tr("dashboard.projectSearchPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          aria-label={tr("dashboard.projectSearchPlaceholder")}
        />
        {busyCount > 0 ? (
          <span className="agent-dash__badge">
            {tr("dashboard.busyCount", { n: busyCount })}
          </span>
        ) : null}
      </div>
      {isEmptyCatalog ? (
        <div className="agent-dash__empty">
          <p className="agent-dash__empty-title">{tr("dashboard.empty")}</p>
          <p className="agent-dash__empty-hint">{tr("dashboard.emptyHint")}</p>
        </div>
      ) : isEmptyFilter ? (
        <div className="agent-dash__empty">
          <p className="agent-dash__empty-title">
            {tr("dashboard.filterEmpty")}
          </p>
          <p className="agent-dash__empty-hint">
            {tr("dashboard.filterEmptyHint")}
          </p>
          {hasActiveFilters ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm agent-dash__clear-filters"
              onClick={() => {
                setQuery("");
                setProjectQuery("");
                setStatusFilter("all");
              }}
            >
              {tr("dashboard.clearFilters")}
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="agent-dash__select-bar">
            <button
              type="button"
              role="checkbox"
              aria-checked={
                allVisibleSelected
                  ? true
                  : someVisibleSelected
                    ? "mixed"
                    : false
              }
              className={
                "agent-dash__check agent-dash__check--all" +
                (allVisibleSelected ? " is-on" : "") +
                (someVisibleSelected ? " is-mixed" : "")
              }
              onClick={toggleSelectAllVisible}
              aria-label={
                allVisibleSelected
                  ? tr("dashboard.deselectAllVisible")
                  : tr("dashboard.selectAllVisible")
              }
            >
              <span className="agent-dash__check-box" aria-hidden>
                {allVisibleSelected ? "✓" : someVisibleSelected ? "–" : ""}
              </span>
              <span className="agent-dash__select-label">
                {allVisibleSelected
                  ? tr("dashboard.deselectAllVisible")
                  : tr("dashboard.selectAllVisible")}
              </span>
            </button>
            {selectedIds.size > 0 ? (
              <span className="agent-dash__select-count">
                {tr("dashboard.selectedCount", {
                  n: selectedIds.size,
                  stoppable: selectedStoppableCount,
                })}
              </span>
            ) : null}
          </div>
          <ul className="agent-dash__list" role="list">
            {filtered.map((row) => (
              <DashboardRow
                key={row.sessionId}
                row={row}
                t={(k, vars) => tr(k, vars)}
                locale={locale}
                selected={selectedIds.has(row.sessionId)}
                onToggleSelect={toggleRow}
                onSelect={(id) => {
                  onSelectSession?.(id);
                  onClose();
                }}
              />
            ))}
          </ul>
        </>
      )}
    </GlassModal>
  );
}
