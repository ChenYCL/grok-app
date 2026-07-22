/**
 * Chat thread: Message + Marker based UI.
 * Reasoning is collapsed after stream completes; click to expand full thought.
 */

import { useMemo, useState } from "react";
import type { Locale } from "@/i18n";
import { createT } from "@/i18n";
import type { ChatMessage, SessionState } from "@/lib/session";
import type { Attachment } from "@/lib/attachments";
import { isImagePath } from "@/lib/attachments";
import { MarkdownBody } from "@/components/MarkdownBody";
import { AttachmentCard } from "@/components/AttachmentCard";
import {
  Conversation,
  ConversationContent,
} from "@/components/ui/conversation";
import {
  Message,
  MessageActions,
  MessageContent,
  MessageToolbar,
} from "@/components/ui/message";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  IconCheck,
  IconChevronDown,
  IconCopy,
  IconExportMd,
  IconPlan,
} from "@/components/icons";
import { cn } from "@/lib/utils";

export interface ConversationThreadProps {
  locale: Locale;
  messages: ChatMessage[];
  sessionState: SessionState;
  plan?: {
    visible: boolean;
    waiting: boolean;
    title: string;
    body: string;
    entries: unknown[];
  };
  onDismissPlan?: () => void;
  onAddAttachmentToComposer?: (att: Attachment) => void;
  attachLabels: {
    open: string;
    reveal: string;
    copyPath: string;
    copyImage: string;
    addToComposer: string;
    remove: string;
  };
}

function ReasoningBlock({
  text,
  streaming,
  locale,
}: {
  text: string;
  streaming: boolean;
  locale: Locale;
}) {
  const tr = useMemo(() => createT(locale), [locale]);
  const [open, setOpen] = useState(false);
  const trimmed = text.trim();
  if (!trimmed && !streaming) return null;

  // While streaming: status marker with shimmer only (no dump of text at top)
  if (streaming) {
    return (
      <Marker role="status" className="pl-0.5">
        <MarkerIcon>
          <Spinner size={14} />
        </MarkerIcon>
        <MarkerContent className="shimmer">{tr("chat.thinking")}</MarkerContent>
      </Marker>
    );
  }

  // Done: collapsed by default — click to view full reasoning
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full">
      <Marker variant="border" className="!border-b-0 py-0">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left",
              "text-[13px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]",
              "transition-colors",
            )}
          >
            <MarkerIcon className="mt-0">
              <IconCheck size={14} />
            </MarkerIcon>
            <MarkerContent className="!flex-none">
              {tr("chat.thoughtDone")}
            </MarkerContent>
            <span className="text-[12px] text-[var(--text-tertiary)]">
              {open ? tr("chat.hideThought") : tr("chat.showThought")}
            </span>
            <IconChevronDown
              size={14}
              className={cn(
                "ml-auto text-[var(--text-tertiary)] transition-transform",
                open && "rotate-180",
              )}
            />
          </button>
        </CollapsibleTrigger>
      </Marker>
      <CollapsibleContent>
        <div
          className={cn(
            "mt-1 mb-2 rounded-xl border border-[var(--border-subtle)]",
            "bg-[var(--bg-elevated)] px-3.5 py-3",
            "text-[13px] leading-relaxed text-[var(--text-secondary)]",
            "whitespace-pre-wrap max-h-[min(40vh,22rem)] overflow-y-auto",
          )}
        >
          {trimmed}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolMarker({
  message,
  locale,
}: {
  message: ChatMessage;
  locale: Locale;
}) {
  const tr = useMemo(() => createT(locale), [locale]);
  const running = message.streaming || message.toolStatus === "running";
  return (
    <Marker
      variant="border"
      role={running ? "status" : undefined}
      className="py-1.5"
    >
      <MarkerIcon>
        {running ? <Spinner size={14} /> : <IconCheck size={14} />}
      </MarkerIcon>
      <MarkerContent className={running ? "shimmer" : undefined}>
        {message.content?.trim() ||
          message.toolStatus ||
          (running ? tr("chat.toolRunning") : tr("chat.toolDone"))}
      </MarkerContent>
    </Marker>
  );
}

