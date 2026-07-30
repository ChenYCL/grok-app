/**
 * Local archive of reviewed plans — body previews only (redacted, capped).
 * Used from the session menu / Plan history modal.
 */

import { useEffect, useState } from "react";
import {
  PLAN_HISTORY_CHANGE_EVENT,
  PLAN_HISTORY_STORAGE_KEY,
  loadPlanHistory,
  planHistoryEntryKey,
  planHistoryLabel,
  planHistoryListSnippet,
  type PlanHistoryDecision,
  type PlanHistoryEntry,
} from "@/lib/planHistory";

export type PlanHistoryListLabels = {
  empty: string;
  open: string;
  decisionApproved: string;
  decisionAbandoned: string;
  decisionCompleted: string;
  /** Optional list aria */
  listAria?: string;
};

export type PlanHistoryListProps = {
  labels: PlanHistoryListLabels;
  onOpen?: (entry: PlanHistoryEntry) => void;
  className?: string;
  compact?: boolean;
};

function formatAt(iso: string): string {
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return iso || "";
  try {
    return new Date(d).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function decisionLabel(
  decision: PlanHistoryDecision,
  labels: PlanHistoryListLabels,
): string {
  if (decision === "approved") return labels.decisionApproved;
  if (decision === "abandoned") return labels.decisionAbandoned;
  return labels.decisionCompleted;
}

export function PlanHistoryList({
  labels,
  onOpen,
  className = "",
  compact = false,
}: PlanHistoryListProps) {
  const [entries, setEntries] = useState<PlanHistoryEntry[]>(() =>
    loadPlanHistory(),
  );

  useEffect(() => {
    const refresh = () => setEntries(loadPlanHistory());
    refresh();
    const onChange = () => refresh();
    window.addEventListener(PLAN_HISTORY_CHANGE_EVENT, onChange);
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === PLAN_HISTORY_STORAGE_KEY) refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(PLAN_HISTORY_CHANGE_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  if (entries.length === 0) {
    return (
      <div
        className={"plan-history-empty" + (className ? ` ${className}` : "")}
        role="status"
      >
        {labels.empty}
      </div>
    );
  }

  return (
    <ul
      className={
        "plan-history-list" +
        (compact ? " plan-history-list--compact" : "") +
        (className ? ` ${className}` : "")
      }
      aria-label={labels.listAria}
    >
      {entries.map((e) => {
        const label = planHistoryLabel(e);
        const snippet = planHistoryListSnippet(e);
        const decision = decisionLabel(e.decision, labels);
        return (
          <li key={planHistoryEntryKey(e)} className="plan-history-row">
            <button
              type="button"
              className="plan-history-row__btn"
              onClick={() => onOpen?.(e)}
              title={labels.open}
            >
              <div className="plan-history-row__text">
                <div className="plan-history-row__title" title={label}>
                  {label}
                </div>
                <div className="plan-history-row__meta">
                  <span
                    className={
                      "plan-history-row__decision plan-history-row__decision--" +
                      e.decision
                    }
                  >
                    {decision}
                  </span>
                  {e.at ? (
                    <span className="plan-history-row__when">
                      {formatAt(e.at)}
                    </span>
                  ) : null}
                </div>
                {snippet ? (
                  <div className="plan-history-row__snippet" title={snippet}>
                    {snippet}
                  </div>
                ) : null}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
