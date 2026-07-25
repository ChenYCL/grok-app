/**
 * Mid-stream tool activity — plain one-line text (Codex-style).
 *
 * Rules:
 * - Only the latest **running** tool is shown
 * - Multiple tools replace the same line (no stack)
 * - Line sits in the stream (after current reply / at live edge)
 * - Hidden when no running tool (content can resume without chrome)
 * - Historical successful tool_step rows are not stacked in the transcript
 * - Failed tool_step rows stay visible (FailedToolRow)
 */

import { useMemo } from "react";
import type { Locale } from "@/i18n";
import { createT } from "@/i18n";
import type { ChatMessage } from "@/lib/session";
import {
  isFailedToolStepMessage,
  toolStepDisplayTitle,
} from "@/lib/session";
import { EndOfTurnChip } from "./EndOfTurnChip";

export {
  isToolStepMessage,
  isFailedToolStepMessage,
  pickLatestTurnTool,
  pickRunningTurnTool,
  toolStepDisplayTitle,
} from "@/lib/session";

/**
 * Mid-stream tool status — plain call text only (no "tool" chrome).
 * Hidden when there is no meaningful title yet.
 */
export function LiveToolText({
  message,
  locale: _locale,
}: {
  message: ChatMessage;
  locale: Locale;
}) {
  const title = toolStepDisplayTitle(message);
  if (!title) return null;

  return (
    <div
      className="lobe-chat-tool-text"
      role="status"
      aria-live="polite"
      data-tool-id={message.toolCallId}
      title={message.toolDetail || message.toolPath || title}
    >
      {title}
    </div>
  );
}

/** Historical / terminal failed tool — stays in transcript. */
export function FailedToolRow({
  message,
  locale,
}: {
  message: ChatMessage;
  locale: Locale;
}) {
  const tr = useMemo(() => createT(locale), [locale]);
  const title = toolStepDisplayTitle(message) || tr("activity.failed");
  const detail = message.toolDetail || message.toolPath || "";
  return (
    <div
      className="lobe-chat-failed-tool"
      role="status"
      data-testid="failed-tool-row"
      data-tool-id={message.toolCallId}
    >
      <span className="lobe-chat-failed-tool__dot" aria-hidden />
      <div className="lobe-chat-failed-tool__body">
        <div className="lobe-chat-failed-tool__title">{title}</div>
        {detail ? (
          <div className="lobe-chat-failed-tool__detail" title={detail}>
            {detail}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function isFailedToolVisible(m: ChatMessage): boolean {
  return isFailedToolStepMessage(m);
}

/** @deprecated Prefer EndOfTurnChip — kept as thin alias. */
export function TurnCancelledRow({
  message,
  locale,
}: {
  message: ChatMessage;
  locale: Locale;
}) {
  return <EndOfTurnChip message={message} locale={locale} />;
}
