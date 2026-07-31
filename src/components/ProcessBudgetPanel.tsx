/**
 * Process budget occupancy panel — live warm-agent counts vs maxConcurrentAgents.
 * Used in Settings → Runtime → Process pool and Reliability center.
 * Soft-fails when host snapshot is unavailable; never invents busy occupancy.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createT, type Locale, type MessageKey } from "@/i18n";
import * as api from "@/lib/api";
import {
  emptyProcessBudgetSnapshot,
  occupancyPercent,
  occupancyTone,
  parseProcessBudgetSnapshot,
  processBudgetCountVars,
  processLimitAgeMinutes,
  PROCESS_BUDGET_POLL_MS,
  reclaimPlan,
  reclaimPlanCopyKey,
  type ProcessBudgetSnapshot,
  type ProcessLimitEvent,
} from "@/lib/processBudget";

export type ProcessBudgetPanelProps = {
  locale: Locale;
  /** When false, skip polling (e.g. settings tab not visible). Default true. */
  active?: boolean;
  /** Compact (settings row) vs card (reliability). */
  variant?: "settings" | "card";
  /** Last process_limit event from App (optional honesty callout). */
  lastProcessLimit?: ProcessLimitEvent | null;
  /** Optional class on root. */
  className?: string;
  /** Anchor id for settings search / deep link. */
  id?: string;
};

function formatWhen(ms: number, locale: Locale): string {
  try {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(
      locale === "zh" || locale === "zh-TW" ? "zh-CN" : "en-US",
      { dateStyle: "short", timeStyle: "short" },
    );
  } catch {
    return "";
  }
}

export function ProcessBudgetPanel({
  locale,
  active = true,
  variant = "settings",
  lastProcessLimit = null,
  className = "",
  id,
}: ProcessBudgetPanelProps) {
  const t = useMemo(() => createT(locale), [locale]);
  const [snap, setSnap] = useState<ProcessBudgetSnapshot>(() =>
    emptyProcessBudgetSnapshot(),
  );
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const raw = await api.processBudgetSnapshot();
      setSnap(parseProcessBudgetSnapshot(raw));
    } catch {
      setSnap(emptyProcessBudgetSnapshot());
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, PROCESS_BUDGET_POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const plan = reclaimPlan(snap);
  const planKey = reclaimPlanCopyKey(plan) as MessageKey;
  const tone = occupancyTone(plan);
  const vars = processBudgetCountVars(snap);
  const pct = snap.available
    ? occupancyPercent(snap.totalWarm, snap.maxConcurrent)
    : 0;

  const limitAgeMin = processLimitAgeMinutes(lastProcessLimit, now);
  const showLimit =
    lastProcessLimit != null &&
    (limitAgeMin == null || limitAgeMin < 24 * 60);

  const rootClass =
    (variant === "card" ? "reliab-card process-budget-panel" : "process-budget-panel") +
    (className ? ` ${className}` : "");

  return (
    <section
      className={rootClass}
      id={id}
      aria-labelledby={id ? `${id}-title` : undefined}
      data-testid="process-budget-panel"
      data-available={snap.available ? "1" : "0"}
      data-plan={plan}
    >
      <header className="process-budget-panel__head">
        <h3
          id={id ? `${id}-title` : undefined}
          className={
            variant === "card"
              ? "reliab-card__title process-budget-panel__title"
              : "process-budget-panel__title"
          }
        >
          {t("processBudget.title")}
        </h3>
        <div className="process-budget-panel__head-actions">
          {snap.available ? (
            <span
              className="process-budget-panel__count"
              aria-label={t("processBudget.countsAria", vars)}
            >
              {t("processBudget.counts", vars)}
            </span>
          ) : (
            <span className="process-budget-panel__count process-budget-panel__count--muted">
              {loading
                ? t("processBudget.loading")
                : t("processBudget.unavailable")}
            </span>
          )}
          <button
            type="button"
            className="btn btn--ghost btn--sm process-budget-panel__refresh"
            onClick={() => void load()}
            disabled={loading}
            data-testid="process-budget-refresh"
          >
            {t("processBudget.refresh")}
          </button>
        </div>
      </header>

      <p className="process-budget-panel__lead">
        {t("processBudget.lead")}
      </p>

      <div
        className={`process-budget-panel__meter process-budget-panel__meter--${tone}`}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={t("processBudget.meterAria", vars)}
      >
        <div
          className="process-budget-panel__meter-fill"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="process-budget-panel__buckets" aria-hidden={!snap.available}>
        <span className="process-budget-panel__bucket">
          <span className="process-budget-panel__bucket-label">
            {t("processBudget.bucket.live")}
          </span>
          <span className="process-budget-panel__bucket-val">{vars.live}</span>
        </span>
        <span className="process-budget-panel__bucket">
          <span className="process-budget-panel__bucket-label">
            {t("processBudget.bucket.background")}
          </span>
          <span className="process-budget-panel__bucket-val">
            {vars.background}
          </span>
        </span>
        <span className="process-budget-panel__bucket">
          <span className="process-budget-panel__bucket-label">
            {t("processBudget.bucket.parked")}
          </span>
          <span className="process-budget-panel__bucket-val">{vars.parked}</span>
        </span>
        <span className="process-budget-panel__bucket">
          <span className="process-budget-panel__bucket-label">
            {t("processBudget.bucket.free")}
          </span>
          <span className="process-budget-panel__bucket-val">{vars.free}</span>
        </span>
      </div>

      <p className="process-budget-panel__plan" data-testid="process-budget-plan">
        {t(planKey, vars)}
      </p>

      <p className="process-budget-panel__policy">
        {t("processBudget.idlePolicy", { idleMinutes: vars.idleMinutes })}
      </p>

      {showLimit && lastProcessLimit ? (
        <div
          className="process-budget-panel__limit"
          role="status"
          data-testid="process-budget-last-limit"
        >
          <div className="process-budget-panel__limit-title">
            {t("processBudget.limit.title")}
          </div>
          <p className="process-budget-panel__limit-body">
            {t("processBudget.limit.explain", {
              max:
                lastProcessLimit.maxConcurrentAgents ??
                vars.max ??
                DEFAULT_MAX_LABEL,
              when: formatWhen(lastProcessLimit.at, locale),
            })}
          </p>
        </div>
      ) : null}
    </section>
  );
}

const DEFAULT_MAX_LABEL = 8;

export type { ProcessLimitEvent };
