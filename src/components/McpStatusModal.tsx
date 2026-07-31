import { useCallback, useMemo, useState } from "react";
import type { Locale, MessageKey } from "@/i18n";
import { createT } from "@/i18n";
import { GlassModal } from "@/components/GlassModal";
import {
  IconCopy,
  IconDoctor,
  IconExternalLink,
  IconRefresh,
} from "@/components/icons";
import { mcpMetaLine } from "@/lib/extensionsUi";
import * as api from "@/lib/api";
import {
  classifyMcpOauthFinding,
  classifyMcpOauthFromStatus,
  mcpOauthActionLabelKey,
  type McpOauthAction,
} from "@/lib/mcpOauth";
import { McpOauthWizard } from "@/components/McpOauthWizard";
import {
  classifyMcpRowHealth,
  countMcpDoctorFindings,
  countMcpRowsByHealth,
  filterMcpDoctorFindings,
  filterMcpRows,
  indexDoctorServerStatuses,
  lookupServerStatus,
  mcpAuthGuidanceKey,
  mcpDoctorFindingTone,
  mcpRowCopyText,
  mcpStatusBadgeMod,
  mcpStatusLabelKey,
  normalizeMcpDoctorFindings,
  redactMcpText,
  MCP_ROW_STATUS_FILTERS,
  type McpDoctorFindingLevel,
  type McpDoctorFindingRow,
  type McpDoctorReportLike,
  type McpRowHealth,
  type McpRowStatusFilter,
  type McpServerStatus,
} from "@/lib/mcpStatus";

export type McpServerRow = {
  name: string;
  transport?: string | null;
  target?: string | null;
  vendor?: string | null;
  compatibilityStatus?: string | null;
};

type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

type OauthWizardTarget = {
  action: McpOauthAction;
  status?: McpServerStatus | null;
  /** Extra redacted reason (e.g. finding detail). */
  reason?: string | null;
};

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


function levelLabelKey(level: McpDoctorFindingLevel): MessageKey {
  if (level === "ok") return "mcpModal.doctor.level.ok";
  if (level === "warn") return "mcpModal.doctor.level.warn";
  return "mcpModal.doctor.level.fail";
}

