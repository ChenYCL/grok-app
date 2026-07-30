import { useMemo, useState } from "react";
import type { Locale, MessageKey } from "@/i18n";
import { createT } from "@/i18n";
import { GlassModal } from "@/components/GlassModal";
import { IconDoctor, IconRefresh } from "@/components/icons";
import { mcpMetaLine } from "@/lib/extensionsUi";
import {
  countMcpDoctorFindings,
  filterMcpDoctorFindings,
  mcpDoctorFindingTone,
  mcpStatusBadgeMod,
  normalizeMcpDoctorFindings,
  type McpDoctorFindingLevel,
  type McpDoctorFindingRow,
  type McpDoctorReportLike,
} from "@/lib/mcpStatus";

export type McpServerRow = {
  name: string;
  transport?: string | null;
  target?: string | null;
  vendor?: string | null;
  compatibilityStatus?: string | null;
};

function levelLabelKey(level: McpDoctorFindingLevel): MessageKey {
  if (level === "ok") return "mcpModal.doctor.level.ok";
  if (level === "warn") return "mcpModal.doctor.level.warn";
  return "mcpModal.doctor.level.fail";
}

function FindingRowView({
  row,
  tr,
}: {
  row: McpDoctorFindingRow;
  tr: (key: MessageKey, vars?: Record<string, string | number>) => string;
}) {
  const tone = mcpDoctorFindingTone(row.level);
  const badgeMod = mcpStatusBadgeMod(tone);
  return (
    <li
      className={
        "mcp-modal__finding mcp-modal__finding--" + row.level
      }
    >
      <div className="mcp-modal__finding-head">
        <span className={"ext-badge ext-badge--" + badgeMod}>
          {tr(levelLabelKey(row.level))}
        </span>
        {row.server ? (
          <span className="mcp-modal__finding-server" title={row.server}>
            {row.server}
          </span>
        ) : null}
        <strong className="mcp-modal__finding-title">{row.title}</strong>
      </div>
      {row.detail ? (
        <p className="mcp-modal__finding-detail">{row.detail}</p>
      ) : null}
    </li>
  );
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
  doctorReport,
  doctorError,
  doctorLoading,
  doctorFocus,
  onRunDoctor,
}: {
  open: boolean;
  locale: Locale;
  servers: McpServerRow[];
  error?: string | null;
  loading?: boolean;
  onClose: () => void;
  /** Open Settings → Extensions for full Skills/MCP management. */
  onManage?: () => void;
  /** Re-run inspect while the modal stays open (coexists with doctor). */
  onRefresh?: () => void;
  /** Latest `mcp_doctor` report (host JSON). Null until first run. */
  doctorReport?: McpDoctorReportLike | null;
  doctorError?: string | null;
  doctorLoading?: boolean;
  /** Optional server name filter applied when doctor last ran. */
  doctorFocus?: string | null;
  /**
   * Run MCP doctor. Pass a server name to focus one host-reported server,
   * or null/undefined for all. Host never invents servers.
   */
  onRunDoctor?: (name?: string | null) => void;
}) {
  const tr = useMemo(() => createT(locale), [locale]);
  const [findingQuery, setFindingQuery] = useState("");
  const [serverFilter, setServerFilter] = useState<string>("");

  const findingRows = useMemo(() => {
    // Client-side filter only — host already scoped when doctor ran with a name.
    const filter = serverFilter.trim() || null;
    return normalizeMcpDoctorFindings(doctorReport ?? null, {
      server: filter,
      includeUnscoped: !filter,
    });
  }, [doctorReport, serverFilter]);

  const visibleFindings = useMemo(
    () => filterMcpDoctorFindings(findingRows, findingQuery),
    [findingRows, findingQuery],
  );

  const findingCounts = useMemo(
    () => countMcpDoctorFindings(findingRows),
    [findingRows],
  );

  const serverNamesFromDoctor = useMemo(() => {
    const names = new Set<string>();
    for (const r of normalizeMcpDoctorFindings(doctorReport ?? null)) {
      if (r.server) names.add(r.server);
    }
    // Prefer inspect list order when present (still host-discovered only).
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const s of servers) {
      if (s.name && names.has(s.name) && !seen.has(s.name)) {
        ordered.push(s.name);
        seen.add(s.name);
      }
    }
    for (const n of names) {
      if (!seen.has(n)) ordered.push(n);
    }
    return ordered;
  }, [doctorReport, servers]);

  const hasDoctorResult = !!doctorReport || !!doctorError;
  const canDoctor = typeof onRunDoctor === "function";

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
        {onRefresh ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => onRefresh()}
            disabled={!!loading}
            title={tr("mcpModal.refresh")}
            aria-label={tr("mcpModal.refresh")}
          >
            <IconRefresh size={14} />
            <span>
              {loading ? tr("mcpModal.refreshing") : tr("mcpModal.refresh")}
            </span>
          </button>
        ) : null}
        {canDoctor ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setServerFilter("");
              onRunDoctor?.(null);
            }}
            disabled={!!doctorLoading}
            title={tr("mcpModal.doctor.run")}
            aria-label={tr("mcpModal.doctor.run")}
          >
            <IconDoctor size={14} />
            <span>
              {doctorLoading
                ? tr("mcpModal.doctor.running")
                : hasDoctorResult
                  ? tr("mcpModal.doctor.rerun")
                  : tr("mcpModal.doctor.run")}
            </span>
          </button>
        ) : null}
      </div>

      {loading && servers.length === 0 && (
        <p className="modal-status">{tr("mcpModal.loading")}</p>
      )}
      {error && (
        <p className="modal-status modal-status--error">{error}</p>
      )}
      {!loading && servers.length === 0 && !error && (
        <p className="modal-status">{tr("mcpModal.empty")}</p>
      )}

      {servers.length > 0 ? (
        <ul className="mcp-modal__list" role="list">
          {servers.map((s) => {
            const meta = mcpMetaLine(s);
            return (
              <li key={s.name} className="mcp-modal__item">
                <div className="mcp-modal__item-head">
                  <strong className="mcp-modal__name" title={s.name}>
                    {s.name}
                  </strong>
                  {canDoctor ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm mcp-modal__row-doctor"
                      disabled={!!doctorLoading}
                      onClick={() => {
                        setServerFilter(s.name);
                        onRunDoctor?.(s.name);
                      }}
                      title={tr("mcpModal.doctor.runFor", { name: s.name })}
                      aria-label={tr("mcpModal.doctor.runFor", {
                        name: s.name,
                      })}
                    >
                      <IconDoctor size={13} />
                      <span>{tr("mcpModal.doctor.short")}</span>
                    </button>
                  ) : null}
                </div>
                {meta ? <span>{meta}</span> : null}
                {s.target ? <em title={s.target}>{s.target}</em> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {canDoctor ? (
        <section
          className="mcp-modal__doctor"
          aria-label={tr("mcpModal.doctor.section")}
        >
          <div className="mcp-modal__doctor-head">
            <h3 className="mcp-modal__doctor-title">
              {tr("mcpModal.doctor.section")}
              {doctorFocus ? (
                <span className="mcp-modal__doctor-focus">
                  {" "}
                  · {doctorFocus}
                </span>
              ) : null}
            </h3>
          </div>

          {doctorLoading && (
            <p className="modal-status">{tr("mcpModal.doctor.running")}</p>
          )}
          {!doctorLoading && doctorError && (
            <p className="modal-status modal-status--error">{doctorError}</p>
          )}

          {!doctorLoading && doctorReport && (
            <>
              <p className="mcp-modal__doctor-summary" role="status">
                {tr("mcpModal.doctor.summary", {
                  ok: findingCounts.ok,
                  warn: findingCounts.warn,
                  fail: findingCounts.fail,
                })}
              </p>

              {serverNamesFromDoctor.length > 0 ? (
                <div
                  className="mcp-modal__chips"
                  role="tablist"
                  aria-label={tr("mcpModal.doctor.filterServer")}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={!serverFilter}
                    className={
                      "mcp-modal__chip" + (!serverFilter ? " is-active" : "")
                    }
                    onClick={() => setServerFilter("")}
                  >
                    {tr("mcpModal.doctor.filterAll")}
                  </button>
                  {serverNamesFromDoctor.map((name) => (
                    <button
                      key={name}
                      type="button"
                      role="tab"
                      aria-selected={serverFilter === name}
                      className={
                        "mcp-modal__chip" +
                        (serverFilter === name ? " is-active" : "")
                      }
                      onClick={() => setServerFilter(name)}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              ) : null}

              <input
                type="search"
                className="settings-input mcp-modal__search"
                value={findingQuery}
                onChange={(e) => setFindingQuery(e.target.value)}
                placeholder={tr("mcpModal.doctor.searchPlaceholder")}
                autoComplete="off"
                spellCheck={false}
                aria-label={tr("mcpModal.doctor.searchPlaceholder")}
              />

              {visibleFindings.length === 0 ? (
                <p className="modal-status">
                  {findingRows.length === 0
                    ? tr("mcpModal.doctor.empty")
                    : tr("mcpModal.doctor.filterEmpty")}
                </p>
              ) : (
                <ul className="mcp-modal__findings" role="list">
                  {visibleFindings.map((row) => (
                    <FindingRowView key={row.id} row={row} tr={tr} />
                  ))}
                </ul>
              )}
            </>
          )}

          {!doctorLoading && !doctorReport && !doctorError && (
            <p className="mcp-modal__doctor-idle">
              {tr("mcpModal.doctor.idle")}
            </p>
          )}
        </section>
      ) : null}
    </GlassModal>
  );
}
