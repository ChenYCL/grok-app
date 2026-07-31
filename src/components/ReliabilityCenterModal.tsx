/**
 * Reliability / Observability center — aggregate long-task signals:
 * busy sessions, stall / end-of-turn stalls, recent error-deck cards,
 * a persisted stall timeline (localStorage ring), and the cross-session
 * tool/permission audit ledger (host JSONL).
 * Actions: export support bundle, open Doctor, clear stall/audit, export audit.
 * No secrets from logs.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  IconActivity,
  IconAlertTriangle,
  IconClose,
  IconDoctor,
} from "@/components/icons";
import { ProcessBudgetPanel } from "@/components/ProcessBudgetPanel";
import { createT, type Locale, type MessageKey } from "@/i18n";
import * as api from "@/lib/api";
import {
  auditLedgerEventKey,
  filterAuditLedger,
  parseAuditLedgerList,
  type AuditLedgerEntry,
  type AuditLedgerEvent,
} from "@/lib/auditLedger";
import type { ProcessLimitEvent } from "@/lib/processBudget";
import {
  buildStallTimelineSnapshot,
  clearStallHistory,
  filterStallHistory,
  loadStallHistory,
  serializeStallTimelineSnapshot,
  STALL_HISTORY_CHANGE_EVENT,
  STALL_HISTORY_STORAGE_KEY,
  type ReliabilityBusySession,
  type ReliabilityCenterView,
  type ReliabilityErrorEntry,
  type ReliabilityStallKind,
  type ReliabilityStallSignal,
  type StallHistoryEntry,
} from "@/lib/reliabilityCenter";

export type ReliabilityCenterModalProps = {
  open: boolean;
  onClose: () => void;
  locale: Locale;
  view: ReliabilityCenterView;
  onOpenDoctor: () => void;
  /** Jump to a busy session (optional). */
  onSelectSession?: (sessionId: string) => void;
  /** Display-only: show Goal orchestration section (CLI goal_updated events). */
  goalOrchUiEnabled?: boolean;
  /** In-memory ring of observed goal phase events (never invented). */
  goalOrchEvents?: Array<{
    id: string;
    phase?: string;
    progress?: number | string;
    at?: number | string;
    summary?: string;
  }>;
  /** Last process_limit toast context for process-budget honesty. */
  lastProcessLimit?: ProcessLimitEvent | null;
};

type StallKindFilter = "all" | ReliabilityStallKind;

function formatWhen(ms: number, locale: Locale): string {
  try {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(
      locale === "zh" || locale === "zh-TW" ? "zh-CN" : "en-US",
      { dateStyle: "short", timeStyle: "medium" },
    );
  } catch {
    return "";
  }
}

function busyStatusKey(status: ReliabilityBusySession["status"]): MessageKey {
  switch (status) {
    case "streaming":
      return "tasks.activity.streaming";
    case "awaiting_permission":
      return "tasks.activity.permission";
    case "connecting":
      return "tasks.activity.connecting";
    default:
      return "tasks.activity.other";
  }
}

function stallKindKey(kind: ReliabilityStallSignal["kind"]): MessageKey {
  switch (kind) {
    case "active":
      return "reliability.stall.kind.active";
    case "hard_end":
      return "reliability.stall.kind.hardEnd";
    case "terminal":
      return "reliability.stall.kind.terminal";
    case "end_of_turn":
      return "reliability.stall.kind.endOfTurn";
    default:
      return "reliability.stall.kind.terminal";
  }
}

function BusyRow({
  row,
  t,
  onSelect,
}: {
  row: ReliabilityBusySession;
  t: ReturnType<typeof createT>;
  onSelect?: (sessionId: string) => void;
}) {
  return (
    <li className="reliab-card__row">
      <div className="reliab-card__row-main">
        <span
          className={
            "reliab-card__dot" +
            (row.status === "awaiting_permission"
              ? " reliab-card__dot--warn"
              : " reliab-card__dot--busy")
          }
          aria-hidden
        />
        <span className="reliab-card__name" title={row.title}>
          {row.title}
          {row.isCurrent ? (
            <span className="reliab-card__tag">
              {" "}
              {t("tasks.activity.current")}
            </span>
          ) : null}
        </span>
        <span className="reliab-card__meta">{t(busyStatusKey(row.status))}</span>
      </div>
      {row.liveToolTitle ? (
        <div className="reliab-card__sub" title={row.liveToolTitle}>
          {row.liveToolTitle}
        </div>
      ) : null}
      {!row.isCurrent && onSelect ? (
        <div className="reliab-card__actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => onSelect(row.sessionId)}
          >
            {t("tasks.activity.open")}
          </button>
        </div>
      ) : null}
    </li>
  );
}

