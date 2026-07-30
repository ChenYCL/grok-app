import { useCallback, useMemo, useState } from "react";
import type { Locale, MessageKey } from "@/i18n";
import { createT } from "@/i18n";
import { GlassModal } from "@/components/GlassModal";
import { IconCopy, IconRefresh } from "@/components/icons";
import { mcpMetaLine } from "@/lib/extensionsUi";
import {
  classifyMcpRowHealth,
  countMcpRowsByHealth,
  filterMcpRows,
  mcpRowCopyText,
  mcpStatusBadgeMod,
  mcpStatusLabelKey,
  MCP_ROW_STATUS_FILTERS,
  type McpRowHealth,
  type McpRowStatusFilter,
} from "@/lib/mcpStatus";

export type McpServerRow = {
  name: string;
  transport?: string | null;
  target?: string | null;
  vendor?: string | null;
  compatibilityStatus?: string | null;
};

type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

function healthFilterLabel(filter: McpRowStatusFilter, t: TFn): string {
  if (filter === "all") return t("mcpModal.filter.all");
  // Reuse Extensions status labels (ok / warn / error / unknown).
  return t(mcpStatusLabelKey(filter) as MessageKey);
}

function healthDotClass(health: McpRowHealth): string {
  switch (health) {
    case "ok":
      return "mcp-modal__dot--ok";
    case "warn":
      return "mcp-modal__dot--warn";
    case "error":
      return "mcp-modal__dot--error";
    default:
      return "mcp-modal__dot--unknown";
  }
}

