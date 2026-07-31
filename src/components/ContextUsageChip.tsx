/**
 * Persistent context usage chip in the composer row.
 * Click opens a compact summary menu + action to run `/compact`.
 * Optional honest $ cost estimates when rates exist + Settings toggle is on.
 *
 * CONTEXT-USAGE-PRO: empty/no-data honesty, labelled breakdown rows,
 * soft-fail "—" when tokens unknown after compact (still opens the menu).
 */

import { useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { IconActivity, IconArrowsMinimize } from "@/components/icons";
import { Tip } from "@/components/ui/tooltip";
import { useFloatingMenu } from "@/lib/floatingMenu";
import {
  buildContextBreakdownRows,
  formatTokenCount,
  hasContextUsageData,
  resolveContextUsageEmptyState,
  resolveContextUsageSurface,
  type ContextBreakdownRowId,
  type ContextUsageDisplay,
  type LastCompactSummary,
} from "@/lib/contextUsage";
import {
  estimateCostUsd,
  formatCostUsd,
  type CostEstimateResult,
} from "@/lib/estimateCost";

export type ContextUsageChipLabels = {
  aria: string;
  tipUnknown: string;
  tipEstimated: string;
  tipKnown: string;
  menuTitle: string;
  current: string;
  sourceKnown: string;
  sourceEstimated: string;
  sourceUnknown: string;
  lastCompact: string;
  lastCompactNone: string;
  tokensRange: string;
  compactAction: string;
  heuristicNote: string;
  auto: string;
  manual: string;
  /** Section header above role / system / tools rows. */
  breakdownSection: string;
  breakdownUser: string;
  breakdownAssistant: string;
  breakdownThought: string;
  breakdownSystem: string;
  breakdownTools: string;
  breakdownHistory: string;
  /** Shown under role rows when breakdown is estimated-only. */
  breakdownEstimatedNote: string;
  /** When no role/system/tools signal is available. */
  breakdownEmpty: string;
  /** Soft-fail note when total tokens are unknown (e.g. after compact). */
  softFailUnknownNote: string;
  /** Partial agent I/O without a total. */
  partialAgentNote: string;
  /** Agent-reported input / output rows. */
  knownInput: string;
  knownOutput: string;
  knownTotal: string;
  knownFromAgent: string;
  /** Cost estimate section (when Settings toggle + rates). */
  costSection: string;
  costInput: string;
  costOutput: string;
  costTotal: string;
  /** Honest disclaimer under $ rows. */
  costDisclaimer: string;
  /** When toggle on but model not in rates table. */
  costUnavailable: string;
};

type Props = {
  display: ContextUsageDisplay;
  labels: ContextUsageChipLabels;
  disabled?: boolean;
  onCompact: () => void;
  /** For 万/億 vs 萬/億 on menu breakdown rows. Chip label already resolved. */
  locale?: string;
  /**
   * Settings → Show usage estimates. When false, hide $ section entirely.
   * Token rows stay (core context UX).
   */
  showUsageEstimates?: boolean;
  /** Active model id for crude rate lookup. */
  modelId?: string | null;
};

function tipFor(
  display: ContextUsageDisplay,
  labels: ContextUsageChipLabels,
): string {
  if (display.source === "known") return labels.tipKnown;
  if (display.source === "estimated") return labels.tipEstimated;
  return labels.tipUnknown;
}

function sourceLabel(
  source: ContextUsageDisplay["source"],
  labels: ContextUsageChipLabels,
): string {
  if (source === "known") return labels.sourceKnown;
  if (source === "estimated") return labels.sourceEstimated;
  return labels.sourceUnknown;
}

function formatLastCompactDetail(
  last: LastCompactSummary,
  labels: ContextUsageChipLabels,
  locale: string,
): string {
  if (
    last.tokensBefore != null &&
    last.tokensAfter != null &&
    Number.isFinite(last.tokensBefore) &&
    Number.isFinite(last.tokensAfter)
  ) {
    return labels.tokensRange
      .replace("{before}", formatTokenCount(last.tokensBefore, locale))
      .replace("{after}", formatTokenCount(last.tokensAfter, locale));
  }
  if (last.note?.trim()) return last.note.trim();
  return last.trigger === "manual" ? labels.manual : labels.auto;
}

function breakdownRowLabel(
  id: ContextBreakdownRowId,
  labels: ContextUsageChipLabels,
): string {
  switch (id) {
    case "system":
      return labels.breakdownSystem;
    case "tools":
      return labels.breakdownTools;
    case "history":
      return labels.breakdownHistory;
    case "user":
      return labels.breakdownUser;
    case "assistant":
      return labels.breakdownAssistant;
    case "thought":
      return labels.breakdownThought;
  }
}

function BreakdownRows({
  display,
  labels,
  locale,
}: {
  display: ContextUsageDisplay;
  labels: ContextUsageChipLabels;
  locale: string;
}) {
  const rows = buildContextBreakdownRows(display.breakdown, locale);
  const empty = resolveContextUsageEmptyState(display);
  const showEmptyNote =
    empty.kind === "no_breakdown" ||
    empty.kind === "unknown_after_compact" ||
    empty.kind === "partial_agent";
  const emptyCopy =
    empty.kind === "unknown_after_compact"
      ? labels.softFailUnknownNote
      : empty.kind === "partial_agent"
        ? labels.partialAgentNote
        : empty.kind === "no_breakdown"
          ? labels.breakdownEmpty
          : null;

  return (
    <>
      <div className="ctx-chip__head ctx-chip__head--sub">
        {labels.breakdownSection}
      </div>
      {showEmptyNote && emptyCopy && !display.breakdown ? (
        <p className="ctx-chip__note ctx-chip__note--empty" role="status">
          {emptyCopy}
        </p>
      ) : (
        rows.map((row) => (
          <div key={row.id} className="ctx-chip__row">
            <span className="ctx-chip__k">
              {breakdownRowLabel(row.id, labels)}
            </span>
            <span className="ctx-chip__v">
              <span className="ctx-chip__tokens">{row.value}</span>
            </span>
          </div>
        ))
      )}
      {display.breakdown?.estimated ? (
        <p className="ctx-chip__note">{labels.breakdownEstimatedNote}</p>
      ) : null}
      {empty.kind === "unknown_after_compact" && display.breakdown ? (
        <p className="ctx-chip__note ctx-chip__note--empty" role="status">
          {labels.softFailUnknownNote}
        </p>
      ) : null}
    </>
  );
}

function resolveCostEstimate(
  display: ContextUsageDisplay,
  modelId: string | null | undefined,
): CostEstimateResult {
  const known = display.knownUsage;
  if (
    known &&
    (known.inputTokens != null ||
      known.outputTokens != null ||
      known.totalTokens != null)
  ) {
    return estimateCostUsd(
      {
        inputTokens: known.inputTokens,
        outputTokens: known.outputTokens,
        totalTokens: known.totalTokens,
      },
      modelId,
    );
  }
  // Fall back to chip total when agent has not reported I/O split.
  if (display.tokens != null && display.tokens > 0) {
    return estimateCostUsd(display.tokens, modelId);
  }
  return estimateCostUsd({}, modelId);
}

function CostEstimateRows({
  cost,
  labels,
  hasTokenSignal,
}: {
  cost: CostEstimateResult;
  labels: ContextUsageChipLabels;
  /** True when we have some token count to estimate against. */
  hasTokenSignal: boolean;
}) {
  if (!hasTokenSignal) return null;

  if (cost.precision === "none" || cost.totalUsd == null) {
    // Model not in rates table — tokens only, honest about missing $.
    if (!cost.rates) {
      return (
        <>
          <div className="ctx-chip__head ctx-chip__head--sub">
            {labels.costSection}
          </div>
          <p className="ctx-chip__note">{labels.costUnavailable}</p>
        </>
      );
    }
    return null;
  }

  return (
    <>
      <div className="ctx-chip__head ctx-chip__head--sub">
        {labels.costSection}
      </div>
      {cost.inputUsd != null ? (
        <div className="ctx-chip__row">
          <span className="ctx-chip__k">{labels.costInput}</span>
          <span className="ctx-chip__v">
            <span className="ctx-chip__tokens">
              {formatCostUsd(cost.inputUsd, true)}
            </span>
          </span>
        </div>
      ) : null}
      {cost.outputUsd != null ? (
        <div className="ctx-chip__row">
          <span className="ctx-chip__k">{labels.costOutput}</span>
          <span className="ctx-chip__v">
            <span className="ctx-chip__tokens">
              {formatCostUsd(cost.outputUsd, true)}
            </span>
          </span>
        </div>
      ) : null}
      <div className="ctx-chip__row">
        <span className="ctx-chip__k">{labels.costTotal}</span>
        <span className="ctx-chip__v">
          <span className="ctx-chip__tokens">
            {formatCostUsd(cost.totalUsd, true)}
          </span>
        </span>
      </div>
      <p className="ctx-chip__note">{labels.costDisclaimer}</p>
    </>
  );
}

export function ContextUsageChip({
  display,
  labels,
  disabled,
  onCompact,
  locale = "zh",
  showUsageEstimates = true,
  modelId = null,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const cost = useMemo(
    () =>
      showUsageEstimates
        ? resolveCostEstimate(display, modelId)
        : null,
    [showUsageEstimates, display, modelId],
  );

  const hasTokenSignal =
    display.tokens != null ||
    display.knownUsage?.inputTokens != null ||
    display.knownUsage?.outputTokens != null ||
    display.knownUsage?.totalTokens != null;

  const { pos, style: popStyle } = useFloatingMenu({
    open,
    triggerRef,
    panelRef: popRef,
    roots: [rootRef],
    onClose: () => setOpen(false),
    placement: "up",
    fitContent: true,
    minWidth: 220,
    estHeight: 420,
    gap: 8,
    deps: [
      display.label,
      display.lastCompact?.messageId,
      display.breakdown?.totalTokens,
      cost?.totalUsd,
      showUsageEstimates,
    ],
  });

  const tip = useMemo(() => tipFor(display, labels), [display, labels]);
  const source = sourceLabel(display.source, labels);
  const lastDetail = display.lastCompact
    ? formatLastCompactDetail(display.lastCompact, labels, locale)
    : null;
  const surface = resolveContextUsageSurface(display);
  const softUnknown = surface === "soft_unknown";

  // New sessions: no empty "—" chip. Soft-unknown after compact still shows.
  if (!hasContextUsageData(display)) return null;

  return (
    <div ref={rootRef} className={`ctx-chip${open ? " is-open" : ""}`}>
      <Tip label={tip} disabled={open || disabled}>
        <button
          ref={triggerRef}
          type="button"
          className={
            "chip chip--context" +
            (open ? " is-open" : "") +
            (display.source === "unknown" || softUnknown
              ? " chip--muted"
              : "")
          }
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`${labels.aria}: ${display.label}`}
          data-context-surface={surface}
          onClick={() => setOpen((v) => !v)}
        >
          <IconActivity size={14} />
          <span className="chip__label chip__label--nums">{display.label}</span>
        </button>
      </Tip>
      {open &&
        pos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popRef}
            className="cmm__pop cmm__pop--portal ctx-chip__pop"
            role="menu"
            aria-label={labels.menuTitle}
            style={popStyle as CSSProperties}
          >
            <div className="ctx-chip__head">{labels.menuTitle}</div>
            <div className="ctx-chip__row">
              <span className="ctx-chip__k">{labels.current}</span>
              <span className="ctx-chip__v">
                <span className="ctx-chip__tokens">{display.label}</span>
                <span className="ctx-chip__src">{source}</span>
              </span>
            </div>
            {display.knownUsage &&
            (display.knownUsage.inputTokens != null ||
              display.knownUsage.outputTokens != null ||
              display.knownUsage.totalTokens != null) ? (
              <>
                <div className="ctx-chip__head ctx-chip__head--sub">
                  {labels.knownFromAgent}
                </div>
                {display.knownUsage.inputTokens != null ? (
                  <div className="ctx-chip__row">
                    <span className="ctx-chip__k">{labels.knownInput}</span>
                    <span className="ctx-chip__v">
                      <span className="ctx-chip__tokens">
                        {formatTokenCount(
                          display.knownUsage.inputTokens,
                          locale,
                        )}
                      </span>
                    </span>
                  </div>
                ) : null}
                {display.knownUsage.outputTokens != null ? (
                  <div className="ctx-chip__row">
                    <span className="ctx-chip__k">{labels.knownOutput}</span>
                    <span className="ctx-chip__v">
                      <span className="ctx-chip__tokens">
                        {formatTokenCount(
                          display.knownUsage.outputTokens,
                          locale,
                        )}
                      </span>
                    </span>
                  </div>
                ) : null}
                {display.knownUsage.totalTokens != null ? (
                  <div className="ctx-chip__row">
                    <span className="ctx-chip__k">{labels.knownTotal}</span>
                    <span className="ctx-chip__v">
                      <span className="ctx-chip__tokens">
                        {formatTokenCount(
                          display.knownUsage.totalTokens,
                          locale,
                        )}
                      </span>
                    </span>
                  </div>
                ) : null}
              </>
            ) : null}
            <BreakdownRows
              display={display}
              labels={labels}
              locale={locale}
            />
            {showUsageEstimates && cost ? (
              <CostEstimateRows
                cost={cost}
                labels={labels}
                hasTokenSignal={!!hasTokenSignal}
              />
            ) : null}
            <div className="ctx-chip__row">
              <span className="ctx-chip__k">{labels.lastCompact}</span>
              <span className="ctx-chip__v">
                {lastDetail ?? labels.lastCompactNone}
              </span>
            </div>
            {display.lastCompact?.summaryPreview?.trim() ? (
              <p className="ctx-chip__summary">
                {display.lastCompact.summaryPreview.trim()}
              </p>
            ) : null}
            <p className="ctx-chip__note">{labels.heuristicNote}</p>
            <button
              type="button"
              role="menuitem"
              className="ctx-chip__action"
              onClick={() => {
                setOpen(false);
                onCompact();
              }}
            >
              <IconArrowsMinimize size={14} aria-hidden />
              <span>{labels.compactAction}</span>
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