function FindingRowView({
  row,
  tr,
  oauthAction,
  onOauth,
  oauthBusy,
}: {
  row: McpDoctorFindingRow;
  tr: (key: MessageKey, vars?: Record<string, string | number>) => string;
  oauthAction: McpOauthAction | null;
  onOauth: (action: McpOauthAction) => void;
  oauthBusy: boolean;
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
        <p className="mcp-modal__finding-detail">
          {redactMcpText(row.detail)}
        </p>
      ) : null}
      {oauthAction ? (
        <div className="mcp-modal__oauth-row ext-mcp-auth-row">
          <p className="ext-mcp-auth-hint">
            {tr(
              (oauthAction.isRetry
                ? "ext.mcp.auth.expiredHint"
                : "ext.mcp.auth.requiredHint") as MessageKey,
            )}
          </p>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={oauthBusy}
            onClick={() => onOauth(oauthAction)}
          >
            {oauthAction.preferredUrl ? (
              <IconExternalLink size={13} />
            ) : null}
            <span>
              {tr(mcpOauthActionLabelKey(oauthAction.kind) as MessageKey)}
            </span>
          </button>
        </div>
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
  onOpenExternalUrl,
  onRefreshDoctor,
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
  /** Optional doctor report from last host `mcp_doctor` call. */
  doctorReport?: McpDoctorReportLike | null;
  doctorError?: string | null;
  doctorLoading?: boolean;
  /** Focused server name when doctor was run with a name. */
  doctorFocus?: string | null;
  /** Run host doctor; optional name scopes to one server. */
  onRunDoctor?: (name?: string | null) => void;
  /**
   * Soft-fail open browser URL (defaults to host `openExternalUrl`).
   * Never pass secrets — callers only receive sanitized http(s).
   */
  onOpenExternalUrl?: (url: string) => void | Promise<void>;
  /**
   * Optional doctor runner that returns the report so the OAuth wizard can
   * evaluate success/soft-fail after “I’ve authorized”.
   */
  onRefreshDoctor?: (
    name?: string | null,
  ) => Promise<{
    report?: McpDoctorReportLike | null;
    error?: string | null;
  }>;
}) {
  const tr = useMemo(() => createT(locale), [locale]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<McpRowStatusFilter>("all");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [oauthWizard, setOauthWizard] = useState<OauthWizardTarget | null>(
    null,
  );
  const [oauthBusy, setOauthBusy] = useState(false);

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

  const [findingQuery, setFindingQuery] = useState("");
  const [serverFilter, setServerFilter] = useState<string>("");

  const doctorStatusIndex = useMemo(
    () => indexDoctorServerStatuses(doctorReport ?? null),
    [doctorReport],
  );

  const findingRows = useMemo(() => {
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

  const openExternal = useCallback(
    async (url: string) => {
      if (onOpenExternalUrl) {
        await onOpenExternalUrl(url);
        return;
      }
      if (!api.isTauri()) {
        // Browser / non-host: soft-fail open via window.
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      await api.openExternalUrl(url);
    },
    [onOpenExternalUrl],
  );

  const handleOauth = useCallback(
    (
      action: McpOauthAction,
      status?: McpServerStatus | null,
      reason?: string | null,
    ) => {
      // Open multi-step OAuth recovery wizard (never window.confirm).
      setOauthWizard({
        action,
        status: status ?? null,
        reason: reason ?? status?.reason ?? null,
      });
    },
    [],
  );

  const refreshDoctorForWizard = useCallback(
    async (serverName: string | null) => {
      if (onRefreshDoctor) {
        return onRefreshDoctor(serverName);
      }
      // Fallback: run host doctor and also notify parent (fire-and-forget).
      setOauthBusy(true);
      try {
        if (!api.isTauri()) {
          return { report: null, error: tr("ext.needTauri") };
        }
        try {
          const report = await api.mcpDoctor(serverName);
          onRunDoctor?.(serverName);
          return { report, error: null };
        } catch (e) {
          const msg = String(e);
          onRunDoctor?.(serverName);
          return { report: null, error: msg };
        }
      } finally {
        setOauthBusy(false);
      }
    },
    [onRefreshDoctor, onRunDoctor, tr],
  );

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
    <>
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
            const doctorSt = lookupServerStatus(doctorStatusIndex, s.name);
            const oauthAction = classifyMcpOauthFromStatus(doctorSt);
            // Prefer doctor tone when available (auth lamps); else inspect health.
            const health = doctorSt
              ? doctorSt.tone === "auth_expired" ||
                doctorSt.tone === "auth_required"
                ? "error"
                : doctorSt.tone === "ok"
                  ? "ok"
                  : doctorSt.tone === "warn"
                    ? "warn"
                    : doctorSt.tone === "error"
                      ? "error"
                      : classifyMcpRowHealth(s)
              : classifyMcpRowHealth(s);
            const badgeTone = doctorSt?.tone
              ? doctorSt.tone
              : health === "error"
                ? "error"
                : health === "warn"
                  ? "warn"
                  : health === "ok"
                    ? "ok"
                    : "unknown";
            const badgeMod = mcpStatusBadgeMod(badgeTone);
            const nameCopied = copiedKey === `${s.name}:name`;
            const targetCopied = copiedKey === `${s.name}:target`;
            const guidanceKey = doctorSt
              ? mcpAuthGuidanceKey(doctorSt.tone)
              : null;
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
                    title={
                      doctorSt?.reason ??
                      s.compatibilityStatus ??
                      undefined
                    }
                  >
                    {tr(mcpStatusLabelKey(badgeTone) as MessageKey)}
                  </span>
                  <span className="mcp-modal__item-actions">
                    {oauthAction ? (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={oauthBusy}
                        onClick={() =>
                          void handleOauth(oauthAction, doctorSt)
                        }
                        title={tr(
                          mcpOauthActionLabelKey(
                            oauthAction.kind,
                          ) as MessageKey,
                        )}
                        aria-label={tr(
                          mcpOauthActionLabelKey(
                            oauthAction.kind,
                          ) as MessageKey,
                        )}
                      >
                        {oauthAction.preferredUrl ? (
                          <IconExternalLink size={13} />
                        ) : null}
                        <span>
                          {tr(
                            mcpOauthActionLabelKey(
                              oauthAction.kind,
                            ) as MessageKey,
                          )}
                        </span>
                      </button>
                    ) : null}
                    {canDoctor ? (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={!!doctorLoading}
                        onClick={() => onRunDoctor?.(s.name)}
                        title={tr("mcpModal.doctor.runFor", { name: s.name })}
                        aria-label={tr("mcpModal.doctor.runFor", {
                          name: s.name,
                        })}
                      >
                        <IconDoctor size={13} />
                        <span>{tr("mcpModal.doctor.short")}</span>
                      </button>
                    ) : null}
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
                {doctorSt?.reason && doctorSt.tone !== "ok" ? (
                  <p className="mcp-modal__auth-reason ext-mcp-status-reason">
                    {redactMcpText(doctorSt.reason)}
                  </p>
                ) : null}
                {oauthAction && guidanceKey ? (
                  <div className="mcp-modal__oauth-row ext-mcp-auth-row">
                    <p className="ext-mcp-auth-hint">
                      {tr(guidanceKey as MessageKey)}
                    </p>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {canDoctor ? (
        <section className="mcp-modal__doctor" aria-label={tr("mcpModal.doctor.section")}>
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
                    <FindingRowView
                      key={row.id}
                      row={row}
                      tr={tr}
                      oauthAction={classifyMcpOauthFinding(row)}
                      onOauth={(action) => {
                        const st = action.server
                          ? lookupServerStatus(
                              doctorStatusIndex,
                              action.server,
                            )
                          : null;
                        handleOauth(
                          action,
                          st,
                          st?.reason ?? null,
                        );
                      }}
                      oauthBusy={oauthBusy}
                    />
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

    <McpOauthWizard
      open={!!oauthWizard}
      locale={locale}
      action={oauthWizard?.action ?? null}
      statusReason={
        oauthWizard?.reason ?? oauthWizard?.status?.reason ?? null
      }
      onClose={() => setOauthWizard(null)}
      onOpenExternalUrl={openExternal}
      onRefreshDoctor={refreshDoctorForWizard}
    />
    </>
  );
}