export function ConversationThread({
  locale,
  messages,
  sessionState,
  plan,
  onDismissPlan,
  onAddAttachmentToComposer,
  attachLabels,
}: ConversationThreadProps) {
  const tr = useMemo(() => createT(locale), [locale]);

  const showWorking =
    sessionState === "streaming" &&
    !messages.some((m) => m.role === "assistant" && m.streaming && m.content);

  return (
    <Conversation>
      <ConversationContent>
        {messages.map((m) => {
          if (m.role === "tool") {
            return <ToolMarker key={m.id} message={m} locale={locale} />;
          }

          if (m.role === "user") {
            return (
              <Message key={m.id} from="user">
                {m.content.trim() ? (
                  <MessageContent>{m.content}</MessageContent>
                ) : null}
                {m.attachments && m.attachments.length > 0 ? (
                  <div className="flex max-w-[min(100%,42rem)] flex-wrap justify-end gap-2">
                    {m.attachments.map((a) => (
                      <AttachmentCard
                        key={a.path}
                        attachment={a}
                        variant="chip"
                        labels={attachLabels}
                        galleryPaths={m.attachments
                          ?.filter((x) => !x.isDir && isImagePath(x.path))
                          .map((x) => x.path)}
                        onAddToComposer={onAddAttachmentToComposer}
                      />
                    ))}
                  </div>
                ) : null}
              </Message>
            );
          }

          // assistant — reasoning sits above the answer, collapsed once answer starts / stream ends
          const hasThought = !!(m.thought && m.thought.trim());
          const thoughtStillStreaming =
            !!m.streaming && !m.content.trim() && hasThought;
          const showThoughtCollapsed =
            hasThought && (!m.streaming || !!m.content.trim());
          const showThinkingPlaceholder =
            !!m.streaming && !m.content.trim() && !hasThought;

          return (
            <div key={m.id} className="flex w-full flex-col gap-1.5">
              {thoughtStillStreaming ? (
                <ReasoningBlock text="" streaming locale={locale} />
              ) : null}
              {showThoughtCollapsed ? (
                <ReasoningBlock
                  text={m.thought ?? ""}
                  streaming={false}
                  locale={locale}
                />
              ) : null}
              {showThinkingPlaceholder ? (
                <ReasoningBlock text="" streaming locale={locale} />
              ) : null}

              {(m.content.trim() ||
                (m.attachments && m.attachments.length > 0)) && (
                <Message from="assistant">
                  {m.content.trim() ? (
                    <MessageContent>
                      <MarkdownBody streaming={m.streaming} locale={locale}>
                        {m.content}
                      </MarkdownBody>
                    </MessageContent>
                  ) : null}
                  {m.attachments && m.attachments.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {m.attachments.map((a) => (
                        <AttachmentCard
                          key={a.path}
                          attachment={a}
                          variant="chip"
                          labels={attachLabels}
                          galleryPaths={m.attachments
                            ?.filter((x) => !x.isDir && isImagePath(x.path))
                            .map((x) => x.path)}
                          onAddToComposer={onAddAttachmentToComposer}
                        />
                      ))}
                    </div>
                  ) : null}
                  {!m.streaming && m.content.trim() ? (
                    <MessageToolbar>
                      <MessageActions className="opacity-100">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          title={tr("message.copy")}
                          aria-label={tr("message.copy")}
                          onClick={() =>
                            void navigator.clipboard.writeText(m.content)
                          }
                        >
                          <IconCopy size={15} />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          title={tr("message.exportMd")}
                          aria-label={tr("message.exportMd")}
                          onClick={() => {
                            const blob = new Blob([m.content], {
                              type: "text/markdown;charset=utf-8",
                            });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `grok-${m.id.slice(0, 8)}.md`;
                            a.click();
                            URL.revokeObjectURL(url);
                          }}
                        >
                          <IconExportMd size={15} />
                        </Button>
                      </MessageActions>
                    </MessageToolbar>
                  ) : null}
                </Message>
              )}
            </div>
          );
        })}

        {showWorking ? (
          <Marker role="status" className="pl-0.5">
            <MarkerIcon>
              <Spinner size={14} />
            </MarkerIcon>
            <MarkerContent className="shimmer">
              {tr("main.working")}
            </MarkerContent>
          </Marker>
        ) : null}

        {plan?.visible ? (
          <div
            className={cn(
              "rounded-xl border border-[var(--border-subtle)]",
              "bg-[var(--bg-card)] p-4 shadow-sm",
            )}
          >
            <Marker className="mb-2">
              <MarkerIcon>
                <IconPlan size={14} />
              </MarkerIcon>
              <MarkerContent className="font-medium text-[var(--text-primary)]">
                {plan.waiting ? tr("plan.waiting") : tr("plan.ready")}
              </MarkerContent>
            </Marker>
            <h3 className="mb-2 text-[15px] font-semibold text-[var(--text-primary)]">
              {plan.title}
            </h3>
            <div className="mb-1 text-[12px] font-medium text-[var(--text-tertiary)]">
              {tr("plan.context")}
            </div>
            <pre className="mb-3 max-h-48 overflow-auto rounded-lg bg-[var(--bg-code)] p-3 font-mono text-[12px] text-[var(--text-secondary)]">
              {Array.isArray(plan.entries) && plan.entries.length
                ? JSON.stringify(plan.entries, null, 2)
                : plan.body || tr("plan.empty")}
            </pre>
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={plan.waiting}>
                {tr("plan.approve")}
              </Button>
              <Button type="button" variant="ghost" disabled={plan.waiting}>
                {tr("plan.changes")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={onDismissPlan}
              >
                {tr("plan.dismiss")}
              </Button>
            </div>
          </div>
        ) : null}
      </ConversationContent>
    </Conversation>
  );
}
