/**
 * Structured Doctor health UI — checks with ok/warn/fail, re-run, copy, close.
 * Replaces the previous raw JSON `<pre>` dump.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  IconAlertTriangle,
  IconCheck,
  IconClose,
  IconCopy,
  IconDoctor,
  IconRefresh,
} from "@/components/icons";
import { createT, type Locale, type MessageKey } from "@/i18n";
import * as api from "@/lib/api";
import type { DoctorCheck, DoctorLevel, DoctorReport } from "@/lib/api";
import { redact } from "@/lib/redact";

export type DoctorModalProps = {
  open: boolean;
  onClose: () => void;
  locale: Locale;
};

const CHECK_TITLE_KEYS: Record<string, MessageKey> = {
  cli: "doctor.check.cli",
  auth: "doctor.check.auth",
  workspace: "doctor.check.workspace",
  backend: "doctor.check.backend",
  logs: "doctor.check.logs",
};

function levelLabelKey(level: DoctorLevel): MessageKey {
  if (level === "warn") return "doctor.level.warn";
  if (level === "fail") return "doctor.level.fail";
  return "doctor.level.ok";
}

function checkTitle(
  check: DoctorCheck,
  t: ReturnType<typeof createT>,
): string {
  const key = CHECK_TITLE_KEYS[check.id];
  return key ? t(key) : check.title;
}

function formatGeneratedAt(iso: string, locale: Locale): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
      dateStyle: "medium",
      timeStyle: "medium",
    });
  } catch {
    return iso;
  }
}

function LevelIcon({ level }: { level: DoctorLevel }) {
  if (level === "fail") {
    return <IconClose size={14} className="doctor-check__icon" />;
  }
  if (level === "warn") {
    return <IconAlertTriangle size={14} className="doctor-check__icon" />;
  }
  return <IconCheck size={14} className="doctor-check__icon" />;
}

export function DoctorModal({ open, onClose, locale }: DoctorModalProps) {
  const t = useMemo(() => createT(locale), [locale]);
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const next = await api.doctorReport();
      setReport(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void run();
  }, [open, run]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const onCopy = async () => {
    if (!report) return;
    const payload = report.raw ?? report;
    const text = redact(JSON.stringify(payload, null, 2));
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError(t("doctor.error"));
    }
  };

  if (!open) return null;

  const summary = report?.summary;
  const checks = report?.checks ?? [];

  return (
    <div
      className="overlay doctor-modal-overlay"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="modal doctor-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="doctor-modal-title"
      >
        <header className="doctor-modal__head">
          <div className="doctor-modal__title-row">
            <IconDoctor size={18} />
            <h2 id="doctor-modal-title">{t("doctor.title")}</h2>
          </div>
          <button
            type="button"
            className="icon-btn modal-close doctor-modal__close"
            onClick={onClose}
            aria-label={t("doctor.close")}
          >
            <IconClose size={16} />
          </button>
        </header>

        {summary && !loading && (
          <div className="doctor-modal__summary" aria-live="polite">
            <span
              className={`doctor-summary-pill doctor-summary-pill--ok${
                summary.ok ? " is-active" : ""
              }`}
            >
              {summary.ok} {t("doctor.level.ok")}
            </span>
            <span
              className={`doctor-summary-pill doctor-summary-pill--warn${
                summary.warn ? " is-active" : ""
              }`}
            >
              {summary.warn} {t("doctor.level.warn")}
            </span>
            <span
              className={`doctor-summary-pill doctor-summary-pill--fail${
                summary.fail ? " is-active" : ""
              }`}
            >
              {summary.fail} {t("doctor.level.fail")}
            </span>
            {report?.generatedAt && (
              <span className="doctor-modal__ts">
                {t("doctor.generatedAt", {
                  time: formatGeneratedAt(report.generatedAt, locale),
                })}
              </span>
            )}
          </div>
        )}

        <div className="doctor-modal__body">
          {loading && (
            <p className="doctor-modal__status">{t("doctor.loading")}</p>
          )}
          {!loading && error && (
            <p className="doctor-modal__status doctor-modal__status--error">
              {t("doctor.error")}: {error}
            </p>
          )}
          {!loading && !error && checks.length === 0 && (
            <p className="doctor-modal__status">{t("doctor.empty")}</p>
          )}
          {!loading && checks.length > 0 && (
            <ul className="doctor-checks">
              {checks.map((c) => (
                <li
                  key={c.id}
                  className={`doctor-check doctor-check--${c.level}`}
                >
                  <div className="doctor-check__badge" aria-hidden>
                    <LevelIcon level={c.level} />
                  </div>
                  <div className="doctor-check__main">
                    <div className="doctor-check__row">
                      <span className="doctor-check__title">
                        {checkTitle(c, t)}
                      </span>
                      <span
                        className={`doctor-check__level doctor-check__level--${c.level}`}
                      >
                        {t(levelLabelKey(c.level))}
                      </span>
                    </div>
                    <p className="doctor-check__detail">{c.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="doctor-modal__foot">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void run()}
            disabled={loading}
          >
            <IconRefresh size={14} />
            {t("doctor.rerun")}
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void onCopy()}
            disabled={!report || loading}
          >
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            {copied ? t("doctor.copied") : t("doctor.copy")}
          </button>
          <span className="doctor-modal__foot-spacer" />
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={onClose}
          >
            {t("doctor.close")}
          </button>
        </footer>
      </div>
    </div>
  );
}
