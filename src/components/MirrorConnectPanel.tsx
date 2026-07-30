/**
 * Phone mirror connect UI — QR + public URL + start/stop host.
 * - `modal`: legacy GlassModal (optional; settings uses inline).
 * - `inline`: settings card body (Remote control → Phone mirror tab).
 * Closing the UI does NOT stop the host — only 停止主机 does.
 *
 * Write-ACL audit (localStorage ring) records write enable/disable,
 * token rotate, and optional host start/stop — never stores secrets.
 *
 * Harden: write categories + broad warning, max clients, rotate confirm.
 */

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { GlassModal } from "@/components/GlassModal";
import { IconCopy, IconDeviceMobile } from "@/components/icons";
import type { MirrorPhase, MirrorStatus } from "@/lib/api";
import * as api from "@/lib/api";
import {
  MIRROR_WRITE_AUDIT_CHANGE_EVENT,
  MIRROR_WRITE_AUDIT_STORAGE_KEY,
  clearMirrorWriteAudit,
  loadMirrorWriteAudit,
  recordMirrorWriteAudit,
  type MirrorWriteAuditEvent,
  type MirrorWriteAuditType,
} from "@/lib/mirrorWriteAudit";
import {
  MIRROR_DEFAULT_MAX_CLIENTS,
  MIRROR_MAX_CLIENTS_CAP,
  MIRROR_MIN_CLIENTS,
  MIRROR_WRITE_CATEGORIES,
  isBroadMirrorWriteSurface,
  normalizeMirrorMaxClients,
  type MirrorWriteCategoryId,
} from "@/lib/mirrorWriteSurface";

export type MirrorConnectLabels = {
  title: string;
  close: string;
  start: string;
  stop: string;
  stopConfirmTitle: string;
  stopConfirmMessage: string;
  stopConfirmOk: string;
  cancel: string;
  copyLink: string;
  copied: string;
  clients: string;
  phaseStopped: string;
  phaseStarting: string;
  phaseLocal: string;
  phaseWaitingTunnel: string;
  phaseLive: string;
  phaseTunnelDead: string;
  phaseError: string;
  hint: string;
  warningToken: string;
  missingCloudflared: string;
  errorGeneric: string;
  qrAlt: string;
  linkLabel: string;
  rotate: string;
  rotateDone: string;
  /** Confirm before regenerating the link (invalidates old QR). */
  rotateConfirmTitle: string;
  rotateConfirmMessage: string;
  rotateConfirmMessageClients: string;
  rotateConfirmOk: string;
  allowWrite: string;
  readOnlyOn: string;
  readOnlyHint: string;
  /** Confirm dialog when enabling phone writes. */
  writeConfirmTitle: string;
  writeConfirmMessage: string;
  writeConfirmOk: string;
  /** Persistent banner while phone write is enabled. */
  writeEnabledBanner: string;
  /** Write-category section while write is on. */
  writeCategoriesTitle: string;
  writeCategoriesHint: string;
  writeBroadWarn: string;
  writeCategorySend: string;
  writeCategoryStop: string;
  writeCategorySessions: string;
  writeCategoryPermissions: string;
  writeCategoryAskUser: string;
  writeCategoryPlan: string;
  writeCategoryDelete: string;
  writeCategoryRename: string;
  /** Optional concurrent phone client cap. */
  maxClientsLabel: string;
  maxClientsHint: string;
  maxClientsValue: string;
  /** Collapsible local write-ACL audit log. */
  auditTitle: string;
  auditEmpty: string;
  auditClear: string;
  auditClearConfirmTitle: string;
  auditClearConfirmMessage: string;
  auditClearConfirmOk: string;
  auditTypeWriteEnabled: string;
  auditTypeWriteDisabled: string;
  auditTypeTokenRotated: string;
  auditTypeHostStarted: string;
  auditTypeHostStopped: string;
};

export type MirrorConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
};

