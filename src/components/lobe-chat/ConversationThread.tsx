/**
 * LobeHub-aligned chat thread (pure CSS 1:1).
 * Replaces AI Elements / previous ConversationThread.
 */

import { useMemo } from "react";
import type { Locale } from "@/i18n";
import { createT } from "@/i18n";
import {
  formatTurnErrorBody,
  type ChatMessage,
  type SessionState,
} from "@/lib/session";
import type { Attachment } from "@/lib/attachments";
import {
  buildInlineMediaPathMap,
  filterAttachmentsNotInlined,
  isImagePath,
  isMediaPath,
} from "@/lib/attachments";
import { AttachmentCard } from "@/components/AttachmentCard";
import {
  IconArrowsMinimize,
  IconExportMd,
  IconPlan,
  IconRename,
} from "@/components/icons";
import { formatMessageTime } from "@/lib/accountUi";
import { useStickToBottom } from "@/hooks/useStickToBottom";
import {
  MessageActionButton,
  MessageCopyButton,
} from "./MessageAction";
import { Button } from "@/components/ui/button";
import { ChatItem } from "./ChatItem";
import { MarkdownChat } from "./MarkdownChat";
import { Thinking } from "./Thinking";
import { BackBottom } from "./BackBottom";
import { InlineUserEdit } from "./InlineUserEdit";
import { SkillChip } from "@/components/SkillChip";
import { hydrateDisplayContent, parseStoredContent } from "@/lib/draftDoc";
import {
  isToolStepMessage,
  LiveToolLine,
  pickLatestTurnTool,
  TurnCancelledRow,
} from "./AgentActivity";
import "./lobe-chat.css";

function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** User bubble: inline skill chips (`[[skill:name]]` or agent-form `/name` history). */
function UserMessageBody({ content }: { content: string }) {
  const hydrated = hydrateDisplayContent(content);
  const segs = parseStoredContent(hydrated);
  if (!segs.some((s) => s.type === "skill")) {
    return <>{content}</>;
  }
  return (
    <span className="user-msg-body">
      {segs.map((s, i) =>
        s.type === "skill" ? (
          <SkillChip key={`sk-${i}-${s.name}`} name={s.name} size="sm" />
        ) : (
          <span key={`t-${i}`}>{s.text}</span>
        ),
      )}
    </span>
  );
}

export interface ConversationThreadProps {
  locale: Locale;
  messages: ChatMessage[];
  sessionState: SessionState;
  sessionKey?: string;
  projectPath?: string | null;
  /** When true, suppress generic empty copy (brand mark lives above composer). */
  suppressEmptyCopy?: boolean;
  /** Only the latest user message may be edited (idle session). */
  canEditLastUser?: boolean;
  lastUserMessageId?: string | null;
  /** Message currently being edited inline (id). */
  editingUserMessageId?: string | null;
  /** True while edit-resend is in flight (rewind + send). */
  editSubmitting?: boolean;
  onEditUserMessage?: (message: ChatMessage) => void;
  onCancelEditUserMessage?: () => void;
  onSubmitEditUserMessage?: (message: ChatMessage, content: string) => void;
  onOpenResource?: (
    target: import("@/components/ResourceViewer").ResourceOpenTarget,
  ) => void;
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
  /**
   * Epoch ms when current agent turn started.
   * Retained for callers; Codex-style UI no longer shows a separate elapsed bar
   * when tool motion is present.
   */
  turnStartedAt?: number | null;
}

