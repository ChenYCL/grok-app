import { useEffect, useMemo } from "react";
import type { Locale } from "@/i18n";
import { createT } from "@/i18n";
import { IconClose } from "@/components/icons";

export function StatusModal({
  open,
  locale,
  sessionId,
  agentSessionId,
  modelId,
  effort,
  mode,
  policy,
  projectPath,
  messageCount,
  onClose,
}: {
  open: boolean;
  locale: Locale;
  sessionId?: string | null;
  agentSessionId?: string | null;
  modelId?: string | null;
  effort?: string | null;
  mode?: string | null;
  policy?: string | null;
  projectPath?: string | null;
  messageCount?: number;
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

  const rows: { label: string; value: string }[] = [
    { label: tr("statusModal.sessionId"), value: sessionId || "—" },
    { label: tr("statusModal.agentSessionId"), value: agentSessionId || "—" },
    { label: tr("statusModal.model"), value: modelId || "—" },
    { label: tr("statusModal.effort"), value: effort || "—" },
    { label: tr("statusModal.mode"), value: mode || "—" },
    { label: tr("statusModal.policy"), value: policy || "—" },
    { label: tr("statusModal.project"), value: projectPath || "—" },
    {
      label: tr("statusModal.messages"),
      value: String(messageCount ?? 0),
    },
  ];

  return (
    <div className="overlay" onClick={onClose} role="presentation">
      <div
        className="modal status-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="status-modal-title"
      >
        <header className="modal-head">
          <h2 id="status-modal-title" className="modal-title">
            {tr("statusModal.title")}
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
        <dl className="status-modal__dl">
          {rows.map((r) => (
            <div key={r.label} className="status-modal__row">
              <dt>{r.label}</dt>
              <dd title={r.value}>{r.value}</dd>
            </div>
          ))}
        </dl>
        <div className="modal-actions">
          <button type="button" className="btn btn--solid" onClick={onClose}>
            {tr("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
