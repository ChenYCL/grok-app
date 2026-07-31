/**
 * Remote IM Bridge overview — settings-card rows + project chrome controls.
 */

import { useEffect, useMemo, useState } from "react";
import { createT, resolveLocale, type MessageKey } from "@/i18n";
import type {
  BridgeLifecycle,
  BridgeStatus,
  ChannelInstance,
  RemoteChannelId,
} from "@/lib/remoteIm";
import {
  classifyRecoveryStatus,
  clearRimEventTimeline,
  formatRimEventAt,
  getChannelSchema,
  loadRimEventTimeline,
  rimBridgeEventTypeKey,
  RIM_EVENT_TIMELINE_CHANGE_EVENT,
  RIM_EVENT_TIMELINE_STORAGE_KEY,
  type RimBridgeEvent,
} from "@/lib/remoteIm";
import {
  RimBadge,
  RimChoiceRow,
  RimStatusDot,
  RimSwitch,
} from "@/components/remoteIm/RimControls";
import { GlassModal } from "@/components/GlassModal";
import { IconActivity, IconPlug } from "@/components/icons";

export interface RemoteImOverviewProps {
  locale: string;
  bridge: BridgeStatus | null;
  busy: string | null;
  instances: ChannelInstance[];
  onStart: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
  onRestart: () => void | Promise<void>;
  onToggleEnabled: (enabled: boolean) => void | Promise<void>;
  onLifecycle: (lifecycle: BridgeLifecycle) => void | Promise<void>;
  onAllowYolo: (allow: boolean) => void | Promise<void>;
  onOpenChannel: (channelId: RemoteChannelId) => void;
}

