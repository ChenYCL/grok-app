/**
 * Desktop Connect panel — QR + public URL + stop host (DESIGN §4.2 / AC7).
 * Closing the panel does NOT stop the host — only 停止主機 does.
 */

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { GlassModal } from "@/components/GlassModal";
import { IconCopy, IconDeviceMobile } from "@/components/icons";
import type { MirrorPhase, MirrorStatus } from "@/lib/api";
import * as api from "@/lib/api";

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
};

export type MirrorConnectPanelProps = {
  open: boolean;
  onClose: () => void;
  labels: MirrorConnectLabels;
  /** In-app confirm for stop (no window.confirm). */
  onConfirmStop: (opts: {
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
  }) => void;
  showToast: (msg: string, ms?: number) => void;
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
    clients: 0,
    phase: "stopped",
    error: null,
  };
}

export function MirrorConnectPanel({
  open,
  onClose,
  labels,
  onConfirmStop,
  showToast,
}: MirrorConnectPanelProps) {
  const [status, setStatus] = useState<MirrorStatus>(emptyStatus);
  const [busy, setBusy] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const st = await api.mirrorStatus();
      setStatus(st);
      setErr(st.error);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  // On open: ensure host started, then poll status.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBusy(true);
    setErr(null);
    void (async () => {
      try {
        const st = await api.mirrorStart();
        if (cancelled) return;
        setStatus(st);
        setErr(st.error);
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
  }, [open, refresh]);

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

  const handleStop = () => {
    onConfirmStop({
      title: labels.stopConfirmTitle,
      message: labels.stopConfirmMessage,
      confirmLabel: labels.stopConfirmOk,
      onConfirm: () => {
        setBusy(true);
        void api
          .mirrorStop()
          .then((st) => {
            setStatus(st);
            setErr(null);
            showToast(labels.phaseStopped, 2000);
          })
          .catch((e) => setErr(String(e)))
          .finally(() => setBusy(false));
      },
    });
  };

  const phase = status.phase;
  const showQr = !!status.publicUrl && (phase === "live" || phase === "local");

  return (
    <GlassModal
      open={open}
      onClose={onClose}
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
              onClick={() => {
                setBusy(true);
                void api
                  .mirrorStart()
                  .then((st) => {
                    setStatus(st);
                    setErr(st.error);
                  })
                  .catch((e) => setErr(String(e)))
                  .finally(() => setBusy(false));
              }}
            >
              {labels.start}
            </button>
          )}
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {labels.close}
          </button>
        </div>
      }
    >
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
