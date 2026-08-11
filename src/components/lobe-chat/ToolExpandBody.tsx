/**
 * Shared expanded body for a tool step — one implementation for the bare
 * TimelineToolRow and the in-phase GrokActivityStepRow so live and history
 * look identical.
 *
 * Layout (terminal transcript order):
 *   [fail hint]
 *   $ command          ← only for shell tools, when there is output to pair it with
 *   <tool output>      ← ACP content[]; scrolls internally, elided in the middle
 *   <legacy detail>    ← only when no real output was captured
 */

import type { toolExpandBody } from "@/lib/toolDisplay";

export type ToolExpandBodyModel = ReturnType<typeof toolExpandBody>;

export function ToolExpandBody({
  body,
  className = "lobe-timeline-tool__body",
}: {
  body: ToolExpandBodyModel;
  className?: string;
}) {
  const { failHint, failHintShort, detailTail, outputBody, command } = body;
  const showDetail =
    !!detailTail && detailTail !== failHint && detailTail !== failHintShort;
  return (
    <div className={className}>
      {failHintShort ? (
        <div className="lobe-timeline-tool__fail-hint" title={failHint}>
          {failHintShort}
        </div>
      ) : null}
      {command && outputBody ? (
        <pre className="lobe-timeline-tool__cmd">
          <span className="lobe-timeline-tool__cmd-sigil" aria-hidden>
            ${" "}
          </span>
          {command}
        </pre>
      ) : null}
      {outputBody ? (
        <pre className="lobe-timeline-tool__output" data-testid="tool-output">
          {outputBody}
        </pre>
      ) : null}
      {showDetail ? (
        <pre className="lobe-timeline-tool__detail">{detailTail}</pre>
      ) : null}
    </div>
  );
}