export function ConversationThread({
  locale,
  messages,
  sessionState,
  sessionKey,
  projectPath,
  suppressEmptyCopy = false,
  canEditLastUser = false,
  lastUserMessageId = null,
  editingUserMessageId = null,
  editSubmitting = false,
  onEditUserMessage,
  onCancelEditUserMessage,
  onSubmitEditUserMessage,
  onOpenResource,
  plan,
  onDismissPlan,
  onAddAttachmentToComposer,
  attachLabels,
}: ConversationThreadProps) {
  const tr = useMemo(() => createT(locale), [locale]);

  // Re-pin when user sends (even if they had scrolled up to read history).
  const forceStickKey = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") return messages[i]!.id;
    }
    return null;
  }, [messages]);

  const {
    viewportRef: scrollRef,
    contentRef,
    onScroll,
    scrollToBottom,
    showBack,
  } = useStickToBottom({
    conversationKey: sessionKey ?? "chat",
    forceStickKey,
  });

  const turnBusy =
    sessionState === "streaming" || sessionState === "awaiting_permission";

  /** Codex: only surface the latest tool for the active turn; hide when idle. */
  const liveTool = useMemo(() => {
    if (!turnBusy) return null;
    return pickLatestTurnTool(messages);
  }, [messages, turnBusy]);

  /** Index of the streaming (or last) assistant message after the last user. */
  const activeAssistantId = useMemo(() => {
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "user") {
        lastUser = i;
        break;
      }
    }
    let lastAssistantId: string | null = null;
    for (let i = lastUser + 1; i < messages.length; i++) {
      const m = messages[i]!;
      if (m.role === "assistant" && !m.isError) {
        lastAssistantId = m.id;
        if (m.streaming) return m.id;
      }
    }
    return turnBusy ? lastAssistantId : null;
  }, [messages, turnBusy]);

  const hasStreamingAssistant = messages.some(
    (m) => m.role === "assistant" && m.streaming,
  );

  // Quiet thinking only when busy, no live tool motion, and no assistant yet.
  // Live tool animation replaces a separate progress / working bar.
  const showQuietThinking =
    turnBusy && !liveTool && !hasStreamingAssistant;

  const empty =
    messages.length === 0 &&
    !showQuietThinking &&
    !liveTool &&
    !turnBusy &&
    !plan?.visible;

  return (
    <div className="lobe-chat" data-slot="lobe-chat">
      <div
        ref={scrollRef}
        className="lobe-chat__scroll"
        onScroll={onScroll}
      >
        <div ref={contentRef} className="lobe-chat__inner">
          {empty && !suppressEmptyCopy ? (
            <div className="lobe-chat-empty">
              <h3 className="lobe-chat-empty__title">{tr("main.startTitle")}</h3>
              <p className="lobe-chat-empty__desc">{tr("main.startHint")}</p>
            </div>
          ) : null}

          {messages.map((m) => {
            if (
              m.marker === "turn_cancelled" ||
              (m.role === "tool" && m.content?.startsWith("turn_cancelled"))
            ) {
              return (
                <TurnCancelledRow key={m.id} message={m} locale={locale} />
              );
            }

            // Codex: never render historical tool stacks in the transcript.
            // Live latest tool is injected above the active assistant reply.
            if (isToolStepMessage(m)) {
              return null;
            }

            if (
              m.marker === "context_compact" ||
              (m.role === "tool" &&
                (m.content?.startsWith("context_compact") ||
                  m.compactMeta))
            ) {
              const meta = m.compactMeta;
              const auto = (meta?.trigger || "auto") !== "manual";
              const title = auto
                ? tr("compact.bannerAuto")
                : tr("compact.bannerManual");
              let detail = "";
              if (
                meta?.tokensBefore != null &&
                meta?.tokensAfter != null &&
                Number.isFinite(meta.tokensBefore) &&
                Number.isFinite(meta.tokensAfter)
              ) {
                detail = tr("compact.tokensRange", {
                  before: formatTokenCount(meta.tokensBefore),
                  after: formatTokenCount(meta.tokensAfter),
                });
              } else if (meta?.note) {
                detail = meta.note;
              }
              const summary = meta?.summaryPreview?.trim();
              return (
                <div
                  key={m.id}
                  className="lobe-chat-compact"
                  role="status"
                  data-trigger={meta?.trigger || "auto"}
                >
                  <span className="lobe-chat-compact__icon" aria-hidden>
                    <IconArrowsMinimize size={15} />
                  </span>
                  <div className="lobe-chat-compact__body">
                    <div className="lobe-chat-compact__title">{title}</div>
                    {detail ? (
                      <div className="lobe-chat-compact__detail">{detail}</div>
                    ) : null}
                    {summary ? (
                      <details className="lobe-chat-compact__summary">
                        <summary>{tr("compact.summaryToggle")}</summary>
                        <p>{summary}</p>
                      </details>
                    ) : null}
                  </div>
                </div>
              );
            }

            // Generic tool rows (non marker) — keep quiet; no history stack.
            if (m.role === "tool") {
              return null;
            }

            if (m.role === "user") {
              const isLastUser = lastUserMessageId === m.id;
              const isEditing = editingUserMessageId === m.id;
              const timeLabel = formatMessageTime(m.createdAt, locale);
              return (
                <ChatItem
                  key={m.id}
                  id={m.id}
                  placement="right"
                  showAvatar={false}
                  showTitle={false}
                  message={
                    <div className="lobe-chat-user-stack">
                      {/* Attachments above the bubble (ref: user message layout) */}
                      {m.attachments && m.attachments.length > 0 ? (
                        <div className="lobe-chat-atts lobe-chat-atts--user">
                          {m.attachments.map((a) => (
                            <AttachmentCard
                              key={a.path}
                              attachment={a}
                              variant="card"
                              labels={attachLabels}
                              galleryPaths={m.attachments
                                ?.filter((x) => !x.isDir && isImagePath(x.path))
                                .map((x) => x.path)}
                              onAddToComposer={onAddAttachmentToComposer}
                            />
                          ))}
                        </div>
                      ) : null}
                      {isEditing ? (
                        <InlineUserEdit
                          content={m.content}
                          busy={editSubmitting}
                          cancelLabel={tr("message.editCancel")}
                          resendLabel={tr("message.editResend")}
                          placeholder={tr("message.editPlaceholder")}
                          onCancel={() => onCancelEditUserMessage?.()}
                          onSubmit={(stored) =>
                            onSubmitEditUserMessage?.(m, stored)
                          }
                        />
                      ) : m.content.trim() ? (
                        <div className="lobe-chat-bubble">
                          <UserMessageBody content={m.content} />
                        </div>
                      ) : null}
                    </div>
                  }
                  actions={
                    isEditing ? null : (
                      <>
                        {timeLabel ? (
                          <span className="lobe-chat-action-time">
                            {timeLabel}
                          </span>
                        ) : null}
                        {m.content.trim() ? (
                          <MessageCopyButton
                            text={m.content}
                            copyLabel={tr("message.copy")}
                            copiedLabel={tr("message.copied")}
                          />
                        ) : null}
                        {isLastUser ? (
                          <MessageActionButton
                            label={tr("message.edit")}
                            disabled={!canEditLastUser}
                            onClick={() => {
                              if (!canEditLastUser) return;
                              onEditUserMessage?.(m);
                            }}
                          >
                            <IconRename size={15} />
                          </MessageActionButton>
                        ) : null}
                      </>
                    )
                  }
                />
              );
            }

            if (m.isError) {
              const friendly = formatTurnErrorBody(
                { content: m.content, code: undefined, message: undefined },
                locale === "en" ? "en" : "zh",
              );
              return (
                <div
                  key={m.id}
                  className="lobe-chat-error"
                  role="alert"
                  data-testid="chat-turn-error"
                >
                  <div className="lobe-chat-error__label">
                    {tr("chat.turnFailed")}
                  </div>
                  <div className="lobe-chat-error__body">{friendly}</div>
                </div>
              );
            }

            // Assistant
            const hasThought = !!(m.thought && m.thought.trim());
            const thoughtStreaming =
              !!m.streaming && !m.content.trim() && hasThought;
            const showThinkingPlaceholder =
              !!m.streaming &&
              !m.content.trim() &&
              !hasThought &&
              // When a live tool is animating above this reply, skip the
              // empty “thinking” placeholder — motion already signals work.
              !(liveTool && activeAssistantId === m.id);
            const showReasoning =
              thoughtStreaming || hasThought || showThinkingPlaceholder;
            const showLiveToolAbove =
              !!liveTool && activeAssistantId === m.id;

            return (
              <ChatItem
                key={m.id}
                id={m.id}
                placement="left"
                showAvatar={false}
                loading={!!m.streaming}
                aboveMessage={
                  <>
                    {showLiveToolAbove && liveTool ? (
                      <LiveToolLine
                        message={liveTool}
                        locale={locale}
                      />
                    ) : null}
                    {showReasoning ? (
                      <Thinking
                        locale={locale}
                        thinking={
                          thoughtStreaming || showThinkingPlaceholder
                        }
                        content={hasThought ? m.thought : undefined}
                        streamingLabel={tr("chat.thinking")}
                        doneLabel={tr("chat.thoughtDone")}
                        thoughtForLabel={(n) =>
                          tr("chat.thoughtFor", { n })
                        }
                      />
                    ) : null}
                  </>
                }
                message={(() => {
                  const imagePathMap = buildInlineMediaPathMap(m.attachments);
                  const bottomAtts = filterAttachmentsNotInlined(
                    m.content,
                    m.attachments,
                  );
                  if (
                    !m.content.trim() &&
                    !(bottomAtts && bottomAtts.length)
                  ) {
                    return null;
                  }
                  return (
                    <>
                      {m.content.trim() ? (
                        <MarkdownChat
                          locale={locale}
                          streaming={!!m.streaming}
                          imagePathMap={
                            Object.keys(imagePathMap).length
                              ? imagePathMap
                              : undefined
                          }
                          projectPath={projectPath}
                          onOpenResource={onOpenResource}
                        >
                          {m.content}
                        </MarkdownChat>
                      ) : null}
                      {bottomAtts && bottomAtts.length > 0 ? (
                        <div className="lobe-chat-atts">
                          {bottomAtts.map((a) => (
                            <AttachmentCard
                              key={a.path}
                              attachment={a}
                              variant={
                                !a.isDir && isMediaPath(a.path) ? "card" : "chip"
                              }
                              labels={attachLabels}
                              galleryPaths={bottomAtts
                                .filter((x) => !x.isDir && isImagePath(x.path))
                                .map((x) => x.path)}
                              onAddToComposer={onAddAttachmentToComposer}
                            />
                          ))}
                        </div>
                      ) : null}
                    </>
                  );
                })()}
                actions={
                  !m.streaming && m.content.trim() ? (
                    <>
                      <MessageCopyButton
                        text={m.content}
                        copyLabel={tr("message.copy")}
                        copiedLabel={tr("message.copied")}
                      />
                      <MessageActionButton
                        label={tr("message.exportMd")}
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
                      </MessageActionButton>
                    </>
                  ) : null
                }
              />
            );
          })}

          {/*
            Live tool / quiet thinking when no assistant bubble yet for this turn.
            Tool motion replaces an explicit progress bar.
          */}
          {liveTool && !activeAssistantId ? (
            <LiveToolLine message={liveTool} locale={locale} />
          ) : null}

          {showQuietThinking ? (
            <div className="lobe-chat-live-tool is-running" role="status">
              <span className="lobe-chat-live-tool__mark" aria-hidden>
                <span className="lobe-chat-thinking__dot lobe-chat-thinking__dot--live" />
              </span>
              <span className="lobe-chat-live-tool__title lobe-chat-live-tool__title--pulse">
                {tr("chat.thinking")}
              </span>
            </div>
          ) : null}

          {plan?.visible ? (
            <div className="lobe-chat-plan">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 8,
                  color: "var(--lobe-color-text-secondary)",
                  fontSize: 14,
                }}
              >
                <IconPlan size={14} />
                <span style={{ fontWeight: 500, color: "var(--lobe-color-text)" }}>
                  {plan.waiting ? tr("plan.waiting") : tr("plan.ready")}
                </span>
              </div>
              <h3
                style={{
                  margin: "0 0 8px",
                  fontSize: 15,
                  fontWeight: 600,
                  color: "var(--lobe-color-text)",
                }}
              >
                {plan.title}
              </h3>
              <pre
                style={{
                  margin: "0 0 12px",
                  maxHeight: "12rem",
                  overflow: "auto",
                  padding: 12,
                  borderRadius: 8,
                  background: "var(--lobe-color-fill-quaternary)",
                  border: "1px solid var(--lobe-color-border-secondary)",
                  fontFamily: "var(--lobe-font-mono)",
                  fontSize: 12,
                  color: "var(--lobe-color-text-secondary)",
                }}
              >
                {Array.isArray(plan.entries) && plan.entries.length
                  ? JSON.stringify(plan.entries, null, 2)
                  : plan.body || tr("plan.empty")}
              </pre>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <Button type="button" disabled={plan.waiting}>
                  {tr("plan.approve")}
                </Button>
                <Button type="button" variant="ghost" disabled={plan.waiting}>
                  {tr("plan.changes")}
                </Button>
                <Button type="button" variant="ghost" onClick={onDismissPlan}>
                  {tr("plan.dismiss")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <BackBottom
        visible={showBack}
        label={tr("chat.scrollBottom")}
        onClick={() => scrollToBottom("smooth")}
      />
    </div>
  );
}
