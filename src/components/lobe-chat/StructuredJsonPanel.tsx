/**
 * Structured JSON panel under an assistant reply when the session has an
 * optional JSON Schema (structured output mode).
 *
 * Always renders when mounted: valid JSON → pretty view + schema check;
 * invalid JSON → honest failure (no crash).
 */

import { useMemo, useState } from "react";
import { IconAlertTriangle, IconCheck, IconCopy, IconFileText } from "@/components/icons";
import { Tip } from "@/components/ui/tooltip";
import {
  assessStructuredReply,
  type StructuredReplyAssessment,
} from "@/lib/jsonSchema";
import { cn } from "@/lib/utils";

export type StructuredJsonPanelLabels = {
  title: string;
  badge: string;
  copy: string;
  copied: string;
  export: string;
  /** Shown when the reply is not parseable JSON. */
  invalidJson: string;
  /** Shown when reply is empty. */
  empty: string;
  /** Schema checks pass. */
  valid: string;
  /** Generic schema mismatch (e.g. wrong root type). */
  schemaMismatch: string;
  /** Missing required fields; `{fields}` = comma-separated names. */
  missingRequired: string;
};

export function StructuredJsonPanel({
  content,
  schemaText,
  labels,
  className,
}: {
  content: string;
  /** Active session JSON Schema text (optional; enables required-field checks). */
  schemaText?: string | null;
  labels: StructuredJsonPanelLabels;
  className?: string;
}) {
  const assessment = useMemo(
    () => assessStructuredReply(content, schemaText),
    [content, schemaText],
  );
  const [copied, setCopied] = useState(false);

  const statusLabel = statusText(assessment, labels);
  const canExport = !!assessment.pretty;

  const onCopy = async () => {
    const text = assessment.pretty;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };

  const onExport = () => {
    const text = assessment.pretty;
    if (!text) return;
    try {
      const blob = new Blob([text], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "structured-output.json";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch {
      /* ignore */
    }
  };

  const tone =
    assessment.status === "valid"
      ? "ok"
      : assessment.status === "schema_mismatch"
        ? "warn"
        : "err";

  return (
    <div
      className={cn("struct-json", `struct-json--${tone}`, className)}
      data-testid="struct-json-panel"
      data-status={assessment.status}
    >
      <div className="struct-json__bar">
        <div className="struct-json__bar-left">
          <span className="struct-json__badge" data-testid="struct-json-badge">
            {labels.badge}
          </span>
          <span className="struct-json__title">{labels.title}</span>
          <span
            className={cn("struct-json__status", `struct-json__status--${tone}`)}
            data-testid="struct-json-status"
          >
            {tone === "ok" ? (
              <IconCheck size={12} />
            ) : (
              <IconAlertTriangle size={12} />
            )}
            <span>{statusLabel}</span>
          </span>
        </div>
        <div className="struct-json__actions">
          {canExport ? (
            <>
              <Tip label={copied ? labels.copied : labels.copy}>
                <button
                  type="button"
                  className={cn("struct-json__btn", copied && "is-copied")}
                  aria-label={labels.copy}
                  onClick={() => void onCopy()}
                >
                  {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                  <span>{copied ? labels.copied : labels.copy}</span>
                </button>
              </Tip>
              <Tip label={labels.export}>
                <button
                  type="button"
                  className="struct-json__btn"
                  aria-label={labels.export}
                  onClick={onExport}
                >
                  <IconFileText size={14} />
                  <span>{labels.export}</span>
                </button>
              </Tip>
            </>
          ) : null}
        </div>
      </div>
      {assessment.pretty ? (
        <pre className="struct-json__pre">
          <code>{assessment.pretty}</code>
        </pre>
      ) : (
        <div
          className="struct-json__fail"
          role="status"
          data-testid="struct-json-fail"
        >
          {assessment.status === "empty" ? labels.empty : labels.invalidJson}
        </div>
      )}
    </div>
  );
}

function statusText(
  assessment: StructuredReplyAssessment,
  labels: StructuredJsonPanelLabels,
): string {
  switch (assessment.status) {
    case "valid":
      return labels.valid;
    case "empty":
      return labels.empty;
    case "invalid_json":
      return labels.invalidJson;
    case "schema_mismatch": {
      const missing = assessment.schema?.missingRequired ?? [];
      if (missing.length > 0) {
        return labels.missingRequired.replace("{fields}", missing.join(", "));
      }
      return labels.schemaMismatch;
    }
    default:
      return labels.invalidJson;
  }
}
