/**
 * Settings → Runtime → Connection: Agent leader fleet + serve status.
 * Surfaces `grok leader list|info|kill` with in-app confirm for stop.
 */

import { useCallback, useEffect, useState } from "react";
import type { MessageKey, Vars } from "@/i18n";
import { GlassModal } from "@/components/GlassModal";
import * as api from "@/lib/api";
import type { LeaderInfo, LeaderProcess, LeaderStatus, ServeStatus } from "@/lib/api";
import {
  formatLeaderRowSummary,
  hasLeaderFleet,
  leaderInfoDetailRows,
  leaderRowKey,
} from "@/lib/leaderFleet";

function formatAge(
  secs: number | null | undefined,
  t: (k: MessageKey, vars?: Vars) => string,
): string {
  if (secs == null || !Number.isFinite(secs)) return t("settings.leader.ageUnknown");
  if (secs < 60) return t("settings.leader.ageSeconds", { n: Math.max(0, Math.floor(secs)) });
  if (secs < 3600) {
    return t("settings.leader.ageMinutes", { n: Math.floor(secs / 60) });
  }
  if (secs < 86400) {
    return t("settings.leader.ageHours", { n: Math.floor(secs / 3600) });
  }
  return t("settings.leader.ageDays", { n: Math.floor(secs / 86400) });
}

