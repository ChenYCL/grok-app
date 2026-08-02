/**
 * External transcript store for the viewing session.
 *
 * Stream tokens update messages without forcing the whole App shell to
 * re-render: ConversationThread subscribes to full snapshots; App shell
 * only subscribes to a cheap structural meta snapshot.
 */

import type { ChatMessage } from "@/lib/session";
import { resolveTranscriptContentNotifyMs } from "@/lib/streamRenderPolicy";

export type TranscriptMeta = {
  /** Message count in the viewing transcript. */
  length: number;
  lastUserId: string | null;
  hasError: boolean;
  /** Any assistant row still marked streaming. */
  hasStreamingAssistant: boolean;
  /** Last message id (structural identity). */
  tailId: string | null;
  /**
   * Bumps only on structural changes (add/remove/role/streaming flag/error),
   * not on content growth of an existing streaming row.
   */
  structuralRev: number;
};

export type MessagesReducer = (prev: ChatMessage[]) => ChatMessage[];

function computeMeta(messages: readonly ChatMessage[]): Omit<
  TranscriptMeta,
  "structuralRev"
> {
  let lastUserId: string | null = null;
  let hasError = false;
  let hasStreamingAssistant = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "user") lastUserId = m.id;
    if (m.isError) hasError = true;
    if (m.role === "assistant" && m.streaming) hasStreamingAssistant = true;
  }
  const tail = messages.length > 0 ? messages[messages.length - 1]! : null;
  return {
    length: messages.length,
    lastUserId,
    hasError,
    hasStreamingAssistant,
    tailId: tail?.id ?? null,
  };
}

function metaStructuralEqual(
  a: Omit<TranscriptMeta, "structuralRev">,
  b: Omit<TranscriptMeta, "structuralRev">,
): boolean {
  return (
    a.length === b.length &&
    a.lastUserId === b.lastUserId &&
    a.hasError === b.hasError &&
    a.hasStreamingAssistant === b.hasStreamingAssistant &&
    a.tailId === b.tailId
  );
}

type Listener = () => void;

class SessionTranscriptStore {
  private messages: ChatMessage[] = [];
  private meta: TranscriptMeta = {
    length: 0,
    lastUserId: null,
    hasError: false,
    hasStreamingAssistant: false,
    tailId: null,
    structuralRev: 0,
  };
  private bySession = new Map<string, ChatMessage[]>();
  private viewingSessionId: string | null = null;
  /** Prefer App's viewingSessionIdRef when set (ahead of React session state). */
  private viewingIdResolver: (() => string | null) | null = null;
  private contentListeners = new Set<Listener>();
  private metaListeners = new Set<Listener>();
  /** Leading+trailing throttle for non-structural content growth. */
  private contentThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private contentNotifyQueued = false;

  /** Full viewing messages — for ConversationThread / export. */
  subscribeContent = (listener: Listener): (() => void) => {
    this.contentListeners.add(listener);
    return () => {
      this.contentListeners.delete(listener);
    };
  };

  getContentSnapshot = (): ChatMessage[] => this.messages;

  /** Structural meta — for App shell (welcome empty, a11y stream edge, …). */
  subscribeMeta = (listener: Listener): (() => void) => {
    this.metaListeners.add(listener);
    return () => {
      this.metaListeners.delete(listener);
    };
  };

  getMetaSnapshot = (): TranscriptMeta => this.meta;

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  getMessagesRef(): ChatMessage[] {
    return this.messages;
  }

  getBySessionMap(): Map<string, ChatMessage[]> {
    return this.bySession;
  }

  getCached(sessionId: string): ChatMessage[] | undefined {
    return this.bySession.get(sessionId);
  }

  setViewingSessionId(sessionId: string | null): void {
    this.viewingSessionId = sessionId;
  }

  /** App wires this to `() => viewingSessionIdRef.current`. */
  setViewingIdResolver(fn: (() => string | null) | null): void {
    this.viewingIdResolver = fn;
  }

