/**
 * Phone-only account / status sheet (top-bar account button).
 * Holds host account summary + connection status pills that used to
 * crowd the 390px top bar. Desktop never mounts this.
 */

import { useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { IconClose, IconPanelRight, IconUser } from "@/components/icons";

export type PhoneAccountSheetProps = {
  open: boolean;
  onClose: () => void;
  labels: {
    title: string;
    close: string;
    hostAccount: string;
    linkStatus: string;
    agentStatus: string;
    openFiles: string;
    connected: string;
    reconnecting: string;
  };
  hostLabel: string | null;
  linkOk: boolean;
  agentStatusLabel: string;
  agentTone: "ok" | "warn" | "err" | "muted";
  onOpenFiles: () => void;
};

export function PhoneAccountSheet({
  open,
  onClose,
  labels,
  hostLabel,
  linkOk,
  agentStatusLabel,
  agentTone,
  onOpenFiles,
}: PhoneAccountSheetProps) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="phone-sheet" role="presentation">
      <button
        type="button"
        className="phone-sheet__scrim"
        aria-label={labels.close}
        onClick={onClose}
      />
      <div
        className="phone-sheet__panel phone-sheet__panel--account"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="phone-sheet__handle" aria-hidden />
        <div className="phone-sheet__head">
          <span className="phone-sheet__icon-btn phone-sheet__icon-btn--spacer" />
          <h2 id={titleId} className="phone-sheet__title">
            {labels.title}
          </h2>
          <button
            type="button"
            className="phone-sheet__icon-btn"
            onClick={onClose}
            aria-label={labels.close}
          >
            <IconClose size={18} />
          </button>
        </div>
        <div className="phone-sheet__body">
          <div className="phone-account__card">
            <div className="phone-account__avatar" aria-hidden>
              <IconUser size={22} />
            </div>
            <div className="phone-account__meta">
              <span className="phone-account__label">{labels.hostAccount}</span>
              <span className="phone-account__name">
                {hostLabel || labels.reconnecting}
              </span>
            </div>
          </div>

          <div className="phone-account__status-list">
            <div className="phone-account__status-row">
              <span className="phone-account__status-label">
                {labels.linkStatus}
              </span>
              <span
                className={
                  "status-pill status-pill--" + (linkOk ? "ok" : "warn")
                }
              >
                <span className="status-pill__dot" aria-hidden />
                {linkOk ? labels.connected : labels.reconnecting}
              </span>
            </div>
            <div className="phone-account__status-row">
              <span className="phone-account__status-label">
                {labels.agentStatus}
              </span>
              <span className={`status-pill status-pill--${agentTone}`}>
                <span className="status-pill__dot" aria-hidden />
                {agentStatusLabel}
              </span>
            </div>
          </div>

          <button
            type="button"
            className="phone-sheet__row"
            onClick={() => {
              onOpenFiles();
              onClose();
            }}
          >
            <span className="phone-sheet__row-icon" aria-hidden>
              <IconPanelRight size={20} />
            </span>
            <span className="phone-sheet__row-label">{labels.openFiles}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