export function LeaderServePanel({
  t,
  onOpenUseLeader,
}: {
  t: (k: MessageKey, vars?: Vars) => string;
  /** Deep-link to General → Agent → useLeader toggle. */
  onOpenUseLeader?: () => void;
}) {
  const [status, setStatus] = useState<LeaderStatus | null>(null);
  const [serve, setServe] = useState<ServeStatus | null>(null);
  /** One-time full connection URL from serve_start (not re-fetched by status). */
  const [serveConnectionUrl, setServeConnectionUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<"refresh" | "start" | "stop" | "info" | null>(null);
  const [serveBusy, setServeBusy] = useState<"refresh" | "start" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serveError, setServeError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [serveCopied, setServeCopied] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoLoadingPid, setInfoLoadingPid] = useState<number | "default" | null>(null);
  const [info, setInfo] = useState<LeaderInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);

  const refreshLeader = useCallback(async () => {
    setBusy("refresh");
    setError(null);
    try {
      const st = await api.leaderStatus();
      setStatus(st);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const refreshServe = useCallback(async () => {
    setServeBusy("refresh");
    setServeError(null);
    try {
      const st = await api.serveStatus();
      setServe(st);
      // Status never returns full URL — clear one-time URL if serve stopped.
      if (st.state !== "running") {
        setServeConnectionUrl(null);
      }
    } catch (e) {
      setServeError(e instanceof Error ? e.message : String(e));
    } finally {
      setServeBusy(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([refreshLeader(), refreshServe()]);
  }, [refreshLeader, refreshServe]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      void refresh();
    }, 8000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const onStart = async () => {
    setBusy("start");
    setError(null);
    try {
      const st = await api.leaderStart();
      setStatus(st);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      try {
        setStatus(await api.leaderStatus());
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(null);
    }
  };

  const onStopConfirmed = async () => {
    setBusy("stop");
    setError(null);
    setConfirmStop(false);
    try {
      const st = await api.leaderStop();
      setStatus(st);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      try {
        setStatus(await api.leaderStatus());
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(null);
    }
  };

  const onShowInfo = async (row?: LeaderProcess) => {
    const pid = row?.pid ?? null;
    setInfoOpen(true);
    setInfo(null);
    setInfoError(null);
    setInfoLoadingPid(pid != null ? pid : "default");
    setBusy("info");
    try {
      const detail = await api.leaderInfo(pid);
      setInfo(detail);
      if (detail.error && !detail.pid && !detail.socketPath) {
        setInfoError(detail.error);
      }
    } catch (e) {
      setInfoError(e instanceof Error ? e.message : String(e));
    } finally {
      setInfoLoadingPid(null);
      setBusy(null);
    }
  };

  const onServeStart = async () => {
    setServeBusy("start");
    setServeError(null);
    try {
      const st = await api.serveStart();
      setServe(st);
      if (st.connectionUrl) {
        setServeConnectionUrl(st.connectionUrl);
        try {
          await navigator.clipboard.writeText(st.connectionUrl);
          setServeCopied(true);
          window.setTimeout(() => setServeCopied(false), 2000);
        } catch {
          /* clipboard optional — URL still held for manual copy */
        }
      }
    } catch (e) {
      setServeError(e instanceof Error ? e.message : String(e));
      try {
        setServe(await api.serveStatus());
      } catch {
        /* ignore */
      }
    } finally {
      setServeBusy(null);
    }
  };

  const onServeStop = async () => {
    setServeBusy("stop");
    setServeError(null);
    try {
      const st = await api.serveStop();
      setServe(st);
      setServeConnectionUrl(null);
    } catch (e) {
      setServeError(e instanceof Error ? e.message : String(e));
      try {
        setServe(await api.serveStatus());
      } catch {
        /* ignore */
      }
    } finally {
      setServeBusy(null);
    }
  };

  const onCopySocket = async () => {
    const path = status?.socketPath;
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onCopyServeUrl = async () => {
    if (!serveConnectionUrl) return;
    try {
      await navigator.clipboard.writeText(serveConnectionUrl);
      setServeCopied(true);
      window.setTimeout(() => setServeCopied(false), 1600);
    } catch (e) {
      setServeError(e instanceof Error ? e.message : String(e));
    }
  };

  const state = status?.state ?? "stopped";
  const running = state === "running";
  const unsupported = state === "unsupported" || status?.cliSupportsLeader === false;
  const canStart =
    !busy &&
    !running &&
    !unsupported &&
    status?.cliFound !== false &&
    status?.cliSupportsLeader !== false;
  const canStop = !busy && (running || state === "error");

  const leaders = status?.leaders ?? [];
  const fleetCount = leaders.length;
  const infoRows = leaderInfoDetailRows(info);

  const stateLabel =
    state === "running"
      ? t("settings.leader.stateRunning")
      : state === "error"
        ? t("settings.leader.stateError")
        : state === "unsupported"
          ? t("settings.leader.stateUnsupported")
          : t("settings.leader.stateStopped");

  const tone =
    state === "running" ? "ok" : state === "error" || state === "unsupported" ? "err" : "muted";

  const serveState = serve?.state ?? "stopped";
  const serveRunning = serveState === "running";
  const serveUnsupported =
    serveState === "unsupported" || serve?.cliSupportsServe === false;
  const canServeStart =
    !serveBusy &&
    !serveRunning &&
    !serveUnsupported &&
    serve?.cliFound !== false &&
    serve?.cliSupportsServe !== false;
  const canServeStop = !serveBusy && (serveRunning || serveState === "error");

  const serveStateLabel =
    serveState === "running"
      ? t("settings.serve.stateRunning")
      : serveState === "error"
        ? t("settings.serve.stateError")
        : serveState === "unsupported"
          ? t("settings.serve.stateUnsupported")
          : t("settings.serve.stateStopped");

  const serveTone =
    serveState === "running"
      ? "ok"
      : serveState === "error" || serveState === "unsupported"
        ? "err"
        : "muted";

  const secretDisplay =
    serve?.secretMasked ||
    (serve?.secretLast4 ? `••••${serve.secretLast4}` : null);

  return (
    <div className="settings-card" id="settings-anchor-leaderServe">
      {/* ── Leader ─────────────────────────────────────────────────────── */}
      <div className="settings-row settings-row--stack">
        <div className="settings-row__text">
          <div className="settings-row__label">{t("settings.leader.title")}</div>
          <div className="settings-row__desc">{t("settings.leader.desc")}</div>
        </div>
        <div className="rim-btn-row" style={{ alignItems: "center", gap: 8 }}>
          <span
            className={
              "account-badge" +
              (tone === "ok"
                ? " account-badge--ok"
                : tone === "err"
                  ? " account-badge--warn"
                  : " account-badge--muted")
            }
          >
            {stateLabel}
          </span>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={!!busy}
            onClick={() => void refreshLeader()}
          >
            {t("settings.leader.refresh")}
          </button>
        </div>
      </div>

      {unsupported ? (
        <div className="settings-row settings-row--stack">
          <div className="settings-row__hint is-danger" role="status">
            {status?.message || t("settings.leader.unsupportedBody")}
          </div>
          {onOpenUseLeader ? (
            <button type="button" className="btn btn--ghost" onClick={onOpenUseLeader}>
              {t("settings.leader.openUseLeader")}
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="settings-row settings-row--stack">
            <div className="settings-row__text">
              <div className="settings-row__label">{t("settings.leader.socket")}</div>
              <div className="settings-row__desc">
                {status?.socketPath || t("settings.leader.socketDefault")}
              </div>
              <div className="settings-row__hint">
                {status?.socketExists
                  ? t("settings.leader.socketExists", {
                      age: formatAge(status.socketAgeSecs, t),
                    })
                  : t("settings.leader.socketMissing")}
                {status?.pid != null ? ` · PID ${status.pid}` : ""}
                {status?.version ? ` · v${status.version}` : ""}
                {status?.classification ? ` · ${status.classification}` : ""}
              </div>
            </div>
            <div className="rim-btn-row">
              <button
                type="button"
                className="btn btn--ghost"
                disabled={!status?.socketPath}
                onClick={() => void onCopySocket()}
              >
                {copied ? t("settings.leader.copied") : t("settings.leader.copySocket")}
              </button>
            </div>
          </div>

          {/* Fleet list from grok leader list */}
          <div className="settings-row settings-row--stack">
            <div className="settings-row__text">
              <div className="settings-row__label">
                {t("settings.leader.fleetTitle", { n: fleetCount })}
              </div>
              <div className="settings-row__desc">{t("settings.leader.fleetDesc")}</div>
            </div>
            {hasLeaderFleet(leaders) ? (
              <ul
                className="settings-row__list"
                style={{
                  listStyle: "none",
                  margin: "6px 0 0",
                  padding: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  width: "100%",
                }}
                aria-label={t("settings.leader.fleetTitle", { n: fleetCount })}
              >
                {leaders.map((row, i) => {
                  const loadingThis =
                    infoLoadingPid !== null &&
                    ((row.pid != null && infoLoadingPid === row.pid) ||
                      (row.pid == null && infoLoadingPid === "default"));
                  return (
                    <li
                      key={leaderRowKey(row, i)}
                      className="settings-row"
                      style={{
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 0",
                        borderTop: i === 0 ? undefined : "1px solid var(--border, rgba(128,128,128,0.2))",
                      }}
                    >
                      <div className="settings-row__text" style={{ minWidth: 0, flex: 1 }}>
                        <div
                          className="settings-row__desc"
                          style={{ wordBreak: "break-all" }}
                          title={formatLeaderRowSummary(row)}
                        >
                          {formatLeaderRowSummary(row)}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        disabled={!!busy}
                        onClick={() => void onShowInfo(row)}
                      >
                        {loadingThis
                          ? t("settings.leader.infoLoading")
                          : t("settings.leader.info")}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="settings-row__hint">{t("settings.leader.fleetEmpty")}</div>
            )}
          </div>

          <div className="settings-row settings-row--stack">
            <div className="settings-row__label">{t("settings.leader.actions")}</div>
            <div className="rim-btn-row">
              <button
                type="button"
                className="btn btn--primary"
                disabled={!canStart}
                onClick={() => void onStart()}
              >
                {busy === "start" ? t("settings.leader.starting") : t("settings.leader.start")}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={!canStop}
                onClick={() => setConfirmStop(true)}
              >
                {busy === "stop" ? t("settings.leader.stopping") : t("settings.leader.stop")}
              </button>
              {running || fleetCount > 0 ? (
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={!!busy}
                  onClick={() => void onShowInfo(leaders[0])}
                >
                  {t("settings.leader.info")}
                </button>
              ) : null}
            </div>
            <div className="settings-row__hint">{t("settings.leader.startHint")}</div>
          </div>

          {onOpenUseLeader ? (
            <div className="settings-row">
              <div className="settings-row__text">
                <div className="settings-row__label">{t("settings.useLeader")}</div>
                <div className="settings-row__desc">{t("settings.leader.useLeaderLinkDesc")}</div>
              </div>
              <button type="button" className="btn btn--ghost" onClick={onOpenUseLeader}>
                {t("settings.leader.openUseLeader")}
              </button>
            </div>
          ) : null}
        </>
      )}

      {(error || (status?.message && state === "error")) && (
        <div className="settings-row settings-row--stack">
          <div className="settings-row__hint is-danger" role="alert">
            {error || status?.message}
          </div>
        </div>
      )}

      {/* ── Serve (WebSocket) ──────────────────────────────────────────── */}
      <div
        className="settings-row settings-row--stack"
        id="settings-anchor-agentServe"
        style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border, rgba(128,128,128,0.25))" }}
      >
        <div className="settings-row__text">
          <div className="settings-row__label">{t("settings.serve.title")}</div>
          <div className="settings-row__desc">{t("settings.serve.desc")}</div>
        </div>
        <div className="rim-btn-row" style={{ alignItems: "center", gap: 8 }}>
          <span
            className={
              "account-badge" +
              (serveTone === "ok"
                ? " account-badge--ok"
                : serveTone === "err"
                  ? " account-badge--warn"
                  : " account-badge--muted")
            }
          >
            {serveStateLabel}
          </span>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={!!serveBusy}
            onClick={() => void refreshServe()}
          >
            {t("settings.serve.refresh")}
          </button>
        </div>
      </div>

      {serveUnsupported ? (
        <div className="settings-row settings-row--stack">
          <div className="settings-row__hint is-danger" role="status">
            {serve?.message || t("settings.serve.unsupportedBody")}
          </div>
        </div>
      ) : (
        <>
          <div className="settings-row settings-row--stack">
            <div className="settings-row__text">
              <div className="settings-row__label">{t("settings.serve.bind")}</div>
              <div className="settings-row__desc">
                {serve?.bind || t("settings.serve.bindDefault")}
              </div>
              <div className="settings-row__hint">
                {serve?.portOpen
                  ? t("settings.serve.portOpen")
                  : t("settings.serve.portClosed")}
                {serve?.pid != null ? ` · PID ${serve.pid}` : ""}
              </div>
            </div>
          </div>

          <div className="settings-row settings-row--stack">
            <div className="settings-row__text">
              <div className="settings-row__label">{t("settings.serve.secret")}</div>
              <div className="settings-row__desc">
                {secretDisplay || t("settings.serve.secretNone")}
              </div>
              <div className="settings-row__hint">{t("settings.serve.secretHint")}</div>
            </div>
            <div className="rim-btn-row">
              <button
                type="button"
                className="btn btn--ghost"
                disabled={!serveConnectionUrl}
                onClick={() => void onCopyServeUrl()}
                title={
                  serveConnectionUrl
                    ? t("settings.serve.copyUrlHint")
                    : t("settings.serve.copyUrlUnavailable")
                }
              >
                {serveCopied ? t("settings.serve.copied") : t("settings.serve.copyUrl")}
              </button>
            </div>
          </div>

          <div className="settings-row settings-row--stack">
            <div className="settings-row__label">{t("settings.serve.actions")}</div>
            <div className="rim-btn-row">
              <button
                type="button"
                className="btn btn--primary"
                disabled={!canServeStart}
                onClick={() => void onServeStart()}
              >
                {serveBusy === "start" ? t("settings.serve.starting") : t("settings.serve.start")}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={!canServeStop}
                onClick={() => void onServeStop()}
              >
                {serveBusy === "stop" ? t("settings.serve.stopping") : t("settings.serve.stop")}
              </button>
            </div>
            <div className="settings-row__hint">{t("settings.serve.startHint")}</div>
          </div>
        </>
      )}

      {(serveError || (serve?.message && serveState === "error")) && (
        <div className="settings-row settings-row--stack">
          <div className="settings-row__hint is-danger" role="alert">
            {serveError || serve?.message}
          </div>
        </div>
      )}

      <GlassModal
        open={confirmStop}
        onClose={() => {
          if (busy !== "stop") setConfirmStop(false);
        }}
        title={t("settings.leader.stopConfirmTitle")}
        size="sm"
        closeLabel={t("common.close")}
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy === "stop"}
              onClick={() => setConfirmStop(false)}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--solid"
              disabled={busy === "stop"}
              onClick={() => void onStopConfirmed()}
            >
              {busy === "stop" ? t("settings.leader.stopping") : t("settings.leader.stopConfirmAction")}
            </button>
          </>
        }
      >
        <p className="app-dialog__msg">
          {t("settings.leader.stopConfirmBody", { n: Math.max(fleetCount, running ? 1 : 0) })}
        </p>
      </GlassModal>

      <GlassModal
        open={infoOpen}
        onClose={() => {
          if (infoLoadingPid == null) {
            setInfoOpen(false);
            setInfo(null);
            setInfoError(null);
          }
        }}
        title={t("settings.leader.infoTitle")}
        size="md"
        closeLabel={t("common.close")}
        wrapBody
        footer={
          <button
            type="button"
            className="btn btn--ghost"
            disabled={infoLoadingPid != null}
            onClick={() => {
              setInfoOpen(false);
              setInfo(null);
              setInfoError(null);
            }}
          >
            {t("common.close")}
          </button>
        }
      >
        {infoLoadingPid != null ? (
          <p className="app-dialog__msg">{t("settings.leader.infoLoading")}</p>
        ) : (
          <div>
            {(infoError || info?.error) && (
              <p className="settings-row__hint is-danger" role="alert">
                {infoError || info?.error || t("settings.leader.infoFailed")}
              </p>
            )}
            {info?.unsupported ? (
              <p className="settings-row__hint">{t("settings.leader.infoUnsupported")}</p>
            ) : null}
            {infoRows.length > 0 ? (
              <dl style={{ margin: infoError || info?.error ? "8px 0 0" : 0, display: "grid", gap: 8 }}>
                {infoRows.map((r) => (
                  <div key={r.key}>
                    <dt className="settings-row__label" style={{ fontSize: "0.85em" }}>
                      {r.label}
                    </dt>
                    <dd
                      className="settings-row__desc"
                      style={{ margin: 0, wordBreak: "break-all", whiteSpace: "pre-wrap" }}
                    >
                      {r.value}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : !infoError && !info?.error ? (
              <p className="app-dialog__msg">{t("settings.leader.infoEmpty")}</p>
            ) : null}
          </div>
        )}
      </GlassModal>
    </div>
  );
}
