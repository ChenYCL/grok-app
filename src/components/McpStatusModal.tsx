import { useMemo } from "react";
import type { Locale } from "@/i18n";
import { createT } from "@/i18n";
import { GlassModal } from "@/components/GlassModal";

export type McpServerRow = {
  name: string;
  transport?: string | null;
  target?: string | null;
  vendor?: string | null;
  compatibilityStatus?: string | null;
};

export function McpStatusModal({
  open,
  locale,
  servers,
  error,
  loading,
  onClose,
}: {
  open: boolean;
  locale: Locale;
  servers: McpServerRow[];
  error?: string | null;
  loading?: boolean;
  onClose: () => void;
}) {
  const tr = useMemo(() => createT(locale), [locale]);

  return (
    <GlassModal
      open={open}
      onClose={onClose}
      title={tr("mcpModal.title")}
      titleId="mcp-modal-title"
      closeLabel={tr("common.close")}
      size="md"
      className="mcp-modal"
      footer={
        <button type="button" className="btn btn--solid" onClick={onClose}>
          {tr("common.close")}
        </button>
      }
    >
      <p className="mcp-modal__hint">{tr("mcpModal.hint")}</p>
      {loading && <p className="modal-status">{tr("mcpModal.loading")}</p>}
      {error && (
        <p className="modal-status modal-status--error">{error}</p>
      )}
      {!loading && servers.length === 0 && !error && (
        <p className="modal-status">{tr("mcpModal.empty")}</p>
      )}
      {servers.length > 0 ? (
        <ul className="mcp-modal__list">
          {servers.map((s) => (
            <li key={s.name} className="mcp-modal__item">
              <strong>{s.name}</strong>
              <span>
                {[s.transport, s.compatibilityStatus, s.vendor]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              {s.target ? <em title={s.target}>{s.target}</em> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </GlassModal>
  );
}
