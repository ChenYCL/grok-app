/**
 * Cost rollup panel — known token usage by project/day or session/day.
 * Estimates only (never invoice-grade). Honest "unknown" when missing.
 * Optional plain-text export; clear uses in-app GlassModal (no window.confirm).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { GlassModal } from "@/components/GlassModal";
import { createT, type Locale } from "@/i18n";
import {
  buildCostRollupView,
  clearCostUsageSamples,
  COST_USAGE_SAMPLES_CHANGE_EVENT,
  formatCostRollupExport,
  formatRollupEstimatedCost,
  formatRollupTokens,
  loadCostUsageSamples,
  sinceDayDaysAgo,
  type CostRollupGroupBy,
  type CostRollupPrecision,
  type CostRollupProjectMeta,
  type CostRollupSessionMeta,
  type CostUsageSample,
  type LiveUsageMap,
} from "@/lib/costRollup";

export type CostRollupPanelProps = {
  locale: Locale;
  /** Session index rows (for unknown counting + project/model). */
  sessions?: readonly CostRollupSessionMeta[];
  projects?: readonly CostRollupProjectMeta[];
  /** Optional live usage map (sessionId → last known tokens). */
  liveUsage?: LiveUsageMap | null;
  /** Optional journal-extracted samples already loaded by parent. */
  journalSamples?: readonly CostUsageSample[];
  /** Rolling window in days (default 14). */
  days?: number;
  /** Compact embed inside a settings card (no outer chrome). */
  embedded?: boolean;
  /** Optional toast for copy success/failure. */
  onToast?: (message: string, ms?: number) => void;
};

