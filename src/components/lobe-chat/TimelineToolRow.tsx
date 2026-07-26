/**
 * Inline tool step on the assistant timeline (stream order).
 * Quiet red mark on failure; no bottom activity dump.
 */

import { useMemo, useState } from "react";
import type { Locale } from "@/i18n";
import { createT } from "@/i18n";
import type { ChatMessage, MessageSegment, MessageToolSegment } from "@/lib/session";
import {
  isToolStepMessage,
  parseToolStepContent,
  toolStepDisplayTitle,
} from "@/lib/session";
import { isContextToolKind, summarizeToolDisplay } from "@/lib/toolDisplay";
import { normalizeTaskStatus } from "@/lib/sessionTasks";

export function toolSegmentIsRunning(seg: MessageToolSegment): boolean {
  if (seg.streaming) return true;
  const s = (seg.status || "").toLowerCase();
  return s === "in_progress" || s === "pending" || s === "running" || s === "";
}

export function toolSegmentFailed(seg: MessageToolSegment): boolean {
  if (seg.isError) return true;
  const s = (seg.status || "").toLowerCase();
  return s === "failed" || s === "error" || s === "rejected" || s === "denied";
}

function toolSummary(seg: MessageToolSegment): string {
  const display = summarizeToolDisplay({
    kind: seg.toolKind,
    title: seg.title,
    detail: seg.detail,
    path: seg.path,
  });
  return display.summary || seg.title || seg.toolKind || seg.toolCallId;
}

/** One timeline tool line (CodePilot ToolActionRow–style). */
export function TimelineToolRow({
  tool,
}: {
  tool: MessageToolSegment;
}) {
  const failed = toolSegmentFailed(tool);
  const running = toolSegmentIsRunning(tool);
  const summary = toolSummary(tool);
  const failHint = failed
    ? (tool.path || tool.detail || "").trim().split("\n")[0] || ""
    : "";
  const failHintShort =
    failHint.length > 72 ? `${failHint.slice(0, 71)}…` : failHint;
  const pathTail = tool.path
    ? tool.path.replace(/\\/g, "/").split("/").filter(Boolean).pop()
    : "";

  return (
    <div
      className={
        "lobe-timeline-tool" +
        (failed ? " is-error" : "") +
        (running ? " is-running" : "")
      }
      role="status"
      data-tool-id={tool.toolCallId}
      data-testid="timeline-tool"
      title={tool.detail || tool.path || summary}
    >
      <div className="lobe-timeline-tool__row">
        <span
          className={
            "lobe-timeline-tool__name" + (failed ? " is-error" : "")
          }
        >
          {summary}
        </span>
        {pathTail && pathTail !== summary ? (
          <span className="lobe-timeline-tool__path" title={tool.path}>
            {pathTail}
          </span>
        ) : null}
        <span
          className={
            "lobe-timeline-tool__status" +
            (failed ? " is-error" : "") +
            (running ? " is-running" : "")
          }
          aria-hidden
        />
      </div>
      {failHintShort ? (
        <div className="lobe-timeline-tool__fail-hint" title={failHint}>
          {failHintShort}
        </div>
      ) : null}
    </div>
  );
}

/** ≥3 consecutive context tools → collapsible group (CodePilot-style). */
export function TimelineContextGroup({
  tools,
  locale,
}: {
  tools: MessageToolSegment[];
  locale: Locale;
}) {
  const tr = useMemo(() => createT(locale), [locale]);
  const [open, setOpen] = useState(() => tools.some(toolSegmentFailed));
  const running = tools.some(toolSegmentIsRunning);
  const hasErr = tools.some(toolSegmentFailed);

  return (
    <div
      className={
        "lobe-timeline-tool-group" +
        (hasErr ? " is-error" : "") +
        (running ? " is-running" : "")
      }
      data-testid="timeline-tool-group"
    >
      <button
        type="button"
        className="lobe-timeline-tool-group__trigger"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="lobe-timeline-tool-group__label">
          {running
            ? tr("turnActivity.gathering", { n: tools.length })
            : tr("turnActivity.gathered", { n: tools.length })}
        </span>
        <span
          className={
            "lobe-timeline-tool__status" +
            (hasErr ? " is-error" : "") +
            (running ? " is-running" : "")
          }
          aria-hidden
        />
      </button>
      {open ? (
        <div className="lobe-timeline-tool-group__list">
          {tools.map((t) => (
            <TimelineToolRow key={t.toolCallId} tool={t} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export type TimelineDisplayItem =
  | { type: "segment"; seg: MessageSegment; si: number }
  | { type: "tool-group"; tools: MessageToolSegment[]; startSi: number };

const CONTEXT_GROUP_MIN = 3;

/**
 * Walk message segments and collapse ≥3 consecutive context tools.
 * Thought / content / non-context tools stay as individual items.
 */
export function buildTimelineDisplayItems(
  segs: MessageSegment[],
  minContext = CONTEXT_GROUP_MIN,
): TimelineDisplayItem[] {
  const items: TimelineDisplayItem[] = [];
  let i = 0;
  while (i < segs.length) {
    const seg = segs[i]!;
    if (seg.kind !== "tool") {
      items.push({ type: "segment", seg, si: i });
      i += 1;
      continue;
    }
    // Peek consecutive context tools
    if (isContextToolKind(seg.toolKind, seg.title)) {
      const buf: MessageToolSegment[] = [seg];
      let j = i + 1;
      while (j < segs.length) {
        const n = segs[j]!;
        if (n.kind !== "tool") break;
        if (!isContextToolKind(n.toolKind, n.title)) break;
        buf.push(n);
        j += 1;
      }
      if (buf.length >= minContext) {
        items.push({ type: "tool-group", tools: buf, startSi: i });
        i = j;
        continue;
      }
    }
    items.push({ type: "segment", seg, si: i });
    i += 1;
  }
  return items;
}

/** Map a tool_step ChatMessage to a MessageToolSegment for standalone rows. */
export function toolSegmentFromMessage(
  m: ChatMessage,
): MessageToolSegment | null {
  if (!isToolStepMessage(m)) return null;
  const tcid =
    (m.toolCallId || "").trim() ||
    (m.id.startsWith("tool-") ? m.id.slice(5) : m.id);
  if (!tcid) return null;
  const status = normalizeTaskStatus(
    m.toolStatus ||
      (m.content?.startsWith("tool_step|")
        ? parseToolStepContent(m.content)?.status
        : "") ||
      "",
    m.streaming,
  );
  return {
    kind: "tool",
    toolCallId: tcid,
    title: toolStepDisplayTitle(m) || tcid,
    toolKind: m.toolKind,
    status,
    detail: m.toolDetail,
    path: m.toolPath,
    streaming: !!m.streaming || status === "running",
    isError: !!m.isError || status === "failed",
  };
}