export type MirrorConnectPanelProps = {
  /**
   * `modal` — GlassModal dialog.
   * `inline` — embed in settings (no modal chrome).
   */
  variant?: "modal" | "inline";
  /**
   * Modal: panel open. Inline: when true (default), poll + auto-start while mounted.
   * Set false to pause without unmounting.
   */
  open?: boolean;
  onClose?: () => void;
  labels: MirrorConnectLabels;
  /**
   * In-app confirm for stop / enable-write (no window.confirm).
   * Prefer GlassModal / setAppDialog from the parent.
   */
  onRequestConfirm: (opts: MirrorConfirmRequest) => void;
  showToast: (msg: string, ms?: number) => void;
  /**
   * Inline only: auto-start host when the panel becomes active (default true).
   * Modal always auto-starts on open.
   */
  autoStart?: boolean;
};

function phaseLabel(phase: MirrorPhase, labels: MirrorConnectLabels): string {
  switch (phase) {
    case "stopped":
      return labels.phaseStopped;
    case "starting":
      return labels.phaseStarting;
    case "local":
      return labels.phaseLocal;
    case "waiting_tunnel":
      return labels.phaseWaitingTunnel;
    case "live":
      return labels.phaseLive;
    case "tunnel_dead":
      return labels.phaseTunnelDead;
    case "error":
      return labels.phaseError;
    default:
      return phase;
  }
}

function emptyStatus(): MirrorStatus {
  return {
    running: false,
    publicUrl: null,
    localPort: null,
    token: null,
    tokenTail: null,
    clients: 0,
    maxClients: MIRROR_DEFAULT_MAX_CLIENTS,
    phase: "stopped",
    error: null,
    readOnly: true,
  };
}

function categoryLabel(
  id: MirrorWriteCategoryId,
  labels: MirrorConnectLabels,
): string {
  switch (id) {
    case "send":
      return labels.writeCategorySend;
    case "stop":
      return labels.writeCategoryStop;
    case "sessions":
      return labels.writeCategorySessions;
    case "permissions":
      return labels.writeCategoryPermissions;
    case "askUser":
      return labels.writeCategoryAskUser;
    case "plan":
      return labels.writeCategoryPlan;
    case "delete":
      return labels.writeCategoryDelete;
    case "rename":
      return labels.writeCategoryRename;
    default:
      return id;
  }
}