const DAY_PRESETS = [7, 14, 30] as const;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function downloadText(filename: string, body: string) {
  const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function CostRollupPanel({
  locale,
  sessions = [],
  projects = [],
  liveUsage = null,
  journalSamples = [],
  days: daysProp = 14,
  embedded = false,
  onToast,
}: CostRollupPanelProps) {
  const t = useMemo(() => createT(locale), [locale]);
  const [samples, setSamples] = useState<CostUsageSample[]>(() =>
    loadCostUsageSamples(),
  );
  const [tick, setTick] = useState(0);
  const [groupBy, setGroupBy] = useState<CostRollupGroupBy>("project");
  const [days, setDays] = useState(daysProp);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    setDays(daysProp);
  }, [daysProp]);

  const refresh = useCallback(() => {
    setSamples(loadCostUsageSamples());
    setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    const onChange = (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      if (Array.isArray(detail)) {
        setSamples(detail as CostUsageSample[]);
      } else {
        setSamples(loadCostUsageSamples());
      }
    };
    window.addEventListener(COST_USAGE_SAMPLES_CHANGE_EVENT, onChange);
    return () =>
      window.removeEventListener(COST_USAGE_SAMPLES_CHANGE_EVENT, onChange);
  }, []);

  const view = useMemo(() => {
    void tick;
    return buildCostRollupView({
      samples,
      liveMap: liveUsage,
      journalSamples,
      sessions,
      projects,
      sinceDay: sinceDayDaysAgo(days),
      maxBuckets: groupBy === "session" ? 80 : 40,
      groupBy,
    });
  }, [
    samples,
    liveUsage,
    journalSamples,
    sessions,
    projects,
    days,
    tick,
    groupBy,
  ]);

  const exportLabels = useMemo(
    () => ({
      title: t("costRollup.exportTitle"),
      disclaimer: t("costRollup.disclaimer"),
      groupByProject: t("costRollup.exportGroupProject"),
      groupBySession: t("costRollup.exportGroupSession"),
      windowDays: t("costRollup.exportWindow"),
      knownTokens: t("costRollup.knownTokens"),
      estCost: t("costRollup.estCost"),
      sessionsKnown: t("costRollup.sessionsKnown"),
      sessionsUnknown: t("costRollup.sessionsUnknown"),
      tokens: t("costRollup.tokens"),
      noProject: t("costRollup.noProject"),
      untitledSession: t("costRollup.untitledSession"),
      costUnknown: t("costRollup.costUnknown"),
      precisionEstimate: t("costRollup.precisionEstimate"),
      precisionPartial: t("costRollup.precisionPartial"),
      precisionNone: t("costRollup.precisionNone"),
      unknownCount: t("costRollup.unknownCount"),
      empty: t("costRollup.exportEmpty"),
      invoiceNote: t("costRollup.invoiceNote"),
    }),
    [t],
  );

  const onClearConfirm = () => {
    clearCostUsageSamples();
    setConfirmClear(false);
    refresh();
  };

  const onCopyExport = async () => {
    // Fresh timestamp on copy.
    const text = formatCostRollupExport(view, {
      days,
      labels: exportLabels,
      generatedAt: new Date().toISOString(),
    });
    const ok = await copyText(text);
    onToast?.(
      ok ? t("costRollup.exportCopied") : t("costRollup.exportCopyFailed"),
      2000,
    );
  };

  const onDownloadExport = () => {
    const text = formatCostRollupExport(view, {
      days,
      labels: exportLabels,
      generatedAt: new Date().toISOString(),
    });
    const stamp = new Date().toISOString().slice(0, 10);
    downloadText(`cost-rollup-${stamp}.txt`, text);
    onToast?.(t("costRollup.exportDownloaded"), 2000);
  };

  const precisionBadge = (precision: CostRollupPrecision) => {
    const label =
      precision === "partial"
        ? t("costRollup.precisionPartial")
        : precision === "estimate"
          ? t("costRollup.precisionEstimate")
          : t("costRollup.precisionNone");
    return (
      <span
        className={
          "cost-rollup__badge" +
          (precision === "partial" ? " cost-rollup__badge--partial" : "") +
          (precision === "none" ? " cost-rollup__badge--none" : "")
        }
      >
        {label}
      </span>
    );
  };

  const totalCostLabel = formatRollupEstimatedCost(
    view.totalEstimatedUsd,
    view.precision === "none" && view.totalEstimatedUsd == null
      ? "none"
      : view.precision,
  );

  const body = (
    <div className="cost-rollup">
      <p className="cost-rollup__lead settings-row__desc">
        {t("costRollup.lead", { days })}
      </p>
      <p className="cost-rollup__disclaimer settings-row__desc">
        {t("costRollup.disclaimer")}
      </p>

      <div
        className="cost-rollup__mode"
        role="group"
        aria-label={t("costRollup.groupByAria")}
      >
        <button
          type="button"
          className={
            "btn btn--ghost btn--sm" +
            (groupBy === "project" ? " is-active" : "")
          }
          aria-pressed={groupBy === "project"}
          onClick={() => setGroupBy("project")}
        >
          {t("costRollup.groupProject")}
        </button>
        <button
          type="button"
          className={
            "btn btn--ghost btn--sm" +
            (groupBy === "session" ? " is-active" : "")
          }
          aria-pressed={groupBy === "session"}
          onClick={() => setGroupBy("session")}
        >
          {t("costRollup.groupSession")}
        </button>
      </div>

      <div
        className="cost-rollup__days"
        role="group"
        aria-label={t("costRollup.daysAria")}
      >
        {DAY_PRESETS.map((d) => (
          <button
            key={d}
            type="button"
            className={
              "btn btn--ghost btn--sm" + (days === d ? " is-active" : "")
            }
            aria-pressed={days === d}
            onClick={() => setDays(d)}
          >
            {t("costRollup.daysN", { days: d })}
          </button>
        ))}
      </div>

      <div className="cost-rollup__toolbar">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={refresh}
        >
          {t("costRollup.refresh")}
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => void onCopyExport()}
          disabled={view.empty}
          title={t("costRollup.exportCopy")}
        >
          {t("costRollup.exportCopy")}
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={onDownloadExport}
          disabled={view.empty}
          title={t("costRollup.exportDownload")}
        >
          {t("costRollup.exportDownload")}
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setConfirmClear(true)}
          disabled={samples.length === 0}
        >
          {t("costRollup.clear")}
        </button>
      </div>

      {view.empty ? (
        <div className="cost-rollup__empty" role="status">
          <div className="cost-rollup__empty-title">
            {t("costRollup.emptyTitle")}
          </div>
          <div className="settings-row__desc">{t("costRollup.emptyBody")}</div>
        </div>
      ) : (
        <>
          <div className="cost-rollup__summary" aria-live="polite">
            <div className="cost-rollup__stat">
              <span className="cost-rollup__stat-label">
                {t("costRollup.knownTokens")}
              </span>
              <span className="cost-rollup__stat-value">
                {formatRollupTokens(view.totalTokensKnown)}
              </span>
            </div>
            <div className="cost-rollup__stat">
              <span className="cost-rollup__stat-label">
                {t("costRollup.estCost")}
              </span>
              <span className="cost-rollup__stat-value cost-rollup__stat-value--cost">
                {totalCostLabel}
                {view.totalEstimatedUsd != null
                  ? precisionBadge(view.precision)
                  : null}
              </span>
            </div>
            <div className="cost-rollup__stat">
              <span className="cost-rollup__stat-label">
                {t("costRollup.sessionsKnown")}
              </span>
              <span className="cost-rollup__stat-value">
                {view.sessionsKnown}
              </span>
            </div>
            <div className="cost-rollup__stat">
              <span className="cost-rollup__stat-label">
                {t("costRollup.sessionsUnknown")}
              </span>
              <span className="cost-rollup__stat-value">
                {view.sessionsUnknown}
              </span>
            </div>
          </div>

          <ul
            className="cost-rollup__list"
            aria-label={
              groupBy === "session"
                ? t("costRollup.listSessionAria")
                : t("costRollup.listProjectAria")
            }
          >
            {view.buckets.map((b) => {
              const projectLabel =
                b.projectName ||
                b.projectId ||
                t("costRollup.noProject");
              const sessionLabel =
                b.sessionTitle ||
                b.sessionId ||
                t("costRollup.untitledSession");
              const costLabel = formatRollupEstimatedCost(
                b.estimatedUsd,
                b.precision === "none" && b.estimatedUsd == null
                  ? "none"
                  : b.precision,
              );
              const unknownNote =
                b.sessionsUnknown > 0
                  ? t("costRollup.unknownCount", {
                      count: b.sessionsUnknown,
                    })
                  : null;
              const rowKey =
                groupBy === "session"
                  ? `${b.day}:${b.sessionId ?? ""}`
                  : `${b.day}:${b.projectId ?? ""}`;
              return (
                <li key={rowKey} className="cost-rollup__row">
                  <div className="cost-rollup__row-main">
                    <span className="cost-rollup__day">{b.day}</span>
                    {groupBy === "session" ? (
                      <>
                        <span
                          className="cost-rollup__session"
                          title={sessionLabel}
                        >
                          {sessionLabel}
                        </span>
                        <span
                          className="cost-rollup__project cost-rollup__project--muted"
                          title={projectLabel}
                        >
                          {projectLabel}
                        </span>
                      </>
                    ) : (
                      <span
                        className="cost-rollup__project"
                        title={projectLabel}
                      >
                        {projectLabel}
                      </span>
                    )}
                  </div>
                  <div className="cost-rollup__row-meta">
                    <span>
                      {t("costRollup.tokens")}:{" "}
                      {formatRollupTokens(b.totalTokens)}
                    </span>
                    {b.inputTokens != null || b.outputTokens != null ? (
                      <span className="cost-rollup__io">
                        {t("costRollup.ioSplit", {
                          input: formatRollupTokens(b.inputTokens),
                          output: formatRollupTokens(b.outputTokens),
                        })}
                      </span>
                    ) : null}
                    <span className="cost-rollup__cost-cell">
                      {t("costRollup.estCost")}: {costLabel}
                      {b.estimatedUsd != null
                        ? precisionBadge(b.precision)
                        : null}
                    </span>
                    {groupBy === "project" && b.sessionsKnown > 0 ? (
                      <span>
                        {t("costRollup.sessionsKnown")}: {b.sessionsKnown}
                      </span>
                    ) : null}
                    {unknownNote ? (
                      <span className="cost-rollup__unknown">
                        {unknownNote}
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <GlassModal
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title={t("costRollup.clearConfirmTitle")}
        size="sm"
        closeLabel={t("common.close")}
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setConfirmClear(false)}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--solid"
              onClick={onClearConfirm}
            >
              {t("costRollup.clearConfirmAction")}
            </button>
          </>
        }
      >
        <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>
          {t("costRollup.clearConfirmBody")}
        </p>
      </GlassModal>
    </div>
  );

  if (embedded) return body;

  return (
    <div className="cost-rollup cost-rollup--card">
      <div className="settings-row__label">{t("costRollup.title")}</div>
      {body}
    </div>
  );
}
