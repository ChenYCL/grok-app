/**
 * Codex-style agent activity — calm, non-intrusive.
 *
 * Rules:
 * - Externally only the latest tool line (one row)
 * - Motion on the live tool replaces a separate “Working” progress bar
 * - Tool line sits above the current turn’s reply content
 * - Historical tool_step rows are not rendered in the transcript
 */

import { useMemo } from "react";
import type { Locale } from "@/i18n";
import { createT } from "@/i18n";
import type { ChatMessage } from "@/lib/session";
import { IconStop } from "@/components/icons";

export { isToolStepMessage, pickLatestTurnTool } from "@/lib/session";

/** One-line live tool status (Codex: title + motion, no chrome). */
export function LiveToolLine({
  message,
  locale,
}: {
  message: ChatMessage;
  locale: Locale;
}) {
  const tr = useMemo(() => createT(locale), [locale]);
  const running = !!message.streaming;
  const failed = !!message.isError || message.toolStatus === "failed";
  const title =
    message.content?.trim() ||
    message.toolKind ||
    tr("activity.tool");
  const hint =
    message.toolDetail ||
    message.toolPath ||
    undefined;

  return (
    <div
      className={
        "lobe-chat-live-tool" +
        (running ? " is-running" : "") +
        (failed ? " is-failed" : "")
      }
      role="status"
      aria-live="polite"
      data-tool-id={message.toolCallId}
      title={hint || title}
    >
      <span className="lobe-chat-live-tool__mark" aria-hidden>
        {running ? (
          <span className="lobe-chat-thinking__dot lobe-chat-thinking__dot--live" />
        ) : failed ? (
          <span className="lobe-chat-live-tool__x">×</span>
        ) : (
          <span className="lobe-chat-live-tool__done" />
        )}
      </span>
      <span
        className={
          "lobe-chat-live-tool__title" +
          (running ? " lobe-chat-live-tool__title--pulse" : "")
        }
      >
        {title}
      </span>
    </div>
  );
}

export function TurnCancelledRow({
  message,
  locale,
}: {
  message: ChatMessage;
  locale: Locale;
}) {
  const tr = useMemo(() => createT(locale), [locale]);
  const reason = message.toolStatus || "";
  const label =
    reason === "user_stop"
      ? tr("activity.cancelledByUser")
      : reason === "agent_exit"
        ? tr("activity.cancelledAgentExit")
        : tr("activity.cancelled");
  return (
    <div className="lobe-chat-live-tool lobe-chat-live-tool--cancel" role="status">
      <span className="lobe-chat-live-tool__mark" aria-hidden>
        <IconStop size={13} />
      </span>
      <span className="lobe-chat-live-tool__title">{label}</span>
    </div>
  );
}

