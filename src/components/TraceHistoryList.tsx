/**
 * Recent session-trace exports — paths only (never file contents).
 * Used in Settings → Runtime → Diagnostics and the Traces modal.
 *
 * Manage: search filter · remove row · clear all (in-app confirm) · size if known.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { IconClose, IconCopy, IconFolder, IconTrash } from "@/components/icons";
import * as api from "@/lib/api";
import {
  TRACE_HISTORY_CHANGE_EVENT,
  TRACE_HISTORY_STORAGE_KEY,
  clearTraceHistory,
  filterTraceHistory,
  formatTraceHistorySize,
  loadTraceHistory,
  removeTraceHistory,
  traceHistoryFileName,
  traceHistoryLabel,
  type TraceHistoryEntry,
} from "@/lib/traceHistory";

export type TraceHistoryListLabels = {
  empty: string;
  emptyFilter: string;
  reveal: string;
  copyPath: string;
  copied: string;
  remove: string;
  clearAll: string;
  clearConfirmTitle: string;
  clearConfirmMessage: string;
  clearConfirmAction: string;
  cancel: string;
  searchPlaceholder: string;
  /** Optional column/section aria */
  listAria?: string;
  /** Optional badge when history notes uploaded=true (no URLs). */
  uploadedBadge?: string;
};

export type TraceHistoryListProps = {
  labels: TraceHistoryListLabels;
  /** Called after copy-path success (toast). */
  onCopied?: () => void;
  /** Called after reveal failure. */
  onError?: (msg: string) => void;
  className?: string;
  /** Compact rows for modal. */
  compact?: boolean;
};

function formatExportedAt(iso: string): string {
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

export function TraceHistoryList({
  labels,
  onCopied,
  onError,
  className = "",
  compact = false,
}: TraceHistoryListProps) {
  const [entries, setEntries] = useState<TraceHistoryEntry[]>(() =>
    loadTraceHistory(),
  );
  const [query, setQuery] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    const refresh = () => setEntries(loadTraceHistory());
    refresh();
    const onChange = () => refresh();
    window.addEventListener(TRACE_HISTORY_CHANGE_EVENT, onChange);
    // Storage events from other tabs
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === TRACE_HISTORY_STORAGE_KEY) refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(TRACE_HISTORY_CHANGE_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const filtered = useMemo(
    () => filterTraceHistory(entries, query),
    [entries, query],
  );

  const reveal = useCallback(
    async (path: string) => {
      try {
        if (api.isTauri()) await api.pathReveal(path);
      } catch (e) {
        onError?.(String(e));
      }
    },
    [onError],
  );

  const copyPath = useCallback(
    async (path: string) => {
      try {
        await navigator.clipboard.writeText(path);
        onCopied?.();
      } catch (e) {
        onError?.(String(e));
      }
    },
    [onCopied, onError],
  );

  const removeRow = useCallback((path: string) => {
    const next = removeTraceHistory(path);
    setEntries(next);
  }, []);

  const doClearAll = useCallback(() => {
    const next = clearTraceHistory();
    setEntries(next);
    setQuery("");
    setConfirmClear(false);
  }, []);

  const rootClass =
    "trace-history" +
    (compact ? " trace-history--compact" : "") +
    (className ? ` ${className}` : "");

  const toolbar =
    entries.length > 0 ? (
      <div className="trace-history-toolbar">
        <input
          type="search"
          className="trace-history-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={labels.searchPlaceholder}
          aria-label={labels.searchPlaceholder}
        />
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setConfirmClear(true)}
          title={labels.clearAll}
          aria-label={labels.clearAll}
        >
          <IconTrash size={14} />
          <span className="trace-history-row__action-label">
            {labels.clearAll}
          </span>
        </button>
      </div>
    ) : null;

  const confirmPortal =
    confirmClear &&
    typeof document !== "undefined" &&
    createPortal(
      <div
        className="overlay app-dialog-overlay"
        role="presentation"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setConfirmClear(false);
        }}
      >
        <div
          className="modal app-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="trace-history-clear-title"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <header className="modal-head">
            <h2 id="trace-history-clear-title" className="modal-title">
              {labels.clearConfirmTitle}
            </h2>
            <button
              type="button"
              className="icon-btn modal-close"
              onClick={() => setConfirmClear(false)}
              aria-label={labels.cancel}
            >
              <IconClose size={16} />
            </button>
          </header>
          <div className="app-dialog__form">
            <p className="app-dialog__msg">{labels.clearConfirmMessage}</p>
            <div className="app-dialog__actions modal-actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setConfirmClear(false)}
              >
                {labels.cancel}
              </button>
              <button
                type="button"
                className="btn btn--danger"
                onClick={doClearAll}
              >
                {labels.clearConfirmAction}
              </button>
            </div>
          </div>
        </div>
      </div>,
      document.body,
    );

  if (entries.length === 0) {
    return (
      <div className={rootClass}>
        <div className="trace-history-empty" role="status">
          {labels.empty}
        </div>
        {confirmPortal}
      </div>
    );
  }

  return (
    <div className={rootClass}>
      {toolbar}
      {filtered.length === 0 ? (
        <div className="trace-history-empty" role="status">
          {labels.emptyFilter}
        </div>
      ) : (
        <ul
          className={
            "trace-history-list" +
            (compact ? " trace-history-list--compact" : "")
          }
          aria-label={labels.listAria}
        >
          {filtered.map((e) => {
            const file = traceHistoryFileName(e.path);
            const label = traceHistoryLabel(e);
            const sizeLabel = formatTraceHistorySize(e.sizeBytes);
            return (
              <li
                key={`${e.path}|${e.exportedAt}`}
                className="trace-history-row"
              >
                <div className="trace-history-row__text">
                  <div className="trace-history-row__title" title={label}>
                    {label}
                  </div>
                  <div className="trace-history-row__meta" title={e.path}>
                    <span className="trace-history-row__file">{file}</span>
                    {sizeLabel ? (
                      <span className="trace-history-row__size">
                        {sizeLabel}
                      </span>
                    ) : null}
                    {e.uploaded && labels.uploadedBadge ? (
                      <span
                        className="trace-history-row__uploaded"
                        title={labels.uploadedBadge}
                      >
                        {labels.uploadedBadge}
                      </span>
                    ) : null}
                    {e.exportedAt ? (
                      <span className="trace-history-row__when">
                        {formatExportedAt(e.exportedAt)}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="trace-history-row__actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => void reveal(e.path)}
                    title={labels.reveal}
                    aria-label={labels.reveal}
                  >
                    <IconFolder size={14} />
                    <span className="trace-history-row__action-label">
                      {labels.reveal}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => void copyPath(e.path)}
                    title={labels.copyPath}
                    aria-label={labels.copyPath}
                  >
                    <IconCopy size={14} />
                    <span className="trace-history-row__action-label">
                      {labels.copyPath}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => removeRow(e.path)}
                    title={labels.remove}
                    aria-label={labels.remove}
                  >
                    <IconTrash size={14} />
                    <span className="trace-history-row__action-label">
                      {labels.remove}
                    </span>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {confirmPortal}
    </div>
  );
}
