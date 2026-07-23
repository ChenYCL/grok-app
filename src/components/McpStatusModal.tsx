import { useEffect, useMemo } from "react";
import type { Locale } from "@/i18n";
import { createT } from "@/i18n";
import { IconClose } from "@/components/icons";

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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="overlay" onClick={onClose} role="presentation">
      <div
        className="modal mcp-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-modal-title"
      >
        <header className="modal-head">
          <h2 id="mcp-modal-title" className="modal-title">
            {tr("mcpModal.title")}
          </h2>
          <button
            type="button"
            className="icon-btn modal-close"
            onClick={onClose}
            aria-label={tr("common.close")}
          >
            <IconClose size={16} />
          </button>
        </header>
        <p className="mcp-modal__hint">{tr("mcpModal.hint")}</p>
        {loading && (
          <p className="modal-status">{tr("mcpModal.loading")}</p>
        )}
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
        <div className="modal-actions">
          <button type="button" className="btn btn--solid" onClick={onClose}>
            {tr("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
