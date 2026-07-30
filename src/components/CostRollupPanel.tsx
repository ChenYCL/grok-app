/**
 * Cost rollup panel — known token usage by project/day.
 * Estimates only (never invoice-grade). Honest "unknown" when missing.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createT, type Locale } from "@/i18n";
import {
  buildCostRollupView,
  clearCostUsageSamples,
  COST_USAGE_SAMPLES_CHANGE_EVENT,
  formatCostUsd,
  formatRollupTokens,
  loadCostUsageSamples,
  sinceDayDaysAgo,
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
};

export function CostRollupPanel({
  locale,
  sessions = [],
  projects = [],
  liveUsage = null,
  journalSamples = [],
  days = 14,
  embedded = false,
}: CostRollupPanelProps) {
  const t = useMemo(() => createT(locale), [locale]);
  const [samples, setSamples] = useState<CostUsageSample[]>(() =>
    loadCostUsageSamples(),
  );
  const [tick, setTick] = useState(0);

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
      maxBuckets: 40,
    });
  }, [samples, liveUsage, journalSamples, sessions, projects, days, tick]);

  const onClear = () => {
    clearCostUsageSamples();
    refresh();
  };

  const body = (
    <div className="cost-rollup">
      <p className="cost-rollup__lead settings-row__desc">
        {t("costRollup.lead", { days })}
      </p>
      <p className="cost-rollup__disclaimer settings-row__desc">
        {t("costRollup.disclaimer")}
      </p>

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
          onClick={onClear}
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
              <span className="cost-rollup__stat-value">
                {formatCostUsd(view.totalEstimatedUsd)}
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

          <ul className="cost-rollup__list" aria-label={t("costRollup.title")}>
            {view.buckets.map((b) => {
              const projectLabel =
                b.projectName ||
                b.projectId ||
                t("costRollup.noProject");
              const costLabel =
                b.estimatedUsd != null
                  ? formatCostUsd(b.estimatedUsd)
                  : t("costRollup.costUnknown");
              const unknownNote =
                b.sessionsUnknown > 0
                  ? t("costRollup.unknownCount", {
                      count: b.sessionsUnknown,
                    })
                  : null;
              return (
                <li
                  key={`${b.day}:${b.projectId ?? ""}`}
                  className="cost-rollup__row"
                >
                  <div className="cost-rollup__row-main">
                    <span className="cost-rollup__day">{b.day}</span>
                    <span
                      className="cost-rollup__project"
                      title={projectLabel}
                    >
                      {projectLabel}
                    </span>
                  </div>
                  <div className="cost-rollup__row-meta">
                    <span>
                      {t("costRollup.tokens")}:{" "}
                      {formatRollupTokens(b.totalTokens)}
                    </span>
                    <span>
                      {t("costRollup.estCost")}: {costLabel}
                    </span>
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