export function RemoteImOverview({
  locale,
  bridge,
  busy,
  instances,
  onStart,
  onStop,
  onRestart,
  onToggleEnabled,
  onLifecycle,
  onAllowYolo,
  onOpenChannel,
}: RemoteImOverviewProps) {
  const tr = useMemo(() => createT(resolveLocale(locale)), [locale]);
  const t = (k: string, vars?: Record<string, string | number>) =>
    tr(k as MessageKey, vars);

  const [timelineOpen, setTimelineOpen] = useState(false);
  const [timeline, setTimeline] = useState<RimBridgeEvent[]>(() =>
    loadRimEventTimeline(),
  );
  const [clearConfirm, setClearConfirm] = useState(false);

  useEffect(() => {
    const refresh = () => setTimeline(loadRimEventTimeline());
    refresh();
    const onChange = () => refresh();
    window.addEventListener(RIM_EVENT_TIMELINE_CHANGE_EVENT, onChange);
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === RIM_EVENT_TIMELINE_STORAGE_KEY) refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(RIM_EVENT_TIMELINE_CHANGE_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const state = bridge?.state ?? "stopped";
  const enabled = bridge?.enabled ?? false;
  const lifecycle = bridge?.lifecycle ?? "attached";
  const yolo = bridge?.allowRemoteYolo ?? false;
  const connected = bridge?.connectedChannels ?? [];
  const configured = instances.filter((i) => i.hasCredentials);

  const recovery = useMemo(
    () =>
      classifyRecoveryStatus({
        state: bridge?.state,
        enabled: bridge?.enabled ?? false,
        restartAttempt: bridge?.restartAttempt,
        nextRetrySecs: bridge?.nextRetrySecs,
        lastError: bridge?.lastError,
        errorKind: bridge?.errorKind,
        rateLimited: bridge?.rateLimited,
      }),
    [bridge],
  );

  const stateLabel =
    state === "running" || state === "listening"
      ? t("settings.remoteIm.bridge.listening")
      : state === "error"
        ? t("settings.remoteIm.bridge.error")
        : state === "starting"
          ? t("settings.remoteIm.bridge.starting")
          : state === "degraded"
            ? t("settings.remoteIm.bridge.degraded")
            : t("settings.remoteIm.bridge.stopped");

  const badgeTone =
    state === "running" || state === "listening"
      ? "ok"
      : state === "error" || state === "degraded" || recovery.phase === "rate_limited"
        ? "err"
        : recovery.phase === "backing_off" || recovery.phase === "restarting"
          ? "warn"
          : "neutral";

  return (
    <div className="rim-overview">
      <header className="rim-panel__header">
        <div className="rim-panel__header-text">
          <div className="rim-panel__title-row">
            <IconPlug size={18} />
            <h2 className="rim-panel__title">
              {t("settings.remoteIm.bridgeOverview")}
            </h2>
          </div>
          <p className="rim-panel__lead">{t("settings.remoteIm.bridge.lead")}</p>
        </div>
        <RimBadge tone={badgeTone}>
          <span className="rim-badge__inner">
            <RimStatusDot
              tone={
                state === "running" || state === "listening"
                  ? "connected"
                  : state === "error"
                    ? "error"
                    : "unconfigured"
              }
            />
            {stateLabel}
            {bridge?.mock ? ` · ${t("settings.remoteIm.bridge.mock")}` : ""}
          </span>
        </RimBadge>
      </header>

      <h3 className="settings-page__h2">{t("settings.remoteIm.bridge.actions")}</h3>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row__text">
            <div className="settings-row__label">
              {t("settings.remoteIm.bridge.enable")}
            </div>
            <div className="settings-row__desc">
              {t("settings.remoteIm.bridge.enableDesc")}
            </div>
          </div>
          <RimSwitch
            checked={enabled}
            disabled={!!busy}
            label={t("settings.remoteIm.bridge.enable")}
            onChange={(v) => void onToggleEnabled(v)}
          />
        </div>

        <div className="settings-row settings-row--stack">
          <div className="settings-row__text">
            <div className="settings-row__label">
              {t("settings.remoteIm.bridge.lifecycle")}
            </div>
            <div className="settings-row__desc">
              {t("settings.remoteIm.bridge.lifecycleDesc")}
            </div>
          </div>
          <RimChoiceRow
            value={lifecycle}
            disabled={!!busy}
            onChange={(v) => void onLifecycle(v as BridgeLifecycle)}
            options={[
              {
                value: "attached",
                label: t("settings.remoteIm.bridge.attached"),
              },
              {
                value: "detached",
                label: t("settings.remoteIm.bridge.detached"),
              },
            ]}
          />
        </div>

        <div className="settings-row">
          <div className="settings-row__text">
            <div className="settings-row__label">
              {t("settings.remoteIm.bridge.allowYolo")}
            </div>
            <div className="settings-row__desc">
              {t("settings.remoteIm.bridge.allowYoloDesc")}
            </div>
          </div>
          <RimSwitch
            checked={yolo}
            disabled={!!busy}
            label={t("settings.remoteIm.bridge.allowYolo")}
            onChange={(v) => void onAllowYolo(v)}
          />
        </div>

        <div className="settings-row settings-row--stack">
          <div className="settings-row__label">
            {t("settings.remoteIm.bridge.actions")}
          </div>
          <div className="rim-btn-row">
            <button
              type="button"
              className="btn btn--primary"
              disabled={
                !!busy ||
                state === "running" ||
                state === "listening" ||
                state === "starting"
              }
              onClick={() => void onStart()}
            >
              {t("settings.remoteIm.bridge.start")}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={!!busy || state === "stopped"}
              onClick={() => void onStop()}
            >
              {t("settings.remoteIm.bridge.stop")}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={!!busy}
              onClick={() => void onRestart()}
            >
              {t("settings.remoteIm.bridge.restart")}
            </button>
          </div>
        </div>
      </div>

      <h3 className="settings-page__h2">
        <IconActivity size={14} />
        {t("settings.remoteIm.bridge.connected")}
      </h3>
      <div className="settings-card">
        {connected.length === 0 && configured.length === 0 ? (
          <div className="settings-row settings-row--stack">
            <p className="settings-page__lead" style={{ margin: 0 }}>
              {t("settings.remoteIm.bridge.noneConnected")}
            </p>
          </div>
        ) : (
          <ul className="rim-list">
            {connected.map((c) => (
              <li key={c.instanceId}>
                <button
                  type="button"
                  className="rim-list__link"
                  onClick={() => onOpenChannel(c.channel)}
                >
                  <span className="rim-list__name">
                    {t(
                      getChannelSchema(c.channel)?.nameKey ??
                        "settings.remoteIm.channel.feishu",
                    )}
                    <span className="rim-list__meta">{c.name}</span>
                  </span>
                  <RimStatusDot tone="connected" />
                </button>
              </li>
            ))}
            {configured
              .filter((i) => !connected.some((c) => c.instanceId === i.id))
              .map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    className="rim-list__link"
                    onClick={() => onOpenChannel(i.channel)}
                  >
                    <span className="rim-list__name">
                      {t(
                        getChannelSchema(i.channel)?.nameKey ??
                          "settings.remoteIm.channel.feishu",
                      )}
                      <span className="rim-list__meta">{i.name}</span>
                    </span>
                    <RimStatusDot tone="configured" />
                  </button>
                </li>
              ))}
          </ul>
        )}
      </div>

      {recovery.showCard ? (
        <div
          className={
            recovery.severity === "err"
              ? "rim-callout rim-callout--error"
              : "rim-callout rim-callout--warn"
          }
          role="status"
          data-rim-recovery={recovery.phase}
        >
          <div className="rim-callout__title">{t(recovery.titleKey)}</div>
          {recovery.bodyKey ? (
            <p className="rim-callout__body" style={{ margin: "0.35rem 0 0" }}>
              {t(recovery.bodyKey)}
            </p>
          ) : null}
          {recovery.errorKindKey ? (
            <p className="settings-row__desc" style={{ margin: "0.35rem 0 0" }}>
              {t("settings.remoteIm.resilience.errorKindLabel")}:{" "}
              {t(recovery.errorKindKey)}
            </p>
          ) : null}
          {recovery.showRetryMeta ? (
            <p className="settings-row__desc" style={{ margin: "0.35rem 0 0" }}>
              {t("settings.remoteIm.resilience.retryMeta", {
                attempt: recovery.attempt,
                secs: recovery.nextRetrySecs ?? 0,
              })}
            </p>
          ) : null}
          {bridge?.lastError ? (
            <code className="rim-callout__code" style={{ marginTop: "0.5rem" }}>
              {bridge.lastError}
            </code>
          ) : null}
        </div>
      ) : bridge?.lastError ? (
        <div className="rim-callout rim-callout--error" role="alert">
          <div className="rim-callout__title">
            {t("settings.remoteIm.bridge.lastError")}
          </div>
          <code className="rim-callout__code">{bridge.lastError}</code>
        </div>
      ) : null}

      {bridge && bridge.backend && bridge.backend !== "rust" ? (
        <div className="rim-callout rim-callout--warn">
          <p>{t("settings.remoteIm.bridge.remoteBridgeMissing")}</p>
        </div>
      ) : null}

      <h3 className="settings-page__h2">
        {t("settings.remoteIm.timeline.title")}
      </h3>
      <div className="settings-card rim-timeline">
        <div className="rim-timeline__head">
          <button
            type="button"
            className="rim-timeline__toggle"
            aria-expanded={timelineOpen}
            onClick={() => setTimelineOpen((v) => !v)}
          >
            <span className="rim-timeline__chevron" aria-hidden>
              {timelineOpen ? "▾" : "▸"}
            </span>
            <span className="rim-timeline__title">
              {t("settings.remoteIm.timeline.subtitle")}
            </span>
            {timeline.length > 0 ? (
              <span className="rim-timeline__count">{timeline.length}</span>
            ) : null}
          </button>
          {timelineOpen && timeline.length > 0 ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setClearConfirm(true)}
            >
              {t("settings.remoteIm.timeline.clear")}
            </button>
          ) : null}
        </div>
        <p className="settings-row__desc rim-timeline__desc">
          {t("settings.remoteIm.timeline.desc")}
        </p>
        {timelineOpen ? (
          timeline.length === 0 ? (
            <p className="rim-timeline__empty" role="status">
              {t("settings.remoteIm.timeline.empty")}
            </p>
          ) : (
            <ul
              className="rim-timeline__list"
              aria-label={t("settings.remoteIm.timeline.title")}
            >
              {timeline.map((e) => (
                <li key={e.id} className="rim-timeline__row">
                  <span className="rim-timeline__when" title={e.at}>
                    {formatRimEventAt(e.at)}
                  </span>
                  <span className="rim-timeline__label">
                    {t(rimBridgeEventTypeKey(e.type))}
                    {e.channel ? (
                      <span className="rim-timeline__meta">
                        {" "}
                        ·{" "}
                        {t(
                          getChannelSchema(e.channel as RemoteChannelId)
                            ?.nameKey ?? "settings.remoteIm.unknownChannel",
                        )}
                      </span>
                    ) : null}
                    {e.note ? (
                      <span className="rim-timeline__note"> — {e.note}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>

      <h3 className="settings-page__h2">
        {t("settings.remoteIm.bridge.commands")}
      </h3>
      <div className="settings-card">
        <div className="settings-row settings-row--stack">
          <div className="settings-row__desc">
            {t("settings.remoteIm.bridge.commandsDesc")}
          </div>
          <ul className="rim-help-list">
            <li>
              <code>/start</code> · <code>/help</code> —{" "}
              {t("settings.remoteIm.cmd.help")}
            </li>
            <li>
              <code>/p</code> — {t("settings.remoteIm.cmd.project")}
            </li>
            <li>
              <code>/r</code> — {t("settings.remoteIm.cmd.resume")}
            </li>
            <li>
              <code>/new</code> — {t("settings.remoteIm.cmd.new")}
            </li>
            <li>
              <code>/status</code> — {t("settings.remoteIm.cmd.status")}
            </li>
            <li>
              <code>/context</code> — {t("settings.remoteIm.cmd.context")}
            </li>
            <li>
              <code>/compact [note]</code> — {t("settings.remoteIm.cmd.compact")}
            </li>
            <li>
              <code>/account</code> · <code>/quota</code> —{" "}
              {t("settings.remoteIm.cmd.account")}
            </li>
            <li>
              <code>/account n</code> · <code>/switch n</code> —{" "}
              {t("settings.remoteIm.cmd.switch")}
            </li>
            <li>
              <code>/whoami</code> — {t("settings.remoteIm.cmd.whoami")}
            </li>
            <li>
              <code>/stop</code> — {t("settings.remoteIm.cmd.stop")}
            </li>
          </ul>
          <div className="settings-row__desc" style={{ marginTop: 8 }}>
            {t("settings.remoteIm.bridge.telegramNativeCommands")}
          </div>
        </div>
      </div>

      <GlassModal
        open={clearConfirm}
        onClose={() => setClearConfirm(false)}
        title={t("settings.remoteIm.timeline.clearTitle")}
        wrapBody
        footer={
          <div className="rim-modal__actions">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setClearConfirm(false)}
            >
              {t("settings.remoteIm.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => {
                setTimeline(clearRimEventTimeline());
                setClearConfirm(false);
              }}
            >
              {t("settings.remoteIm.timeline.clearConfirm")}
            </button>
          </div>
        }
      >
        <p className="rim-modal__body">
          {t("settings.remoteIm.timeline.clearBody")}
        </p>
      </GlassModal>
    </div>
  );
}