export function McpStatusModal({
  open,
  locale,
  servers,
  error,
  loading,
  onClose,
  onManage,
  onRefresh,
}: {
  open: boolean;
  locale: Locale;
  servers: McpServerRow[];
  error?: string | null;
  loading?: boolean;
  onClose: () => void;
  /** Open Settings → Extensions for full Skills/MCP management. */
  onManage?: () => void;
  /** Re-run inspect while the modal stays open. */
  onRefresh?: () => void;
}) {
  const tr = useMemo(() => createT(locale), [locale]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<McpRowStatusFilter>("all");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const statusCounts = useMemo(() => countMcpRowsByHealth(servers), [servers]);
  const filtered = useMemo(
    () => filterMcpRows(servers, { query, status: statusFilter }),
    [servers, query, statusFilter],
  );

  const hasActiveFilters =
    statusFilter !== "all" || query.trim().length > 0;
  const isEmptyCatalog = !loading && servers.length === 0 && !error;
  const isEmptyFilter =
    !loading && servers.length > 0 && filtered.length === 0;

  const copyField = useCallback(
    async (row: McpServerRow, field: "name" | "target") => {
      const text = mcpRowCopyText(row, field);
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        const key = `${row.name}:${field}`;
        setCopiedKey(key);
        window.setTimeout(() => {
          setCopiedKey((cur) => (cur === key ? null : cur));
        }, 1600);
      } catch {
        // Clipboard may be denied; leave UI unchanged.
      }
    },
    [],
  );

  return (
    <GlassModal
      open={open}
      onClose={onClose}
      title={tr("mcpModal.title")}
      titleId="mcp-modal-title"
      closeLabel={tr("common.close")}
      size="md"
      className="mcp-modal"
      wrapBody
      bodyClassName="mcp-modal__body"
      footer={
        <div className="mcp-modal__footer">
          {onManage ? (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                onManage();
                onClose();
              }}
            >
              {tr("mcpModal.manage")}
            </button>
          ) : null}
          <button type="button" className="btn btn--solid" onClick={onClose}>
            {tr("common.close")}
          </button>
        </div>
      }
    >
      <p className="mcp-modal__hint">{tr("mcpModal.hint")}</p>

      <div className="mcp-modal__toolbar">
        <input
          type="search"
          className="settings-input mcp-modal__search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tr("mcpModal.searchPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          aria-label={tr("mcpModal.searchPlaceholder")}
          disabled={loading && servers.length === 0}
        />
        {onRefresh ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm mcp-modal__refresh"
            onClick={() => onRefresh()}
            disabled={!!loading}
            title={tr("mcpModal.refresh")}
            aria-label={tr("mcpModal.refresh")}
          >
            <IconRefresh size={14} />
            <span>{loading ? tr("mcpModal.refreshing") : tr("mcpModal.refresh")}</span>
          </button>
        ) : null}
      </div>

      {servers.length > 0 || hasActiveFilters ? (
        <div
          className="mcp-modal__chips"
          role="tablist"
          aria-label={tr("mcpModal.filter.statusLabel")}
        >
          {MCP_ROW_STATUS_FILTERS.map((id) => {
            const n = statusCounts[id];
            // Hide zero-count chips except "all" and the active selection.
            if (id !== "all" && n === 0 && statusFilter !== id) return null;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={statusFilter === id}
                className={
                  "mcp-modal__chip" + (statusFilter === id ? " is-active" : "")
                }
                onClick={() => setStatusFilter(id)}
              >
                <span>{healthFilterLabel(id, (k, vars) => tr(k, vars))}</span>
                <span className="mcp-modal__chip-count">{n}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {!loading && servers.length > 0 ? (
        <p className="mcp-modal__summary" role="status">
          {hasActiveFilters
            ? tr("mcpModal.summaryFiltered", {
                shown: filtered.length,
                total: servers.length,
              })
            : tr("mcpModal.summary", { n: servers.length })}
        </p>
      ) : null}

      {loading && servers.length === 0 && (
        <p className="modal-status">{tr("mcpModal.loading")}</p>
      )}
      {error && (
        <p className="modal-status modal-status--error">{error}</p>
      )}
      {isEmptyCatalog && (
        <p className="modal-status">{tr("mcpModal.empty")}</p>
      )}
      {isEmptyFilter ? (
        <div className="mcp-modal__empty-filter">
          <p className="modal-status">{tr("mcpModal.filterEmpty")}</p>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setQuery("");
              setStatusFilter("all");
            }}
          >
            {tr("mcpModal.clearFilters")}
          </button>
        </div>
      ) : null}

      {filtered.length > 0 ? (
        <ul className="mcp-modal__list" role="list">
          {filtered.map((s) => {
            const meta = mcpMetaLine(s);
            const health = classifyMcpRowHealth(s);
            const badgeMod = mcpStatusBadgeMod(
              health === "error"
                ? "error"
                : health === "warn"
                  ? "warn"
                  : health === "ok"
                    ? "ok"
                    : "unknown",
            );
            const nameCopied = copiedKey === `${s.name}:name`;
            const targetCopied = copiedKey === `${s.name}:target`;
            return (
              <li key={s.name} className="mcp-modal__item">
                <div className="mcp-modal__item-head">
                  <span
                    className={`mcp-modal__dot ${healthDotClass(health)}`}
                    aria-hidden
                  />
                  <strong className="mcp-modal__name" title={s.name}>
                    {s.name}
                  </strong>
                  <span
                    className={"ext-badge ext-badge--" + badgeMod}
                    title={s.compatibilityStatus ?? undefined}
                  >
                    {tr(mcpStatusLabelKey(
                      health === "error"
                        ? "error"
                        : health === "warn"
                          ? "warn"
                          : health === "ok"
                            ? "ok"
                            : "unknown",
                    ) as MessageKey)}
                  </span>
                  <span className="mcp-modal__item-actions">
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm mcp-modal__copy"
                      onClick={() => void copyField(s, "name")}
                      title={tr("mcpModal.copyName")}
                      aria-label={tr("mcpModal.copyName")}
                    >
                      <IconCopy size={13} />
                      <span>
                        {nameCopied
                          ? tr("mcpModal.copied")
                          : tr("mcpModal.copyName")}
                      </span>
                    </button>
                    {s.target ? (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm mcp-modal__copy"
                        onClick={() => void copyField(s, "target")}
                        title={tr("mcpModal.copyTarget")}
                        aria-label={tr("mcpModal.copyTarget")}
                      >
                        <IconCopy size={13} />
                        <span>
                          {targetCopied
                            ? tr("mcpModal.copied")
                            : tr("mcpModal.copyTarget")}
                        </span>
                      </button>
                    ) : null}
                  </span>
                </div>
                {meta ? <span className="mcp-modal__meta">{meta}</span> : null}
                {s.target ? (
                  <em className="mcp-modal__target" title={s.target}>
                    {s.target}
                  </em>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </GlassModal>
  );
}