function StallRow({
  signal,
  t,
  locale,
}: {
  signal: ReliabilityStallSignal | StallHistoryEntry;
  t: ReturnType<typeof createT>;
  locale: Locale;
}) {
  const when = formatWhen(signal.at, locale);
  const secs =
    signal.stallSeconds != null
      ? t("reliability.stall.seconds", {
          seconds: String(signal.stallSeconds),
        })
      : null;
  return (
    <li className="reliab-card__row">
      <div className="reliab-card__row-main">
        <span className="reliab-card__dot reliab-card__dot--warn" aria-hidden />
        <span className="reliab-card__name" title={signal.title ?? undefined}>
          {signal.title || t("reliability.stall.unknownSession")}
        </span>
        <span className="reliab-card__meta">{t(stallKindKey(signal.kind))}</span>
      </div>
      <div className="reliab-card__sub">
        {[
          secs,
          "tier" in signal ? signal.tier : null,
          when,
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>
    </li>
  );
}

function ErrorRow({
  entry,
  locale,
}: {
  entry: ReliabilityErrorEntry;
  locale: Locale;
}) {
  const when = formatWhen(entry.at, locale);
  return (
    <li className="reliab-card__row">
      <div className="reliab-card__row-main">
        <span className="reliab-card__dot reliab-card__dot--err" aria-hidden />
        <span className="reliab-card__name" title={entry.problem}>
          {entry.problem}
        </span>
        {entry.code ? (
          <span className="reliab-card__meta reliab-card__code">{entry.code}</span>
        ) : null}
      </div>
      {entry.cause ? (
        <div className="reliab-card__sub" title={entry.cause}>
          {entry.cause}
        </div>
      ) : null}
      <div className="reliab-card__sub reliab-card__sub--muted">
        {[entry.title, when].filter(Boolean).join(" · ")}
      </div>
    </li>
  );
}

type AuditEventFilter = "all" | AuditLedgerEvent;

function auditDotClass(event: AuditLedgerEvent): string {
  if (event === "permission") return " reliab-card__dot--warn";
  if (event === "tool_end") return " reliab-card__dot--busy";
  return "";
}

function AuditRow({
  entry,
  t,
  locale,
}: {
  entry: AuditLedgerEntry;
  t: ReturnType<typeof createT>;
  locale: Locale;
}) {
  const when = formatWhen(Date.parse(entry.ts) || 0, locale);
  const meta = [
    entry.permission,
    entry.outcome,
    when,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="reliab-card__row" data-testid="reliab-audit-row">
      <div className="reliab-card__row-main">
        <span
          className={"reliab-card__dot" + auditDotClass(entry.event)}
          aria-hidden
        />
        <span className="reliab-card__name" title={entry.toolName}>
          {entry.toolName}
        </span>
        <span className="reliab-card__meta">{t(auditLedgerEventKey(entry.event))}</span>
      </div>
      {entry.summary ? (
        <div className="reliab-card__sub" title={entry.summary}>
          {entry.summary}
        </div>
      ) : null}
      <div className="reliab-card__sub reliab-card__sub--muted">
        {[
          entry.sessionId
            ? entry.sessionId.slice(0, 8)
            : t("reliability.audit.unknownSession"),
          meta,
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>
    </li>
  );
}

export function ReliabilityCenterModal({
  open,
  onClose,
  locale,
  view,
  onOpenDoctor,
  onSelectSession,
  lastProcessLimit = null,
}: ReliabilityCenterModalProps) {
  const t = useMemo(() => createT(locale), [locale]);
  const [busy, setBusy] = useState<"zip" | "audit-export" | "audit-clear" | null>(
    null,
  );
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [stallHistory, setStallHistory] = useState<StallHistoryEntry[]>(() =>
    loadStallHistory(),
  );
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyKind, setHistoryKind] = useState<StallKindFilter>("all");
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);

  const [auditEntries, setAuditEntries] = useState<AuditLedgerEntry[]>([]);
  const [auditQuery, setAuditQuery] = useState("");
  const [auditEvent, setAuditEvent] = useState<AuditEventFilter>("all");
  const [confirmClearAudit, setConfirmClearAudit] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);

  const loadAudit = useCallback(async () => {
    setAuditLoading(true);
    try {
      const raw = await api.auditLedgerList(200);
      setAuditEntries(parseAuditLedgerList(raw, 200));
    } catch {
      setErrorMsg(t("reliability.audit.loadFail"));
      setAuditEntries([]);
    } finally {
      setAuditLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!open) return;
    setStatusMsg(null);
    setErrorMsg(null);
    setBusy(null);
    setHistoryQuery("");
    setHistoryKind("all");
    setConfirmClearHistory(false);
    setStallHistory(loadStallHistory());
    setAuditQuery("");
    setAuditEvent("all");
    setConfirmClearAudit(false);
    void loadAudit();
  }, [open, loadAudit]);

  useEffect(() => {
    if (!open) return;
    const refresh = () => setStallHistory(loadStallHistory());
    const onChange = () => refresh();
    window.addEventListener(STALL_HISTORY_CHANGE_EVENT, onChange);
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === STALL_HISTORY_STORAGE_KEY) refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(STALL_HISTORY_CHANGE_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (confirmClearHistory) {
          setConfirmClearHistory(false);
          return;
        }
        if (confirmClearAudit) {
          setConfirmClearAudit(false);
          return;
        }
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, confirmClearHistory, confirmClearAudit]);

  const filteredHistory = useMemo(
    () =>
      filterStallHistory(stallHistory, {
        query: historyQuery,
        kind: historyKind,
      }),
    [stallHistory, historyQuery, historyKind],
  );

  const filteredAudit = useMemo(
    () =>
      filterAuditLedger(auditEntries, {
        query: auditQuery,
        event: auditEvent,
      }),
    [auditEntries, auditQuery, auditEvent],
  );

  const onSupportZip = useCallback(async () => {
    setBusy("zip");
    setStatusMsg(null);
    setErrorMsg(null);
    try {
      // Structured stall timeline only (titles/kinds/seconds) — host redacts secrets.
      const timeline = buildStallTimelineSnapshot(view.stalls.signals);
      const stallJson = serializeStallTimelineSnapshot(timeline);
      const res = await api.exportSupportBundle(null, stallJson);
      setStatusMsg(`${t("doctor.supportZipDone")}: ${res.path}`);
    } catch (e) {
      setErrorMsg(`${t("doctor.supportZipFail")}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }, [t, view.stalls.signals]);

  const doClearHistory = useCallback(() => {
    clearStallHistory();
    setStallHistory([]);
    setConfirmClearHistory(false);
  }, []);

  const doClearAudit = useCallback(async () => {
    setBusy("audit-clear");
    setStatusMsg(null);
    setErrorMsg(null);
    try {
      await api.auditLedgerClear();
      setAuditEntries([]);
      setConfirmClearAudit(false);
      setStatusMsg(t("reliability.audit.clearDone"));
    } catch (e) {
      setErrorMsg(`${t("reliability.audit.clearFail")}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }, [t]);

  const onExportAudit = useCallback(async () => {
    setBusy("audit-export");
    setStatusMsg(null);
    setErrorMsg(null);
    try {
      const res = await api.auditLedgerExport();
      setStatusMsg(
        t("reliability.audit.exportDone", {
          path: res.path ?? "",
        }),
      );
    } catch (e) {
      setErrorMsg(`${t("reliability.audit.exportFail")}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }, [t]);

  const openDoctor = () => {
    onClose();
    onOpenDoctor();
  };

  if (!open) return null;

  const historyChips: { id: StallKindFilter; label: string }[] = [
    { id: "all", label: t("reliability.timeline.filterAll") },
    { id: "active", label: t("reliability.stall.kind.active") },
    { id: "hard_end", label: t("reliability.stall.kind.hardEnd") },
    { id: "terminal", label: t("reliability.stall.kind.terminal") },
    { id: "end_of_turn", label: t("reliability.stall.kind.endOfTurn") },
  ];

  const auditChips: { id: AuditEventFilter; label: string }[] = [
    { id: "all", label: t("reliability.audit.filterAll") },
    {
      id: "permission",
      label: t("reliability.audit.event.permission"),
    },
    {
      id: "tool_start",
      label: t("reliability.audit.event.toolStart"),
    },
    {
      id: "tool_end",
      label: t("reliability.audit.event.toolEnd"),
    },
  ];

  const clearConfirmPortal =
    confirmClearHistory &&
    typeof document !== "undefined" &&
    createPortal(
      <div
        className="overlay app-dialog-overlay"
        role="presentation"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setConfirmClearHistory(false);
        }}
      >
        <div
          className="modal app-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="reliab-stall-history-clear-title"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <header className="modal-head">
            <h2
              id="reliab-stall-history-clear-title"
              className="modal-title"
            >
              {t("reliability.timeline.clearConfirmTitle")}
            </h2>
            <button
              type="button"
              className="icon-btn modal-close"
              onClick={() => setConfirmClearHistory(false)}
              aria-label={t("common.cancel")}
            >
              <IconClose size={16} />
            </button>
          </header>
          <div className="app-dialog__form">
            <p className="app-dialog__msg">
              {t("reliability.timeline.clearConfirmMessage")}
            </p>
            <div className="app-dialog__actions modal-actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setConfirmClearHistory(false)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn btn--danger"
                onClick={doClearHistory}
              >
                {t("reliability.timeline.clearConfirmAction")}
              </button>
            </div>
          </div>
        </div>
      </div>,
      document.body,
    );

  const clearAuditPortal =
    confirmClearAudit &&
    typeof document !== "undefined" &&
    createPortal(
      <div
        className="overlay app-dialog-overlay"
        role="presentation"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setConfirmClearAudit(false);
        }}
      >
        <div
          className="modal app-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="reliab-audit-clear-title"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <header className="modal-head">
            <h2 id="reliab-audit-clear-title" className="modal-title">
              {t("reliability.audit.clearConfirmTitle")}
            </h2>
            <button
              type="button"
              className="icon-btn modal-close"
              onClick={() => setConfirmClearAudit(false)}
              aria-label={t("common.cancel")}
            >
              <IconClose size={16} />
            </button>
          </header>
          <div className="app-dialog__form">
            <p className="app-dialog__msg">
              {t("reliability.audit.clearConfirmMessage")}
            </p>
            <div className="app-dialog__actions modal-actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setConfirmClearAudit(false)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn btn--danger"
                disabled={busy === "audit-clear"}
                onClick={() => void doClearAudit()}
                data-testid="reliab-audit-clear-confirm"
              >
                {t("reliability.audit.clearConfirmAction")}
              </button>
            </div>
          </div>
        </div>
      </div>,
      document.body,
    );

  return (
    <div
      className="overlay doctor-modal-overlay reliab-modal-overlay"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="modal doctor-modal reliab-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="reliab-modal-title"
      >
        <header className="doctor-modal__head">
          <div className="doctor-modal__title-row">
            <IconActivity size={18} />
            <h2 id="reliab-modal-title">{t("reliability.title")}</h2>
          </div>
          <button
            type="button"
            className="icon-btn modal-close doctor-modal__close"
            onClick={onClose}
            aria-label={t("reliability.close")}
          >
            <IconClose size={16} />
          </button>
        </header>

        <p className="reliab-modal__lead">{t("reliability.lead")}</p>

        {(statusMsg || errorMsg) && (
          <div className="doctor-modal__summary" aria-live="polite">
            {statusMsg ? (
              <p className="doctor-modal__status" role="status">
                {statusMsg}
              </p>
            ) : null}
            {errorMsg ? (
              <p className="doctor-modal__status doctor-modal__status--error">
                {errorMsg}
              </p>
            ) : null}
          </div>
        )}

        <div className="doctor-modal__body reliab-modal__body">
          {view.empty &&
          stallHistory.length === 0 &&
          auditEntries.length === 0 ? (
            <div className="reliab-empty" role="status">
              <IconAlertTriangle size={20} className="reliab-empty__icon" />
              <p className="reliab-empty__title">{t("reliability.empty.title")}</p>
              <p className="reliab-empty__body">{t("reliability.empty.body")}</p>
            </div>
          ) : null}

          <ProcessBudgetPanel
            locale={locale}
            active={open}
            variant="card"
            lastProcessLimit={lastProcessLimit}
            id="reliab-process-budget"
          />

          <section className="reliab-card" aria-labelledby="reliab-busy-title">
            <header className="reliab-card__head">
              <h3 id="reliab-busy-title" className="reliab-card__title">
                {t("reliability.busy.title")}
              </h3>
              <span className="reliab-card__count">
                {t("reliability.busy.count", { count: view.busy.count })}
              </span>
            </header>
            {view.hasBusy ? (
              <ul className="reliab-card__list">
                {view.busy.sessions.map((row) => (
                  <BusyRow
                    key={row.sessionId}
                    row={row}
                    t={t}
                    onSelect={onSelectSession}
                  />
                ))}
              </ul>
            ) : (
              <p className="reliab-card__empty">{t("reliability.busy.empty")}</p>
            )}
          </section>

          <section className="reliab-card" aria-labelledby="reliab-stall-title">
            <header className="reliab-card__head">
              <h3 id="reliab-stall-title" className="reliab-card__title">
                {t("reliability.stalls.title")}
              </h3>
              <span className="reliab-card__count">
                {t("reliability.stalls.count", { count: view.stalls.count })}
              </span>
            </header>
            {view.hasStalls ? (
              <ul className="reliab-card__list">
                {view.stalls.signals.map((s) => (
                  <StallRow key={s.id} signal={s} t={t} locale={locale} />
                ))}
              </ul>
            ) : (
              <p className="reliab-card__empty">{t("reliability.stalls.empty")}</p>
            )}
          </section>

          <section
            className="reliab-card"
            aria-labelledby="reliab-timeline-title"
          >
            <header className="reliab-card__head">
              <h3 id="reliab-timeline-title" className="reliab-card__title">
                {t("reliability.timeline.title")}
              </h3>
              <span className="reliab-card__count">
                {t("reliability.timeline.count", {
                  count: stallHistory.length,
                })}
              </span>
            </header>

            {stallHistory.length === 0 ? (
              <p className="reliab-card__empty">
                {t("reliability.timeline.empty")}
              </p>
            ) : (
              <>
                <div className="reliab-timeline__toolbar">
                  <label className="reliab-timeline__search">
                    <span className="sr-only">
                      {t("reliability.timeline.searchPlaceholder")}
                    </span>
                    <input
                      type="search"
                      className="reliab-timeline__search-input"
                      value={historyQuery}
                      onChange={(e) => setHistoryQuery(e.target.value)}
                      placeholder={t("reliability.timeline.searchPlaceholder")}
                      autoComplete="off"
                      data-testid="reliab-timeline-search"
                    />
                  </label>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setConfirmClearHistory(true)}
                    data-testid="reliab-timeline-clear"
                  >
                    {t("reliability.timeline.clear")}
                  </button>
                </div>

                <div
                  className="reliab-timeline__chips settings-seg"
                  role="tablist"
                  aria-label={t("reliability.timeline.filterAria")}
                >
                  {historyChips.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      role="tab"
                      className={
                        "settings-seg__btn reliab-timeline__chip" +
                        (historyKind === c.id ? " is-on" : "")
                      }
                      aria-selected={historyKind === c.id}
                      data-testid={`reliab-timeline-filter-${c.id}`}
                      onClick={() => setHistoryKind(c.id)}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>

                {filteredHistory.length === 0 ? (
                  <p className="reliab-card__empty">
                    {t("reliability.timeline.emptyFilter")}
                  </p>
                ) : (
                  <ul className="reliab-card__list">
                    {filteredHistory.map((s) => (
                      <StallRow key={s.id} signal={s} t={t} locale={locale} />
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>

          <section className="reliab-card" aria-labelledby="reliab-err-title">
            <header className="reliab-card__head">
              <h3 id="reliab-err-title" className="reliab-card__title">
                {t("reliability.errors.title")}
              </h3>
              <span className="reliab-card__count">
                {t("reliability.errors.count", { count: view.errors.count })}
              </span>
            </header>
            {view.hasErrors ? (
              <ul className="reliab-card__list">
                {view.errors.entries.map((e) => (
                  <ErrorRow key={e.id} entry={e} locale={locale} />
                ))}
              </ul>
            ) : (
              <p className="reliab-card__empty">{t("reliability.errors.empty")}</p>
            )}
          </section>

          <section
            className="reliab-card"
            aria-labelledby="reliab-audit-title"
            data-testid="reliab-audit-section"
          >
            <header className="reliab-card__head">
              <h3 id="reliab-audit-title" className="reliab-card__title">
                {t("reliability.audit.title")}
              </h3>
              <span className="reliab-card__count">
                {t("reliability.audit.count", {
                  count: auditEntries.length,
                })}
              </span>
            </header>
            <p className="reliab-card__empty" style={{ marginBottom: 8 }}>
              {t("reliability.audit.lead")}
            </p>

            <div className="reliab-timeline__toolbar">
              <label className="reliab-timeline__search">
                <span className="sr-only">
                  {t("reliability.audit.searchPlaceholder")}
                </span>
                <input
                  type="search"
                  className="reliab-timeline__search-input"
                  value={auditQuery}
                  onChange={(e) => setAuditQuery(e.target.value)}
                  placeholder={t("reliability.audit.searchPlaceholder")}
                  autoComplete="off"
                  data-testid="reliab-audit-search"
                />
              </label>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={!!busy || auditLoading}
                onClick={() => void loadAudit()}
                data-testid="reliab-audit-refresh"
              >
                {auditLoading ? "…" : t("reliability.audit.refresh")}
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={!!busy || auditEntries.length === 0}
                onClick={() => void onExportAudit()}
                data-testid="reliab-audit-export"
              >
                {busy === "audit-export" ? "…" : t("reliability.audit.export")}
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={!!busy || auditEntries.length === 0}
                onClick={() => setConfirmClearAudit(true)}
                data-testid="reliab-audit-clear"
              >
                {t("reliability.audit.clear")}
              </button>
            </div>

            <div
              className="reliab-timeline__chips settings-seg"
              role="tablist"
              aria-label={t("reliability.audit.filterAria")}
            >
              {auditChips.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="tab"
                  className={
                    "settings-seg__btn reliab-timeline__chip" +
                    (auditEvent === c.id ? " is-on" : "")
                  }
                  aria-selected={auditEvent === c.id}
                  data-testid={`reliab-audit-filter-${c.id}`}
                  onClick={() => setAuditEvent(c.id)}
                >
                  {c.label}
                </button>
              ))}
            </div>

            {auditEntries.length === 0 ? (
              <p className="reliab-card__empty">
                {t("reliability.audit.empty")}
              </p>
            ) : filteredAudit.length === 0 ? (
              <p className="reliab-card__empty">
                {t("reliability.audit.emptyFilter")}
              </p>
            ) : (
              <ul className="reliab-card__list">
                {filteredAudit.map((e, i) => (
                  <AuditRow
                    key={`${e.ts}-${e.event}-${e.toolName}-${i}`}
                    entry={e}
                    t={t}
                    locale={locale}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>

        <footer className="doctor-modal__foot reliab-modal__foot">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={!!busy}
            onClick={() => void onSupportZip()}
            title={t("reliability.supportZipHint")}
          >
            {busy === "zip" ? "…" : t("doctor.supportZip")}
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={openDoctor}
          >
            <IconDoctor size={14} />
            {t("reliability.openDoctor")}
          </button>
          <span className="doctor-modal__foot-spacer" />
          <button
            type="button"
            className="btn btn--solid btn--sm"
            onClick={onClose}
          >
            {t("common.close")}
          </button>
        </footer>
      </div>
      {clearConfirmPortal}
      {clearAuditPortal}
    </div>
  );
}
