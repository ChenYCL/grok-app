/**
 * Inline tool step on the assistant timeline (stream order).
 * Quiet red mark on failure; no bottom activity dump.
 * Finished rows honor `grok.toolStepsAutoCollapse` (default: start collapsed).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Locale } from "@/i18n";
import { createT } from "@/i18n";
import type { ChatMessage, MessageSegment, MessageToolSegment } from "@/lib/session";
import {
  isToolStepMessage,
  parseToolStepContent,
  toolStepDisplayTitle,
} from "@/lib/session";
import { isContextToolKind, summarizeToolDisplay, toolDetailTail } from "@/lib/toolDisplay";
import { normalizeTaskStatus } from "@/lib/sessionTasks";
import {
  loadToolStepsAutoCollapsePref,
  toolStepDefaultOpen,
  TOOL_STEPS_AUTO_COLLAPSE_CHANGE_EVENT,
} from "@/lib/toolStepsAutoCollapsePref";
import { IconChevronRight } from "@/components/icons";

export function toolSegmentIsRunning(seg: MessageToolSegment): boolean {
  if (seg.streaming) return true;
  const s = (seg.status || "").toLowerCase().trim();
  // Empty + not streaming → finished (see timelinePhases.toolRunning).
  if (!s) return false;
  return s === "in_progress" || s === "pending" || s === "running";
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

function toolExpandBody(seg: MessageToolSegment, failed: boolean): {
  failHint: string;
  failHintShort: string;
  detailTail: string;
  hasBody: boolean;
} {
  const failHint = failed
    ? (seg.path || seg.detail || "").trim().split("\n")[0] || ""
    : "";
  const failHintShort =
    failHint.length > 72 ? `${failHint.slice(0, 71)}…` : failHint;
  // Prefer multi-line detail when richer than the one-line fail hint.
  const detailTail = toolDetailTail(seg.detail, 8);
  const hasBody =
    !!failHintShort ||
    (!!detailTail && detailTail !== failHint && detailTail !== failHintShort);
  return { failHint, failHintShort, detailTail, hasBody };
}

/** One timeline tool line (CodePilot ToolActionRow–style). */
export function TimelineToolRow({
  tool,
  autoCollapse: autoCollapseProp,
  defaultExpanded,
}: {
  tool: MessageToolSegment;
  /** Override stored auto-collapse pref (tests / parent). */
  autoCollapse?: boolean;
  /** Explicit initial open; overrides pref helper when set. */
  defaultExpanded?: boolean;
}) {
  const failed = toolSegmentFailed(tool);
  const running = toolSegmentIsRunning(tool);
  const summary = toolSummary(tool);
  const { failHint, failHintShort, detailTail, hasBody } = toolExpandBody(
    tool,
    failed,
  );
  const pathTail = tool.path
    ? tool.path.replace(/\\/g, "/").split("/").filter(Boolean).pop()
    : "";

  const [autoCollapse, setAutoCollapse] = useState(
    () => autoCollapseProp ?? loadToolStepsAutoCollapsePref(),
  );
  const userToggled = useRef(false);
  const runningRef = useRef(running);
  runningRef.current = running;

  useEffect(() => {
    if (autoCollapseProp != null) setAutoCollapse(autoCollapseProp);
  }, [autoCollapseProp]);

  useEffect(() => {
    if (autoCollapseProp != null) return;
    const apply = (next: boolean) => {
      setAutoCollapse(next);
      if (!runningRef.current && !userToggled.current) {
        setOpen(toolStepDefaultOpen(false, next));
      }
    };
    const onPref = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      apply(typeof detail === "boolean" ? detail : loadToolStepsAutoCollapsePref());
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === "grok.toolStepsAutoCollapse") {
        apply(loadToolStepsAutoCollapsePref());
      }
    };
    window.addEventListener(TOOL_STEPS_AUTO_COLLAPSE_CHANGE_EVENT, onPref);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(TOOL_STEPS_AUTO_COLLAPSE_CHANGE_EVENT, onPref);
      window.removeEventListener("storage", onStorage);
    };
  }, [autoCollapseProp]);

  const prefOpen =
    defaultExpanded != null
      ? defaultExpanded
      : toolStepDefaultOpen(running, autoCollapse);

  const [open, setOpen] = useState(() => prefOpen);

  useEffect(() => {
    if (running) {
      setOpen(true);
      userToggled.current = false;
      return;
    }
    if (!userToggled.current) {
      setOpen(
        defaultExpanded != null
          ? defaultExpanded
          : toolStepDefaultOpen(false, autoCollapse),
      );
    }
  }, [running, autoCollapse, defaultExpanded, tool.toolCallId]);

  const showBody = hasBody && open;

  const rowInner = (
    <>
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
      {hasBody ? (
        <span
          className={
            "lobe-timeline-tool__caret" + (open ? " is-open" : "")
          }
          aria-hidden
        >
          <IconChevronRight size={11} />
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
    </>
  );

  return (
    <div
      className={
        "lobe-timeline-tool" +
        (failed ? " is-error" : "") +
        (running ? " is-running" : "") +
        (open && hasBody ? " is-open" : "")
      }
      role="status"
      data-tool-id={tool.toolCallId}
      data-testid="timeline-tool"
      data-expanded={hasBody ? (open ? "1" : "0") : undefined}
      title={tool.detail || tool.path || summary}
    >
      {hasBody ? (
        <button
          type="button"
          className="lobe-timeline-tool__row lobe-timeline-tool__row--toggle"
          aria-expanded={open}
          onClick={() => {
            userToggled.current = true;
            setOpen((v) => !v);
          }}
        >
          {rowInner}
        </button>
      ) : (
        <div className="lobe-timeline-tool__row">{rowInner}</div>
      )}
      {showBody ? (
        <div className="lobe-timeline-tool__body">
          {failHintShort ? (
            <div className="lobe-timeline-tool__fail-hint" title={failHint}>
              {failHintShort}
            </div>
          ) : null}
          {detailTail &&
          detailTail !== failHint &&
          detailTail !== failHintShort ? (
            <pre className="lobe-timeline-tool__detail">{detailTail}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** ≥3 consecutive context tools → collapsible group (CodePilot-style). */
export function TimelineContextGroup({
  tools,
  locale,
  autoCollapse: autoCollapseProp,
}: {
  tools: MessageToolSegment[];
  locale: Locale;
  autoCollapse?: boolean;
}) {
  const tr = useMemo(() => createT(locale), [locale]);
  const [autoCollapse, setAutoCollapse] = useState(
    () => autoCollapseProp ?? loadToolStepsAutoCollapsePref(),
  );
  const running = tools.some(toolSegmentIsRunning);
  const hasErr = tools.some(toolSegmentFailed);
  const userToggled = useRef(false);
  const runningRef = useRef(running);
  runningRef.current = running;

  useEffect(() => {
    if (autoCollapseProp != null) setAutoCollapse(autoCollapseProp);
  }, [autoCollapseProp]);

  useEffect(() => {
    if (autoCollapseProp != null) return;
    const apply = (next: boolean) => {
      setAutoCollapse(next);
      if (!runningRef.current && !userToggled.current) {
        setOpen(toolStepDefaultOpen(false, next));
      }
    };
    const onPref = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      apply(typeof detail === "boolean" ? detail : loadToolStepsAutoCollapsePref());
    };
    window.addEventListener(TOOL_STEPS_AUTO_COLLAPSE_CHANGE_EVENT, onPref);
    return () => {
      window.removeEventListener(TOOL_STEPS_AUTO_COLLAPSE_CHANGE_EVENT, onPref);
    };
  }, [autoCollapseProp]);

  const [open, setOpen] = useState(() =>
    toolStepDefaultOpen(running, autoCollapse),
  );

  useEffect(() => {
    if (running) {
      setOpen(true);
      userToggled.current = false;
      return;
    }
    if (!userToggled.current) {
      setOpen(toolStepDefaultOpen(false, autoCollapse));
    }
  }, [running, autoCollapse]);

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
        onClick={() => {
          userToggled.current = true;
          setOpen((v) => !v);
        }}
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
            <TimelineToolRow
              key={t.toolCallId}
              tool={t}
              autoCollapse={autoCollapse}
            />
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