  getViewingSessionId(): string | null {
    if (this.viewingIdResolver) {
      const id = this.viewingIdResolver();
      if (id !== undefined) return id;
    }
    return this.viewingSessionId;
  }

  private flushContentListeners(): void {
    for (const l of this.contentListeners) l();
  }

  /**
   * Content listeners: structural changes notify immediately; pure token growth
   * uses leading+trailing throttle so ConversationThread is not re-rendered on
   * every coalesced stream flush.
   */
  private scheduleContentNotify(immediate: boolean): void {
    if (immediate) {
      if (this.contentThrottleTimer != null) {
        clearTimeout(this.contentThrottleTimer);
        this.contentThrottleTimer = null;
      }
      this.contentNotifyQueued = false;
      this.flushContentListeners();
      return;
    }
    if (this.contentThrottleTimer == null) {
      // Leading edge.
      this.flushContentListeners();
      this.contentThrottleTimer = setTimeout(() => {
        this.contentThrottleTimer = null;
        if (this.contentNotifyQueued) {
          this.contentNotifyQueued = false;
          this.flushContentListeners();
        }
      }, resolveTranscriptContentNotifyMs());
      return;
    }
    this.contentNotifyQueued = true;
  }

  private notifyMeta(): void {
    for (const l of this.metaListeners) l();
  }

  private commitViewing(
    next: ChatMessage[],
    opts?: { forceStructural?: boolean },
  ): void {
    const prevMetaCore = {
      length: this.meta.length,
      lastUserId: this.meta.lastUserId,
      hasError: this.meta.hasError,
      hasStreamingAssistant: this.meta.hasStreamingAssistant,
      tailId: this.meta.tailId,
    };
    const nextCore = computeMeta(next);
    const structural =
      !!opts?.forceStructural || !metaStructuralEqual(prevMetaCore, nextCore);

    this.messages = next;
    const viewing = this.getViewingSessionId();
    if (viewing) {
      this.bySession.set(viewing, next);
    }

    if (structural) {
      this.meta = {
        ...nextCore,
        structuralRev: this.meta.structuralRev + 1,
      };
      this.notifyMeta();
    } else {
      // Keep structuralRev stable; still refresh non-rev fields if needed.
      this.meta = {
        ...nextCore,
        structuralRev: this.meta.structuralRev,
      };
    }
    this.scheduleContentNotify(structural);
  }

  /** Replace viewing messages (open session / clear / optimistic full set). */
  setMessages(next: ChatMessage[] | MessagesReducer): void {
    const resolved =
      typeof next === "function"
        ? (next as MessagesReducer)(this.messages)
        : next;
    this.commitViewing(resolved);
  }

  /**
   * Apply reducer to a session. Only notifies React when the target is the
   * viewing session (background sessions stay in the cache only).
   */
  patchSession(
    targetSessionId: string | null | undefined,
    reduce: MessagesReducer,
  ): void {
    if (!targetSessionId) return;
    if (this.getViewingSessionId() === targetSessionId) {
      const next = reduce(this.messages);
      this.commitViewing(next);
      return;
    }
    const prev = this.bySession.get(targetSessionId) ?? [];
    this.bySession.set(targetSessionId, reduce(prev));
  }

  /** Cache helper used when switching sessions (leave behind). */
  cacheSession(sessionId: string, messages: ChatMessage[]): void {
    this.bySession.set(sessionId, messages);
  }

  deleteSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  /** Test / hot-reload reset. */
  resetForTests(): void {
    if (this.contentThrottleTimer != null) {
      clearTimeout(this.contentThrottleTimer);
      this.contentThrottleTimer = null;
    }
    this.contentNotifyQueued = false;
    this.messages = [];
    this.meta = {
      length: 0,
      lastUserId: null,
      hasError: false,
      hasStreamingAssistant: false,
      tailId: null,
      structuralRev: 0,
    };
    this.bySession.clear();
    this.viewingSessionId = null;
    this.viewingIdResolver = null;
  }
}

/** App-wide singleton (one desktop window = one viewing transcript). */
export const sessionTranscriptStore = new SessionTranscriptStore();
