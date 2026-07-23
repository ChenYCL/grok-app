/**
 * Lobe Thinking — Accordion + shinyText (1:1 of lobe-chat Thinking).
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconChevronDown } from "@/components/icons";
import { cn } from "@/lib/utils";
import { MarkdownChat } from "./MarkdownChat";
import type { Locale } from "@/i18n";

export function Thinking({
  content,
  thinking,
  durationMs,
  streamingLabel,
  doneLabel,
  thoughtForLabel,
  locale = "zh",
}: {
  content?: string | ReactNode;
  thinking?: boolean;
  /** Duration in ms (Lobe stores ms). */
  durationMs?: number;
  streamingLabel: string;
  doneLabel: string;
  /** e.g. "Thought for {n}s" — n is seconds with 1 decimal */
  thoughtForLabel: (seconds: string) => string;
  locale?: Locale;
}) {
  const [open, setOpen] = useState(!!thinking);
  const startRef = useRef<number | null>(null);
  const [localDuration, setLocalDuration] = useState<number | undefined>(durationMs);

  useEffect(() => {
    if (thinking) {
      setOpen(true);
      if (startRef.current == null) startRef.current = Date.now();
    } else if (startRef.current != null) {
      setLocalDuration(Date.now() - startRef.current);
      startRef.current = null;
    }
  }, [thinking]);

  useEffect(() => {
    if (durationMs != null) setLocalDuration(durationMs);
  }, [durationMs]);

  const durationText =
    localDuration != null && localDuration > 0
      ? thoughtForLabel((localDuration / 1000).toFixed(1))
      : doneLabel;

  const hasBody =
    (typeof content === "string" && content.trim().length > 0) ||
    (content != null && typeof content !== "string");

  return (
    <div className="lobe-chat-thinking">
      <button
        type="button"
        className="lobe-chat-thinking__trigger"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className={cn(
            "lobe-chat-thinking__dot",
            thinking && "lobe-chat-thinking__dot--live",
          )}
        />
        {thinking ? (
          <span style={{ color: "var(--lobe-color-text-secondary)" }}>
            {streamingLabel}
          </span>
        ) : (
          <span style={{ color: "var(--lobe-color-text-secondary)" }}>
            {durationText}
          </span>
        )}
        {hasBody ? (
          <IconChevronDown
            size={14}
            className={cn(
              "text-[var(--lobe-color-text-tertiary)] transition-transform",
              open && "rotate-180",
            )}
          />
        ) : null}
      </button>
      {open && hasBody ? (
        <div className="lobe-chat-thinking__body">
          {typeof content === "string" ? (
            <MarkdownChat locale={locale} muted>
              {content}
            </MarkdownChat>
          ) : (
            content
          )}
        </div>
      ) : null}
    </div>
  );
}
