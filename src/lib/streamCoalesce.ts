/**
 * Merge high-frequency stream chunks before React setState.
 * Same session + messageId + kind text is concatenated; terminal `done`
 * and thought phase boundaries flush immediately.
 */

export type CoalesceStreamChunk = {
  sessionId?: string | null;
  messageId?: string | null;
  text?: string | null;
  done?: boolean | null;
  kind?: string | null;
  thoughtPhase?: string | null;
};

/** Stable key for mergeable stream rows. */
export function streamCoalesceKey(chunk: CoalesceStreamChunk): string {
  const sid = chunk.sessionId ?? "";
  const mid = chunk.messageId ?? "";
  const kind = chunk.kind ?? "assistant";
  return `${sid}\0${mid}\0${kind}`;
}

/** Whether this chunk must not wait in the batch buffer. */
export function streamChunkNeedsImmediateFlush(chunk: CoalesceStreamChunk): boolean {
  if (chunk.done) return true;
  const phase = (chunk.thoughtPhase ?? "").toLowerCase();
  // Phase boundary opens a new thought block — flush prior + this promptly.
  if (phase === "new" || phase === "open") return true;
  return false;
}

/**
 * Merge `next` into `prev` when they share the coalesce key.
 * Returns null when they cannot merge (caller should flush prev first).
 */
export function mergeStreamChunks(
  prev: CoalesceStreamChunk,
  next: CoalesceStreamChunk,
): CoalesceStreamChunk | null {
  if (streamCoalesceKey(prev) !== streamCoalesceKey(next)) return null;
  const text = `${prev.text ?? ""}${next.text ?? ""}`;
  const done = !!(prev.done || next.done);
  // Prefer the latest non-empty thought phase (new/open/continue).
  const thoughtPhase =
    next.thoughtPhase && next.thoughtPhase !== "none"
      ? next.thoughtPhase
      : prev.thoughtPhase;
  return {
    ...prev,
    ...next,
    text,
    done,
    thoughtPhase: thoughtPhase ?? next.thoughtPhase ?? prev.thoughtPhase,
  };
}

export type StreamCoalescerOptions = {
  /** Max hold time before a non-terminal batch is flushed (default 48ms). */
  flushMs?: number;
  /** Deliver one (possibly merged) chunk to the UI reducer. */
  onFlush: (chunk: CoalesceStreamChunk) => void;
};

/**
 * Batches stream chunks per key. Call `push` from the Tauri event listener
 * and `dispose` on unmount / cancel.
 */
export class StreamCoalescer {
  private readonly flushMs: number;
  private readonly onFlush: (chunk: CoalesceStreamChunk) => void;
  private pending = new Map<string, CoalesceStreamChunk>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(opts: StreamCoalescerOptions) {
    this.flushMs = Math.max(8, opts.flushMs ?? 48);
    this.onFlush = opts.onFlush;
  }

  push(chunk: CoalesceStreamChunk): void {
    if (this.disposed) return;
    const key = streamCoalesceKey(chunk);
    const existing = this.pending.get(key);
    if (existing) {
      const merged = mergeStreamChunks(existing, chunk);
      if (merged) {
        if (streamChunkNeedsImmediateFlush(merged)) {
          this.pending.delete(key);
          this.onFlush(merged);
          this.armOrClear();
          return;
        }
        this.pending.set(key, merged);
        this.armOrClear();
        return;
      }
      // Different shape (shouldn't for same key) — flush old.
      this.pending.delete(key);
      this.onFlush(existing);
    }

    if (streamChunkNeedsImmediateFlush(chunk) || !(chunk.text ?? "")) {
      this.onFlush(chunk);
      this.armOrClear();
      return;
    }

    this.pending.set(key, chunk);
    this.armOrClear();
  }

  /** Flush all pending immediately (turn end / unmount). */
  flushAll(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const items = [...this.pending.values()];
    this.pending.clear();
    for (const c of items) this.onFlush(c);
  }

  dispose(): void {
    this.flushAll();
    this.disposed = true;
  }

  private armOrClear(): void {
    if (this.pending.size === 0) {
      if (this.timer != null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      return;
    }
    if (this.timer != null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushAll();
    }, this.flushMs);
  }
}