function formatAuditAt(iso: string): string {
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

function auditTypeLabel(
  type: MirrorWriteAuditType,
  labels: MirrorConnectLabels,
): string {
  switch (type) {
    case "write_enabled":
      return labels.auditTypeWriteEnabled;
    case "write_disabled":
      return labels.auditTypeWriteDisabled;
    case "token_rotated":
      return labels.auditTypeTokenRotated;
    case "host_started":
      return labels.auditTypeHostStarted;
    case "host_stopped":
      return labels.auditTypeHostStopped;
    default:
      return type;
  }
}

function MirrorWriteAuditSection({
  labels,
  onRequestConfirm,
}: {
  labels: MirrorConnectLabels;
  onRequestConfirm: (opts: MirrorConfirmRequest) => void;
}) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<MirrorWriteAuditEvent[]>(() =>
    loadMirrorWriteAudit(),
  );

  useEffect(() => {
    const refresh = () => setEvents(loadMirrorWriteAudit());
    refresh();
    const onChange = () => refresh();
    window.addEventListener(MIRROR_WRITE_AUDIT_CHANGE_EVENT, onChange);
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === MIRROR_WRITE_AUDIT_STORAGE_KEY) refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(MIRROR_WRITE_AUDIT_CHANGE_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const handleClear = () => {
    onRequestConfirm({
      title: labels.auditClearConfirmTitle,
      message: labels.auditClearConfirmMessage,
      confirmLabel: labels.auditClearConfirmOk,
      onConfirm: () => {
        setEvents(clearMirrorWriteAudit());
      },
    });
  };

  return (
    <div className="mirror-connect__audit">
      <div className="mirror-connect__audit-head">
        <button
          type="button"
          className="mirror-connect__audit-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="mirror-connect__audit-chevron" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
          <span className="mirror-connect__audit-title">{labels.auditTitle}</span>
          {events.length > 0 ? (
            <span className="mirror-connect__audit-count">{events.length}</span>
          ) : null}
        </button>
        {open && events.length > 0 ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm mirror-connect__audit-clear"
            onClick={handleClear}
          >
            {labels.auditClear}
          </button>
        ) : null}
      </div>
      {open ? (
        events.length === 0 ? (
          <p className="mirror-connect__audit-empty" role="status">
            {labels.auditEmpty}
          </p>
        ) : (
          <ul className="mirror-connect__audit-list" aria-label={labels.auditTitle}>
            {events.map((e) => (
              <li key={e.id} className="mirror-connect__audit-row">
                <span className="mirror-connect__audit-when" title={e.at}>
                  {formatAuditAt(e.at)}
                </span>
                <span className="mirror-connect__audit-label">
                  {auditTypeLabel(e.type, labels)}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

function MirrorWriteCategories({ labels }: { labels: MirrorConnectLabels }) {
  const broad = isBroadMirrorWriteSurface();
  return (
    <div className="mirror-connect__write-surface" role="region" aria-label={labels.writeCategoriesTitle}>
      <div className="mirror-connect__write-surface-head">
        <span className="mirror-connect__write-surface-title">
          {labels.writeCategoriesTitle}
        </span>
        {broad ? (
          <span className="mirror-connect__write-surface-broad" role="status">
            {labels.writeBroadWarn}
          </span>
        ) : null}
      </div>
      <p className="mirror-connect__write-surface-hint">{labels.writeCategoriesHint}</p>
      <ul className="mirror-connect__write-cats">
        {MIRROR_WRITE_CATEGORIES.map((c) => (
          <li key={c.id} className="mirror-connect__write-cat">
            {categoryLabel(c.id, labels)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MirrorConnectBody({
  labels,
  status,
  busy,
  err,
  qrDataUrl,
  maxClientsDraft,
  onMaxClientsChange,
  onMaxClientsCommit,
  onCopy,
  onStart,
  onStop,
  onRotate,
  onToggleReadOnly,
  onRequestConfirm,
}: {
  labels: MirrorConnectLabels;
  status: MirrorStatus;
  busy: boolean;
  err: string | null;
  qrDataUrl: string | null;
  maxClientsDraft: number;
  onMaxClientsChange: (n: number) => void;
  onMaxClientsCommit: () => void;
  onCopy: () => void;
  onStart: () => void;
  onStop: () => void;
  onRotate: () => void;
  onToggleReadOnly: () => void;
  onRequestConfirm: (opts: MirrorConfirmRequest) => void;
}) {
  const phase = status.phase;
  const showQr = !!status.publicUrl && (phase === "live" || phase === "local");
  const writeOn = status.running && status.readOnly === false;

  return (
    <>
      <p className="mirror-connect__hint">{labels.hint}</p>

      <div
        className={
          "mirror-connect__phase" +
          (phase === "live" || phase === "local"
            ? " mirror-connect__phase--ok"
            : phase === "error" || phase === "tunnel_dead"
              ? " mirror-connect__phase--err"
              : "")
        }
        role="status"
      >
        <span className="mirror-connect__phase-dot" aria-hidden />
        {phaseLabel(phase, labels)}
        {status.running && status.clients > 0 ? (
          <span className="mirror-connect__clients">
            · {labels.clients.replace("{n}", String(status.clients))}
          </span>
        ) : null}
      </div>

      {(err || status.error) && (
        <div className="mirror-connect__error" role="alert">
          {(err || status.error || "").includes("cloudflared")
            ? labels.missingCloudflared
            : err || status.error}
        </div>
      )}

      {showQr && qrDataUrl ? (
        <div className="mirror-connect__qr-wrap">
          <img
            className="mirror-connect__qr"
            src={qrDataUrl}
            width={220}
            height={220}
            alt={labels.qrAlt}
          />
        </div>
      ) : (
        <div className="mirror-connect__qr-placeholder" aria-hidden>
          {busy || phase === "starting" || phase === "waiting_tunnel"
            ? "…"
            : null}
        </div>
      )}

      {status.publicUrl ? (
        <div className="mirror-connect__link-row">
          <label className="mirror-connect__link-label">{labels.linkLabel}</label>
          <div className="mirror-connect__link-box">
            <code className="mirror-connect__url" title={status.publicUrl}>
              {status.publicUrl}
            </code>
            <button
              type="button"
              className="btn btn--ghost mirror-connect__copy"
              onClick={() => void onCopy()}
              title={labels.copyLink}
            >
              <IconCopy size={16} />
              {labels.copyLink}
            </button>
          </div>
          <p className="mirror-connect__warn">{labels.warningToken}</p>
        </div>
      ) : null}

      <div className="mirror-connect__max-clients">
        <label className="mirror-connect__max-clients-label" htmlFor="mirror-max-clients">
          {labels.maxClientsLabel}
        </label>
        <div className="mirror-connect__max-clients-row">
          <input
            id="mirror-max-clients"
            className="mirror-connect__max-clients-input"
            type="number"
            min={MIRROR_MIN_CLIENTS}
            max={MIRROR_MAX_CLIENTS_CAP}
            step={1}
            disabled={busy}
            value={maxClientsDraft}
            onChange={(e) => {
              const n = normalizeMirrorMaxClients(e.target.value);
              onMaxClientsChange(n);
            }}
            onBlur={() => onMaxClientsCommit()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onMaxClientsCommit();
                (e.target as HTMLInputElement).blur();
              }
            }}
            aria-describedby="mirror-max-clients-hint"
          />
          <span className="mirror-connect__max-clients-value" aria-hidden>
            {labels.maxClientsValue
              .replace("{n}", String(maxClientsDraft))
              .replace("{max}", String(MIRROR_MAX_CLIENTS_CAP))}
          </span>
        </div>
        <p id="mirror-max-clients-hint" className="mirror-connect__max-clients-hint">
          {labels.maxClientsHint}
        </p>
      </div>

      <div className="mirror-connect__footer">
        {status.running ? (
          <button
            type="button"
            className="btn btn--danger"
            disabled={busy}
            onClick={onStop}
          >
            {labels.stop}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={onStart}
          >
            {labels.start}
          </button>
        )}
        {status.running ? (
          <>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={onRotate}
            >
              {labels.rotate}
            </button>
            <button
              type="button"
              className={
                "btn btn--ghost" +
                (status.readOnly ? "" : " mirror-connect__write-toggle--on")
              }
              disabled={busy}
              onClick={onToggleReadOnly}
              aria-pressed={!status.readOnly}
            >
              {status.readOnly ? labels.allowWrite : labels.readOnlyOn}
            </button>
          </>
        ) : null}
      </div>
      {status.running && status.readOnly ? (
        <p className="mirror-connect__hint">{labels.readOnlyHint}</p>
      ) : null}
      {writeOn ? (
        <>
          <div
            className="mirror-connect__write-banner"
            role="status"
            aria-live="polite"
          >
            <span className="mirror-connect__write-banner-chip" aria-hidden>
              !
            </span>
            <span className="mirror-connect__write-banner-text">
              {labels.writeEnabledBanner}
            </span>
          </div>
          <MirrorWriteCategories labels={labels} />
        </>
      ) : null}

      <MirrorWriteAuditSection
        labels={labels}
        onRequestConfirm={onRequestConfirm}
      />
    </>
  );
}

export function MirrorConnectPanel({
  variant = "modal",
  open = true,
  onClose,
  labels,
  onRequestConfirm,
  showToast,
  autoStart = true,
}: MirrorConnectPanelProps) {
  const [status, setStatus] = useState<MirrorStatus>(emptyStatus);
  const [busy, setBusy] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [maxClientsDraft, setMaxClientsDraft] = useState(
    MIRROR_DEFAULT_MAX_CLIENTS,
  );

  const active = variant === "inline" ? open !== false : !!open;

  /** Update status/error. Optionally sync max-clients draft (not on poll — would clobber edits). */
  const applyStatus = useCallback(
    (st: MirrorStatus, opts?: { syncMaxClients?: boolean }) => {
      setStatus(st);
      setErr(st.error);
      if (opts?.syncMaxClients) {
        setMaxClientsDraft(
          normalizeMirrorMaxClients(
            st.maxClients ?? MIRROR_DEFAULT_MAX_CLIENTS,
          ),
        );
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    try {
      const st = await api.mirrorStatus();
      // Poll: keep status.clients/phase fresh; leave maxClientsDraft alone.
      applyStatus(st);
    } catch (e) {
      setErr(String(e));
    }
  }, [applyStatus]);

  // When active: optionally auto-start, then poll status.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setBusy(true);
    setErr(null);
    void (async () => {
      try {
        if (autoStart) {
          const st = await api.mirrorStart();
          if (cancelled) return;
          applyStatus(st, { syncMaxClients: true });
        } else {
          try {
            const st = await api.mirrorStatus();
            if (!cancelled) applyStatus(st, { syncMaxClients: true });
          } catch (e) {
            if (!cancelled) setErr(String(e));
          }
        }
      } catch (e) {
        if (!cancelled) {
          setErr(String(e));
          await refresh();
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();

    const id = window.setInterval(() => {
      void refresh();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active, autoStart, refresh, applyStatus]);

  // Render QR whenever public URL is available.
  useEffect(() => {
    const url = status.publicUrl;
    if (!url) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(url, {
      width: 220,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#111111", light: "#ffffff" },
    })
      .then((data) => {
        if (!cancelled) setQrDataUrl(data);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [status.publicUrl]);

  const doRotate = () => {
    void (async () => {
      try {
        const st = await api.mirrorRotateToken();
        applyStatus(st, { syncMaxClients: true });
        // Never log token/URL — type only.
        recordMirrorWriteAudit({ type: "token_rotated" });
        showToast?.(labels.rotateDone);
      } catch (e) {
        setErr(String(e));
      }
    })();
  };

  const handleRotate = () => {
    // Regenerating the link invalidates every phone session — confirm in-app.
    const n = status.clients ?? 0;
    const message =
      n > 0
        ? labels.rotateConfirmMessageClients.replace("{n}", String(n))
        : labels.rotateConfirmMessage;
    onRequestConfirm({
      title: labels.rotateConfirmTitle,
      message,
      confirmLabel: labels.rotateConfirmOk,
      onConfirm: doRotate,
    });
  };

  const applyReadOnly = (readOnly: boolean) => {
    void (async () => {
      try {
        const st = await api.mirrorSetReadOnly(readOnly);
        applyStatus(st, { syncMaxClients: true });
        recordMirrorWriteAudit({
          type: readOnly ? "write_disabled" : "write_enabled",
        });
      } catch (e) {
        setErr(String(e));
      }
    })();
  };

  const handleToggleReadOnly = () => {
    // Enabling write is a high-risk action — always confirm in-app (never window.confirm).
    if (status.readOnly) {
      onRequestConfirm({
        title: labels.writeConfirmTitle,
        message: labels.writeConfirmMessage,
        confirmLabel: labels.writeConfirmOk,
        onConfirm: () => applyReadOnly(false),
      });
      return;
    }
    // Reverting to read-only is safe; no confirm.
    applyReadOnly(true);
  };

  const handleMaxClientsCommit = () => {
    const next = normalizeMirrorMaxClients(maxClientsDraft);
    setMaxClientsDraft(next);
    const current = normalizeMirrorMaxClients(
      status.maxClients ?? MIRROR_DEFAULT_MAX_CLIENTS,
    );
    if (next === current) return;
    void (async () => {
      try {
        const st = await api.mirrorSetMaxClients(next);
        applyStatus(st, { syncMaxClients: true });
      } catch (e) {
        setErr(String(e));
        setMaxClientsDraft(current);
      }
    })();
  };

  const handleCopy = async () => {
    const url = status.publicUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      showToast(labels.copied, 1800);
    } catch {
      showToast(labels.errorGeneric, 3000);
    }
  };

  const handleStart = () => {
    setBusy(true);
    void api
      .mirrorStart()
      .then((st) => {
        applyStatus(st, { syncMaxClients: true });
        // Explicit user start only (auto-start on open does not audit).
        if (st.running) {
          recordMirrorWriteAudit({ type: "host_started" });
        }
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setBusy(false));
  };

  const handleStop = () => {
    onRequestConfirm({
      title: labels.stopConfirmTitle,
      message: labels.stopConfirmMessage,
      confirmLabel: labels.stopConfirmOk,
      onConfirm: () => {
        setBusy(true);
        void api
          .mirrorStop()
          .then((st) => {
            applyStatus(st, { syncMaxClients: true });
            setErr(null);
            recordMirrorWriteAudit({ type: "host_stopped" });
            showToast(labels.phaseStopped, 2000);
          })
          .catch((e) => setErr(String(e)))
          .finally(() => setBusy(false));
      },
    });
  };

  const body = (
    <MirrorConnectBody
      labels={labels}
      status={status}
      busy={busy}
      err={err}
      qrDataUrl={qrDataUrl}
      maxClientsDraft={maxClientsDraft}
      onMaxClientsChange={setMaxClientsDraft}
      onMaxClientsCommit={handleMaxClientsCommit}
      onCopy={() => void handleCopy()}
      onStart={handleStart}
      onStop={handleStop}
      onRotate={handleRotate}
      onToggleReadOnly={handleToggleReadOnly}
      onRequestConfirm={onRequestConfirm}
    />
  );

  if (variant === "inline") {
    if (!active) return null;
    // No second page title — settings shell already has h1 + tab strip.
    return <div className="mirror-connect mirror-connect--inline">{body}</div>;
  }

  return (
    <GlassModal
      open={!!open}
      onClose={onClose ?? (() => {})}
      title={
        <span className="mirror-connect__title">
          <IconDeviceMobile size={18} />
          {labels.title}
        </span>
      }
      size="md"
      closeLabel={labels.close}
      wrapBody
      bodyClassName="mirror-connect"
      footer={
        <div className="mirror-connect__footer">
          {status.running ? (
            <button
              type="button"
              className="btn btn--danger"
              disabled={busy}
              onClick={handleStop}
            >
              {labels.stop}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy}
              onClick={handleStart}
            >
              {labels.start}
            </button>
          )}
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onClose}
          >
            {labels.close}
          </button>
        </div>
      }
    >
      {/* Footer owns actions in modal; body omits duplicate footer via split — reuse hint block only */}
      <p className="mirror-connect__hint">{labels.hint}</p>

      <div
        className={
          "mirror-connect__phase" +
          (status.phase === "live" || status.phase === "local"
            ? " mirror-connect__phase--ok"
            : status.phase === "error" || status.phase === "tunnel_dead"
              ? " mirror-connect__phase--err"
              : "")
        }
        role="status"
      >
        <span className="mirror-connect__phase-dot" aria-hidden />
        {phaseLabel(status.phase, labels)}
        {status.running && status.clients > 0 ? (
          <span className="mirror-connect__clients">
            · {labels.clients.replace("{n}", String(status.clients))}
          </span>
        ) : null}
      </div>

      {(err || status.error) && (
        <div className="mirror-connect__error" role="alert">
          {(err || status.error || "").includes("cloudflared")
            ? labels.missingCloudflared
            : err || status.error}
        </div>
      )}

      {!!status.publicUrl &&
      (status.phase === "live" || status.phase === "local") &&
      qrDataUrl ? (
        <div className="mirror-connect__qr-wrap">
          <img
            className="mirror-connect__qr"
            src={qrDataUrl}
            width={220}
            height={220}
            alt={labels.qrAlt}
          />
        </div>
      ) : (
        <div className="mirror-connect__qr-placeholder" aria-hidden>
          {busy ||
          status.phase === "starting" ||
          status.phase === "waiting_tunnel"
            ? "…"
            : null}
        </div>
      )}

      {status.publicUrl ? (
        <div className="mirror-connect__link-row">
          <label className="mirror-connect__link-label">{labels.linkLabel}</label>
          <div className="mirror-connect__link-box">
            <code className="mirror-connect__url" title={status.publicUrl}>
              {status.publicUrl}
            </code>
            <button
              type="button"
              className="btn btn--ghost mirror-connect__copy"
              onClick={() => void handleCopy()}
              title={labels.copyLink}
            >
              <IconCopy size={16} />
              {labels.copyLink}
            </button>
          </div>
          <p className="mirror-connect__warn">{labels.warningToken}</p>
        </div>
      ) : null}
    </GlassModal>
  );
}
